// ADR-017 / DESIGN-007 D-04 — the admin registry refresh. Reads each server's live
// `GET /library/sections` (+ `/identity`) via the @hnet/plex READ client and upserts
// plex_servers/plex_libraries keyed on (server_id, section_key) — NEVER name (Q-03: two
// servers mirror `Movies` under different names; identity is (server, key)). A library that
// no longer appears is marked `available = false` (soft-state — keeps role_library_grants +
// share audit intact), never hard-deleted. Registry tables are on the no-direct-writes guard,
// so this write path lives in packages/domain (admin-only orchestrator).
import {
  plexLibraries,
  plexServers,
  PLEX_MEDIA_TYPES,
  type DbClient,
  type PlexMediaType,
  type PlexServerSlug,
} from '@hnet/db';
import { and, asc, eq, notInArray, sql } from 'drizzle-orm';
import { PlexError } from '@hnet/plex';
import { resolveDb, inTransaction } from './db-client';
import { NotFoundError, PlexServerUnavailableError } from './errors';
import type { PlexClientBundle } from './plex-clients';

export interface UpsertPlexLibrariesInput {
  db?: DbClient;
  slug: PlexServerSlug;
  libraries: Array<{ sectionKey: string; name: string; mediaType: PlexMediaType }>;
}

/**
 * ADR-017 D-04 — the client-free upsert core the registry refresh runs and the e2e/dev:local
 * seed uses to populate plex_libraries deterministically (the seed runs before the stub Plex is
 * up, so it can't refresh). Upserts keyed on (server_id, section_key); does NOT mark vanished
 * libraries unavailable (that is refresh's job). A guarded write — lives in packages/domain.
 */
export async function upsertPlexLibraries(input: UpsertPlexLibrariesInput): Promise<void> {
  const db = resolveDb(input.db);
  const [server] = await db
    .select({ id: plexServers.id })
    .from(plexServers)
    .where(eq(plexServers.slug, input.slug));
  if (!server) throw new NotFoundError(`Plex server '${input.slug}' not found`);
  await inTransaction(input.db, async (tx) => {
    for (const lib of input.libraries) {
      await tx
        .insert(plexLibraries)
        .values({
          serverId: server.id,
          sectionKey: lib.sectionKey,
          name: lib.name,
          mediaType: lib.mediaType,
          available: true,
        })
        .onConflictDoUpdate({
          target: [plexLibraries.serverId, plexLibraries.sectionKey],
          set: { name: lib.name, mediaType: lib.mediaType, available: true, syncedAt: sql`now()` },
        });
    }
  });
}

export interface RefreshPlexRegistryInput {
  db?: DbClient;
  plex: PlexClientBundle;
  /** Restrict to one or more servers; default = every registered server. */
  slugs?: PlexServerSlug[];
}

export interface RefreshedServer {
  slug: PlexServerSlug;
  serverId: string;
  machineIdentifier: string;
  upserted: number;
  markedUnavailable: number;
}

export interface RefreshPlexRegistryResult {
  servers: RefreshedServer[];
}

const isPlexMediaType = (t: string): t is PlexMediaType =>
  (PLEX_MEDIA_TYPES as readonly string[]).includes(t);

/**
 * Refresh the Plex library registry from the live servers. External reads happen OUTSIDE the
 * transaction (one server at a time); the per-server upsert + soft-unavailable pass + machine
 * identifier update run in ONE transaction so a partial refresh never leaves half-synced rows.
 */
export async function refreshPlexRegistry(
  input: RefreshPlexRegistryInput,
): Promise<RefreshPlexRegistryResult> {
  const db = resolveDb(input.db);

  const serverRows = await db
    .select({ id: plexServers.id, slug: plexServers.slug, machineIdentifier: plexServers.machineIdentifier })
    .from(plexServers)
    .orderBy(asc(plexServers.slug));
  const targets = input.slugs
    ? serverRows.filter((s) => input.slugs!.includes(s.slug))
    : serverRows;

  const results: RefreshedServer[] = [];
  for (const server of targets) {
    const client = input.plex.read[server.slug];

    // ---- external reads (outside the tx) ----
    let sections: Awaited<ReturnType<typeof client.listSections>>;
    let machineIdentifier = server.machineIdentifier;
    try {
      sections = await client.listSections();
      const identity = await client.getIdentity();
      if (identity.machineIdentifier) machineIdentifier = identity.machineIdentifier;
    } catch (err) {
      if (err instanceof PlexError) {
        throw new PlexServerUnavailableError(
          `Plex server '${server.slug}' is unavailable during registry refresh`,
          { cause: err },
        );
      }
      throw err;
    }

    // Validate media types up front (loud failure beats a raw CHECK violation mid-tx).
    for (const s of sections) {
      if (!isPlexMediaType(s.type)) {
        throw new PlexServerUnavailableError(
          `Plex server '${server.slug}' library '${s.title}' has unexpected media type '${s.type}' — add it to PLEX_MEDIA_TYPES`,
        );
      }
    }

    // ---- one write transaction per server ----
    const seenKeys = sections.map((s) => s.key);
    const outcome = await inTransaction(input.db, async (tx) => {
      for (const s of sections) {
        await tx
          .insert(plexLibraries)
          .values({
            serverId: server.id,
            sectionKey: s.key,
            name: s.title,
            mediaType: s.type as PlexMediaType,
            available: true,
          })
          .onConflictDoUpdate({
            target: [plexLibraries.serverId, plexLibraries.sectionKey],
            set: {
              name: s.title,
              mediaType: s.type as PlexMediaType,
              available: true,
              syncedAt: sql`now()`,
            },
          });
      }

      // Soft-state: any still-available library not seen this refresh is now unavailable.
      const unavailableWhere =
        seenKeys.length > 0
          ? and(
              eq(plexLibraries.serverId, server.id),
              eq(plexLibraries.available, true),
              notInArray(plexLibraries.sectionKey, seenKeys),
            )
          : and(eq(plexLibraries.serverId, server.id), eq(plexLibraries.available, true));
      const gone = await tx
        .update(plexLibraries)
        .set({ available: false, syncedAt: sql`now()` })
        .where(unavailableWhere)
        .returning({ id: plexLibraries.id });

      await tx
        .update(plexServers)
        .set({ machineIdentifier, updatedAt: sql`now()` })
        .where(eq(plexServers.id, server.id));

      return { upserted: sections.length, markedUnavailable: gone.length };
    });

    results.push({
      slug: server.slug,
      serverId: server.id,
      machineIdentifier,
      upserted: outcome.upserted,
      markedUnavailable: outcome.markedUnavailable,
    });
  }

  return { servers: results };
}
