import {
  readWrongContentPartSelection,
  selectedPartBindings,
  assertWrongContentPartInterlock,
  type WrongContentPartSelection,
} from './wrong-content-parts';
// DESIGN-055 P4 decision 38: explicitly confirmed import follows the request that owns the grab.
// No public parent IDs, parallel repair, library remap, rejection stripping or uncertain-command replay.
import { createHash, randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import {
  fixRequests,
  mediaItems,
  repairRequests,
  watchCarries,
  type DbClient,
  type FixActionEntry,
} from '@hnet/db';
import type { SonarrManualImportCandidate, SonarrManualImportFile } from '@hnet/arr';
import type { ArrClientBundle } from './arr-clients';
import { inTransaction, resolveDb } from './db-client';
import { FixPlanChangedError, FixRefusedError } from './errors';
import { appendFixActions, OPEN_FIX_STATUSES, recordFixAction } from './fix-requests';
import {
  appendRepairActions,
  OPEN_REPAIR_STATUSES,
  recordRepairTransition,
} from './repair-requests';
import { checkSonarrImport, queueTexts, type SonarrImportCheck } from './import-check';
import { getRepairGuideRemedies } from './repair-guide-settings';

/** Read-only proof that an ignored event is this parent's own post-verified neutral queue forget. */
export async function isVerifiedOwnedQueueForget(input: {
  arr: Pick<ArrClientBundle, 'read'>;
  parent: OwnedImportParent;
  actions: FixActionEntry[];
  targetEpisodeIds: number[];
  seriesId: number;
  downloadId: string;
  ignoredAt: string | null;
}): Promise<boolean> {
  const matching = (step: string) =>
    [...input.actions].reverse().find((a) => a.step === step && a.downloadId === input.downloadId);
  const intent = matching('owned_import_intent'),
    forget = matching('owned_queue_forget_intent');
  const read =
    forget &&
    [...input.actions]
      .reverse()
      .find(
        (a) =>
          a.step === 'owned_import_read_back' &&
          a.downloadId === input.downloadId &&
          Date.parse(a.at) <= Date.parse(forget.at),
      );
  if (
    !intent ||
    !read ||
    !forget ||
    hash(intent.parent) !== hash(input.parent) ||
    hash(forget.parent) !== hash(input.parent) ||
    !same(ids(intent.targetEpisodeIds), ids(input.targetEpisodeIds)) ||
    read.ok !== true ||
    read.protectedUnchanged !== true ||
    Date.parse(forget.at) < Date.parse(read.at) ||
    !input.ignoredAt ||
    Date.parse(input.ignoredAt) < Math.floor(Date.parse(forget.at) / 1000) * 1000
  )
    return false;
  const options = object(forget.options),
    source = object(intent.source);
  if (
    options.removeFromClient !== false ||
    options.blocklist !== false ||
    options.skipRedownload !== true ||
    typeof source.size !== 'number' ||
    !Array.isArray(read.targets) ||
    !Array.isArray(read.protectedFiles) ||
    !Array.isArray(read.importedHistory)
  )
    return false;
  const saved = read.targets as Boundary,
    protectedFiles = read.protectedFiles as Boundary;
  if (
    !same(ids(saved.map((x) => x.episodeId)), ids(input.targetEpisodeIds)) ||
    saved.some(
      (x) =>
        x.fileId <= 0 ||
        x.size !== source.size ||
        !(read.importedHistory as unknown[]).some((v) => {
          const h = object(v);
          return (
            h.downloadId === input.downloadId &&
            h.episodeId === x.episodeId &&
            h.fileId === x.fileId &&
            typeof h.date === 'string' &&
            Date.parse(h.date) >= Math.floor(Date.parse(intent.at) / 1000) * 1000
          );
        }),
    )
  )
    return false;
  try {
    const [episodes, files, history] = await Promise.all([
      input.arr.read.sonarr.listEpisodes(input.seriesId),
      input.arr.read.sonarr.listEpisodeFileReleases(input.seriesId),
      input.arr.read.sonarr.getSeriesReleaseHistory(input.seriesId),
    ]);
    return (
      hash(boundary(episodes, files, input.targetEpisodeIds)) === hash(saved) &&
      same(
        ids(
          episodes.filter((e) => saved.some((s) => s.fileId === e.episodeFileId)).map((e) => e.id),
        ),
        ids(input.targetEpisodeIds),
      ) &&
      hash(
        boundary(
          episodes,
          files,
          protectedFiles.map((x) => x.episodeId),
        ),
      ) === hash(protectedFiles) &&
      saved.every((x) =>
        history.some(
          (h) =>
            h.eventType === 'downloadFolderImported' &&
            h.downloadId === input.downloadId &&
            h.episodeId === x.episodeId &&
            h.fileId === x.fileId &&
            h.date &&
            Date.parse(h.date) >= Math.floor(Date.parse(intent.at) / 1000) * 1000,
        ),
      )
    );
  } catch {
    return false;
  }
}

export type OwnedImportParent = { kind: 'fix' | 'release_pick'; id: string };
/** Constructed internally or from authenticated server context; never parsed from a public request. */
export type OwnedImportActor =
  { kind: 'staff' } | { kind: 'user'; userId: string; isAdmin: boolean };
export interface OwnedSonarrImportInput {
  db?: DbClient;
  arr: ArrClientBundle;
  parent: OwnedImportParent;
  downloadId: string;
  actor: OwnedImportActor;
}
/** An existing request blocks another write but does not grant a continuation handle. */
export interface OwnedSonarrImportDiscoveryStatus {
  state: 'waiting' | 'staff';
  downloadId: string | null;
}
type Episode = Awaited<ReturnType<ArrClientBundle['read']['sonarr']['listEpisodes']>>[number];
type EpisodeFile = Awaited<
  ReturnType<ArrClientBundle['read']['sonarr']['listEpisodeFileReleases']>
>[number];
type Boundary = Array<{
  episodeId: number;
  fileId: number;
  name: string | null;
  size: number | null;
}>;
type ParentState = {
  status: string;
  mediaItemId: string;
  createdAt: Date;
  requesterId: string | null;
  actions: FixActionEntry[];
  allowed: number[];
  intents: Array<{ title: string; ids: number[] }>;
  seriesId: number;
  fingerprint: string;
  partSelection?: WrongContentPartSelection | null;
};
function refuse(message: string): never {
  throw new FixRefusedError('needs_guide', message);
}
function canonical(x: unknown): unknown {
  if (Array.isArray(x)) return x.map(canonical);
  if (x !== null && typeof x === 'object')
    return Object.fromEntries(
      Object.entries(x)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, canonical(v)]),
    );
  return x;
}
const hash = (x: unknown) =>
  createHash('sha256')
    .update(JSON.stringify(canonical(x)) ?? 'undefined')
    .digest('hex')
    .slice(0, 24);
const ids = (x: unknown): number[] =>
  Array.isArray(x) && x.every((n) => Number.isInteger(n) && n > 0)
    ? [...new Set(x as number[])].sort((a, b) => a - b)
    : [];
const same = (a: readonly number[], b: readonly number[]) =>
  a.length === b.length && a.every((n) => b.includes(n));
const object = (x: unknown): Record<string, unknown> =>
  x !== null && typeof x === 'object' && !Array.isArray(x) ? (x as Record<string, unknown>) : {};
const titleOf = (a: Record<string, unknown>): string | null =>
  typeof (a.release ?? a.title) === 'string' ? String(a.release ?? a.title) : null;

function assertOwner(actor: OwnedImportActor, requesterId: string | null) {
  if (
    actor.kind === 'staff' ? requesterId !== null : !actor.isAdmin && requesterId !== actor.userId
  ) {
    refuse('This download belongs to another request owner.');
  }
}

async function loadParent(input: OwnedSonarrImportInput, lock = false): Promise<ParentState> {
  const db = resolveDb(input.db);
  let out: Omit<ParentState, 'seriesId' | 'fingerprint'>;
  let carrySeriesId: number | null = null;
  let carryFingerprint: unknown = null;
  if (input.parent.kind === 'fix') {
    const query = db.select().from(fixRequests).where(eq(fixRequests.id, input.parent.id));
    const [p] = await (lock ? query.for('update') : query);
    if (
      !p ||
      p.reason !== 'wrong_content' ||
      p.pathTaken !== 'delete_search' ||
      p.targetScope !== 'episode' ||
      (!['actioned', 'search_triggered'].includes(p.status) &&
        !(
          p.status === 'completed' &&
          p.actionsTaken.some(
            (a) => a.step === 'owned_import_intent' && a.downloadId === input.downloadId,
          )
        ))
    )
      refuse('The owning Fix is not open for this import.');
    assertOwner(input.actor, p.requesterId);
    const carries = await db
      .select()
      .from(watchCarries)
      .where(
        and(eq(watchCarries.mediaItemId, p.mediaItemId), eq(watchCarries.kind, 'wrong_content')),
      );
    const linked = carries.filter((c) => c.detail.fixRequestId === p.id);
    const carry = linked.length === 1 ? linked[0]! : null;
    const deletion = object(carry?.detail.wrongContentDeletion);
    if (
      !carry ||
      carry.status !== 'verified' ||
      deletion.grabStarted !== true ||
      deletion.version !== 1 ||
      (Array.isArray(carry.scope.pendingDeletes) && carry.scope.pendingDeletes.length > 0)
    ) {
      refuse('The owning Fix needs its verified Watch Carry and recorded grab intent.');
    }
    carrySeriesId = carry.seriesId;
    const partSelection = readWrongContentPartSelection(carry.detail);
    if (partSelection) assertWrongContentPartInterlock(partSelection, p.actionsTaken);
    carryFingerprint = {
      partSelection,
      id: carry.id,
      status: carry.status,
      seriesId: carry.seriesId,
      deletion,
      scope: carry.scope,
    };
    const allowed = ids(
      (Array.isArray(deletion.files) ? deletion.files : []).flatMap((f) =>
        ids(object(f).episodeIds),
      ),
    );
    if (!allowed.includes(p.targetArrChildId ?? -1))
      refuse('The owning Fix does not identify this slot.');
    const explicit = p.actionsTaken.filter(
      (a) => a.step === 'grab_intent' && titleOf(a) && ids(a.episodeIds).length,
    );
    // Pre-helper v0.125.0 requests have one approved release covering the entire stored deletion slot.
    // Multiple legacy releases cannot be inferred from a list of titles: refuse them.
    const legacy = Array.isArray(carry.detail.releases) ? carry.detail.releases : [];
    const intents = explicit.length
      ? explicit.map((a) => ({ title: titleOf(a)!, ids: ids(a.episodeIds) }))
      : legacy.length === 1 && typeof legacy[0] === 'string'
        ? [{ title: legacy[0], ids: allowed }]
        : [];
    if (
      !explicit.length &&
      !p.actionsTaken.some(
        (a) =>
          a.step === 'release_grab' && a.ok === true && intents.some((i) => i.title === a.release),
      )
    )
      refuse('The owning Fix has no successful or reconcilable grab.');
    out = {
      status: p.status,
      mediaItemId: p.mediaItemId,
      createdAt: p.createdAt,
      requesterId: p.requesterId,
      actions: p.actionsTaken,
      allowed,
      intents,
      partSelection,
    };
  } else {
    const query = db.select().from(repairRequests).where(eq(repairRequests.id, input.parent.id));
    const [p] = await (lock ? query.for('update') : query);
    if (
      !p ||
      p.kind !== 'release_pick' ||
      p.scope !== 'episode' ||
      (!(OPEN_REPAIR_STATUSES as readonly string[]).includes(p.status) &&
        !(
          p.status === 'completed' &&
          p.actionsTaken.some(
            (a) => a.step === 'owned_import_intent' && a.downloadId === input.downloadId,
          )
        ))
    )
      refuse('The owning Release Pick is not open.');
    assertOwner(input.actor, p.requesterId);
    const allowed = ids(p.targetChildIds);
    const title = typeof p.preview.title === 'string' ? p.preview.title : null;
    if (!title || !allowed.length) refuse('The owning Release Pick has no exact grab intent.');
    if (
      !p.actionsTaken.some(
        (a) =>
          titleOf(a) === title &&
          (a.step === 'grab_intent' ||
            (a.step === 'grab' && (a.ok === true || a.uncertain === true))),
      )
    ) {
      refuse('The owning Release Pick has no successful or reconcilable grab.');
    }
    out = {
      status: p.status,
      mediaItemId: p.mediaItemId,
      createdAt: p.createdAt,
      requesterId: p.requesterId,
      actions: p.actionsTaken,
      allowed,
      intents: [{ title, ids: allowed }],
    };
  }
  if (
    !out.allowed.length ||
    !out.intents.length ||
    out.intents.some((i) => !i.ids.length || i.ids.some((n) => !out.allowed.includes(n)))
  ) {
    refuse('The stored grab intent is incomplete.');
  }
  const [item] = await db.select().from(mediaItems).where(eq(mediaItems.id, out.mediaItemId));
  if (!item || item.arrKind !== 'sonarr' || item.deletedFromArrAt)
    refuse('The owning title is no longer on Sonarr.');
  if (carrySeriesId !== null && carrySeriesId !== item.arrItemId)
    refuse('The stored carry belongs to another Sonarr series.');
  const fingerprint = hash({
    status: out.status,
    mediaItemId: out.mediaItemId,
    requesterId: out.requesterId,
    createdAt: out.createdAt.toISOString(),
    allowed: out.allowed,
    intents: out.intents,
    item: { id: item.id, arrItemId: item.arrItemId, tvdbId: item.tvdbId },
    carry: carryFingerprint,
  });
  return { ...out, seriesId: item.arrItemId, fingerprint };
}

function boundary(episodes: Episode[], files: EpisodeFile[], affected: number[]): Boundary {
  return [...affected]
    .sort((a, b) => a - b)
    .map((episodeId) => {
      const e = episodes.find((x) => x.id === episodeId);
      if (!e) refuse('An affected episode disappeared.');
      const fileId = e.episodeFileId ?? 0;
      const f = files.find((x) => x.id === fileId);
      if (fileId > 0 && (!f || !f.relativePath || !f.size))
        refuse('An affected library file cannot be verified.');
      return { episodeId, fileId, name: f?.relativePath ?? null, size: f?.size ?? null };
    });
}

async function assertNoOtherParent(
  input: OwnedSonarrImportInput,
  p: ParentState,
  targetIds: number[],
  seasons: number[],
) {
  const db = resolveDb(input.db);
  const fixes = await db
    .select()
    .from(fixRequests)
    .where(
      and(
        eq(fixRequests.mediaItemId, p.mediaItemId),
        inArray(fixRequests.status, [...OPEN_FIX_STATUSES]),
      ),
    );
  if (
    fixes.some(
      (f) =>
        !(input.parent.kind === 'fix' && f.id === input.parent.id) &&
        (targetIds.includes(f.targetArrChildId ?? -1) ||
          f.targetScope === 'item' ||
          (f.targetScope === 'season' && seasons.includes(f.targetSeason ?? -1))),
    )
  )
    refuse('Another Fix owns these episodes.');
  const repairs = await db
    .select()
    .from(repairRequests)
    .where(
      and(
        eq(repairRequests.mediaItemId, p.mediaItemId),
        inArray(repairRequests.status, [...OPEN_REPAIR_STATUSES]),
      ),
    );
  if (
    repairs.some(
      (r) =>
        !(input.parent.kind === 'release_pick' && r.id === input.parent.id) &&
        (r.scope !== 'episode'
          ? seasons.includes(r.seasonNumber ?? -1)
          : r.targetChildIds.some((n) => targetIds.includes(n))),
    )
  ) {
    refuse('Another repair owns these episodes.');
  }
}

export interface OwnedSonarrImportPlan {
  parent: OwnedImportParent;
  downloadId: string;
  mediaItemId: string;
  seriesId: number;
  targetEpisodeIds: number[];
  title: string;
  state: 'import' | 'reevaluate' | 'observe' | 'waiting';
  check: SonarrImportCheck | null;
  source: { path: string; size: number } | null;
  protectedFiles: Boundary;
  digest: string;
}
interface InternalPlan extends OwnedSonarrImportPlan {
  owner: ParentState;
  candidate: SonarrManualImportCandidate | null;
  intent: FixActionEntry | null;
  targetSeasons: number[];
}

async function buildPlan(input: OwnedSonarrImportInput): Promise<InternalPlan> {
  const p = await loadParent(input);
  const [history, episodes, files, queue, series] = await Promise.all([
    input.arr.read.sonarr.getSeriesReleaseHistory(p.seriesId),
    input.arr.read.sonarr.listEpisodes(p.seriesId),
    input.arr.read.sonarr.listEpisodeFileReleases(p.seriesId),
    input.arr.read.sonarr.getQueue(p.seriesId),
    input.arr.read.sonarr.getSeriesById(p.seriesId),
  ]);
  const grabbed = history.filter(
    (h) =>
      h.eventType === 'grabbed' &&
      h.downloadId === input.downloadId &&
      h.date &&
      Date.parse(h.date) >= Math.floor(p.createdAt.getTime() / 1000) * 1000,
  );
  const titles = [...new Set(grabbed.map((h) => h.sourceTitle))];
  const matches = p.intents.filter((i) => titles.length === 1 && titles[0] === i.title);
  let chosen = matches.length === 1 ? matches[0]! : null;
  const targetIds = ids(grabbed.map((h) => h.episodeId));
  // Decision 39 retry titles need their actual call/GUID proof, not the original parent's creation timestamp.
  const retries = p.actions.filter(
    (a) =>
      a.step === 'wrong_content_retry_grab_intent' && titles.length === 1 && a.title === titles[0],
  );
  if (retries.length) {
    if (!retries.some((a) => same(ids(a.episodeIds), targetIds)))
      refuse('The download is not the exact grab recorded by this parent.');
    let missingProof = false;
    const bound = retries.filter((retry) => {
      const call = p.actions.find(
        (a) =>
          a.step === 'wrong_content_retry_grab_call_result' &&
          a.attemptId === retry.attemptId &&
          a.title === retry.title &&
          same(ids(a.targetEpisodeIds), ids(retry.episodeIds)),
      );
      const start = Date.parse(String(call?.startedAt)),
        end = Date.parse(String(call?.finishedAt));
      if (!call || !Number.isFinite(start) || !Number.isFinite(end) || end < start) {
        missingProof = true;
        return false;
      }
      const bounded = history.filter(
        (h) =>
          h.eventType === 'grabbed' &&
          h.sourceTitle === retry.title &&
          h.downloadId &&
          h.date &&
          Date.parse(h.date) >= Math.floor(start / 1000) * 1000 &&
          Date.parse(h.date) <= end,
      );
      if (typeof call.downloadId !== 'string') {
        if (bounded.some((h) => h.downloadId === input.downloadId)) missingProof = true;
        return false;
      }
      const downloads = [...new Set(bounded.map((h) => h.downloadId))];
      return (
        downloads.length === 1 &&
        downloads[0] === input.downloadId &&
        call.downloadId === input.downloadId &&
        same(ids(bounded.map((h) => h.episodeId)), ids(retry.episodeIds))
      );
    });
    if (bound.length !== 1) {
      if (missingProof)
        refuse('The retry has no saved actual GRAB call proof; staff must observe it.');
      refuse('The download is not the exact retry GRAB recorded by this parent.');
    }
    chosen = { title: String(bound[0]!.title), ids: ids(bound[0]!.episodeIds) };
  }
  if (p.partSelection) {
    const page = await input.arr.read.sonarr.getHistory({
      page: 1,
      pageSize: 200,
      sortKey: 'date',
      sortDirection: 'descending',
    });
    const bindings = selectedPartBindings(
      p.partSelection,
      p.actions,
      page.records.filter((h) => h.seriesId === p.seriesId),
    );
    const owned = bindings.all.filter((b) => b.downloadId === input.downloadId);
    if (
      owned.length !== 1 ||
      bindings.latest.get(owned[0]!.part.id)?.downloadId !== input.downloadId
    )
      refuse('The download is not the exact grab recorded by this parent.');
    chosen = { title: String(owned[0]!.intent.title), ids: owned[0]!.part.episodeIds };
  }
  if (!chosen || !same(chosen.ids, targetIds))
    refuse('The download is not the exact grab recorded by this parent.');
  const targetSeasons = [
    ...new Set(episodes.filter((e) => targetIds.includes(e.id)).map((e) => e.seasonNumber)),
  ];
  await assertNoOtherParent(input, p, targetIds, targetSeasons);
  const recorded =
    p.actions.find((a) => a.step === 'owned_import_intent' && a.downloadId === input.downloadId) ??
    null;
  if (recorded) {
    const protectedFiles = recorded.protectedFiles as Boundary;
    if (!Array.isArray(protectedFiles) || !same(ids(recorded.targetEpisodeIds), targetIds))
      refuse('The stored import attempt cannot be verified.');
    return {
      parent: input.parent,
      downloadId: input.downloadId,
      mediaItemId: p.mediaItemId,
      seriesId: p.seriesId,
      targetEpisodeIds: targetIds,
      title: chosen.title,
      state: 'observe',
      check: null,
      source: recorded.source as { path: string; size: number },
      protectedFiles,
      digest: hash({ parent: input.parent, intent: recorded }),
      owner: p,
      candidate: null,
      intent: recorded,
      targetSeasons,
    };
  }
  if (
    targetIds.some(
      (n) =>
        !episodes.find((e) => e.id === n) ||
        (episodes.find((e) => e.id === n)?.episodeFileId ?? 0) > 0 ||
        episodes.find((e) => e.id === n)?.hasFile === true,
    )
  ) {
    refuse('An intended episode already has a file; this import would replace it.');
  }
  const records = queue.filter((r) => r.downloadId === input.downloadId);
  if (
    !records.length ||
    records.some((r) => r.title !== chosen.title || r.seriesId !== p.seriesId)
  ) {
    refuse('The owned download is missing or changed its recorded release identity.');
  }
  if (records.some((r) => r.status !== 'completed')) {
    if (
      records.some(
        (r) =>
          r.status === 'failed' ||
          ['failed', 'failedPending'].includes(r.trackedDownloadState ?? ''),
      )
    ) {
      refuse('The owned download failed; its parent must be reconciled.');
    }
    return {
      parent: input.parent,
      downloadId: input.downloadId,
      mediaItemId: p.mediaItemId,
      seriesId: p.seriesId,
      targetEpisodeIds: targetIds,
      title: chosen.title,
      state: 'waiting',
      check: null,
      source: null,
      protectedFiles: boundary(
        episodes,
        files,
        ids(records.map((r) => r.episodeId)).filter((n) => !targetIds.includes(n)),
      ),
      digest: hash({
        parent: p.fingerprint,
        targetIds,
        downloadId: input.downloadId,
        state: 'waiting',
      }),
      owner: p,
      candidate: null,
      intent: null,
      targetSeasons,
    };
  }
  const candidates = await input.arr.read.sonarr.getManualImport(input.downloadId);
  if (candidates.length !== 1)
    refuse('A whole-file import needs one unambiguous owned video file.');
  const c = candidates[0]!;
  if (
    !c.path ||
    !c.path.startsWith('/') ||
    c.path === series.path ||
    c.path.startsWith(`${series.path.replace(/\/$/, '')}/`) ||
    !c.size ||
    c.size <= 0 ||
    c.downloadId !== input.downloadId ||
    c.episodeFileId ||
    c.series?.id !== p.seriesId ||
    !c.quality ||
    !c.languages?.length
  )
    refuse('The completed file identity cannot be verified.');
  const check = checkSonarrImport({
    downloadId: input.downloadId,
    seriesId: p.seriesId,
    seriesYear: series.year ?? null,
    targetEpisodeIds: targetIds,
    recordEpisodeIds: targetIds,
    mode: 'download',
    releaseTitle: chosen.title,
    queueMessages: queueTexts(records),
    candidates,
    episodes,
  });
  // Only a comparison against the raw mapping's existing files may need Sonarr's real target re-evaluation.
  // Every other hard refusal remains a refusal, and names must positively agree even before re-evaluation.
  if (
    check.title?.verdict !== 'agrees' ||
    check.title.conflictingYear !== null ||
    (check.verdict !== 'importable' && check.reason !== 'have_better')
  )
    refuse(`The owned file fails Import Check: ${check.reason}.`);
  if (
    check.verdict === 'importable' &&
    !same(ids(check.files.flatMap((f) => f.episodeIds)), targetIds)
  ) {
    refuse('The whole file would cover episodes outside the parent intent.');
  }
  const affected = ids([
    ...records.map((r) => r.episodeId),
    ...(c.episodes ?? []).map((e) => e.id),
  ]).filter((n) => !targetIds.includes(n));
  const protectedFiles = boundary(episodes, files, affected);
  const digest = hash({
    parent: input.parent,
    targets: targetIds,
    grabs: grabbed,
    parentFingerprint: p.fingerprint,
    candidate: c,
    protectedFiles,
    targetsBefore: boundary(episodes, files, targetIds),
  });
  return {
    parent: input.parent,
    downloadId: input.downloadId,
    mediaItemId: p.mediaItemId,
    seriesId: p.seriesId,
    targetEpisodeIds: targetIds,
    title: chosen.title,
    state: check.verdict === 'importable' ? 'import' : 'reevaluate',
    check,
    source: { path: c.path, size: c.size },
    protectedFiles,
    digest,
    owner: p,
    candidate: c,
    intent: null,
    targetSeasons,
  };
}

const publicPlan = ({
  owner: _owner,
  candidate: _candidate,
  intent: _intent,
  targetSeasons: _targetSeasons,
  ...plan
}: InternalPlan): OwnedSonarrImportPlan => plan;
export async function planOwnedSonarrImport(
  input: OwnedSonarrImportInput,
): Promise<OwnedSonarrImportPlan> {
  return publicPlan(await buildPlan(input));
}

async function append(
  input: OwnedSonarrImportInput,
  actions: FixActionEntry[],
  allowCompleted = false,
) {
  if (input.parent.kind === 'fix')
    await appendFixActions({
      db: input.db,
      fixRequestId: input.parent.id,
      actions,
      allowCompleted,
    });
  else
    await appendRepairActions({
      db: input.db,
      repairRequestId: input.parent.id,
      actions,
      allowCompleted,
    });
}

/** Called only after the exact owned import and protected files have been verified. */
async function forgetVerifiedOwnedQueue(input: OwnedSonarrImportInput, plan: InternalPlan) {
  const queue = await input.arr.read.sonarr.getQueue(plan.seriesId);
  const records = queue.filter((r) => r.downloadId === input.downloadId);
  const allowed = [...plan.targetEpisodeIds, ...plan.protectedFiles.map((f) => f.episodeId)];
  if (
    records.some(
      (r) =>
        r.status !== 'completed' ||
        r.title !== plan.title ||
        r.seriesId !== plan.seriesId ||
        r.episodeId == null ||
        !allowed.includes(r.episodeId),
    )
  )
    refuse('The owned queue identity changed after import.');
  if (records.length && same(ids(records.map((r) => r.episodeId)), plan.targetEpisodeIds))
    return false;
  if (records.length) {
    const opts = { removeFromClient: false, blocklist: false, skipRedownload: true };
    const claimed = await inTransaction(input.db, async (tx) => {
      const owner = await loadParent({ ...input, db: tx }, true);
      if (
        owner.actions.some(
          (a) => a.step === 'owned_queue_forget_intent' && a.downloadId === input.downloadId,
        )
      )
        return false;
      await append(
        { ...input, db: tx },
        [
          {
            step: 'owned_queue_forget_intent',
            at: new Date().toISOString(),
            parent: input.parent,
            downloadId: input.downloadId,
            queueItemId: records[0]!.id,
            targetEpisodeIds: plan.targetEpisodeIds,
            endpoint: `DELETE /api/v3/queue/${records[0]!.id}`,
            options: opts,
          },
        ],
        true,
      );
      return true;
    });
    if (claimed)
      try {
        await input.arr.write.sonarr.deleteQueueItem(records[0]!.id, opts);
        await append(
          input,
          [
            {
              step: 'owned_queue_forget_result',
              at: new Date().toISOString(),
              downloadId: input.downloadId,
              ok: true,
            },
          ],
          true,
        );
      } catch (error) {
        const afterError = await input.arr.read.sonarr.getQueue(plan.seriesId).catch(() => null);
        if (afterError !== null && !afterError.some((r) => r.downloadId === input.downloadId)) {
          await append(
            input,
            [
              {
                step: 'owned_queue_forget_result',
                at: new Date().toISOString(),
                downloadId: input.downloadId,
                ok: true,
                adoptedAbsent: true,
              },
            ],
            true,
          );
        } else {
          await append(
            input,
            [
              {
                step: 'owned_queue_forget_result',
                at: new Date().toISOString(),
                downloadId: input.downloadId,
                ok: false,
                error: error instanceof Error ? error.message : 'Queue forget failed',
              },
            ],
            true,
          );
          throw error;
        }
      }
  }
  const after = await input.arr.read.sonarr.getQueue(plan.seriesId);
  const absent = !after.some((r) => r.downloadId === input.downloadId);
  await append(
    input,
    [
      {
        step: 'owned_queue_forget_read_back',
        at: new Date().toISOString(),
        downloadId: input.downloadId,
        ok: absent,
        absent,
      },
    ],
    true,
  );
  return absent;
}

async function observe(input: OwnedSonarrImportInput, plan: InternalPlan) {
  const [episodes, files, history] = await Promise.all([
    input.arr.read.sonarr.listEpisodes(plan.seriesId),
    input.arr.read.sonarr.listEpisodeFileReleases(plan.seriesId),
    input.arr.read.sonarr.getSeriesReleaseHistory(plan.seriesId),
  ]);
  const protectedFiles = boundary(
    episodes,
    files,
    plan.protectedFiles.map((x) => x.episodeId),
  );
  const unchanged = hash(protectedFiles) === hash(plan.protectedFiles);
  const targets = boundary(episodes, files, plan.targetEpisodeIds);
  const imported = history.filter(
    (h) =>
      h.downloadId === input.downloadId &&
      h.eventType === 'downloadFolderImported' &&
      h.date &&
      Date.parse(h.date) >= Math.floor(Date.parse(plan.intent!.at) / 1000) * 1000,
  );
  const exactFiles =
    plan.targetEpisodeIds.every((n) => {
      const target = targets.find((t) => t.episodeId === n)!;
      return (
        target.fileId > 0 &&
        target.size === plan.source!.size &&
        imported.some((h) => h.episodeId === n && h.fileId === target.fileId)
      );
    }) &&
    same(
      ids(
        episodes
          .filter((e) => targets.some((t) => t.fileId > 0 && t.fileId === e.episodeFileId))
          .map((e) => e.id),
      ),
      plan.targetEpisodeIds,
    );
  const verified = unchanged && exactFiles;
  const evidence = {
    step: 'owned_import_read_back',
    at: new Date().toISOString(),
    downloadId: input.downloadId,
    ok: verified,
    protectedUnchanged: unchanged,
    targets,
    protectedFiles,
    importedHistoryIds: imported.map((h) => h.id),
    importedHistory: imported.map((h) => ({
      id: h.id,
      downloadId: h.downloadId,
      episodeId: h.episodeId,
      fileId: h.fileId,
      sourceTitle: h.sourceTitle,
      date: h.date,
    })),
  };
  if (plan.owner.status === 'completed' && !verified)
    refuse('The completed parent no longer matches the recorded physical import.');
  await append(input, [evidence], verified);
  if (!unchanged)
    refuse('An unselected library file changed; staff must inspect the stored import trail.');
  const queueForgot = verified ? await forgetVerifiedOwnedQueue(input, plan) : false;
  return {
    outcome: verified ? ('imported' as const) : ('importing' as const),
    parent: input.parent,
    downloadId: input.downloadId,
    verified,
    targets,
    protectedUnchanged: unchanged,
    queueForgot,
  };
}

/** Staff records physical probes; a public caller records authenticated confirmation of the shown plan. */
export async function runOwnedSonarrImport(
  input: OwnedSonarrImportInput & { digest: string; evidence: string },
) {
  if (input.evidence.trim().length < 10) refuse('Open Force Search again to review it.');
  if (!(await getRepairGuideRemedies(input.db)).import_check) refuse('Import Check is turned off.');
  let plan = await buildPlan(input);
  if (plan.state === 'observe') return observe(input, plan);
  if (plan.state === 'waiting')
    return {
      outcome: 'importing' as const,
      parent: input.parent,
      downloadId: input.downloadId,
      waiting: true,
      verified: false,
      targets: [],
      protectedUnchanged: true,
    };
  if (plan.digest !== input.digest)
    throw new FixPlanChangedError('The owned import file or boundary changed.');
  const c = plan.candidate!;
  const file: SonarrManualImportFile = {
    path: c.path,
    seriesId: plan.seriesId,
    episodeIds: plan.targetEpisodeIds,
    quality: c.quality!,
    languages: c.languages!,
    indexerFlags: c.indexerFlags ?? 0,
    downloadId: input.downloadId,
    ...(c.releaseGroup ? { releaseGroup: c.releaseGroup } : {}),
    ...(c.releaseType ? { releaseType: c.releaseType } : {}),
    ...(c.folderName ? { folderName: c.folderName } : {}),
  };
  try {
    await append(input, [
      {
        step: 'owned_import_evaluation_intent',
        at: new Date().toISOString(),
        endpoint: 'POST /api/v3/manualimport',
        downloadId: input.downloadId,
        episodeIds: plan.targetEpisodeIds,
      },
    ]);
    const evaluated = await input.arr.write.sonarr.reprocessManualImport([file]);
    if (
      evaluated.length !== 1 ||
      evaluated[0]!.path !== c.path ||
      evaluated[0]!.downloadId !== input.downloadId ||
      !same(ids((evaluated[0]!.episodes ?? []).map((e) => e.id)), plan.targetEpisodeIds) ||
      hash(evaluated[0]!.quality) !== hash(c.quality) ||
      hash(evaluated[0]!.languages) !== hash(c.languages)
    ) {
      refuse('Sonarr re-evaluation changed the owned file or intended coverage.');
    }
    const [episodes, files, series, sourceNow] = await Promise.all([
      input.arr.read.sonarr.listEpisodes(plan.seriesId),
      input.arr.read.sonarr.listEpisodeFileReleases(plan.seriesId),
      input.arr.read.sonarr.getSeriesById(plan.seriesId),
      input.arr.read.sonarr.getManualImport(input.downloadId),
    ]);
    if (sourceNow.length !== 1 || hash(sourceNow[0]) !== hash(c)) {
      throw new FixPlanChangedError('The completed source file changed during validation.');
    }
    const candidate = { ...c, ...evaluated[0]!, series: c.series, size: c.size };
    const check = checkSonarrImport({
      downloadId: input.downloadId,
      seriesId: plan.seriesId,
      seriesYear: series.year ?? null,
      targetEpisodeIds: plan.targetEpisodeIds,
      recordEpisodeIds: plan.targetEpisodeIds,
      mode: 'download',
      releaseTitle: plan.title,
      queueMessages: [],
      candidates: [candidate],
      episodes,
    });
    await append(input, [
      {
        step: 'owned_import_evaluation',
        at: new Date().toISOString(),
        downloadId: input.downloadId,
        ok: check.verdict === 'importable',
        check,
      },
    ]);
    if (
      check.verdict !== 'importable' ||
      !same(ids(check.files.flatMap((f) => f.episodeIds)), plan.targetEpisodeIds)
    ) {
      refuse(`Sonarr's selected-target Import Check refuses this file: ${check.reason}.`);
    }
    if (
      plan.targetEpisodeIds.some(
        (n) => (episodes.find((e) => e.id === n)?.episodeFileId ?? -1) !== 0,
      ) ||
      hash(
        boundary(
          episodes,
          files,
          plan.protectedFiles.map((x) => x.episodeId),
        ),
      ) !== hash(plan.protectedFiles)
    ) {
      throw new FixPlanChangedError(
        'The intended or unselected library files changed during validation.',
      );
    }
    // Every Sonarr read happens before the short DB-only claim transaction.
    const sampled = await buildPlan(input);
    if (sampled.state === 'observe') return observe(input, sampled);
    if (sampled.digest !== input.digest)
      throw new FixPlanChangedError('The owned file changed after target validation.');
    // Claim the actual library command only after transient validation passes. The row lock prevents replay.
    plan = await inTransaction(input.db, async (tx) => {
      const owner = await loadParent({ ...input, db: tx }, true);
      const existing = owner.actions.find(
        (a) => a.step === 'owned_import_intent' && a.downloadId === input.downloadId,
      );
      if (existing) {
        if (
          !same(ids(existing.targetEpisodeIds), sampled.targetEpisodeIds) ||
          !Array.isArray(existing.protectedFiles)
        ) {
          refuse('The stored import attempt cannot be verified.');
        }
        return {
          ...sampled,
          owner,
          state: 'observe' as const,
          intent: existing,
          source: existing.source as OwnedSonarrImportPlan['source'],
          protectedFiles: existing.protectedFiles as Boundary,
        };
      }
      if (owner.fingerprint !== sampled.owner.fingerprint)
        throw new FixPlanChangedError('The owning parent changed before import.');
      await assertNoOtherParent(
        { ...input, db: tx },
        owner,
        sampled.targetEpisodeIds,
        sampled.targetSeasons,
      );
      const live = { ...sampled, owner };
      const intent: FixActionEntry = {
        step: 'owned_import_intent',
        parent: input.parent,
        at: new Date().toISOString(),
        operationId: randomUUID(),
        downloadId: input.downloadId,
        targetEpisodeIds: live.targetEpisodeIds,
        title: live.title,
        source: live.source,
        protectedFiles: live.protectedFiles,
        digest: live.digest,
        evidence: input.evidence,
      };
      await append({ ...input, db: tx }, [
        intent,
        {
          step: 'owned_manual_import_intent',
          at: new Date().toISOString(),
          downloadId: input.downloadId,
          endpoint: 'POST /api/v3/command',
          files: check.files,
        },
      ]);
      return { ...live, intent };
    });
    if (plan.state === 'observe') return observe(input, plan);
    const command = await input.arr.write.sonarr.manualImport(check.files, 'auto');
    const action = {
      step: 'owned_manual_import_result',
      at: new Date().toISOString(),
      downloadId: input.downloadId,
      ok: true,
      commandId: command.id,
      commandName: command.name,
    };
    if (input.parent.kind === 'fix' && plan.owner.status === 'actioned') {
      await recordFixAction({
        db: input.db,
        fixRequestId: input.parent.id,
        transition: 'search_triggered',
        actions: [action],
      });
    } else if (input.parent.kind === 'release_pick' && plan.owner.status === 'pending') {
      await recordRepairTransition({
        db: input.db,
        repairRequestId: input.parent.id,
        transition: 'actioned',
        actions: [action],
      });
    } else await append(input, [action], true);
    const status = await input.arr.read.sonarr.getCommand(command.id).catch(() => null);
    await append(
      input,
      [
        {
          step: 'owned_import_command_read_back',
          at: new Date().toISOString(),
          downloadId: input.downloadId,
          commandId: command.id,
          status: status?.status ?? 'unknown',
        },
      ],
      true,
    );
    return observe(input, plan);
  } catch (error) {
    await append(
      input,
      [
        {
          step: 'owned_import_stopped',
          at: new Date().toISOString(),
          downloadId: input.downloadId,
          ok: false,
          error: error instanceof Error ? error.message : 'Owned import failed',
          replayAllowed: false,
        },
      ],
      true,
    );
    throw error;
  }
}

/** Discover only a server-owned request and its exact grabbed download; a client never supplies a parent ID. */
export async function findOwnedSonarrImport(input: {
  db?: DbClient;
  arr: ArrClientBundle;
  mediaItemId: string;
  targetEpisodeId: number;
  actor: OwnedImportActor;
}): Promise<OwnedSonarrImportInput | OwnedSonarrImportDiscoveryStatus | null> {
  const db = resolveDb(input.db);
  const [item] = await db.select().from(mediaItems).where(eq(mediaItems.id, input.mediaItemId));
  if (!item || item.arrKind !== 'sonarr') return null;
  const parents: Array<{
    parent: OwnedImportParent;
    eligible: boolean;
    requesterId: string | null;
    createdAt: Date;
    titles: string[];
  }> = [];
  const fs = await db
    .select()
    .from(fixRequests)
    .where(
      and(
        eq(fixRequests.mediaItemId, item.id),
        inArray(fixRequests.status, [...OPEN_FIX_STATUSES]),
      ),
    );
  const rs = await db
    .select()
    .from(repairRequests)
    .where(
      and(
        eq(repairRequests.mediaItemId, item.id),
        inArray(repairRequests.status, [...OPEN_REPAIR_STATUSES]),
      ),
    );
  if (!fs.length && !rs.length) return null;
  const [episodes, carries] = await Promise.all([
    input.arr.read.sonarr.listEpisodes(item.arrItemId),
    db
      .select()
      .from(watchCarries)
      .where(and(eq(watchCarries.mediaItemId, item.id), eq(watchCarries.kind, 'wrong_content'))),
  ]);
  const target = episodes.find((e) => e.id === input.targetEpisodeId);
  if (!target) refuse('The intended episode disappeared.');
  for (const f of fs) {
    const linked = carries.find((c) => c.detail.fixRequestId === f.id);
    const deletion = object(linked?.detail.wrongContentDeletion);
    const slot = ids(
      (Array.isArray(deletion.files) ? deletion.files : []).flatMap((v) =>
        ids(object(v).episodeIds),
      ),
    );
    const matches =
      f.targetArrChildId === target.id ||
      slot.includes(target.id) ||
      f.targetScope === 'item' ||
      (f.targetScope === 'season' && f.targetSeason === target.seasonNumber);
    if (!matches) continue;
    parents.push({
      parent: { kind: 'fix', id: f.id },
      eligible:
        f.reason === 'wrong_content' &&
        f.pathTaken === 'delete_search' &&
        f.targetScope === 'episode' &&
        f.actionsTaken.some((a) => a.step === 'wrong_content_replace'),
      requesterId: f.requesterId,
      createdAt: f.createdAt,
      titles: f.actionsTaken
        .filter(
          (a) =>
            a.step === 'grab_intent' ||
            ((a.step === 'grab' || a.step === 'release_grab') &&
              (a.ok === true || a.uncertain === true)),
        )
        .map(titleOf)
        .filter((v): v is string => v !== null),
    });
  }
  for (const r of rs) {
    const matches =
      r.scope === 'episode'
        ? r.targetChildIds.includes(target.id)
        : r.seasonNumber === target.seasonNumber;
    if (!matches) continue;
    parents.push({
      parent: { kind: 'release_pick', id: r.id },
      eligible: r.kind === 'release_pick' && r.scope === 'episode',
      requesterId: r.requesterId,
      createdAt: r.createdAt,
      titles: r.actionsTaken
        .filter(
          (a) =>
            a.step === 'grab_intent' ||
            (a.step === 'grab' && (a.ok === true || a.uncertain === true)),
        )
        .map(titleOf)
        .filter((v): v is string => v !== null),
    });
  }
  if (!parents.length) return null;
  const [history, queue] = await Promise.all([
    input.arr.read.sonarr.getSeriesReleaseHistory(item.arrItemId),
    input.arr.read.sonarr.getQueue(item.arrItemId),
  ]);
  // Status is read-only: an ordinary/foreign/missing-anchor request must not become an unguarded new search.
  const relevantQueue = queue.filter(
    (r) =>
      (r.seriesId == null || r.seriesId === item.arrItemId) &&
      (r.episodeId === target.id ||
        parents.some(
          (p) =>
            (r.title != null &&
              p.titles.includes(r.title) &&
              (!r.added ||
                Date.parse(r.added) >= Math.floor(p.createdAt.getTime() / 1000) * 1000)) ||
            history.some(
              (h) =>
                h.eventType === 'grabbed' &&
                h.episodeId === target.id &&
                h.downloadId &&
                h.downloadId === r.downloadId &&
                h.date &&
                Date.parse(h.date) >= Math.floor(p.createdAt.getTime() / 1000) * 1000,
            ),
        )),
  );
  const status = (): OwnedSonarrImportDiscoveryStatus => {
    const waiting = relevantQueue.find((r) => {
      const state = (r.trackedDownloadState ?? '').toLowerCase();
      return (
        (r.status ?? '').toLowerCase() !== 'failed' &&
        (r.trackedDownloadStatus ?? '').toLowerCase() !== 'error' &&
        ![
          'failed',
          'failedpending',
          'downloadfailed',
          'importfailed',
          'importblocked',
          'importpending',
        ].includes(state)
      );
    });
    return {
      state: waiting ? 'waiting' : 'staff',
      downloadId: waiting?.downloadId ?? relevantQueue[0]?.downloadId ?? null,
    };
  };
  const owned = (p: (typeof parents)[number]) =>
    input.actor.kind === 'staff'
      ? p.requesterId === null
      : input.actor.isAdmin || p.requesterId === input.actor.userId;
  if (parents.length !== 1 || !parents[0]!.eligible || !owned(parents[0]!)) return status();
  const found: OwnedSonarrImportInput[] = [];
  for (const { parent } of parents) {
    const base = { db: input.db, arr: input.arr, actor: input.actor, parent, downloadId: '' };
    let p: ParentState;
    try {
      p = await loadParent(base);
    } catch (error) {
      if (error instanceof FixRefusedError) return status();
      throw error;
    }
    const downloads = [
      ...new Set(
        history
          .filter(
            (h) =>
              h.eventType === 'grabbed' &&
              h.episodeId === input.targetEpisodeId &&
              h.date &&
              Date.parse(h.date) >= Math.floor(p.createdAt.getTime() / 1000) * 1000 &&
              p.intents.some(
                (i) => i.title === h.sourceTitle && i.ids.includes(input.targetEpisodeId),
              ),
          )
          .map((h) => h.downloadId),
      ),
    ];
    for (const downloadId of downloads) if (downloadId) found.push({ ...base, downloadId });
  }
  if (found.length !== 1) return status();
  return found[0]!;
}
