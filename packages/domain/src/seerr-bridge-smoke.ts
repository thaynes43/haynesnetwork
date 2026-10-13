// DESIGN-055 P7 decision 11: owner-authorized staff fixture. No library or download write.
// All fixture ownership/intents/results use setAppSetting, with its same-transaction permission audit.
// Normal mirror, Repair Request and bridge writers retain their own audits. Never a general issue-delete surface.
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { mediaItems, repairRequests, seerrIssues, seerrIssueWrites, type DbClient } from '@hnet/db';
import { type SeerrIssue, type SeerrUserDetail } from '@hnet/arr';
import { SeerrClient } from '@hnet/arr/read';
import { SeerrWriteClient } from '@hnet/arr/write';
import { ARR_CLUSTER_URL_DEFAULTS } from '@hnet/arr';
import { issuerOrigin } from '@hnet/oauth';
import { getAppSetting, setAppSetting, type SeerrBridgeSmokeState } from './app-settings';
import { inTransaction, resolveDb } from './db-client';
import { createRepairRequest, recordRepairTransition } from './repair-requests';
import { refreshSeerrIssue } from './seerr-issues';
import { bridgeUserProblem, getSeerrIssueBridge, runSeerrIssueBridge } from './seerr-issue-writes';
import { silentDomainLogger } from './domain-logger';

export const SEERR_BRIDGE_SMOKE = {
  mediaId: 10974,
  tmdbId: 65465,
  title: 'The Canterville Ghost',
  userId: 19,
  markerPrefix: '[haynesnetwork bridge smoke:',
} as const;

export interface SeerrBridgeSmokeClients {
  read: {
    getUser(id: number): Promise<SeerrUserDetail | null>;
    getIssue(id: number): Promise<SeerrIssue | null>;
    listAllIssues(): Promise<SeerrIssue[]>;
    getMovieIssueTarget(
      id: number,
    ): Promise<{ title: string; mediaInfo?: { id: number; tmdbId: number } | null }>;
  };
  write: {
    createIssue(mediaId: number, message: string, asUserId: number): Promise<SeerrIssue>;
    deleteIssue(issueId: number, asUserId: number): Promise<void>;
    commentOnIssue(issueId: number, message: string, asUserId: number): Promise<SeerrIssue>;
    resolveIssue(issueId: number, asUserId: number): Promise<SeerrIssue>;
  };
}

const markerFor = (runId: string) => `${SEERR_BRIDGE_SMOKE.markerPrefix}${runId}]`;
const reportFor = (marker: string) =>
  `${marker} Staff test of the Seerr bridge. The repair result is simulated. No media files are changed. This issue will be deleted after the check.`;
const fail = (message: string): never => {
  throw new Error(`Seerr bridge smoke: ${message}`);
};
const LEASE_MS = 5 * 60_000;
const OPERATIONS = [
  'ready',
  'create_intended',
  'created',
  'repair_pending',
  'repair_completed',
  'verified',
  'delete_intended',
  'deleted',
];

/** Stored ownership is fail-closed; a malformed record never authorizes an external write. */
function checkedState(raw: SeerrBridgeSmokeState | null): SeerrBridgeSmokeState | null {
  if (raw === null) return null;
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(raw.runId) ||
    raw.marker !== markerFor(raw.runId) ||
    !Number.isFinite(Date.parse(raw.startedAt)) ||
    (raw.issueId !== null && (!Number.isSafeInteger(raw.issueId) || raw.issueId <= 4)) ||
    !OPERATIONS.includes(raw.operation)
  )
    fail('the saved fixture ownership is invalid');
  return raw;
}

/** Every cleanup rechecks remote identity and the exact initial report, not just a local id. */
export function seerrBridgeSmokeFixtureProblem(
  issue: SeerrIssue,
  state: Pick<SeerrBridgeSmokeState, 'issueId' | 'marker' | 'startedAt'>,
): string | null {
  if (!Number.isSafeInteger(issue.id) || issue.id <= 4) return 'issues 1 to 4 are protected';
  if (state.issueId !== null && issue.id !== state.issueId)
    return 'the issue id does not belong to this fixture';
  if (
    issue.media?.id !== SEERR_BRIDGE_SMOKE.mediaId ||
    issue.media.tmdbId !== SEERR_BRIDGE_SMOKE.tmdbId ||
    issue.media.mediaType !== 'movie'
  )
    return 'the issue is on another title';
  if (issue.issueType !== 4 || issue.createdBy?.id !== SEERR_BRIDGE_SMOKE.userId)
    return 'the issue has another reporter or type';
  if (
    issue.comments?.[0]?.message !== reportFor(state.marker) ||
    issue.comments[0].user?.id !== SEERR_BRIDGE_SMOKE.userId
  )
    return 'the initial marked staff report does not match';
  const createdAt = Date.parse(issue.createdAt);
  const start = Math.floor(Date.parse(state.startedAt) / 1000) * 1000;
  if (!Number.isFinite(createdAt) || createdAt < start || createdAt > start + LEASE_MS)
    return 'the issue was not newly created by this run';
  return null;
}

/** A transaction lease serializes pod/web invocations without holding an uncommitted audit across HTTP calls. */
async function claim(
  db: DbClient | undefined,
  cleanupOnly: boolean,
): Promise<SeerrBridgeSmokeState | null> {
  return inTransaction(db, async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('seerr-bridge-smoke'))`);
    let state = checkedState(await getAppSetting(tx, 'seerr_issue_bridge_smoke'));
    if (state === null && cleanupOnly) return null;
    const now = new Date();
    if (state?.leaseOwner && state.leaseUntil && Date.parse(state.leaseUntil) > now.getTime())
      fail('another staff run owns the fixture; retry after its five-minute lease');
    if (!state) {
      const runId = randomUUID();
      state = {
        runId,
        marker: markerFor(runId),
        startedAt: now.toISOString(),
        issueId: null,
        repairRequestId: null,
        operation: 'ready',
        invitationVerified: false,
        pendingVerified: false,
        resolveVerified: false,
        lastError: null,
        leaseOwner: null,
        leaseUntil: null,
      };
    }
    state = {
      ...state,
      leaseOwner: randomUUID(),
      leaseUntil: new Date(now.getTime() + LEASE_MS).toISOString(),
    };
    await setAppSetting({ db: tx, key: 'seerr_issue_bridge_smoke', value: state, actorId: null });
    return state;
  });
}

async function checkpoint(
  db: DbClient | undefined,
  owner: string,
  patch: Partial<SeerrBridgeSmokeState>,
): Promise<SeerrBridgeSmokeState> {
  return inTransaction(db, async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('seerr-bridge-smoke'))`);
    const before = checkedState(await getAppSetting(tx, 'seerr_issue_bridge_smoke'));
    if (!before || before.leaseOwner !== owner) return fail('this run no longer owns the fixture');
    const after = {
      ...before,
      ...patch,
      leaseUntil: patch.leaseOwner === null ? null : new Date(Date.now() + LEASE_MS).toISOString(),
    };
    await setAppSetting({ db: tx, key: 'seerr_issue_bridge_smoke', value: after, actorId: null });
    return after;
  });
}

/** A COMPLETE list proves absence, including Seerr 3.5.0's missing-detail response (HTTP 500). */
async function findFixture(
  clients: SeerrBridgeSmokeClients,
  state: SeerrBridgeSmokeState,
): Promise<SeerrIssue | null> {
  const issues = await clients.read.listAllIssues();
  const matches =
    state.issueId === null
      ? issues.filter((i) => i.comments?.[0]?.message === reportFor(state.marker))
      : issues.filter((i) => i.id === state.issueId);
  if (matches.length > 1)
    return fail('more than one issue has the run marker; refusing every write');
  if (matches.length === 0) return null;
  const fresh = await clients.read.getIssue(matches[0]!.id);
  if (!fresh) return fail('the fixture disappeared during its fresh read; retry cleanup');
  const problem = seerrBridgeSmokeFixtureProblem(fresh, state);
  if (problem) return fail(problem);
  return fresh;
}

export interface SeerrBridgeSmokeReport {
  runId: string | null;
  issueId: number | null;
  repairRequestId: string | null;
  invitationVerified: boolean;
  pendingVerified: boolean;
  resolveVerified: boolean;
  deleted: boolean;
}

/** One resumable, bounded staff test. A failed run leaves its audited checkpoint for --smoke-cleanup. */
export async function runSeerrIssueBridgeSmoke(input: {
  db?: DbClient;
  clients: SeerrBridgeSmokeClients;
  linkOrigin: string;
  cleanupOnly?: boolean;
}): Promise<SeerrBridgeSmokeReport> {
  const { db, clients } = input;
  const userProblem = bridgeUserProblem(
    await clients.read.getUser(SEERR_BRIDGE_SMOKE.userId),
    SEERR_BRIDGE_SMOKE.userId,
  );
  if (userProblem) return fail(userProblem);
  if (!input.cleanupOnly) {
    const setting = await getSeerrIssueBridge({ db });
    if (
      !setting.comment ||
      !setting.resolve ||
      setting.bridgeUserId !== SEERR_BRIDGE_SMOKE.userId ||
      !setting.commentFrom
    )
      return fail('enable both bridge switches as user 19 first');
    const movie = await clients.read.getMovieIssueTarget(SEERR_BRIDGE_SMOKE.tmdbId);
    if (
      movie.title !== SEERR_BRIDGE_SMOKE.title ||
      movie.mediaInfo?.id !== SEERR_BRIDGE_SMOKE.mediaId ||
      movie.mediaInfo.tmdbId !== SEERR_BRIDGE_SMOKE.tmdbId
    )
      return fail('Seerr media 10974 is not The Canterville Ghost (1986)');
    // Seerr's issue timestamps have second precision; do not create before the enable timestamp's next second.
    const wait = Math.ceil(Date.parse(setting.commentFrom) / 1000) * 1000 - Date.now();
    if (wait > 1500) return fail('the bridge enable time is in the future');
    if (wait > 0) await delay(wait);
  }
  let state = await claim(db, input.cleanupOnly === true);
  if (!state)
    return {
      runId: null,
      issueId: null,
      repairRequestId: null,
      invitationVerified: false,
      pendingVerified: false,
      resolveVerified: false,
      deleted: true,
    };
  const owner = state.leaseOwner!;
  const save = async (patch: Partial<SeerrBridgeSmokeState>, tx?: DbClient) => {
    state = await checkpoint(tx ?? db, owner, patch);
  };
  const bridge = async () => {
    const report = await runSeerrIssueBridge({
      db,
      clients: { ...clients, sonarr: null },
      issueIds: [state!.issueId!],
      linkOrigin: input.linkOrigin,
      logger: silentDomainLogger,
    });
    if (report.status !== 'ok') return fail(`the bridge pass returned ${report.status}`);
  };
  const mirror = async (issue: SeerrIssue | null) =>
    refreshSeerrIssue({
      db,
      seerrIssueId: state!.issueId!,
      seerr: { getIssue: async () => issue },
    });
  const cleanup = async () => {
    const issue = await findFixture(clients, state!);
    if (issue && state!.issueId === null) await save({ issueId: issue.id });
    if (state!.repairRequestId) {
      await inTransaction(db, async (tx) => {
        const repair = await resolveDb(tx).query.repairRequests.findFirst({
          where: eq(repairRequests.id, state!.repairRequestId!),
        });
        if (
          !repair ||
          repair.seerrIssueId !== state!.issueId ||
          repair.preview.smokeRunId !== state!.runId
        )
          return fail('the saved repair does not belong to this fixture');
        if (repair.status === 'pending' || repair.status === 'actioned')
          await recordRepairTransition({
            db: tx,
            repairRequestId: repair.id,
            transition: 'failed',
            actions: [
              {
                step: 'staff_smoke_cleanup',
                at: new Date().toISOString(),
                simulated: true,
                noLibraryWrites: true,
              },
            ],
          });
        await save({ operation: 'delete_intended' }, tx);
      });
    } else await save({ operation: 'delete_intended' });
    if (issue) await clients.write.deleteIssue(issue.id, SEERR_BRIDGE_SMOKE.userId);
    if (await findFixture(clients, state!))
      return fail('the test issue still exists after cleanup');
    if (state!.issueId !== null) await mirror(null);
    await save({ operation: 'deleted', lastError: null });
  };
  try {
    if (state.operation !== 'deleted') {
      if (input.cleanupOnly) await cleanup();
      else {
        const item = await resolveDb(db).query.mediaItems.findFirst({
          where: and(
            eq(mediaItems.arrKind, 'radarr'),
            eq(mediaItems.tmdbId, SEERR_BRIDGE_SMOKE.tmdbId),
            isNull(mediaItems.deletedFromArrAt),
          ),
        });
        if (!item || item.title !== SEERR_BRIDGE_SMOKE.title)
          return fail('the exact active movie is missing from the ledger');
        let issue = await findFixture(clients, state);
        if (!issue && state.operation === 'ready') {
          await save({ operation: 'create_intended', startedAt: new Date().toISOString() });
          try {
            issue = await clients.write.createIssue(
              SEERR_BRIDGE_SMOKE.mediaId,
              reportFor(state!.marker),
              SEERR_BRIDGE_SMOKE.userId,
            );
          } catch {
            issue = await findFixture(clients, state!);
            if (!issue)
              return fail(
                'create has an unknown outcome; no retry was sent. Rerun to adopt, or use --smoke-cleanup',
              );
          }
          const problem = seerrBridgeSmokeFixtureProblem(issue, state!);
          if (problem) return fail(problem);
        }
        if (!issue)
          return fail('the saved fixture is absent; no new create was sent. Use --smoke-cleanup');
        if (state!.issueId === null) await save({ issueId: issue.id, operation: 'created' });
        await mirror(issue);
        const mirrored = await resolveDb(db).query.seerrIssues.findFirst({
          where: eq(seerrIssues.seerrIssueId, issue.id),
        });
        if (mirrored?.mediaItemId !== item.id)
          return fail('the fixture mirror does not name the exact active movie');
        await bridge();
        const verifyComment = async (kind: 'comment' | 'resolve') => {
          const rowFor = () =>
            resolveDb(db).query.seerrIssueWrites.findFirst({
              where: and(
                eq(seerrIssueWrites.seerrIssueId, state!.issueId!),
                eq(seerrIssueWrites.kind, kind),
              ),
            });
          let row = await rowFor();
          const deadline = Date.now() + 20_000;
          // A webhook may own this same write. Wait for its audit row; never post around it.
          while (row?.state === 'intended' && Date.now() < deadline) {
            await delay(1000);
            row = await rowFor();
          }
          const current = await clients.read.getIssue(state!.issueId!);
          if (
            !row ||
            row.state !== 'done' ||
            row.seerrUserId !== SEERR_BRIDGE_SMOKE.userId ||
            !current
          )
            return fail(`${kind} has no completed bridge audit`);
          const count = current.comments?.filter(
            (c) => c.user?.id === SEERR_BRIDGE_SMOKE.userId && c.message === row.body,
          ).length;
          if (count !== 1) return fail(`${kind} expected exactly one matching bridge comment`);
          if (kind === 'comment' && !row.body.includes(`/r/seerr/${state!.issueId}`))
            return fail('the invitation has no exact report link');
          if (kind === 'resolve' && current.status !== 2)
            return fail('the simulated completed repair was not resolved');
        };
        await verifyComment('comment');
        await save({ invitationVerified: true });
        if (state!.repairRequestId === null)
          await inTransaction(db, async (tx) => {
            const repair = await createRepairRequest({
              db: tx,
              requesterId: null,
              mediaItemId: item.id,
              kind: 'import_download',
              scope: 'item',
              seasonNumber: null,
              targetChildIds: [],
              seerrIssueId: state!.issueId,
              preview: {
                staffSmoke: true,
                smokeRunId: state!.runId,
                simulated: true,
                noLibraryWrites: true,
              },
            });
            const row = await resolveDb(tx).query.repairRequests.findFirst({
              where: eq(repairRequests.id, repair.repairRequestId),
            });
            if (row?.seerrIssueId !== state!.issueId)
              return fail('the simulated repair did not keep its exact issue link');
            await save(
              { repairRequestId: repair.repairRequestId, operation: 'repair_pending' },
              tx,
            );
          });
        if (!state!.pendingVerified) {
          await bridge();
          const current = await clients.read.getIssue(state!.issueId!);
          const resolve = await resolveDb(db).query.seerrIssueWrites.findFirst({
            where: and(
              eq(seerrIssueWrites.seerrIssueId, state!.issueId!),
              eq(seerrIssueWrites.kind, 'resolve'),
            ),
          });
          if (current?.status !== 1 || resolve)
            return fail('a pending repair resolved the test issue');
          await save({ pendingVerified: true });
        }
        await inTransaction(db, async (tx) => {
          const repair = await resolveDb(tx).query.repairRequests.findFirst({
            where: eq(repairRequests.id, state!.repairRequestId!),
          });
          if (
            !repair ||
            repair.seerrIssueId !== state!.issueId ||
            repair.preview.smokeRunId !== state!.runId
          )
            return fail('the saved repair does not belong to this fixture');
          if (repair.status !== 'completed')
            await recordRepairTransition({
              db: tx,
              repairRequestId: repair.id,
              transition: 'completed',
              actions: [
                {
                  step: 'staff_smoke_simulated_completion',
                  at: new Date().toISOString(),
                  simulated: true,
                  noLibraryWrites: true,
                },
              ],
            });
          await save({ operation: 'repair_completed' }, tx);
        });
        await bridge();
        await verifyComment('resolve');
        await bridge(); // A repeated pass must not post an invitation or outcome note again.
        await verifyComment('comment');
        await verifyComment('resolve');
        await save({ resolveVerified: true, operation: 'verified' });
        await cleanup();
      }
    }
    return {
      runId: state!.runId,
      issueId: state!.issueId,
      repairRequestId: state!.repairRequestId,
      invitationVerified: state!.invitationVerified,
      pendingVerified: state!.pendingVerified,
      resolveVerified: state!.resolveVerified,
      deleted: state!.operation === 'deleted',
    };
  } catch (error) {
    await save({
      lastError:
        'The staff smoke check did not finish. Resume from this checkpoint or run --smoke-cleanup.',
    });
    throw error;
  } finally {
    await save({ leaseOwner: null });
  }
}

/** The staff command uses the same authenticated environment as the normal bridge. Never prints keys or settings. */
export async function runSeerrIssueBridgeSmokeFromEnv(
  input: { db?: DbClient; cleanupOnly?: boolean; env?: Record<string, string | undefined> } = {},
): Promise<SeerrBridgeSmokeReport> {
  const env = input.env ?? process.env;
  const apiKey = env.SEERR_API_KEY?.trim();
  if (!apiKey) return fail('SEERR_API_KEY is required');
  const options = {
    baseUrl: env.SEERR_URL?.trim() || ARR_CLUSTER_URL_DEFAULTS.seerr,
    apiKey,
    timeoutMs: 15_000,
  };
  return runSeerrIssueBridgeSmoke({
    db: input.db,
    cleanupOnly: input.cleanupOnly,
    clients: { read: new SeerrClient(options), write: new SeerrWriteClient(options) },
    linkOrigin: issuerOrigin(env),
  });
}
