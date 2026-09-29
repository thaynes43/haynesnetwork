// ADR-094 / DESIGN-046 D-14 (PLAN-065) — the JANITOR RELEASE BLOCK (T-269).
//
// Before the queue janitor removes a `manual_match` download (remove + blocklist + skipRedownload, then an album
// search), it blocks the failing release's NAME: a "must not contain" term derived from the release title goes into ONE
// app-owned release profile on that *arr and is read back. Only then is the download removed. Lidarr's blocklist
// blocks one posting (indexer + guid), not the title, and the owner's hand sweep of 2026-09-29 showed the search
// grabbing a same-titled re-post of the release that had just failed (18 of 55 grabbed albums); the term closes that.
//
// The term is the whole-name form (`renderWholeNameTerm`, anchored at both ends), and only for a title that names the
// album's artist: the profile applies to every artist, so a title without the artist's name ("Greatest Hits") would
// block other artists' releases. A download whose name cannot be blocked this way is left alone (`skipped_unblockable`).
//
// Single writer: `reconcileJanitorReleaseBlock`, under `pg_advisory_xact_lock('janitor-block:<instance>')`. Its records
// are append-only rows of arr_queue_cleanup_block_terms, inserted in the transaction of the profile write and its
// read-back (a row exists only for a term the *arr confirmed). A term lives 365 days from its latest block (the owner's
// Release Block ruling); an expired term leaves the profile at the next reconcile, which the janitor's hourly upkeep
// runs on drift. Generic by instance (the janitor is being extended beyond the *arrs); Lidarr only today.
//
// Hard rule 4 (amended by ADR-094): the janitor's profile is the only write-back here, through `@hnet/arr/write` from
// this package; "must not contain" terms only, never library files, quality profiles or custom formats.
import { arrQueueCleanupBlockTerms, type ArrKind, type DbClient } from '@hnet/db';
import { and, desc, eq, gt, gte, sql } from 'drizzle-orm';
import { inTransaction, resolveDb } from './db-client';
import { JanitorReleaseBlockError } from './errors';
import {
  foldReleaseName,
  isWholeNameTerm,
  releaseTokens,
  renderWholeNameTerm,
  termMatchesRaw,
  termWords,
} from './release-terms';

/** The plain term that marks the janitor's profile (Lidarr's profiles have no name) and keeps it valid when it holds no
 *  live term. A plain term is a case-insensitive "contains": no release title carries it. */
export const JANITOR_BLOCK_SENTINEL = 'haynesnetwork-janitor-managed-do-not-edit';
/** A janitor term lives this long from its latest block (the owner's Release Block ruling, 365 days). */
export const JANITOR_BLOCK_TERM_LIFETIME_DAYS = 365;
/** At most this many live terms per *arr (the Release Block's cap); the oldest beyond it leave the profile. */
export const JANITOR_BLOCK_TERM_CAP = 3_000;
/** The instances whose janitor writes a release block today (ADR-094: Lidarr only). */
export const JANITOR_BLOCK_KINDS: readonly ArrKind[] = ['lidarr'];

const DAY_MS = 86_400_000;

/** One *arr release profile, as the janitor block reads it (Lidarr: no name). */
export interface JanitorReleaseProfile {
  id: number;
  enabled?: boolean | null;
  required?: readonly string[] | null;
  ignored?: readonly string[] | null;
  indexerId?: number | null;
  tags?: readonly number[] | null;
}

/** The profile body the janitor writes: enabled, no required terms, every indexer, every artist (no tags). */
export interface JanitorReleaseProfileBody {
  enabled: boolean;
  required: string[];
  ignored: string[];
  indexerId: number;
  tags: number[];
}

/** The release-profile surface of one *arr, built from its write client inside @hnet/domain. */
export interface JanitorReleaseProfileClient {
  listReleaseProfiles(): Promise<JanitorReleaseProfile[]>;
  createReleaseProfile(body: JanitorReleaseProfileBody): Promise<unknown>;
  updateReleaseProfile(body: JanitorReleaseProfileBody & { id: number }): Promise<unknown>;
}

const isJanitorProfile = (p: JanitorReleaseProfile) => (p.ignored ?? []).includes(JANITOR_BLOCK_SENTINEL);

/** A term the janitor's profile may hold: its sentinel, or a whole-name term. */
export const isJanitorBlockTerm = (term: string): boolean =>
  term === JANITOR_BLOCK_SENTINEL || isWholeNameTerm(term);

// ---------------------------------------------------------------------------
// The term (pure)
// ---------------------------------------------------------------------------

/** Why no term names only this release: no title, no artist to check against, a title that does not name the artist
 *  (as a run of whole words), a title that is only the artist's name, a title with a word the term cannot write, or a
 *  term outside the grammar. */
export type JanitorTermRefusal =
  | 'no_title'
  | 'no_artist'
  | 'artist_not_named'
  | 'title_is_artist'
  | 'unwritable'
  | 'grammar';

const WRITABLE = /[a-z0-9]/;
/** A letter, a digit or a symbol: a character that can carry a word's meaning (`÷`, `♥`, `★` name albums). */
const MEANINGFUL = /[\p{L}\p{N}\p{S}]/u;

/**
 * Does the title carry a letter, digit or symbol the term cannot write (another script, a Latin letter that does not
 * fold such as `ø` or `ß`, a symbol such as `÷` or `♥`) anywhere but strictly inside a written word? The term matches
 * such a character only through SEP, which is harmless inside a word ("Bjørk": `bj`, one non-alphanumeric, `rk`;
 * "Ke$ha") but lets any other word stand in for a whole unwritten one ("Artist - 日本 (2019)" would also block
 * "Artist - 東京 (2019)", and "Ed Sheeran - ÷ [FLAC]" would block "Ed Sheeran - × [FLAC]").
 */
function hasUnwritableWord(title: string): boolean {
  const chars = [...foldReleaseName(title)];
  return chars.some((c, i) => {
    if (WRITABLE.test(c) || !MEANINGFUL.test(c)) return false;
    const prev = chars[i - 1];
    const next = chars[i + 1];
    return !(prev !== undefined && WRITABLE.test(prev) && next !== undefined && WRITABLE.test(next));
  });
}

export type JanitorBlockTerm = { term: string } | { refused: JanitorTermRefusal };

/** Does `tokens` contain `run` as consecutive tokens? */
function containsRun(tokens: readonly string[], run: readonly string[]): boolean {
  if (run.length === 0 || run.length > tokens.length) return false;
  for (let i = 0; i + run.length <= tokens.length; i += 1) {
    if (run.every((t, j) => tokens[i + j] === t)) return true;
  }
  return false;
}

/**
 * D-14 — the whole-name term for a failing release, or why there is none. The title must name the artist: the artist's
 * words (a leading "The" optional) as a run of the title's words, plus at least one more word; and every word must be
 * one the term can write (`hasUnwritableWord`). The term is built from
 * the title's raw words (apostrophes, accented letters, `&`), anchored at both ends, and must match the title as the
 * *arr tests it (raw). Pure.
 */
export function deriveJanitorBlockTerm(input: {
  releaseTitle: string | null | undefined;
  artistName: string | null | undefined;
}): JanitorBlockTerm {
  const title = (input.releaseTitle ?? '').trim();
  const tokens = releaseTokens(title);
  if (tokens.length === 0) return { refused: 'no_title' };
  const artist = releaseTokens(input.artistName ?? '');
  if (artist.length === 0) return { refused: 'no_artist' };
  const runs = artist[0] === 'the' && artist.length > 1 ? [artist, artist.slice(1)] : [artist];
  const named = runs.find((run) => containsRun(tokens, run));
  if (!named) return { refused: 'artist_not_named' };
  if (tokens.length <= named.length) return { refused: 'title_is_artist' };
  if (hasUnwritableWord(title)) return { refused: 'unwritable' };
  let term: string;
  try {
    const words = termWords(title);
    term = renderWholeNameTerm(words.length === tokens.length ? words : tokens);
  } catch {
    return { refused: 'grammar' };
  }
  if (!isWholeNameTerm(term) || !termMatchesRaw(term, title)) return { refused: 'grammar' };
  return { term };
}

// ---------------------------------------------------------------------------
// Drift (pure)
// ---------------------------------------------------------------------------

export type JanitorBlockDriftReason = 'missing' | 'duplicate' | 'disabled' | 'edited' | 'terms';

export interface JanitorBlockDrift {
  reason: JanitorBlockDriftReason;
  /** Desired terms the profile lacks (the sentinel included). */
  missingTerms: number;
  /** Terms the profile holds that no live record wants (an expired term, a hand edit). */
  extraTerms: number;
}

/**
 * Compare the profiles carrying the janitor's sentinel with the desired state (one profile, enabled, no required terms,
 * every indexer, no tags, `ignored` exactly `desired` as a set). null ⇒ nothing to write.
 */
export function janitorBlockProfileDrift(
  profiles: readonly JanitorReleaseProfile[],
  desired: readonly string[],
): JanitorBlockDrift | null {
  const ours = profiles.filter(isJanitorProfile);
  const want = new Set(desired);
  if (ours.length === 0) return { reason: 'missing', missingTerms: want.size, extraTerms: 0 };
  if (ours.length > 1) return { reason: 'duplicate', missingTerms: 0, extraTerms: 0 };
  const p = ours[0]!;
  const have = new Set(p.ignored ?? []);
  const missingTerms = [...want].filter((x) => !have.has(x)).length;
  const extraTerms = [...have].filter((x) => !want.has(x)).length;
  if (p.enabled !== true) return { reason: 'disabled', missingTerms, extraTerms };
  if ((p.required ?? []).length > 0 || (p.indexerId ?? 0) !== 0 || (p.tags ?? []).length > 0) {
    return { reason: 'edited', missingTerms, extraTerms };
  }
  if (missingTerms > 0 || extraTerms > 0) return { reason: 'terms', missingTerms, extraTerms };
  return null;
}

// ---------------------------------------------------------------------------
// The single writer
// ---------------------------------------------------------------------------

interface BlockLogger {
  info?: (msg: string, meta?: Record<string, unknown>) => void;
  warn?: (msg: string, meta?: Record<string, unknown>) => void;
}

/** One block to record: the term, and what it was derived from (display and audit only). */
export interface JanitorBlockEntry {
  term: string;
  releaseTitle: string | null;
  downloadId: string | null;
  targetId: number | null;
}

export interface JanitorBlockReconcileReport {
  instance: ArrKind;
  /** Live terms in the profile after the reconcile (the sentinel not counted). */
  total: number;
  added: number;
  removed: number;
  /** Live terms left out by the cap. */
  pruned: number;
  wrote: boolean;
}

const blockLockKey = (instance: ArrKind) => sql`hashtext(${`janitor-block:${instance}`})`;

/** One instance's live terms (expires_at still ahead), newest block first. */
async function readLiveBlockTerms(exec: DbClient, instance: ArrKind, now: Date): Promise<string[]> {
  const t = arrQueueCleanupBlockTerms;
  const rows = await resolveDb(exec)
    .select({ term: t.term, newest: sql<Date>`max(${t.createdAt})`.as('newest') })
    .from(t)
    .where(and(eq(t.instance, instance), gt(t.expiresAt, now)))
    .groupBy(t.term)
    .orderBy(sql`newest desc`, t.term);
  return rows.map((r) => r.term);
}

/**
 * D-14 — `reconcileJanitorReleaseBlock`, the single writer of the janitor's release profile on one *arr, under
 * `pg_advisory_xact_lock('janitor-block:<instance>')`, in one transaction:
 *  1. each `add` entry's term must pass the whole-name grammar; its row is inserted (expires in 365 days);
 *  2. desired = the sentinel + the distinct live terms, newest first, capped at 3,000; every one must pass the grammar;
 *  3. the profile is found by its sentinel: none ⇒ POST; one ⇒ PUT only when it drifted; more ⇒ `duplicate_profile`;
 *  4. a read-back GET must show exactly one enabled profile holding every desired term (`read_back`).
 * Any failure throws JanitorReleaseBlockError and rolls the rows back, so a row exists only for a confirmed term.
 * Idempotent (a set comparison). A hand edit is overwritten; a deleted profile is re-created.
 */
export async function reconcileJanitorReleaseBlock(input: {
  db?: DbClient;
  instance: ArrKind;
  profiles: JanitorReleaseProfileClient;
  add?: readonly JanitorBlockEntry[];
  now?: Date;
  logger?: BlockLogger;
}): Promise<JanitorBlockReconcileReport> {
  const { instance, profiles } = input;
  const now = input.now ?? new Date();
  const t = arrQueueCleanupBlockTerms;
  try {
    return await inTransaction(input.db, async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${blockLockKey(instance)})`);

      // 1 — the new blocks.
      const add = input.add ?? [];
      if (!add.every((e) => isWholeNameTerm(e.term))) {
        throw new JanitorReleaseBlockError(instance, 'validate');
      }
      if (add.length > 0) {
        const expiresAt = new Date(now.getTime() + JANITOR_BLOCK_TERM_LIFETIME_DAYS * DAY_MS);
        await tx.insert(t).values(
          add.map((e) => ({
            instance,
            term: e.term,
            releaseTitle: e.releaseTitle,
            downloadId: e.downloadId,
            targetId: e.targetId,
            createdAt: now,
            expiresAt,
          })),
        );
      }

      // 2 — the desired state, the cap, the grammar.
      const terms = await readLiveBlockTerms(tx, instance, now);
      const live = terms.slice(0, JANITOR_BLOCK_TERM_CAP);
      const pruned = terms.length - live.length;
      if (pruned > 0) input.logger?.warn?.('[queue-cleanup] block_pruned', { instance, terms: pruned });
      const desired = [JANITOR_BLOCK_SENTINEL, ...live];
      if (!desired.every(isJanitorBlockTerm)) throw new JanitorReleaseBlockError(instance, 'validate');

      // 3 — the profile.
      let current: JanitorReleaseProfile[];
      try {
        current = (await profiles.listReleaseProfiles()).filter(isJanitorProfile);
      } catch (cause) {
        throw new JanitorReleaseBlockError(instance, 'put', { cause });
      }
      if (current.length > 1) throw new JanitorReleaseBlockError(instance, 'duplicate_profile');
      const body: JanitorReleaseProfileBody = {
        enabled: true,
        required: [],
        ignored: desired,
        indexerId: 0,
        tags: [],
      };
      const mine = current[0];
      const before = new Set(mine?.ignored ?? []);
      const want = new Set(desired);
      let wrote = false;
      if (janitorBlockProfileDrift(current, desired) !== null) {
        try {
          if (mine === undefined) await profiles.createReleaseProfile(body);
          else await profiles.updateReleaseProfile({ ...body, id: mine.id });
        } catch (cause) {
          throw new JanitorReleaseBlockError(instance, 'put', { cause });
        }
        wrote = true;
      }

      // 4 — the read-back.
      let after: JanitorReleaseProfile[];
      try {
        after = (await profiles.listReleaseProfiles()).filter(isJanitorProfile);
      } catch (cause) {
        throw new JanitorReleaseBlockError(instance, 'read_back', { cause });
      }
      const back = new Set(after[0]?.ignored ?? []);
      if (after.length !== 1 || after[0]?.enabled !== true || !desired.every((x) => back.has(x))) {
        throw new JanitorReleaseBlockError(instance, 'read_back');
      }
      const report: JanitorBlockReconcileReport = {
        instance,
        total: live.length,
        added: [...want].filter((x) => !before.has(x) && x !== JANITOR_BLOCK_SENTINEL).length,
        removed: [...before].filter((x) => !want.has(x) && x !== JANITOR_BLOCK_SENTINEL).length,
        pruned,
        wrote,
      };
      input.logger?.info?.('[queue-cleanup] block_reconciled', { ...report });
      return report;
    });
  } catch (error) {
    if (error instanceof JanitorReleaseBlockError) {
      input.logger?.warn?.('[queue-cleanup] block_failed', { instance, step: error.step });
    }
    throw error;
  }
}

export interface JanitorBlockUpkeep {
  instance: ArrKind;
  /** How the profile differed from the records (null: it matched, or the janitor never blocked on this *arr). */
  drift: JanitorBlockDriftReason | 'cap' | null;
  report: JanitorBlockReconcileReport | null;
  error: string | null;
}

/**
 * D-14 — the hourly upkeep the janitor runs for each instance in JANITOR_BLOCK_KINDS, whatever its cells say: when the
 * janitor has ever blocked a release there, one `GET /releaseprofile` compares the profile with the records, and a
 * drift (an expired term still present, a hand edit, a disabled, deleted or copied profile, the cap) runs the
 * reconcile. Logged `[queue-cleanup] block_drift` (warn). Nothing is created on an *arr the janitor never blocked on.
 * Best effort: a failure is `[queue-cleanup] block_upkeep_failed` (warn), never the run's failure.
 */
export async function reconcileJanitorReleaseBlockIfDue(input: {
  db?: DbClient;
  instance: ArrKind;
  profiles: JanitorReleaseProfileClient;
  now?: Date;
  logger?: BlockLogger;
}): Promise<JanitorBlockUpkeep> {
  const db = resolveDb(input.db);
  const now = input.now ?? new Date();
  const out: JanitorBlockUpkeep = { instance: input.instance, drift: null, report: null, error: null };
  try {
    const t = arrQueueCleanupBlockTerms;
    const [any] = await db
      .select({ id: t.id })
      .from(t)
      .where(eq(t.instance, input.instance))
      .limit(1);
    if (!any) return out;
    const live = await readLiveBlockTerms(db, input.instance, now);
    if (live.length > JANITOR_BLOCK_TERM_CAP) {
      out.drift = 'cap';
    } else {
      const drift = janitorBlockProfileDrift(await input.profiles.listReleaseProfiles(), [
        JANITOR_BLOCK_SENTINEL,
        ...live,
      ]);
      if (drift !== null) {
        out.drift = drift.reason;
        input.logger?.warn?.('[queue-cleanup] block_drift', {
          instance: input.instance,
          reason: drift.reason,
          missingTerms: drift.missingTerms,
          extraTerms: drift.extraTerms,
        });
      }
    }
    if (out.drift !== null) {
      out.report = await reconcileJanitorReleaseBlock({
        db,
        instance: input.instance,
        profiles: input.profiles,
        now,
        logger: input.logger,
      });
    }
  } catch (error) {
    out.error = error instanceof Error ? error.message : String(error);
    input.logger?.warn?.('[queue-cleanup] block_upkeep_failed', {
      instance: input.instance,
      drift: out.drift,
      error: out.error,
    });
  }
  return out;
}

/** D-07 + D-14 — the digest's block line for one instance: blocks written in the window and the live terms. */
export async function janitorBlockDigest(input: {
  db?: DbClient;
  now?: Date;
}): Promise<Array<{ instance: ArrKind; blocked24h: number; live: number }>> {
  const db = resolveDb(input.db);
  const now = input.now ?? new Date();
  const t = arrQueueCleanupBlockTerms;
  const since = new Date(now.getTime() - DAY_MS);
  const rows = await db
    .select({
      instance: t.instance,
      blocked24h: sql<number>`count(*) filter (where ${t.createdAt} >= ${since.toISOString()}::timestamptz)::int`,
      live: sql<number>`count(distinct ${t.term}) filter (where ${t.expiresAt} > ${now.toISOString()}::timestamptz)::int`,
    })
    .from(t)
    .where(gte(t.expiresAt, since))
    .groupBy(t.instance)
    .orderBy(desc(t.instance));
  return rows
    .map((r) => ({ instance: r.instance, blocked24h: Number(r.blocked24h), live: Number(r.live) }))
    .filter((r) => r.blocked24h > 0 || r.live > 0)
    .sort((a, b) => a.instance.localeCompare(b.instance));
}
