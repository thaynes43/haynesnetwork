// DESIGN-055 P4 decision 39: one staff retry on the original verified Wrong-Content Replace.
// The caller never supplies episode IDs. Claims precede external writes; uncertain claims are never replayed.
import { createHash, randomUUID } from 'node:crypto';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  fixRequests,
  ledgerEvents,
  mediaItems,
  repairRequests,
  watchCarries,
  type DbClient,
  type FixActionEntry,
} from '@hnet/db';
import type { ArrClientBundle } from './arr-clients';
import { inTransaction, resolveDb } from './db-client';
import { FixPlanChangedError, FixRefusedError } from './errors';
import { appendFixActions, OPEN_FIX_STATUSES } from './fix-requests';
import { classifyReleases, readReleasePickTarget, sendReleaseGrab } from './release-pick';
import { episodeTitleEvidence } from './title-evidence';
import { getRepairGuideRemedies } from './repair-guide-settings';

const object = (x: unknown): Record<string, unknown> =>
  x !== null && typeof x === 'object' && !Array.isArray(x) ? (x as Record<string, unknown>) : {};
const ids = (x: unknown): number[] =>
  Array.isArray(x) && x.length > 0 && x.every((n) => Number.isInteger(n) && n > 0)
    ? [...new Set(x as number[])].sort((a, b) => a - b)
    : [];
const titleOf = (a: FixActionEntry): string | null =>
  typeof (a.release ?? a.title) === 'string' ? String(a.release ?? a.title) : null;
const same = (a: readonly number[], b: readonly number[]) =>
  JSON.stringify([...a].sort((x, y) => x - y)) === JSON.stringify([...b].sort((x, y) => x - y));
function canonical(x: unknown): unknown {
  if (x instanceof Date) return x.toISOString();
  if (Array.isArray(x)) return x.map(canonical);
  if (x !== null && typeof x === 'object')
    return Object.fromEntries(
      Object.entries(x)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, canonical(v)]),
    );
  return x;
}
const hash = (x: unknown) =>
  createHash('sha256')
    .update(JSON.stringify(canonical(x)))
    .digest('hex');
// Only fixed local reasons are safe for staff output; external errors never enter this registry.
const safeRefusalReasons = new WeakMap<Error, string>();
export function wrongContentRetryRefusalText(error: unknown): string | null {
  return error instanceof Error ? (safeRefusalReasons.get(error) ?? null) : null;
}
function refuse(text: string): never {
  const error = new FixRefusedError('copy_refused', text);
  safeRefusalReasons.set(error, text);
  throw error;
}
function changed(text: string): never {
  const error = new FixPlanChangedError(text);
  safeRefusalReasons.set(error, text);
  throw error;
}
const safeError = (e: unknown) => {
  const x = object(e);
  return {
    name: /^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(String(x.name)) ? x.name : 'Error',
    code: /^[A-Z0-9_]{1,60}$/.test(String(x.code)) ? x.code : null,
  };
};

async function parent(db: DbClient | undefined, id: string, lock = false, interlock = false) {
  const exec = resolveDb(db),
    query = exec.select().from(fixRequests).where(eq(fixRequests.id, id));
  const [fix] = await (lock ? query.for('update') : query);
  if (
    !fix ||
    fix.requesterId !== null ||
    fix.reason !== 'wrong_content' ||
    fix.pathTaken !== 'delete_search' ||
    fix.targetScope !== 'episode' ||
    !(interlock ? ['actioned', 'search_triggered'] : ['search_triggered']).includes(fix.status) ||
    !fix.actionsTaken.some((a) => a.step === 'wrong_content_replace')
  )
    refuse('This is not an active staff Wrong-Content Replace.');
  const linked = (
    await exec
      .select()
      .from(watchCarries)
      .where(
        and(eq(watchCarries.mediaItemId, fix.mediaItemId), eq(watchCarries.kind, 'wrong_content')),
      )
  ).filter((c) => c.detail.fixRequestId === fix.id);
  const carry = linked.length === 1 ? linked[0]! : null,
    deletion = object(carry?.detail.wrongContentDeletion);
  const files = Array.isArray(deletion.files) ? deletion.files.map(object) : [];
  if (
    !carry ||
    carry.status !== 'verified' ||
    deletion.version !== 1 ||
    deletion.grabStarted !== true ||
    !files.length ||
    files.some(
      (f) =>
        !Number.isInteger(f.id) ||
        Number(f.id) <= 0 ||
        typeof f.name !== 'string' ||
        !f.name ||
        typeof f.size !== 'number' ||
        f.size <= 0 ||
        !ids(f.episodeIds).length ||
        ids(f.episodeIds).length !== (f.episodeIds as unknown[]).length,
    ) ||
    (Array.isArray(carry.scope.pendingDeletes) && carry.scope.pendingDeletes.length)
  )
    refuse('The original full-slot Watch Carry is not verified.');
  const slot = files.flatMap((f) => ids(f.episodeIds)).sort((a, b) => a - b);
  if (new Set(slot).size !== slot.length || !slot.includes(fix.targetArrChildId ?? -1))
    refuse('The stored original slot is invalid.');
  const [item] = await exec.select().from(mediaItems).where(eq(mediaItems.id, fix.mediaItemId));
  if (
    !item ||
    item.arrKind !== 'sonarr' ||
    item.arrItemId !== carry.seriesId ||
    item.deletedFromArrAt !== null
  )
    refuse('The original media identity changed.');
  const grab = [...fix.actionsTaken]
    .reverse()
    .find((a) => a.step === 'release_grab' && a.ok === true && typeof a.release === 'string');
  if (!grab) refuse('The parent has no successful recorded grab.');
  const grabIndex = fix.actionsTaken.indexOf(grab);
  const intent = fix.actionsTaken
    .slice(0, grabIndex)
    .reverse()
    .find(
      (a) =>
        a.step === 'grab_intent' &&
        titleOf(a) === grab.release &&
        (a.attemptId ?? null) === (grab.attemptId ?? null),
    );
  const legacy = Array.isArray(carry.detail.releases) ? carry.detail.releases : [];
  const intended = intent
    ? ids(intent.episodeIds)
    : legacy.length === 1 && legacy[0] === grab.release
      ? slot
      : [];
  if (!same(intended, slot))
    refuse('The latest successful grab does not identify the complete original slot.');
  if (
    !interlock &&
    fix.actionsTaken.some((a) =>
      ['owned_import_intent', 'owned_manual_import_intent'].includes(a.step),
    )
  )
    refuse('An import was already claimed; observe it instead of retrying.');
  const receiptUntil = Math.floor(Date.parse(grab.at) / 1000) * 1000 + 1999;
  let anchor = {
    title: String(grab.release),
    attemptId: typeof grab.attemptId === 'string' ? grab.attemptId : null,
    downloadId: null as string | null,
    start: intent?.at ?? fix.createdAt.toISOString(),
    end: receiptUntil,
    source: 'receipt' as 'receipt' | 'native_call',
    httpAccepted: true,
  };
  const actualCall = fix.actionsTaken
    .filter(
      (a) =>
        a.step === 'wrong_content_retry_grab_call_result' &&
        typeof a.downloadId === 'string' &&
        typeof a.title === 'string',
    )
    .map((call) => ({
      call,
      intentIndex: fix.actionsTaken.findIndex(
        (a) =>
          a.step === 'wrong_content_retry_grab_intent' &&
          a.attemptId === call.attemptId &&
          a.title === call.title &&
          same(ids(a.episodeIds), slot),
      ),
    }))
    .filter((bound) => bound.intentIndex >= 0)
    .sort((a, b) => b.intentIndex - a.intentIndex)[0]?.call;
  if (actualCall) {
    const ownIntent = fix.actionsTaken.find(
      (a) =>
        a.step === 'wrong_content_retry_grab_intent' &&
        a.attemptId === actualCall.attemptId &&
        a.title === actualCall.title &&
        same(ids(a.episodeIds), slot),
    );
    const start = Date.parse(String(actualCall.startedAt)),
      end = Date.parse(String(actualCall.finishedAt));
    const native = Array.isArray(actualCall.grabbedHistory)
      ? actualCall.grabbedHistory.map(object)
      : [];
    if (
      !ownIntent ||
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      end < start ||
      !same(ids(actualCall.targetEpisodeIds), slot) ||
      !same(ids(native.map((h) => h.episodeId)), slot) ||
      native.some(
        (h) =>
          h.downloadId !== actualCall.downloadId ||
          Date.parse(String(h.date)) < Math.floor(start / 1000) * 1000 ||
          Date.parse(String(h.date)) > end,
      )
    )
      refuse('The actual retry GRAB proof cannot be verified. Observe its recorded attempt.');
    anchor = {
      title: String(actualCall.title),
      attemptId: String(actualCall.attemptId),
      downloadId: String(actualCall.downloadId),
      start: String(actualCall.startedAt),
      end,
      source: 'native_call',
      httpAccepted: actualCall.accepted === true,
    };
  } else if (!interlock && typeof grab.attemptId === 'string')
    refuse('The retry has no saved actual GRAB identity. Observe its recorded attempt.');
  // A newer retry does not surrender the older owned failure to an automatic search.
  // Each completed receipt bounds its own intent; an uncertain intent needs actual GRAB proof below.
  const unresolvedIntents: Array<{ title: string; since: number; until: number | null }> = [];
  const ownershipBindings = fix.actionsTaken.flatMap((a, i) => {
    const title = titleOf(a);
    if (a.step !== 'grab_intent' || !title || !same(ids(a.episodeIds), slot)) return [];
    const next = fix.actionsTaken.slice(i + 1);
    const nextIntent = next.findIndex((b) => b.step === 'grab_intent');
    const receipt = (nextIntent < 0 ? next : next.slice(0, nextIntent)).find(
      (b) => b.step === 'release_grab' && b.ok === true && b.release === title,
    );
    const retry = fix.actionsTaken.find(
      (b) =>
        b.step === 'wrong_content_retry_grab_intent' &&
        b.attemptId === a.attemptId &&
        b.title === title,
    );
    const call = retry
      ? fix.actionsTaken.find(
          (b) =>
            b.step === 'wrong_content_retry_grab_call_result' &&
            b.attemptId === a.attemptId &&
            b.title === title,
        )
      : null;
    const since = Math.floor(Date.parse(String(call?.startedAt ?? a.at)) / 1000) * 1000;
    if (
      retry &&
      (!call ||
        !Number.isFinite(Date.parse(String(call.finishedAt))) ||
        Date.parse(String(call.finishedAt)) < since)
    ) {
      unresolvedIntents.push({ title, since, until: null });
      return [];
    }
    if (!call && !receipt) return [];
    const until = call
      ? Date.parse(String(call.finishedAt))
      : Math.floor(Date.parse(receipt!.at) / 1000) * 1000 + 1999;
    if (retry && typeof call?.downloadId !== 'string') {
      unresolvedIntents.push({ title, since, until });
      return [];
    }
    return [
      {
        title,
        since,
        until,
        downloadId: typeof call?.downloadId === 'string' ? call.downloadId : null,
      },
    ];
  });
  const legacyReceipt =
    legacy.length === 1 && typeof legacy[0] === 'string'
      ? fix.actionsTaken.find(
          (a) => a.step === 'release_grab' && a.ok === true && a.release === legacy[0],
        )
      : null;
  if (legacyReceipt && !ownershipBindings.some((b) => b.title === legacy[0]))
    ownershipBindings.push({
      title: String(legacy[0]),
      since: Math.floor(fix.createdAt.getTime() / 1000) * 1000,
      until: Math.floor(Date.parse(legacyReceipt.at) / 1000) * 1000 + 1999,
      downloadId: null,
    });
  return {
    ownershipBindings,
    unresolvedIntents,
    anchor,
    fix,
    carry,
    item,
    files,
    slot,
    fingerprint: hash({ fix, carry, item }),
  };
}

export const WRONG_CONTENT_RETRY_HOLD =
  'This failed download belongs to a verified replacement. Staff need to finish its recovery before automatic search resumes.';
export const WRONG_CONTENT_RETRY_UNRESOLVED_HOLD =
  'This failed download may belong to an unfinished replacement. Staff need to check its recorded command before automatic search resumes.';

/** Match actual stored GRAB download GUID and parent series, never reparsed failure episode numbers. */
export async function deferredWrongContentFailures(input: {
  db?: DbClient;
  failures: Array<{
    downloadId: string | null;
    parentId: number;
    title: string | null;
    failedAt: Date;
    grabbedHistory?: { id: number; downloadId: string; title: string; date: string };
  }>;
}): Promise<Map<string, string>> {
  const exec = resolveDb(input.db),
    downloads = [
      ...new Set(input.failures.map((f) => f.downloadId).filter((d): d is string => !!d)),
    ];
  const held = new Map<string, string>();
  if (!downloads.length) return held;
  const active = await exec
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
  for (const f of active) {
    let p: Awaited<ReturnType<typeof parent>>;
    try {
      p = await parent(input.db, f.id, false, true);
    } catch (e) {
      if (e instanceof FixRefusedError) continue;
      throw e;
    }
    for (const failure of input.failures) {
      if (!failure.downloadId || failure.parentId !== p.item.arrItemId) continue;
      const native = failure.grabbedHistory;
      const key = `${failure.downloadId}\u0000${failure.parentId}`;
      if (
        !held.has(key) &&
        p.unresolvedIntents.some((i) => {
          const at = native ? Date.parse(native.date) : 0;
          return (
            i.title === failure.title &&
            failure.failedAt.getTime() >= i.since &&
            (!native ||
              (Number.isInteger(native.id) &&
                native.id > 0 &&
                native.downloadId === failure.downloadId &&
                native.title === i.title &&
                at >= i.since &&
                at <= failure.failedAt.getTime() &&
                (i.until === null || at <= i.until)))
          );
        })
      )
        held.set(key, WRONG_CONTENT_RETRY_UNRESOLVED_HOLD);
    }
    const grabs = await exec
      .select()
      .from(ledgerEvents)
      .where(
        and(
          eq(ledgerEvents.mediaItemId, p.item.id),
          eq(ledgerEvents.source, 'sonarr'),
          eq(ledgerEvents.eventType, 'grabbed'),
          sql`${ledgerEvents.payload}->>'downloadId' IN (${sql.join(
            downloads.map((d) => sql`${d}`),
            sql`, `,
          )})`,
          sql`${ledgerEvents.payload}->>'sourceTitle' IN (${sql.join(
            p.ownershipBindings.map((b) => sql`${b.title}`),
            sql`, `,
          )})`,
        ),
      );
    for (const failure of input.failures) {
      if (!failure.downloadId || failure.parentId !== p.item.arrItemId) continue;
      const native = failure.grabbedHistory;
      if (
        p.ownershipBindings.some(
          (b) =>
            failure.title === b.title &&
            (!b.downloadId || b.downloadId === failure.downloadId) &&
            ((native &&
              Number.isInteger(native.id) &&
              native.id > 0 &&
              native.downloadId === failure.downloadId &&
              native.title === b.title &&
              Date.parse(native.date) >= b.since &&
              Date.parse(native.date) <= failure.failedAt.getTime() &&
              Date.parse(native.date) <= b.until) ||
              grabs.some(
                (g) =>
                  g.payload.downloadId === failure.downloadId &&
                  g.payload.sourceTitle === b.title &&
                  g.occurredAt.getTime() >= b.since &&
                  g.occurredAt <= failure.failedAt &&
                  g.occurredAt.getTime() <= b.until,
              )),
        )
      )
        held.set(`${failure.downloadId}\u0000${failure.parentId}`, WRONG_CONTENT_RETRY_HOLD);
    }
  }
  return held;
}

export interface WrongContentRetryInput {
  db?: DbClient;
  arr: ArrClientBundle;
  /** Trusted private staff invocation, never accepted by a public router. */
  actor: { kind: 'staff' };
  fixRequestId: string;
  /** Optional exact wrong-story download to discard. No caller episode IDs. */
  conflictingDownloadId?: string;
  /** Bind a particular offer after inspecting the candidate list. */
  key?: string;
}
type Boundary = Array<{
  episodeId: number;
  fileId: number;
  name: string | null;
  size: number | null;
}>;
export interface WrongContentRetryPlan {
  fixRequestId: string;
  carryId: string;
  mediaItemId: string;
  seriesId: number;
  targetEpisodeIds: number[];
  failedDownloadId: string;
  failedGrabAttemptId: string | null;
  failedGrabHistoryIds: number[];
  failedGrabHttpAccepted: boolean;
  failedHistoryIds: number[];
  protectedFiles: Boundary;
  conflict: null | {
    downloadId: string;
    queueItemId: number;
    title: string;
    source: { path: string; size: number };
  };
  candidates: Array<{
    key: string;
    title: string;
    holds: string[];
    reasonCodes: string[];
    sizeBytes: number | null;
    languages: string[];
    qualityName: string | null;
  }>;
  state: 'ready' | 'observe';
  selectedKey: string | null;
  digest: string;
}

async function build(input: WrongContentRetryInput) {
  if (input.actor.kind !== 'staff') refuse('This recovery is private staff tooling.');
  if (!(await getRepairGuideRemedies(input.db)).release_pick)
    refuse('Release picking is turned off.');
  const p = await parent(input.db, input.fixRequestId);
  const claims = p.fix.actionsTaken.filter((a) => a.step === 'wrong_content_retry_intent');
  if (claims.some((a) => typeof a.failedDownloadId !== 'string' || typeof a.attemptId !== 'string'))
    refuse('The stored retry attempt scope cannot be verified. Observe its recorded commands.');
  const resolved = await readReleasePickTarget({
    db: input.db,
    arr: input.arr,
    mediaItemId: p.item.id,
    scope: 'episode',
    targetChildId: p.fix.targetArrChildId!,
  });
  if (resolved.target.kind !== 'sonarr') refuse('The original target is not Sonarr.');
  const target = resolved.target;
  const [episodes, files, queue, page] = await Promise.all([
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
  const targets = episodes.filter((e) => p.slot.includes(e.id));
  if (
    targets.length !== p.slot.length ||
    targets.some((e) => e.hasFile || (e.episodeFileId ?? 0) > 0) ||
    targets.some((e) => e.seasonNumber !== target.seasonNumber)
  )
    refuse('Every intended episode must still be empty in the original season.');
  const protectedFiles: Boundary = episodes
    .filter((e) => !p.slot.includes(e.id))
    .map((e) => {
      const fileId = e.episodeFileId ?? 0,
        f = files.find((f) => f.id === fileId);
      if (fileId > 0 && (!f?.relativePath || !f.size))
        refuse('A protected file cannot be verified.');
      return { episodeId: e.id, fileId, name: f?.relativePath ?? null, size: f?.size ?? null };
    })
    .sort((a, b) => a.episodeId - b.episodeId);
  const grabbed = page.records.filter(
    (h) =>
      h.seriesId === p.item.arrItemId &&
      h.eventType === 'grabbed' &&
      h.sourceTitle === p.anchor.title &&
      h.date &&
      Date.parse(h.date) >= Math.floor(Date.parse(p.anchor.start) / 1000) * 1000 &&
      Date.parse(h.date) <= p.anchor.end,
  );
  const latestDate = Math.max(...grabbed.map((h) => Date.parse(h.date!)));
  const downloads = [...new Set(grabbed.map((h) => h.downloadId).filter((d): d is string => !!d))];
  if (downloads.length !== 1)
    refuse('The bounded history does not identify one latest recorded grab.');
  const failedDownloadId = downloads[0]!;
  if (
    (p.anchor.downloadId && p.anchor.downloadId !== failedDownloadId) ||
    (p.anchor.source === 'native_call' && !same(ids(grabbed.map((h) => h.episodeId)), p.slot))
  )
    refuse('The current native GRAB does not match its recorded whole-slot attempt.');
  const claim = claims.find(
    (a) =>
      a.failedDownloadId === failedDownloadId &&
      (a.failedGrabAttemptId ?? null) === p.anchor.attemptId,
  );
  const failed = page.records.filter(
    (h) =>
      h.eventType === 'downloadFailed' &&
      h.seriesId === p.item.arrItemId &&
      h.downloadId === failedDownloadId &&
      h.sourceTitle === p.anchor.title &&
      h.date &&
      Date.parse(h.date) >= latestDate &&
      h.data?.message !== 'Manually marked as failed',
  );
  if (
    !failed.length ||
    page.records.some(
      (h) => h.downloadId === failedDownloadId && h.eventType === 'downloadFolderImported',
    )
  )
    refuse('The exact latest grab has no genuine failure or already imported.');
  const imported = await resolveDb(input.db)
    .select({ id: ledgerEvents.id })
    .from(ledgerEvents)
    .where(
      and(
        eq(ledgerEvents.mediaItemId, p.item.id),
        eq(ledgerEvents.eventType, 'imported'),
        sql`${ledgerEvents.payload}->>'downloadId' = ${failedDownloadId}`,
      ),
    )
    .limit(1);
  if (imported.length || queue.some((q) => q.downloadId === failedDownloadId))
    refuse('The original download still exists or has imported.');
  const otherFix = await resolveDb(input.db)
    .select({
      id: fixRequests.id,
      target: fixRequests.targetArrChildId,
      scope: fixRequests.targetScope,
      season: fixRequests.targetSeason,
    })
    .from(fixRequests)
    .where(
      and(
        eq(fixRequests.mediaItemId, p.item.id),
        inArray(fixRequests.status, [...OPEN_FIX_STATUSES]),
      ),
    );
  const otherRepair = await resolveDb(input.db)
    .select()
    .from(repairRequests)
    .where(
      and(
        eq(repairRequests.mediaItemId, p.item.id),
        inArray(repairRequests.status, ['pending', 'actioned']),
      ),
    );
  if (
    otherFix.some(
      (f) =>
        f.id !== p.fix.id &&
        (f.scope === 'item' ||
          (f.scope === 'season' && f.season === target.seasonNumber) ||
          p.slot.includes(f.target ?? -1)),
    ) ||
    otherRepair.some(
      (r) => r.scope !== 'episode' || r.targetChildIds.some((id) => p.slot.includes(id)),
    )
  )
    refuse('Another request owns this slot.');
  const affecting = queue.filter((q) => p.slot.includes(q.episodeId ?? -1));
  let conflict: WrongContentRetryPlan['conflict'] = null;
  const savedConflict = object(claim?.conflict);
  if (claims.some((a) => hash(protectedFiles) !== hash(a.protectedFiles)))
    refuse('Protected files changed during the recorded recovery.');
  if (input.conflictingDownloadId) {
    const records = queue.filter((q) => q.downloadId === input.conflictingDownloadId);
    if (records.length) {
      if (
        affecting.some((q) => q.downloadId !== input.conflictingDownloadId) ||
        records.some(
          (q) =>
            q.seriesId !== p.item.arrItemId ||
            q.status !== 'completed' ||
            !p.slot.includes(q.episodeId ?? -1),
        ) ||
        !same(ids(records.map((q) => q.episodeId)), p.slot)
      )
        refuse('The conflicting download does not cover only this complete empty slot.');
      const title = records[0]!.title;
      if (
        !page.records.some(
          (h) =>
            h.eventType === 'grabbed' &&
            h.seriesId === p.item.arrItemId &&
            h.downloadId === input.conflictingDownloadId &&
            h.sourceTitle === title &&
            Date.parse(h.date) >= Math.max(...failed.map((f) => Date.parse(f.date))),
        )
      )
        refuse('The conflicting source has no actual post-failure grab on this media.');
      const candidates = await input.arr.read.sonarr.getManualImport(input.conflictingDownloadId);
      const source = candidates.length === 1 ? candidates[0]! : null;
      if (
        !title ||
        records.some((q) => q.title !== title) ||
        !source ||
        source.series?.id !== p.item.arrItemId ||
        !source.path ||
        !source.size ||
        !same(ids((source.episodes ?? []).map((e) => e.id)), p.slot) ||
        !p.files.some((f) => f.size === source.size)
      )
        refuse('The exact original-byte conflicting source cannot be verified.');
      const evidence = episodeTitleEvidence({ name: title, episodes, againstEpisodeIds: p.slot });
      if (evidence.verdict !== 'disagrees' && evidence.verdict !== 'ambiguous')
        refuse('The conflicting source is not positively a different title.');
      conflict = {
        downloadId: input.conflictingDownloadId,
        queueItemId: records[0]!.id,
        title,
        source: { path: source.path, size: source.size },
      };
    } else if (!claim || savedConflict.downloadId !== input.conflictingDownloadId)
      refuse('The reviewed conflicting source disappeared before its claim.');
  } else if (affecting.length)
    refuse('A conflicting download must be explicitly planned before retry.');
  if (claim && conflict && hash(conflict) !== hash(savedConflict))
    refuse('The claimed conflicting source changed.');
  const state: WrongContentRetryPlan['state'] = claim ? 'observe' : 'ready';
  const releases =
    state === 'ready'
      ? await input.arr.read.sonarr.listSeasonReleases(p.item.arrItemId, target.seasonNumber)
      : [];
  const classified = classifyReleases(releases, target, { replacing: true });
  const offers = classified.offers.filter(
    (o) => same(o.episodeIds ?? [target.episodeId], p.slot) && o.titleVerdict === 'agrees',
  );
  const candidates = classified.rows
    .filter((r) => offers.some((o) => o.key === r.key))
    .map((r) => ({
      key: r.key,
      title: r.title,
      holds: r.holds ?? [target.label],
      reasonCodes: r.reasons.map((x) => x.code),
      sizeBytes: r.sizeBytes,
      languages: r.languages,
      qualityName: r.qualityName,
    }));
  if (input.key && state === 'ready' && !offers.some((o) => o.key === input.key))
    refuse('The selected whole-slot release is not allowed.');
  const base = {
    fixRequestId: p.fix.id,
    carryId: p.carry.id,
    mediaItemId: p.item.id,
    seriesId: p.item.arrItemId,
    targetEpisodeIds: p.slot,
    failedDownloadId,
    failedGrabAttemptId: p.anchor.attemptId,
    failedGrabHistoryIds: grabbed.map((h) => h.id).sort((a, b) => a - b),
    failedGrabHttpAccepted: p.anchor.httpAccepted,
    failedHistoryIds: failed.map((h) => h.id).sort((a, b) => a - b),
    protectedFiles,
    conflict,
    candidates,
    state,
    selectedKey: input.key ?? null,
  };
  return {
    plan: { ...base, digest: hash({ base, parent: p.fingerprint, offers }) },
    p,
    target,
    offers,
    claim,
  };
}

export async function planWrongContentRetry(
  input: WrongContentRetryInput,
): Promise<WrongContentRetryPlan> {
  return (await build(input)).plan;
}

export async function runWrongContentRetry(
  input: WrongContentRetryInput & {
    digest: string;
    key: string;
    evidence: string;
    conflictEvidence?: string;
  },
) {
  const current = await build(input),
    { plan, p, claim } = current;
  if (plan.digest !== input.digest) changed('The recovery changed. Read a fresh plan.');
  if (claim) {
    // An absent queue is evidence about current state, not proof that our uncertain command removed it.
    const discard = object(claim.conflict);
    if (
      typeof discard.downloadId === 'string' &&
      plan.conflict === null &&
      !p.fix.actionsTaken.some(
        (a) => a.step === 'wrong_content_retry_remove_read_back' && a.attemptId === claim.attemptId,
      )
    )
      await appendFixActions({
        db: input.db,
        fixRequestId: p.fix.id,
        actions: [
          {
            step: 'wrong_content_retry_remove_read_back',
            at: new Date().toISOString(),
            attemptId: claim.attemptId,
            downloadId: discard.downloadId,
            queueAbsent: true,
            observationOnly: true,
            commandOutcome: p.fix.actionsTaken.some(
              (a) =>
                a.step === 'wrong_content_retry_remove_result' &&
                a.attemptId === claim.attemptId &&
                a.ok === true,
            )
              ? 'accepted'
              : 'unknown',
          },
        ],
      });
    return {
      outcome: 'observe' as const,
      fixRequestId: p.fix.id,
      carryId: p.carry.id,
      targetEpisodeIds: p.slot,
    };
  }
  const offer = current.offers.find((o) => o.key === input.key);
  if (
    !offer ||
    input.evidence.trim().length < 20 ||
    (plan.conflict && (input.conflictEvidence?.trim().length ?? 0) < 20)
  )
    refuse('Confirm a listed whole-slot release and physical wrong-story evidence.');
  const attemptId = randomUUID(),
    at = () => new Date().toISOString();
  const claimAction: FixActionEntry = {
    step: 'wrong_content_retry_intent',
    at: at(),
    attemptId,
    actor: 'staff',
    requesterId: null,
    failedDownloadId: plan.failedDownloadId,
    failedGrabAttemptId: plan.failedGrabAttemptId,
    failedGrabHistoryIds: plan.failedGrabHistoryIds,
    failedGrabHttpAccepted: plan.failedGrabHttpAccepted,
    failedHistoryIds: plan.failedHistoryIds,
    targetEpisodeIds: p.slot,
    protectedFiles: plan.protectedFiles,
    conflict: plan.conflict,
    removeOptions: plan.conflict
      ? { removeFromClient: false, blocklist: true, skipRedownload: true }
      : null,
    key: offer.key,
    title: offer.title,
    evidence: input.evidence.trim(),
    conflictEvidence: input.conflictEvidence?.trim() ?? null,
  };
  await inTransaction(input.db, async (tx) => {
    const locked = await parent(tx, p.fix.id, true);
    if (locked.fingerprint !== p.fingerprint)
      changed('The owning repair changed before its claim.');
    await appendFixActions({
      db: tx,
      fixRequestId: p.fix.id,
      actions: [
        {
          step: 'wrong_content_retry_failed_grab_observed',
          at: at(),
          attemptId,
          downloadId: plan.failedDownloadId,
          grabbedAttemptId: plan.failedGrabAttemptId,
          grabbedHistoryIds: plan.failedGrabHistoryIds,
          failedHistoryIds: plan.failedHistoryIds,
          targetEpisodeIds: p.slot,
          httpAccepted: plan.failedGrabHttpAccepted,
        },
        claimAction,
      ],
    });
  });
  if (plan.conflict) {
    const options = { removeFromClient: false, blocklist: true, skipRedownload: true };
    try {
      await input.arr.write.sonarr.deleteQueueItem(plan.conflict.queueItemId, options);
    } catch (e) {
      await appendFixActions({
        db: input.db,
        fixRequestId: p.fix.id,
        actions: [
          {
            step: 'wrong_content_retry_remove_result',
            at: at(),
            attemptId,
            ok: false,
            downloadId: plan.conflict.downloadId,
            options,
            error: safeError(e),
          },
        ],
      });
      return {
        outcome: 'observe' as const,
        fixRequestId: p.fix.id,
        carryId: p.carry.id,
        targetEpisodeIds: p.slot,
      };
    }
    await appendFixActions({
      db: input.db,
      fixRequestId: p.fix.id,
      actions: [
        {
          step: 'wrong_content_retry_remove_result',
          at: at(),
          attemptId,
          ok: true,
          downloadId: plan.conflict.downloadId,
          options,
        },
      ],
    });
  }
  const checked = await build(input);
  if (checked.plan.conflict || hash(checked.plan.protectedFiles) !== hash(plan.protectedFiles))
    refuse('Queue removal or protected-file read-back is unresolved. Observe this attempt.');
  await inTransaction(input.db, async (tx) => {
    const locked = await parent(tx, p.fix.id, true);
    if (locked.fingerprint !== checked.p.fingerprint)
      changed('The owning repair changed before the grab claim.');
    await appendFixActions({
      db: tx,
      fixRequestId: p.fix.id,
      actions: [
        ...(plan.conflict
          ? [
              {
                step: 'wrong_content_retry_remove_read_back',
                at: at(),
                attemptId,
                downloadId: plan.conflict.downloadId,
                queueAbsent: true,
                commandOutcome: 'accepted',
              },
            ]
          : []),
        {
          step: 'wrong_content_retry_grab_intent',
          at: at(),
          attemptId,
          key: offer.key,
          title: offer.title,
          episodeIds: p.slot,
        },
        { step: 'grab_intent', at: at(), attemptId, title: offer.title, episodeIds: p.slot },
      ],
    });
  });
  const startedAt = at();
  let grabError: unknown;
  let accepted = false;
  try {
    await sendReleaseGrab({ arr: input.arr, target: current.target, offer, episodeIds: p.slot });
    accepted = true;
  } catch (e) {
    grabError = e;
  }
  const finishedAt = at();
  // Save actual call facts separately: a later canonical receipt audit can fail without losing this boundary.
  let nativeGrabs: Array<{ id: number; date: string; downloadId: string; episodeId: number }> = [];
  let historyReadAvailable = false;
  try {
    const page = await input.arr.read.sonarr.getHistory({
      page: 1,
      pageSize: 200,
      sortKey: 'date',
      sortDirection: 'descending',
    });
    historyReadAvailable = true;
    nativeGrabs = page.records
      .filter(
        (h) =>
          h.eventType === 'grabbed' &&
          h.seriesId === p.item.arrItemId &&
          h.sourceTitle === offer.title &&
          h.downloadId &&
          h.episodeId &&
          Date.parse(h.date) >= Math.floor(Date.parse(startedAt) / 1000) * 1000 &&
          Date.parse(h.date) <= Date.parse(finishedAt),
      )
      .map((h) => ({ id: h.id, date: h.date, downloadId: h.downloadId!, episodeId: h.episodeId! }));
  } catch {
    /* Missing native proof stays unresolved; never synthesize a download GUID. */
  }
  const downloads = [...new Set(nativeGrabs.map((h) => h.downloadId))];
  await appendFixActions({
    db: input.db,
    fixRequestId: p.fix.id,
    allowCompleted: true,
    actions: [
      {
        step: 'wrong_content_retry_grab_call_result',
        at: finishedAt,
        attemptId,
        title: offer.title,
        targetEpisodeIds: p.slot,
        startedAt,
        finishedAt,
        accepted,
        downloadId:
          downloads.length === 1 && same(ids(nativeGrabs.map((h) => h.episodeId)), p.slot)
            ? downloads[0]
            : null,
        grabbedHistory: nativeGrabs,
        historyReadAvailable,
        ...(accepted ? {} : { error: safeError(grabError) }),
      },
    ],
  });
  if (!accepted) {
    await appendFixActions({
      db: input.db,
      fixRequestId: p.fix.id,
      allowCompleted: true,
      actions: [
        {
          step: 'wrong_content_retry_grab_result',
          at: at(),
          attemptId,
          ok: false,
          error: safeError(grabError),
        },
      ],
    });
    return {
      outcome: 'observe' as const,
      fixRequestId: p.fix.id,
      carryId: p.carry.id,
      targetEpisodeIds: p.slot,
    };
  }
  await appendFixActions({
    db: input.db,
    fixRequestId: p.fix.id,
    allowCompleted: true,
    actions: [
      {
        step: 'release_grab',
        at: at(),
        attemptId,
        ok: true,
        release: offer.title,
        key: offer.key,
        lands: offer.holds,
        override: true,
      },
      { step: 'wrong_content_retry_grab_result', at: at(), attemptId, ok: true },
    ],
  });
  return {
    outcome: 'grabbed' as const,
    fixRequestId: p.fix.id,
    carryId: p.carry.id,
    targetEpisodeIds: p.slot,
  };
}
