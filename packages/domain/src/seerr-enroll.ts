// ADR-093 C-11 / DESIGN-052 D-17 / D-21 (PLAN-072) — EVERYONE'S SEERR WATCHLIST (T-266): the app turns on Seerr's
// watchlist sync (movies and TV) for every Seerr Plex user, once per user, behind the audited `seerr_watchlist_enroll`
// setting, which starts off (PLAN-072 S9 enables it after the guard and the Release Block are verified and seeded).
//
// - Enroll once, respect an opt-out (driver decision, Q-08): a user with a row is never written again; a daily re-check
//   notes a user who turned sync off (`optout_observed_at`, logged once) and leaves them off.
// - The Seerr write echoes the user's whole settings body (Seerr 3.4.1 assigns name, locale, regions and quotas from
//   the body), through the confined `SeerrWriteClient` (@hnet/arr/write, packages/domain only; hard rule 4 amended by
//   ADR-093 C-08). The row is written only after the external write succeeded and its response shows both flags on
//   (the Authentik-apply precedent, ADR-045).
// - The anime-tags preflight (D-17, PLAN-072 S9 step 1): Seerr tags a Sonarr add with its `animeTags` for an anime
//   series, empty on this install; `setSeerrSonarrAnimeTags` sets them (one PUT echoing the whole server object, read
//   back), run once by the coordinator through the `seerr-watchlist` script.
//
// Never logged: a user's name or email (only the Seerr user id), a token, the settings body.
import {
  ARR_CLUSTER_URL_DEFAULTS,
  ArrConfigError,
  ArrHttpError,
  type SeerrUserSummary,
} from '@hnet/arr';
import { SeerrClient } from '@hnet/arr/read';
import { SeerrWriteClient } from '@hnet/arr/write';
import { seerrWatchlistEnrollments, type DbClient } from '@hnet/db';
import { and, eq, isNull, lt } from 'drizzle-orm';
import { getAppSetting, setAppSetting, type SeerrWatchlistEnrollSetting } from './app-settings';
import { resolveDb } from './db-client';
import { consoleDomainLogger, type DomainLogger } from './domain-logger';

/** D-17 — an enrolled user's flags are re-checked this often (an opt-out is noted, never undone). */
export const SEERR_ENROLL_RECHECK_H = 24;

export interface SeerrEnrollClients {
  read: Pick<SeerrClient, 'listUsers' | 'getUserWatchlistSync' | 'listSonarrServers'>;
  write: Pick<SeerrWriteClient, 'setWatchlistSync' | 'setSonarrAnimeTags'>;
}

/** The Seerr enrollment clients from env (SEERR_URL / SEERR_API_KEY), or null when Seerr is not configured. */
export function seerrEnrollClientsFromEnv(
  env: Record<string, string | undefined> = process.env,
): SeerrEnrollClients | null {
  const apiKey = env.SEERR_API_KEY?.trim();
  if (!apiKey) return null;
  const options = {
    baseUrl: env.SEERR_URL?.trim() || ARR_CLUSTER_URL_DEFAULTS.seerr,
    apiKey,
    timeoutMs: 10_000,
  };
  return { read: new SeerrClient(options), write: new SeerrWriteClient(options) };
}

/** Like `seerrEnrollClientsFromEnv`, but throws (naming the variable) when SEERR_API_KEY is absent (the script). */
export function requireSeerrEnrollClientsFromEnv(
  env: Record<string, string | undefined> = process.env,
): SeerrEnrollClients {
  const clients = seerrEnrollClientsFromEnv(env);
  if (!clients) throw new ArrConfigError(['SEERR_API_KEY']);
  return clients;
}

/** The setting, per-field fail-safe: anything but `enabled === true` reads off; `onlyUserIds` must be integers. */
export async function getSeerrWatchlistEnroll(input: {
  db?: DbClient;
}): Promise<SeerrWatchlistEnrollSetting> {
  const raw = (await getAppSetting(input.db, 'seerr_watchlist_enroll')) as unknown;
  const value = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const ids = Array.isArray(value.onlyUserIds)
    ? value.onlyUserIds.filter((n): n is number => Number.isInteger(n) && (n as number) > 0)
    : null;
  return { enabled: value.enabled === true, onlyUserIds: ids };
}

/** The audited setting write (every change lands in permission_audit; actor null from the coordinator's script). */
export async function setSeerrWatchlistEnroll(input: {
  db?: DbClient;
  value: SeerrWatchlistEnrollSetting;
  actorId: string | null;
}): Promise<{ before: SeerrWatchlistEnrollSetting; after: SeerrWatchlistEnrollSetting }> {
  const onlyUserIds =
    input.value.onlyUserIds === null
      ? null
      : [...new Set(input.value.onlyUserIds.filter((n) => Number.isInteger(n) && n > 0))].sort(
          (a, b) => a - b,
        );
  if (onlyUserIds !== null && onlyUserIds.length === 0) {
    throw new Error(
      'seerr_watchlist_enroll: onlyUserIds must name at least one Seerr user (or be null for all)',
    );
  }
  const before = await getSeerrWatchlistEnroll({ db: input.db });
  const after: SeerrWatchlistEnrollSetting = { enabled: input.value.enabled === true, onlyUserIds };
  await setAppSetting({
    db: input.db,
    key: 'seerr_watchlist_enroll',
    value: after,
    actorId: input.actorId,
  });
  return { before, after };
}

export interface SeerrEnrollReport {
  status: 'disabled' | 'ok' | 'users_failed';
  enrolled: number;
  alreadyOn: number;
  failed: number;
  optoutsObserved: number;
  rechecked: number;
}

const statusOf = (error: unknown): number | string =>
  error instanceof ArrHttpError ? error.status : error instanceof Error ? error.name : 'error';

/**
 * D-17 — the enrollment step, run at the end of each `watchlist-registry` run while the setting is on. For every Seerr
 * Plex user (`userType` 1) with no enrollment row (and in `onlyUserIds` when set): read the flags; both on ⇒ insert the
 * row `already_on`; otherwise write both on (echoing the whole body) and insert the row only when the response shows
 * both on. A failure logs and is retried next run (no row). Then, once a day, re-check the enrolled users and note an
 * opt-out. Never throws for a single user.
 */
export async function enrollSeerrWatchlistSync(input: {
  db?: DbClient;
  seerr: SeerrEnrollClients;
  logger?: DomainLogger;
  now?: Date;
}): Promise<SeerrEnrollReport> {
  const db = resolveDb(input.db);
  const logger = input.logger ?? consoleDomainLogger;
  const now = input.now ?? new Date();
  const report: SeerrEnrollReport = {
    status: 'ok',
    enrolled: 0,
    alreadyOn: 0,
    failed: 0,
    optoutsObserved: 0,
    rechecked: 0,
  };
  const setting = await getSeerrWatchlistEnroll({ db: input.db });
  if (!setting.enabled) return { ...report, status: 'disabled' };

  let users: SeerrUserSummary[];
  try {
    users = await input.seerr.read.listUsers();
  } catch (error) {
    logger.warn('[seerr-enroll] failed', { seerrUserId: null, status: statusOf(error) });
    return { ...report, status: 'users_failed' };
  }
  const rows = await db.select().from(seerrWatchlistEnrollments);
  const known = new Set(rows.map((r) => r.seerrUserId));
  const only = setting.onlyUserIds === null ? null : new Set(setting.onlyUserIds);
  for (const user of users) {
    if (user.userType !== 1 || known.has(user.id)) continue;
    if (only !== null && !only.has(user.id)) continue;
    try {
      const flags = await input.seerr.read.getUserWatchlistSync(user.id);
      let alreadyOn = false;
      if (flags.movies && flags.tv) {
        alreadyOn = true;
      } else {
        const after = await input.seerr.write.setWatchlistSync(user.id, { movies: true, tv: true });
        if (!after.movies || !after.tv) {
          report.failed += 1;
          logger.warn('[seerr-enroll] failed', { seerrUserId: user.id, status: 'not_applied' });
          continue;
        }
      }
      await db
        .insert(seerrWatchlistEnrollments)
        .values({
          seerrUserId: user.id,
          plexAccountId: user.plexId,
          enrolledAt: now,
          alreadyOn,
          lastCheckedAt: now,
        })
        .onConflictDoNothing();
      if (alreadyOn) report.alreadyOn += 1;
      else report.enrolled += 1;
      logger.info('[seerr-enroll] enrolled', { seerrUserId: user.id, alreadyOn });
    } catch (error) {
      report.failed += 1;
      logger.warn('[seerr-enroll] failed', { seerrUserId: user.id, status: statusOf(error) });
    }
  }

  // The daily re-check: an opt-out is noted once and respected (never turned back on).
  const due = await db
    .select()
    .from(seerrWatchlistEnrollments)
    .where(
      and(
        isNull(seerrWatchlistEnrollments.optoutObservedAt),
        lt(
          seerrWatchlistEnrollments.lastCheckedAt,
          new Date(now.getTime() - SEERR_ENROLL_RECHECK_H * 3_600_000),
        ),
      ),
    );
  for (const row of due) {
    try {
      const flags = await input.seerr.read.getUserWatchlistSync(row.seerrUserId);
      report.rechecked += 1;
      const optedOut = !flags.movies || !flags.tv;
      await db
        .update(seerrWatchlistEnrollments)
        .set(optedOut ? { lastCheckedAt: now, optoutObservedAt: now } : { lastCheckedAt: now })
        .where(eq(seerrWatchlistEnrollments.seerrUserId, row.seerrUserId));
      if (optedOut) {
        report.optoutsObserved += 1;
        logger.info('[seerr-enroll] optout_observed', { seerrUserId: row.seerrUserId });
      }
    } catch (error) {
      logger.warn('[seerr-enroll] recheck_failed', {
        seerrUserId: row.seerrUserId,
        status: statusOf(error),
      });
    }
  }
  return report;
}

/** D-17 / D-10 — the enrollment counts for the Watchlists card (never a name). */
export async function getSeerrEnrollSummary(input: {
  db?: DbClient;
}): Promise<{
  setting: SeerrWatchlistEnrollSetting;
  enrolled: number;
  alreadyOn: number;
  optedOut: number;
}> {
  const db = resolveDb(input.db);
  const rows = await db
    .select({
      alreadyOn: seerrWatchlistEnrollments.alreadyOn,
      optout: seerrWatchlistEnrollments.optoutObservedAt,
    })
    .from(seerrWatchlistEnrollments);
  return {
    setting: await getSeerrWatchlistEnroll({ db: input.db }),
    enrolled: rows.filter((r) => !r.alreadyOn).length,
    alreadyOn: rows.filter((r) => r.alreadyOn).length,
    optedOut: rows.filter((r) => r.optout !== null).length,
  };
}

/**
 * D-17 (PLAN-072 S9 preflight step 1) — set Seerr's `animeTags` on one Sonarr server (one PUT echoing the whole server
 * object, then a read-back), so an anime series Seerr adds carries `mediarequests` like every other request and stays
 * out of the TV Trash pool. Returns the ids and tag lists before and after (never the server object).
 */
export async function setSeerrSonarrAnimeTags(input: {
  seerr: SeerrEnrollClients;
  serverId: number;
  animeTags: number[];
  logger?: DomainLogger;
}): Promise<{ serverId: number; before: number[]; after: number[]; tags: number[] }> {
  const logger = input.logger ?? consoleDomainLogger;
  const servers = await input.seerr.read.listSonarrServers();
  const server = servers.find((s) => s.id === input.serverId);
  if (!server) throw new Error(`seerr: no Sonarr server with id ${input.serverId}`);
  const tags = [...new Set(input.animeTags)].sort((a, b) => a - b);
  const saved = await input.seerr.write.setSonarrAnimeTags(input.serverId, tags);
  const after = saved.animeTags ?? [];
  if (after.length !== tags.length || !tags.every((t) => after.includes(t))) {
    throw new Error(
      `seerr: Sonarr server ${input.serverId} read back animeTags ${JSON.stringify(after)}`,
    );
  }
  const result = {
    serverId: input.serverId,
    before: server.animeTags ?? [],
    after,
    tags: saved.tags ?? [],
  };
  logger.info('[seerr-enroll] anime_tags_set', result);
  return result;
}
