import type { WrongContentRetryPlan } from './wrong-content-retry';
// DESIGN-055 P4 decision 40. Private staff continuation; the original deletion and Carry never repeat.
import { createHash, randomUUID } from 'node:crypto';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import {
  fixRequests,
  mediaItems,
  repairRequests,
  watchCarries,
  type DbClient,
  type FixActionEntry,
} from '@hnet/db';
import type { ArrClientBundle } from './arr-clients';
import { inTransaction, resolveDb } from './db-client';
import { FixPlanChangedError, FixRefusedError } from './errors';
import { appendFixActions, recordFixAction, OPEN_FIX_STATUSES } from './fix-requests';
import {
  classifyReleases,
  readReleasePickTarget,
  sendReleaseGrab,
  type ReleasePickOffer,
} from './release-pick';
import { getRepairGuideRemedies } from './repair-guide-settings';

export const partObject = (x: unknown): Record<string, unknown> =>
  x !== null && typeof x === 'object' && !Array.isArray(x) ? (x as Record<string, unknown>) : {};
export const partIds = (x: unknown): number[] =>
  Array.isArray(x) && x.length > 0 && x.every((n) => Number.isInteger(n) && n > 0)
    ? [...new Set(x as number[])].sort((a, b) => a - b)
    : [];
const same = (a: readonly number[], b: readonly number[]) =>
  a.length === b.length && a.every((n) => b.includes(n));
export function partHash(x: unknown): string {
  const canonical = (v: unknown): unknown =>
    v instanceof Date
      ? v.toISOString()
      : Array.isArray(v)
        ? v.map(canonical)
        : v !== null && typeof v === 'object'
          ? Object.fromEntries(
              Object.entries(v)
                .filter(([, a]) => a !== undefined)
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([k, a]) => [k, canonical(a)]),
            )
          : v;
  return createHash('sha256')
    .update(JSON.stringify(canonical(x)))
    .digest('hex');
}
function refuse(): never {
  throw new FixRefusedError('copy_refused', 'The original full-slot Watch Carry is not verified.');
}
export type PartBoundary = Array<{
  episodeId: number;
  fileId: number;
  name: string | null;
  size: number | null;
}>;
export type WrongContentSelectedPart = {
  id: string;
  key: string;
  guid: string;
  indexerId: number;
  title: string;
  episodeIds: number[];
};
export type WrongContentPartSelection = {
  version: 1;
  claimContract: 'before-every-call';
  seriesId: number;
  parts: WrongContentSelectedPart[];
  protectedFiles: PartBoundary;
  digest: string;
};
type Episode = Awaited<ReturnType<ArrClientBundle['read']['sonarr']['listEpisodes']>>[number];
type File = Awaited<
  ReturnType<ArrClientBundle['read']['sonarr']['listEpisodeFileReleases']>
>[number];
const sanitizedHistory = (h: History[number]): History[number] => ({
  id: h.id,
  date: h.date,
  eventType: h.eventType,
  seriesId: h.seriesId,
  episodeId: h.episodeId,
  downloadId: h.downloadId,
  sourceTitle: h.sourceTitle,
  data: /^\d+$/.test(String(h.data?.fileId)) ? { fileId: String(h.data?.fileId) } : {},
});
type History = Awaited<ReturnType<ArrClientBundle['read']['sonarr']['getHistory']>>['records'];
export function partBoundary(
  episodes: readonly Episode[],
  files: readonly File[],
  included: readonly number[],
): PartBoundary {
  return episodes
    .filter((e) => included.includes(e.id))
    .map((e) => {
      const fileId = e.episodeFileId ?? 0,
        f = files.find((f) => f.id === fileId);
      if (fileId > 0 && (!f?.size || !f.relativePath)) refuse();
      return { episodeId: e.id, fileId, name: f?.relativePath ?? null, size: f?.size ?? null };
    })
    .sort((a, b) => a.episodeId - b.episodeId);
}
export function makeWrongContentPartSelection(input: {
  picks: Array<{ offer: ReleasePickOffer; ids: number[] }>;
  episodes: Episode[];
  files: File[];
  slot: number[];
}): WrongContentPartSelection {
  const parts = input.picks.map(({ offer, ids }) => ({
    id: randomUUID(),
    key: offer.key,
    guid: offer.guid,
    indexerId: offer.indexerId,
    title: offer.title,
    episodeIds: [...ids].sort((a, b) => a - b),
  }));
  const union = parts.flatMap((p) => p.episodeIds);
  if (new Set(union).size !== union.length || !same(union, input.slot)) refuse();
  const base = {
    version: 1 as const,
    claimContract: 'before-every-call' as const,
    seriesId: input.episodes[0]?.seriesId ?? 0,
    parts,
    protectedFiles: partBoundary(
      input.episodes,
      input.files,
      input.episodes.filter((e) => !input.slot.includes(e.id)).map((e) => e.id),
    ),
  };
  return { ...base, digest: partHash(base) };
}
export function readWrongContentPartSelection(detail: unknown): WrongContentPartSelection | null {
  const raw = partObject(partObject(detail).wrongContentSelection);
  if (!Object.keys(raw).length) return null;
  const { digest, ...base } = raw;
  if (
    raw.version !== 1 ||
    raw.claimContract !== 'before-every-call' ||
    !Number.isInteger(raw.seriesId) ||
    Number(raw.seriesId) <= 0 ||
    !Array.isArray(raw.parts) ||
    raw.parts.length < 2 ||
    !Array.isArray(raw.protectedFiles) ||
    digest !== partHash(base)
  )
    refuse();
  const parts = raw.parts as WrongContentSelectedPart[],
    union = parts.flatMap((p) => partIds(p.episodeIds));
  if (
    parts.some(
      (p) =>
        !p.id ||
        !p.key ||
        !p.guid ||
        !Number.isInteger(p.indexerId) ||
        p.indexerId <= 0 ||
        !p.title ||
        !p.episodeIds.length ||
        !same(partIds(p.episodeIds), p.episodeIds),
    ) ||
    new Set(parts.map((p) => p.id)).size !== parts.length ||
    new Set(union).size !== union.length
  )
    refuse();
  return raw as WrongContentPartSelection;
}
export type PartBinding = {
  part: WrongContentSelectedPart;
  intent: FixActionEntry;
  call: FixActionEntry;
  downloadId: string;
  grabs: History;
};
function callBinding(
  part: WrongContentSelectedPart,
  intent: FixActionEntry,
  actions: FixActionEntry[],
  history: History,
  seriesId: number,
): PartBinding | null {
  const call = actions.find(
    (a) =>
      a.step === 'wrong_content_part_call_result' &&
      a.attemptId === intent.attemptId &&
      a.partId === part.id,
  );
  const start = Date.parse(String(call?.startedAt)),
    end = Date.parse(String(call?.finishedAt));
  if (
    !call ||
    call.title !== intent.title ||
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    end < start ||
    !same(partIds(call.targetEpisodeIds), part.episodeIds) ||
    typeof intent.title !== 'string'
  )
    return null;
  const title = String(intent.title),
    saved = Array.isArray(call.grabbedHistory) ? (call.grabbedHistory as History) : [];
  const observed = actions
    .filter(
      (a) => a.step === 'wrong_content_part_call_observed' && a.attemptId === intent.attemptId,
    )
    .flatMap((a) => (Array.isArray(a.grabbedHistory) ? (a.grabbedHistory as History) : []));
  const rows = [...saved, ...observed, ...history].filter(
    (h) =>
      h.eventType === 'grabbed' &&
      h.seriesId === seriesId &&
      h.sourceTitle === title &&
      h.downloadId &&
      h.date &&
      Date.parse(h.date) >= Math.floor(start / 1000) * 1000 &&
      Date.parse(h.date) <= end,
  );
  const unique = [...new Map(rows.map((h) => [h.id, h])).values()],
    downloads = [...new Set(unique.map((h) => h.downloadId))];
  if (
    downloads.length !== 1 ||
    !same(partIds(unique.map((h) => h.episodeId)), part.episodeIds) ||
    unique.some((h) => !part.episodeIds.includes(h.episodeId!)) ||
    (call.downloadId && call.downloadId !== downloads[0])
  )
    return null;
  return { part, intent, call, downloadId: downloads[0]!, grabs: unique };
}
export function selectedPartBindings(
  selection: WrongContentPartSelection,
  actions: FixActionEntry[],
  history: History = [],
): { all: PartBinding[]; unresolved: FixActionEntry[]; latest: Map<string, PartBinding> } {
  const all: PartBinding[] = [],
    unresolved: FixActionEntry[] = [],
    latest = new Map<string, PartBinding>();
  for (const intent of actions.filter((a) => a.step === 'wrong_content_part_grab_intent')) {
    const part = selection.parts.find((p) => p.id === intent.partId);
    if (
      !part ||
      !same(partIds(intent.episodeIds), part.episodeIds) ||
      typeof intent.attemptId !== 'string'
    )
      refuse();
    const binding = callBinding(part, intent, actions, history, selection.seriesId);
    latest.delete(part.id);
    if (binding) {
      all.push(binding);
      latest.set(part.id, binding);
    } else unresolved.push(intent);
  }
  return { all, unresolved, latest };
}
export function assertWrongContentPartInterlock(
  selection: WrongContentPartSelection,
  actions: FixActionEntry[],
): void {
  if (
    selectedPartBindings(selection, actions).unresolved.length ||
    actions.some(
      (a) =>
        a.step === 'wrong_content_part_retry_claim' &&
        !actions.some(
          (b) => b.step === 'wrong_content_part_grab_intent' && b.attemptId === a.attemptId,
        ),
    )
  )
    refuse();
}
type PartInput = {
  db?: DbClient;
  arr: ArrClientBundle;
  actor: { kind: 'staff' };
  fixRequestId: string;
};
async function parent(input: Pick<PartInput, 'db' | 'actor' | 'fixRequestId'>, lock = false) {
  const db = resolveDb(input.db),
    q = db.select().from(fixRequests).where(eq(fixRequests.id, input.fixRequestId)),
    [fix] = await (lock ? q.for('update') : q);
  if (
    !fix ||
    input.actor.kind !== 'staff' ||
    fix.requesterId !== null ||
    fix.reason !== 'wrong_content' ||
    fix.pathTaken !== 'delete_search' ||
    !(
      lock ? ['actioned', 'search_triggered'] : ['actioned', 'search_triggered', 'completed']
    ).includes(fix.status)
  )
    refuse();
  const carries = (
    await db
      .select()
      .from(watchCarries)
      .where(
        and(eq(watchCarries.mediaItemId, fix.mediaItemId), eq(watchCarries.kind, 'wrong_content')),
      )
  ).filter((c) => c.detail.fixRequestId === fix.id);
  const carry = carries.length === 1 ? carries[0] : null,
    selection = readWrongContentPartSelection(carry?.detail),
    deletion = partObject(carry?.detail.wrongContentDeletion);
  const slot = Array.isArray(deletion.files)
    ? deletion.files.flatMap((f) => partIds(partObject(f).episodeIds))
    : [];
  if (
    !carry ||
    !selection ||
    carry.status !== 'verified' ||
    deletion.version !== 1 ||
    deletion.grabStarted !== true ||
    !Array.isArray(deletion.files) ||
    deletion.files.some((f) => {
      const x = partObject(f);
      return (
        !Number.isInteger(x.id) ||
        Number(x.id) <= 0 ||
        !x.name ||
        Number(x.size) <= 0 ||
        !partIds(x.episodeIds).length
      );
    }) ||
    !slot.includes(fix.targetArrChildId ?? 0) ||
    selection.seriesId !== carry.seriesId ||
    (Array.isArray(carry.scope.pendingDeletes) && carry.scope.pendingDeletes.length) ||
    !same(
      slot,
      selection.parts.flatMap((p) => p.episodeIds),
    ) ||
    new Set(slot).size !== slot.length
  )
    refuse();
  const [item] = await db.select().from(mediaItems).where(eq(mediaItems.id, fix.mediaItemId));
  if (
    !item ||
    item.arrKind !== 'sonarr' ||
    item.arrItemId !== carry.seriesId ||
    item.deletedFromArrAt
  )
    refuse();
  return { fix, carry, selection, item, slot, fingerprint: partHash({ fix, carry }) };
}
export async function readWrongContentPartsForInterlock(
  db: DbClient | undefined,
  fixRequestId: string,
) {
  return parent({ db, fixRequestId, actor: { kind: 'staff' } });
}
/** Queue enforcement must not bypass the selected-part writer's neutral failed-download removal. */
export async function selectedWrongContentQueueHolds(input: {
  db?: DbClient;
  items: Array<{ downloadId: string | null; parentId?: number | null; title: string | null }>;
}): Promise<Set<string>> {
  const held = new Set<string>();
  if (!input.items.some((i) => i.downloadId && i.parentId && i.title)) return held;
  const active = await resolveDb(input.db)
    .select({ id: fixRequests.id })
    .from(fixRequests)
    .where(
      and(
        isNull(fixRequests.requesterId),
        eq(fixRequests.reason, 'wrong_content'),
        eq(fixRequests.pathTaken, 'delete_search'),
        inArray(fixRequests.status, ['actioned', 'search_triggered']),
      ),
    );
  for (const row of active) {
    let p: Awaited<ReturnType<typeof parent>>;
    try {
      p = await parent({ db: input.db, fixRequestId: row.id, actor: { kind: 'staff' } });
    } catch (error) {
      if (error instanceof FixRefusedError) continue;
      throw error;
    }
    if (p.item.arrInstanceId !== 'main') continue;
    const bindings = selectedPartBindings(p.selection, p.fix.actionsTaken);
    for (const item of input.items)
      if (
        item.parentId === p.selection.seriesId &&
        bindings.all.some((b) => b.downloadId === item.downloadId && b.intent.title === item.title)
      )
        held.add(`${item.downloadId}\u0000${item.parentId}\u0000${item.title}`);
  }
  return held;
}
export async function hasWrongContentParts(
  db: DbClient | undefined,
  fixRequestId: string,
): Promise<boolean> {
  const rows = await resolveDb(db)
    .select({ detail: watchCarries.detail })
    .from(watchCarries)
    .where(eq(watchCarries.kind, 'wrong_content'));
  return rows.some(
    (r) =>
      r.detail.fixRequestId === fixRequestId && readWrongContentPartSelection(r.detail) !== null,
  );
}
async function sample(input: PartInput) {
  const p = await parent(input),
    [episodes, files, queue, page] = await Promise.all([
      input.arr.read.sonarr.listEpisodes(p.item.arrItemId),
      input.arr.read.sonarr.listEpisodeFileReleases(p.item.arrItemId),
      input.arr.read.sonarr.getQueue(p.item.arrItemId),
      input.arr.read.sonarr.getHistory({
        page: 1,
        pageSize: 200,
        sortKey: 'date',
        sortDirection: 'descending',
      }),
    ]);
  if (!p.slot.every((id) => episodes.some((e) => e.id === id))) refuse();
  const history = page.records.filter((h) => h.seriesId === p.item.arrItemId),
    bindings = selectedPartBindings(p.selection, p.fix.actionsTaken, history);
  if (
    partHash(
      partBoundary(
        episodes,
        files,
        p.selection.protectedFiles.map((f) => f.episodeId),
      ),
    ) !== partHash(p.selection.protectedFiles)
  )
    refuse();
  return { ...p, episodes, files, queue, history, bindings };
}
function importedPart(
  s: Awaited<ReturnType<typeof sample>>,
  part: WrongContentSelectedPart,
  binding: PartBinding,
): { targets: PartBoundary; history: History } | null {
  const targets = partBoundary(s.episodes, s.files, part.episodeIds),
    imports = s.history.filter(
      (h) =>
        h.eventType === 'downloadFolderImported' &&
        h.downloadId === binding.downloadId &&
        h.date &&
        Date.parse(h.date) >= Math.floor(Date.parse(String(binding.call.startedAt)) / 1000) * 1000,
    );
  if (
    targets.some(
      (t) =>
        !t.fileId ||
        !t.size ||
        !imports.some((h) => h.episodeId === t.episodeId && Number(h.data?.fileId) === t.fileId),
    ) ||
    !same(
      partIds(
        s.episodes
          .filter((e) => targets.some((t) => t.fileId === e.episodeFileId))
          .map((e) => e.id),
      ),
      part.episodeIds,
    ) ||
    new Set(targets.map((t) => t.fileId)).size !== 1
  )
    return null;
  return { targets, history: imports.map(sanitizedHistory) };
}
function assertOtherParts(s: Awaited<ReturnType<typeof sample>>, target: WrongContentSelectedPart) {
  for (const part of s.selection.parts.filter((p) => p.id !== target.id)) {
    const occupied = s.episodes.some(
      (e) => part.episodeIds.includes(e.id) && (e.hasFile || (e.episodeFileId ?? 0) > 0),
    );
    const binding = s.bindings.latest.get(part.id),
      intents = s.fix.actionsTaken.filter(
        (a) => a.step === 'wrong_content_part_grab_intent' && a.partId === part.id,
      );
    if (occupied) {
      if (!binding) refuse();
      const proof = importedPart(s, part, binding),
        audit = [...s.fix.actionsTaken]
          .reverse()
          .find(
            (a) =>
              (a.step === 'wrong_content_part_import_read_back' ||
                a.step === 'owned_import_read_back') &&
              a.downloadId === binding.downloadId &&
              a.ok === true,
          );
      if (!proof || !audit || partHash(audit.targets) !== partHash(proof.targets)) refuse();
    } else {
      if (intents.length && !binding) refuse();
      if (
        s.queue.some(
          (q) =>
            part.episodeIds.includes(q.episodeId ?? 0) &&
            (!binding || q.downloadId !== binding.downloadId),
        )
      )
        refuse();
      if (
        s.fix.actionsTaken.some(
          (a) =>
            a.step === 'owned_import_intent' &&
            binding?.downloadId === a.downloadId &&
            !s.fix.actionsTaken.some(
              (b) =>
                b.step === 'owned_import_read_back' &&
                b.downloadId === a.downloadId &&
                b.ok === true,
            ),
        )
      )
        refuse();
    }
  }
}
export interface WrongContentPartResumeInput extends PartInput {
  partId: string;
}
export interface WrongContentPartRetryInput extends PartInput {
  failedDownloadId?: string;
  key?: string;
  conflictingDownloadId?: string;
}
async function planPart(
  input: PartInput & {
    partId?: string;
    failedDownloadId?: string;
    key?: string;
    conflictingDownloadId?: string;
  },
) {
  if (!(await getRepairGuideRemedies(input.db)).release_pick) refuse();
  const s = await sample(input),
    part = input.partId
      ? s.selection.parts.find((p) => p.id === input.partId)
      : input.failedDownloadId
        ? s.bindings.all.find((b) => b.downloadId === input.failedDownloadId)?.part
        : s.selection.parts.length === 1
          ? s.selection.parts[0]
          : undefined;
  if (!part) refuse();
  const own = [...s.fix.actionsTaken]
      .reverse()
      .find((a) => a.step === 'wrong_content_part_grab_intent' && a.partId === part.id),
    binding = s.bindings.latest.get(part.id),
    imports = binding ? importedPart(s, part, binding) : null;
  const observedClaim = s.fix.actionsTaken.find(
    (a) =>
      a.step === 'wrong_content_part_retry_claim' &&
      a.failedDownloadId === input.failedDownloadId &&
      a.partId === part.id,
  );
  let state: 'ready' | 'observe' | 'adopt' = 'ready';
  if (input.failedDownloadId) {
    if (
      !binding ||
      binding.downloadId !== input.failedDownloadId ||
      !s.history.some(
        (h) =>
          h.eventType === 'downloadFailed' &&
          h.downloadId === binding.downloadId &&
          h.date &&
          Date.parse(h.date) >= Math.max(...binding.grabs.map((g) => Date.parse(g.date))) &&
          h.data?.message !== 'Manually marked as failed',
      ) ||
      s.history.some(
        (h) => h.downloadId === binding.downloadId && h.eventType === 'downloadFolderImported',
      ) ||
      s.fix.actionsTaken.some(
        (a) => a.step === 'owned_import_intent' && a.downloadId === binding.downloadId,
      )
    )
      refuse();
    if (observedClaim) state = 'observe';
  } else if (own) state = imports ? 'adopt' : 'observe';
  if (state === 'ready' && s.fix.status === 'completed') refuse();
  if (state === 'ready' && s.bindings.unresolved.length) refuse();
  assertOtherParts(s, part);
  const targets = partBoundary(s.episodes, s.files, part.episodeIds);
  if (state === 'ready' && targets.some((t) => t.fileId > 0)) refuse();
  const records = s.queue.filter((q) => q.downloadId === input.failedDownloadId);
  if (
    records.some(
      (q) => q.seriesId !== s.item.arrItemId || (binding && q.title !== binding.intent.title),
    )
  )
    refuse();
  if (input.conflictingDownloadId && input.conflictingDownloadId !== input.failedDownloadId)
    refuse();
  const protectedFiles = partBoundary(
    s.episodes,
    s.files,
    s.episodes.filter((e) => !part.episodeIds.includes(e.id)).map((e) => e.id),
  );
  const overlapping = s.queue.filter(
    (q) => part.episodeIds.includes(q.episodeId ?? 0) && q.downloadId !== input.failedDownloadId,
  );
  if (state === 'ready' && overlapping.length) refuse();
  const [otherFixes, otherRepairs] = await Promise.all([
    resolveDb(input.db)
      .select()
      .from(fixRequests)
      .where(
        and(
          eq(fixRequests.mediaItemId, s.item.id),
          inArray(fixRequests.status, [...OPEN_FIX_STATUSES]),
        ),
      ),
    resolveDb(input.db)
      .select()
      .from(repairRequests)
      .where(
        and(
          eq(repairRequests.mediaItemId, s.item.id),
          inArray(repairRequests.status, ['pending', 'actioned']),
        ),
      ),
  ]);
  if (
    otherFixes.some(
      (f) =>
        f.id !== s.fix.id &&
        (f.targetScope !== 'episode' || s.slot.includes(f.targetArrChildId ?? 0)),
    ) ||
    otherRepairs.some(
      (r) => r.scope !== 'episode' || r.targetChildIds.some((id) => s.slot.includes(id)),
    )
  )
    refuse();
  const { target } = await readReleasePickTarget({
    db: input.db,
    arr: input.arr,
    mediaItemId: s.item.id,
    scope: 'episode',
    targetChildId: part.episodeIds[0]!,
  });
  if (target.kind !== 'sonarr') refuse();
  const releases =
    state === 'ready'
      ? await input.arr.read.sonarr.listSeasonReleases(s.item.arrItemId, target.seasonNumber)
      : [];
  const offers = classifyReleases(releases, target, { replacing: true }).offers.filter(
    (o) =>
      o.titleVerdict === 'agrees' &&
      same(partIds(o.episodeIds ?? [target.episodeId]), part.episodeIds) &&
      (input.failedDownloadId ||
        (o.guid === part.guid && o.indexerId === part.indexerId && o.title === part.title)),
  );
  if (input.key && state === 'ready' && !offers.some((o) => o.key === input.key)) refuse();
  const data = {
    fixRequestId: s.fix.id,
    carryId: s.carry.id,
    partId: part.id,
    targetEpisodeIds: part.episodeIds,
    originalSlotEpisodeIds: s.slot,
    state,
    failedDownloadId: input.failedDownloadId ?? null,
    failedQueue:
      input.failedDownloadId && records.length
        ? {
            downloadId: input.failedDownloadId,
            queueItemIds: records.map((r) => r.id).sort((a, b) => a - b),
            title: String(binding!.intent.title),
            options: {
              removeFromClient: false as const,
              blocklist: false as const,
              skipRedownload: true as const,
            },
          }
        : null,
    protectedFiles,
    candidates: offers.map((o) => ({
      key: o.key,
      title: o.title,
      holds: o.holds ?? [],
      reasonCodes: o.reasonCodes,
      sizeBytes: null,
      languages: o.languages.map((l) => l.name).filter((n): n is string => typeof n === 'string'),
      qualityName: o.quality?.quality?.name ?? null,
    })),
    selectionDigest: s.selection.digest,
    sourceImport: imports,
    digest: '',
  };
  data.digest = partHash({ data, parent: s.fingerprint, offers, records });
  return { data, s, part, target, offers, records, observedClaim };
}
export async function planWrongContentPartResume(input: WrongContentPartResumeInput) {
  return (await planPart(input)).data;
}
export async function planWrongContentPartRetry(
  input: WrongContentPartRetryInput,
): Promise<WrongContentRetryPlan> {
  const p = await planPart(input),
    b = p.s.bindings.latest.get(p.part.id);
  if (!input.failedDownloadId || p.data.state === 'adopt') refuse();
  return {
    ...p.data,
    state: p.data.state,
    failedDownloadId: input.failedDownloadId,
    mediaItemId: p.s.item.id,
    seriesId: p.s.item.arrItemId,
    failedGrabAttemptId: typeof b?.intent.attemptId === 'string' ? b.intent.attemptId : null,
    failedGrabHistoryIds: b?.grabs.map((h) => h.id) ?? [],
    failedGrabHttpAccepted: b?.call.accepted === true,
    failedHistoryIds: p.s.history
      .filter((h) => h.downloadId === input.failedDownloadId && h.eventType === 'downloadFailed')
      .map((h) => h.id),
    conflict: null,
    selectedKey: input.key ?? null,
  };
}
async function runPart(
  input: PartInput & {
    partId?: string;
    failedDownloadId?: string;
    key?: string;
    conflictingDownloadId?: string;
    digest: string;
    evidence: string;
  },
) {
  const p = await planPart(input);
  if (p.data.digest !== input.digest)
    throw new FixPlanChangedError('The recovery changed. Read a fresh plan.');
  if (input.evidence.trim().length < 20) refuse();
  if (p.data.state === 'adopt') {
    const binding = p.s.bindings.latest.get(p.part.id)!;
    await appendFixActions({
      db: input.db,
      fixRequestId: input.fixRequestId,
      allowCompleted: true,
      actions: [
        {
          step: 'wrong_content_part_import_read_back',
          at: new Date().toISOString(),
          partId: p.part.id,
          downloadId: binding.downloadId,
          ok: true,
          targets: p.data.sourceImport!.targets,
          importedHistory: p.data.sourceImport!.history,
          evidence: input.evidence,
        },
      ],
    });
    return { outcome: 'imported' as const, ...p.data };
  }
  if (p.data.state === 'observe') {
    if (
      p.observedClaim &&
      !p.records.length &&
      !p.s.fix.actionsTaken.some(
        (a) =>
          a.step === 'wrong_content_part_remove_read_back' &&
          a.attemptId === p.observedClaim!.attemptId,
      )
    )
      await appendFixActions({
        db: input.db,
        fixRequestId: input.fixRequestId,
        allowCompleted: true,
        actions: [
          {
            step: 'wrong_content_part_remove_read_back',
            at: new Date().toISOString(),
            attemptId: p.observedClaim.attemptId,
            partId: p.part.id,
            downloadId: input.failedDownloadId,
            queueAbsent: true,
            observationOnly: true,
            commandOutcome: 'unknown',
          },
        ],
      });
    const binding = p.s.bindings.latest.get(p.part.id);
    if (binding)
      await appendFixActions({
        db: input.db,
        fixRequestId: input.fixRequestId,
        allowCompleted: true,
        actions: [
          {
            step: 'wrong_content_part_call_observed',
            at: new Date().toISOString(),
            partId: p.part.id,
            attemptId: binding.intent.attemptId,
            downloadId: binding.downloadId,
            grabbedHistory: binding.grabs.map(sanitizedHistory),
          },
        ],
      });
    if (binding && p.s.fix.status === 'actioned')
      await recordFixAction({
        db: input.db,
        fixRequestId: input.fixRequestId,
        transition: 'search_triggered',
        actions: [
          {
            step: 'wrong_content_part_grab_observed',
            at: new Date().toISOString(),
            partId: p.part.id,
            attemptId: binding.intent.attemptId,
            downloadId: binding.downloadId,
            grabbedHistory: binding.grabs.map(sanitizedHistory),
          },
        ],
      });
    return { outcome: 'observe' as const, ...p.data };
  }
  const offer =
    p.offers.find((o) => o.key === input.key) ??
    (!input.failedDownloadId && p.offers.length === 1 ? p.offers[0] : undefined);
  if (!offer) refuse();
  const attemptId = randomUUID();
  if (p.records.length) {
    await inTransaction(input.db, async (tx) => {
      const locked = await parent({ ...input, db: tx }, true);
      if (locked.fingerprint !== p.s.fingerprint) refuse();
      await appendFixActions({
        db: tx,
        fixRequestId: input.fixRequestId,
        actions: [
          {
            step: 'wrong_content_part_retry_claim',
            at: new Date().toISOString(),
            attemptId,
            partId: p.part.id,
            failedDownloadId: input.failedDownloadId,
            queueItemId: p.records[0]!.id,
            protectedFiles: p.data.protectedFiles,
          },
        ],
      });
    });
    const options = { removeFromClient: false, blocklist: false, skipRedownload: true };
    try {
      await input.arr.write.sonarr.deleteQueueItem(p.records[0]!.id, options);
    } catch {
      await appendFixActions({
        db: input.db,
        fixRequestId: input.fixRequestId,
        actions: [
          {
            step: 'wrong_content_part_remove_result',
            at: new Date().toISOString(),
            attemptId,
            partId: p.part.id,
            ok: false,
          },
        ],
      });
      return { outcome: 'observe' as const, ...p.data };
    }
    await appendFixActions({
      db: input.db,
      fixRequestId: input.fixRequestId,
      actions: [
        {
          step: 'wrong_content_part_remove_result',
          at: new Date().toISOString(),
          attemptId,
          partId: p.part.id,
          ok: true,
          downloadId: input.failedDownloadId,
          options,
        },
      ],
    });
    const fresh = await sample(input);
    if (
      fresh.queue.some((q) => q.downloadId === input.failedDownloadId) ||
      partHash(
        partBoundary(
          fresh.episodes,
          fresh.files,
          p.data.protectedFiles.map((f) => f.episodeId),
        ),
      ) !== partHash(p.data.protectedFiles)
    )
      refuse();
    await appendFixActions({
      db: input.db,
      fixRequestId: input.fixRequestId,
      actions: [
        {
          step: 'wrong_content_part_remove_read_back',
          at: new Date().toISOString(),
          attemptId,
          partId: p.part.id,
          downloadId: input.failedDownloadId,
          queueAbsent: true,
        },
      ],
    });
  }
  return dispatchWrongContentSelectedPart({
    ...input,
    partId: p.part.id,
    offer,
    attemptId,
    failedDownloadId: input.failedDownloadId,
    expectedProtected: p.data.protectedFiles,
  });
}
export async function runWrongContentPartResume(
  input: WrongContentPartResumeInput & { digest: string; evidence: string },
) {
  return runPart(input);
}
export async function runWrongContentPartRetry(
  input: WrongContentPartRetryInput & { digest: string; key: string; evidence: string },
) {
  return runPart(input);
}
export async function dispatchWrongContentSelectedPart(
  input: PartInput & {
    partId: string;
    offer: ReleasePickOffer;
    attemptId?: string;
    failedDownloadId?: string;
    expectedProtected?: PartBoundary;
  },
) {
  const s = await sample(input),
    part = s.selection.parts.find((p) => p.id === input.partId);
  if (!part || !same(partIds(input.offer.episodeIds ?? part.episodeIds), part.episodeIds)) refuse();
  if (
    s.bindings.unresolved.length ||
    s.fix.actionsTaken.some(
      (a) =>
        a.step === 'wrong_content_part_retry_claim' &&
        a.attemptId !== input.attemptId &&
        !s.fix.actionsTaken.some(
          (b) => b.step === 'wrong_content_part_grab_intent' && b.attemptId === a.attemptId,
        ),
    ) ||
    s.fix.actionsTaken.some(
      (a) =>
        a.step === 'owned_import_intent' &&
        !s.fix.actionsTaken.some(
          (b) =>
            b.step === 'owned_import_read_back' && b.downloadId === a.downloadId && b.ok === true,
        ),
    )
  )
    refuse();
  assertOtherParts(s, part);
  const protectedFiles = partBoundary(
    s.episodes,
    s.files,
    s.episodes.filter((e) => !part.episodeIds.includes(e.id)).map((e) => e.id),
  );
  if (input.expectedProtected && partHash(protectedFiles) !== partHash(input.expectedProtected))
    refuse();
  if (
    s.episodes
      .filter((e) => part.episodeIds.includes(e.id))
      .some((e) => e.hasFile || (e.episodeFileId ?? 0) > 0)
  )
    refuse();
  const existing = s.fix.actionsTaken.filter(
    (a) => a.step === 'wrong_content_part_grab_intent' && a.partId === part.id,
  );
  if (!input.failedDownloadId && existing.length) refuse();
  if (
    input.failedDownloadId &&
    s.bindings.latest.get(part.id)?.downloadId !== input.failedDownloadId
  )
    refuse();
  const { target } = await readReleasePickTarget({
    db: input.db,
    arr: input.arr,
    mediaItemId: s.item.id,
    scope: 'episode',
    targetChildId: part.episodeIds[0]!,
  });
  if (target.kind !== 'sonarr' || target.seriesId !== s.item.arrItemId) refuse();
  const attemptId = input.attemptId ?? randomUUID(),
    at = () => new Date().toISOString();
  await inTransaction(input.db, async (tx) => {
    const locked = await parent({ ...input, db: tx }, true);
    if (locked.fingerprint !== s.fingerprint)
      throw new FixPlanChangedError('The owning repair changed before its claim.');
    await appendFixActions({
      db: tx,
      fixRequestId: input.fixRequestId,
      actions: [
        {
          step: 'wrong_content_part_grab_intent',
          at: at(),
          attemptId,
          partId: part.id,
          title: input.offer.title,
          episodeIds: part.episodeIds,
          failedDownloadId: input.failedDownloadId ?? null,
          protectedFiles,
        },
        {
          step: 'grab_intent',
          at: at(),
          attemptId,
          partId: part.id,
          title: input.offer.title,
          episodeIds: part.episodeIds,
        },
      ],
    });
  });
  const startedAt = at();
  let accepted = false;
  try {
    await sendReleaseGrab({
      arr: input.arr,
      target,
      offer: input.offer,
      episodeIds: part.episodeIds,
      keepList: true,
    });
    accepted = true;
  } catch {
    /* A thrown transport remains factual and observe-only. */
  }
  const finishedAt = at();
  const call: FixActionEntry = {
    step: 'wrong_content_part_call_result',
    at: finishedAt,
    attemptId,
    partId: part.id,
    title: input.offer.title,
    targetEpisodeIds: part.episodeIds,
    startedAt,
    finishedAt,
    accepted,
  };
  const actions: FixActionEntry[] = [
    {
      step: 'release_grab',
      at: finishedAt,
      attemptId,
      partId: part.id,
      ok: accepted,
      release: input.offer.title,
      key: input.offer.key,
      lands: part.episodeIds,
      override: true,
    },
  ];
  // Preserve actual returned call facts and the HTTP receipt before any further remote read.
  await appendFixActions({
    db: input.db,
    fixRequestId: input.fixRequestId,
    allowCompleted: true,
    actions: [call, ...actions],
  });
  let history: History = [];
  try {
    history = (
      await input.arr.read.sonarr.getHistory({
        page: 1,
        pageSize: 200,
        sortKey: 'date',
        sortDirection: 'descending',
      })
    ).records.filter((h) => h.seriesId === s.item.arrItemId);
  } catch {
    /* An unavailable native read never invents a GUID. */
  }
  const intent = {
    step: 'wrong_content_part_grab_intent',
    at: startedAt,
    attemptId,
    partId: part.id,
    title: input.offer.title,
    episodeIds: part.episodeIds,
  };
  const binding = callBinding(part, intent, [call], history, s.item.arrItemId);
  if (binding)
    await appendFixActions({
      db: input.db,
      fixRequestId: input.fixRequestId,
      allowCompleted: true,
      actions: [
        {
          step: 'wrong_content_part_call_observed',
          at: at(),
          partId: part.id,
          attemptId,
          downloadId: binding.downloadId,
          grabbedHistory: binding.grabs.map(sanitizedHistory),
        },
      ],
    });
  const [current] = await resolveDb(input.db)
    .select({ status: fixRequests.status })
    .from(fixRequests)
    .where(eq(fixRequests.id, input.fixRequestId));
  if (current?.status === 'actioned' && (accepted || binding))
    await recordFixAction({
      db: input.db,
      fixRequestId: input.fixRequestId,
      transition: 'search_triggered',
      actions: [
        {
          step: 'wrong_content_part_grab_observed',
          at: at(),
          attemptId,
          partId: part.id,
          accepted,
          downloadId: binding?.downloadId ?? null,
        },
      ],
    });
  return {
    outcome: accepted && binding ? ('grabbed' as const) : ('observe' as const),
    fixRequestId: input.fixRequestId,
    partId: part.id,
    downloadId: binding?.downloadId ?? null,
    accepted,
  };
}
