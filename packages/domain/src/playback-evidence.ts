// ADR-109 / DESIGN-055 D-09 (PLAN-077 P1) — Playback Evidence (T-309): did this person's play of this title reach our
// servers in the last 48 hours? READ-ONLY. Read before a Won't play Fix (Case C: GoodFellas was a healthy file; the
// play most likely went to Plex's own free copy, so a Fix would have deleted 88 GB for nothing).
//
// Two sources, merged:
// 1. The Tautulli `play` / `stop` webhooks already stored as Feed notifications (DESIGN-012 D-02). Tautulli sends them
//    at session start, before its history drops sessions shorter than its minimum, so a play that failed at once still
//    shows. They name the person by Plex email and username, and the title by the ledger item and its ids. Since
//    PLAN-077 P1 the template also names the server (`server`); older rows have none.
// 2. Each Tautulli instance's history (`get_history`), filtered to the title's rating keys on that instance's server
//    and to the person's Plex username. It covers the instance that posts no webhook (HaynesTower) and names the
//    server by construction.
// A TV title is matched at the show level: the webhook rows carry the show's ids, not the episode's.
import {
  mediaItems,
  mediaPlexMatches,
  notifications,
  plexLibraries,
  plexServers,
  users,
  type DbClient,
  type PlexServerSlug,
} from '@hnet/db';
import type { TautulliHistoryRow } from '@hnet/arr';
import type { TautulliHistoryParams } from '@hnet/arr/read';
import { and, eq, gte, inArray, or, sql, type SQL } from 'drizzle-orm';
import { NotFoundError } from './errors';
import { resolveDb } from './db-client';
import { getKnownIssueServers } from './repair-guide-settings';

/** DESIGN-055 D-09 — how far back a play counts. */
export const PLAYBACK_EVIDENCE_WINDOW_HOURS = 48;

/** The Feed notification types that mean a playback session reached a server. */
export const PLAYBACK_EVENT_TYPES = ['play', 'stop', 'pause', 'resume', 'buffer', 'error', 'pberror'] as const;

/** One Tautulli instance's history read (the slug is its Plex server's). */
export interface PlaybackHistoryReader {
  slug: string;
  getHistory(params: TautulliHistoryParams): Promise<TautulliHistoryRow[]>;
}

export interface PlaybackPlay {
  at: string;
  /** The Plex server slug, or null when a webhook row predates the `server` field. */
  server: string | null;
  source: 'webhook' | 'history';
  /** The webhook's event (`play`, `stop`, ...), or null for a history row. */
  event: string | null;
}

export type PlaybackVerdict = 'no_play' | 'known_issue_server' | 'played';

export interface PlaybackEvidence {
  windowHours: number;
  plays: PlaybackPlay[];
  /** The distinct servers the plays reached (only those known). */
  servers: string[];
  knownIssueServers: PlexServerSlug[];
  /**
   * `no_play`: nothing reached our servers; `known_issue_server`: every play we can place reached a Known-Issue
   * Server (T-314); `played`: a play reached a server with no known issue (or one we cannot place).
   */
  verdict: PlaybackVerdict;
  /** Instances whose history could not be read (the verdict leans on the webhooks for them). */
  unreadServers: string[];
  /** Whether history could be matched to the person (it needs their Plex username). */
  historyMatched: boolean;
  /** Every Plex server's display name, by slug, for the guide's copy. */
  serverNames: Record<string, string>;
}

export interface PlaybackEvidenceInput {
  db?: DbClient;
  mediaItemId: string;
  requesterId: string;
  tautulli: readonly PlaybackHistoryReader[];
  now?: Date;
  windowHours?: number;
}

const lower = (s: string | null | undefined) => (s ?? '').trim().toLowerCase();

/**
 * Tautulli's `after` filter for an instant: a day earlier than its UTC date, because Tautulli compares by its own local
 * day. Rows are filtered again by time, so the extra day only costs a few rows.
 */
function afterDayFor(date: Date): string {
  return new Date(date.getTime() - 86_400_000).toISOString().slice(0, 10);
}

export async function readPlaybackEvidence(input: PlaybackEvidenceInput): Promise<PlaybackEvidence> {
  const db = resolveDb(input.db);
  const now = input.now ?? new Date();
  const windowHours = input.windowHours ?? PLAYBACK_EVIDENCE_WINDOW_HOURS;
  const since = new Date(now.getTime() - windowHours * 3_600_000);

  const [person] = await db
    .select({ email: users.email, plexEmail: users.plexEmail, plexUsername: users.plexUsername })
    .from(users)
    .where(eq(users.id, input.requesterId));
  if (!person) throw new NotFoundError(`User ${input.requesterId} not found`);
  const [item] = await db
    .select({ id: mediaItems.id, arrKind: mediaItems.arrKind, tmdbId: mediaItems.tmdbId, tvdbId: mediaItems.tvdbId })
    .from(mediaItems)
    .where(eq(mediaItems.id, input.mediaItemId));
  if (!item) throw new NotFoundError(`Media item ${input.mediaItemId} not found`);

  const servers = await db.select({ slug: plexServers.slug, name: plexServers.name }).from(plexServers);
  const slugByName = new Map(servers.map((s) => [lower(s.name), s.slug as string]));
  const knownSlugs = new Set(servers.map((s) => s.slug as string));

  const emails = [...new Set([lower(person.email), lower(person.plexEmail)].filter((e) => e !== ''))];
  const username = lower(person.plexUsername);

  // ---- 1. the stored Tautulli webhooks ----
  const titleMatch: SQL[] = [eq(notifications.mediaItemId, item.id)];
  if (item.arrKind === 'radarr' && item.tmdbId !== null) titleMatch.push(eq(notifications.tmdbId, item.tmdbId));
  if (item.arrKind === 'sonarr' && item.tvdbId !== null) titleMatch.push(eq(notifications.tvdbId, item.tvdbId));
  const personMatch: SQL[] = [];
  if (emails.length > 0) personMatch.push(inArray(sql`lower(${notifications.payload}->>'user_email')`, emails));
  if (username !== '') personMatch.push(sql`lower(${notifications.payload}->>'user') = ${username}`);
  const plays: PlaybackPlay[] = [];
  if (personMatch.length > 0) {
    const rows = await db
      .select({
        type: notifications.type,
        occurredAt: notifications.occurredAt,
        server: sql<string | null>`${notifications.payload}->>'server'`,
      })
      .from(notifications)
      .where(
        and(
          eq(notifications.source, 'tautulli'),
          inArray(notifications.type, [...PLAYBACK_EVENT_TYPES]),
          gte(notifications.occurredAt, since),
          or(...titleMatch),
          or(...personMatch),
        ),
      );
    for (const r of rows) {
      const slug = r.server ? (slugByName.get(lower(r.server)) ?? (knownSlugs.has(lower(r.server)) ? lower(r.server) : null)) : null;
      plays.push({ at: r.occurredAt.toISOString(), server: slug, source: 'webhook', event: r.type });
    }
  }

  // ---- 2. each Tautulli instance's history ----
  const unreadServers: string[] = [];
  const historyMatched = username !== '';
  if (historyMatched && input.tautulli.length > 0) {
    const keys = await db
      .select({ slug: plexServers.slug, ratingKey: mediaPlexMatches.ratingKey })
      .from(mediaPlexMatches)
      .innerJoin(plexLibraries, eq(plexLibraries.id, mediaPlexMatches.plexLibraryId))
      .innerJoin(plexServers, eq(plexServers.id, plexLibraries.serverId))
      .where(eq(mediaPlexMatches.mediaItemId, item.id));
    const sinceSeconds = Math.floor(since.getTime() / 1000);
    await Promise.all(
      input.tautulli.map(async (reader) => {
        const ratingKeys = [...new Set(keys.filter((k) => k.slug === reader.slug).map((k) => k.ratingKey))];
        if (ratingKeys.length === 0) return;
        try {
          for (const ratingKey of ratingKeys) {
            const rows = await reader.getHistory({
              ...(item.arrKind === 'sonarr' ? { grandparentRatingKey: ratingKey } : { ratingKey }),
              after: afterDayFor(since),
              length: 50,
              includeActivity: true,
              orderColumn: 'date',
              orderDir: 'desc',
            });
            for (const row of rows) {
              const at = row.started ?? row.date ?? null;
              if (at === null || at < sinceSeconds) continue;
              if (lower(row.user) !== username) continue;
              // The filter is Tautulli's; check the row is this title anyway (a reader may ignore the filter).
              const rowKey = item.arrKind === 'sonarr' ? row.grandparent_rating_key : row.rating_key;
              if (rowKey !== null && rowKey !== undefined && String(rowKey) !== ratingKey) continue;
              plays.push({ at: new Date(at * 1000).toISOString(), server: reader.slug, source: 'history', event: null });
            }
          }
        } catch {
          unreadServers.push(reader.slug);
        }
      }),
    );
  }

  plays.sort((a, b) => b.at.localeCompare(a.at));
  const reached = [...new Set(plays.map((p) => p.server).filter((s): s is string => s !== null))].sort();
  const knownIssueServers = await getKnownIssueServers(input.db);
  let verdict: PlaybackVerdict;
  if (plays.length === 0) verdict = 'no_play';
  else if (
    reached.length > 0 &&
    plays.every((p) => p.server === null || knownIssueServers.includes(p.server as PlexServerSlug)) &&
    reached.every((s) => knownIssueServers.includes(s as PlexServerSlug))
  ) {
    verdict = 'known_issue_server';
  } else verdict = 'played';
  return {
    windowHours,
    plays,
    servers: reached,
    knownIssueServers,
    verdict,
    unreadServers: unreadServers.sort(),
    historyMatched,
    serverNames: Object.fromEntries(servers.map((s) => [s.slug as string, s.name])),
  };
}
