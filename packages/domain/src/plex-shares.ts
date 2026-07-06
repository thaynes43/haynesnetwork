// ADR-017 / DESIGN-007 D-04 — the Plex share orchestrators. shareLibrary / unshareLibrary
// apply a per-user library share on a server's plex.tv account, gated by the user's Role.
// Invariants:
//   1. ROLE GATE (TOCTOU): a share is applied only if the FRESH role-derived allowed set
//      (effectiveAllowedLibrariesForUser, re-derived here, not trusted from the client) still
//      contains the target — else LibraryNotAllowedError, BEFORE any Plex call. (Un-sharing is
//      always permitted: revoking access is the safe direction.)
//   2. READ-MERGE-WRITE (never blind-overwrite): the target user's CURRENT SharedServer is
//      read and the target section is unioned into / subtracted from their existing set, then
//      PUT (or POST for a new share / DELETE when the set empties). A blind overwrite would
//      revoke every OTHER library the user already has (haynestower has 40 real shares).
//   3. AUDIT: a plex_share_audit row (share_added/share_removed) is written AFTER a successful
//      Plex apply (single-shot — the ledger is append-only and records only applied shares;
//      the row's detail carries the preserved section set for the read-merge-write proof).
import {
  plexLibraries,
  plexServers,
  plexShareAudit,
  users,
  type DbClient,
  type PlexServerSlug,
  type PlexShareEvent,
} from '@hnet/db';
import { eq } from 'drizzle-orm';
import { PlexError } from '@hnet/plex';
import { resolveDb, inTransaction } from './db-client';
import {
  LibraryNotAllowedError,
  NotFoundError,
  PlexAccountUnmatchedError,
  PlexAllStateError,
  PlexServerUnavailableError,
} from './errors';
import {
  allGrantedServerIdsForUser,
  effectiveAllowedLibrariesForUser,
} from './effective-allowed-libraries';
import type { PlexClientBundle } from './plex-clients';

export interface ShareMutationInput {
  db?: DbClient;
  plex: PlexClientBundle;
  /** Whose Plex account is modified. */
  userId: string;
  /** plex_libraries.id — the library to share/unshare. */
  libraryId: string;
  /** Who initiated: the user (self-service) or an admin acting for them. */
  actorId: string;
}

export interface ShareMutationResult {
  changed: boolean;
  event: PlexShareEvent | null;
  libraryName: string;
  serverSlug: PlexServerSlug;
}

type Mode = 'add' | 'remove';

async function plexCall<T>(serverSlug: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof PlexError) {
      throw new PlexServerUnavailableError(`Plex server '${serverSlug}' is unavailable`, {
        cause: err,
      });
    }
    throw err;
  }
}

async function applyShare(input: ShareMutationInput, mode: Mode): Promise<ShareMutationResult> {
  const db = resolveDb(input.db);

  const [lib] = await db
    .select({
      libraryId: plexLibraries.id,
      sectionKey: plexLibraries.sectionKey,
      name: plexLibraries.name,
      serverSlug: plexServers.slug,
      serverName: plexServers.name,
      machineIdentifier: plexServers.machineIdentifier,
    })
    .from(plexLibraries)
    .innerJoin(plexServers, eq(plexServers.id, plexLibraries.serverId))
    .where(eq(plexLibraries.id, input.libraryId));
  if (!lib) throw new NotFoundError(`Plex library ${input.libraryId} not found`);

  const [u] = await db.select({ email: users.email }).from(users).where(eq(users.id, input.userId));
  if (!u) throw new NotFoundError(`User ${input.userId} not found`);

  // (1) role gate — re-derive the fresh allowed set (TOCTOU). Add only; remove is always ok.
  if (mode === 'add') {
    const allowed = await effectiveAllowedLibrariesForUser(input.userId, input.db);
    if (!allowed.some((l) => l.libraryId === input.libraryId)) {
      throw new LibraryNotAllowedError(
        `Library '${lib.name}' on ${lib.serverName} is not permitted by your role`,
      );
    }
  }

  const read = input.plex.read[lib.serverSlug];
  const write = input.plex.write[lib.serverSlug];

  // Map the app user → their Plex account (case-insensitive email; NO invite flow — Q-06).
  const friend = await plexCall(lib.serverSlug, () => read.findFriendByEmail(u.email));
  if (!friend) {
    throw new PlexAccountUnmatchedError(
      `${u.email} is not a Plex friend of the ${lib.serverName} account yet`,
    );
  }
  const plexUserId = Number(friend.id);

  // Map the server section key → the plex.tv section id the share body uses.
  const serverSections = await plexCall(lib.serverSlug, () => read.listServerSections());
  const target = serverSections.find((s) => s.key === lib.sectionKey);
  if (!target) {
    throw new PlexServerUnavailableError(
      `Library '${lib.name}' (section ${lib.sectionKey}) is not present on ${lib.serverSlug} right now`,
    );
  }
  const targetSectionId = Number(target.id);

  // (2) read-merge-write: the user's CURRENT shared section set is the base.
  const current = await plexCall(lib.serverSlug, () => read.findSharedServerForUser(friend.id));

  // ADR-024 — no silent demotion. When the account is currently in the plex.tv all-libraries state,
  // a per-library add (union) or remove (subtract) would PUT an explicit list and silently demote
  // the superset grant (future libraries would stop auto-appearing). Throw BEFORE any Plex write
  // for BOTH modes; the user must LEAVE All first (plex.setServerAll { on:false } — seeds the
  // explicit list with their current full set, no access loss) and then manage individual libraries.
  if (current?.allLibraries) {
    throw new PlexAllStateError(
      `Your ${lib.serverName} account currently has all libraries. Turn off “All libraries” for this server first, then add or remove individual libraries.`,
    );
  }

  const currentIds = current
    ? current.sections.filter((s) => s.shared).map((s) => Number(s.id))
    : [];

  let changed = false;
  let newIds = currentIds;
  if (mode === 'add') {
    if (!currentIds.includes(targetSectionId)) {
      newIds = [...currentIds, targetSectionId];
      if (current) {
        await plexCall(lib.serverSlug, () =>
          write.updateSharedServer({ sharedServerId: current.id, librarySectionIds: newIds }),
        );
      } else {
        await plexCall(lib.serverSlug, () =>
          write.createSharedServer({ invitedUserId: plexUserId, librarySectionIds: [targetSectionId] }),
        );
      }
      changed = true;
    }
  } else {
    if (current && currentIds.includes(targetSectionId)) {
      newIds = currentIds.filter((id) => id !== targetSectionId);
      if (newIds.length === 0) {
        await plexCall(lib.serverSlug, () => write.deleteSharedServer(current.id));
      } else {
        await plexCall(lib.serverSlug, () =>
          write.updateSharedServer({ sharedServerId: current.id, librarySectionIds: newIds }),
        );
      }
      changed = true;
    }
  }

  const event: PlexShareEvent | null = changed
    ? mode === 'add'
      ? 'share_added'
      : 'share_removed'
    : null;

  // (3) audit the applied change (single-shot — after the Plex write succeeds).
  if (changed && event) {
    await inTransaction(input.db, async (tx) => {
      await tx.insert(plexShareAudit).values({
        userId: input.userId,
        plexLibraryId: input.libraryId,
        event,
        actorId: input.actorId,
        detail: {
          server_slug: lib.serverSlug,
          library_name: lib.name,
          section_key: lib.sectionKey,
          plex_section_id: targetSectionId,
          self: input.actorId === input.userId,
          previous_section_ids: currentIds,
          new_section_ids: newIds,
        },
      });
    });
  }

  return { changed, event, libraryName: lib.name, serverSlug: lib.serverSlug };
}

/** Self-add (or admin-add for) a library share on the user's Plex account (role-gated). */
export function shareLibrary(input: ShareMutationInput): Promise<ShareMutationResult> {
  return applyShare(input, 'add');
}

/** Remove a library share from the user's Plex account (always permitted — revokes access). */
export function unshareLibrary(input: ShareMutationInput): Promise<ShareMutationResult> {
  return applyShare(input, 'remove');
}

export interface ServerAllShareInput {
  db?: DbClient;
  plex: PlexClientBundle;
  /** Whose Plex account is toggled. */
  userId: string;
  /** plex_servers.id — the server whose all-libraries flag to toggle for the user. */
  serverId: string;
  /** true = enter the plex.tv all-libraries state; false = leave it (demote to explicit full set). */
  on: boolean;
  /** Who initiated: the user (self-service) or an admin acting for them. */
  actorId: string;
}

export interface ServerAllShareResult {
  changed: boolean;
  event: PlexShareEvent | null;
  serverSlug: PlexServerSlug;
  /** The resulting all-libraries state (== `on`, idempotent no-ops included). */
  allActive: boolean;
}

/**
 * ADR-024 — self-toggle (or admin-toggle for) the server-wide all-libraries state on the user's own
 * Plex account. Role-gated: the user's role must hold an all-libraries grant on the server
 * (re-derived here INSIDE the call — TOCTOU; Admin implicitly all-grants every server). Turning it
 * ON share-everything (incl. future libraries); turning it OFF demotes to an EXPLICIT list seeded
 * with the account's CURRENT FULL section set (all of the server's sections) so no access is lost.
 * Audited in plex_share_audit (share_all_enabled / share_all_disabled) after a successful apply.
 */
export async function setServerAllShare(input: ServerAllShareInput): Promise<ServerAllShareResult> {
  const db = resolveDb(input.db);

  const [srv] = await db
    .select({
      id: plexServers.id,
      slug: plexServers.slug,
      name: plexServers.name,
    })
    .from(plexServers)
    .where(eq(plexServers.id, input.serverId));
  if (!srv) throw new NotFoundError(`Plex server ${input.serverId} not found`);

  const [u] = await db.select({ email: users.email }).from(users).where(eq(users.id, input.userId));
  if (!u) throw new NotFoundError(`User ${input.userId} not found`);

  // Role gate (TOCTOU): the fresh all-granted server set must contain this server (Admin ⇒ all).
  const allGranted = await allGrantedServerIdsForUser(input.userId, input.db);
  if (!allGranted.has(srv.id)) {
    throw new LibraryNotAllowedError(
      `Your role does not grant all-libraries access on ${srv.name}.`,
    );
  }

  const read = input.plex.read[srv.slug];
  const write = input.plex.write[srv.slug];

  const friend = await plexCall(srv.slug, () => read.findFriendByEmail(u.email));
  if (!friend) {
    throw new PlexAccountUnmatchedError(
      `${u.email} is not a Plex friend of the ${srv.name} account yet`,
    );
  }
  const plexUserId = Number(friend.id);

  const current = await plexCall(srv.slug, () => read.findSharedServerForUser(friend.id));
  const currentlyAll = current?.allLibraries ?? false;

  let changed = false;
  let event: PlexShareEvent | null = null;
  const detail: Record<string, unknown> = {
    server_slug: srv.slug,
    server_name: srv.name,
    self: input.actorId === input.userId,
    previous_all: currentlyAll,
    new_all: input.on,
  };

  if (input.on && !currentlyAll) {
    await plexCall(srv.slug, () =>
      write.updateSharedServerAll({
        sharedServerId: current?.id ?? null,
        invitedUserId: plexUserId,
        on: true,
      }),
    );
    changed = true;
    event = 'share_all_enabled';
  } else if (!input.on && currentlyAll) {
    // Demote — seed the explicit list with the account's CURRENT FULL section set (every section
    // on the server) so leaving All loses no access. current.id is set (currentlyAll ⇒ a share).
    const serverSections = await plexCall(srv.slug, () => read.listServerSections());
    const seededSectionIds = serverSections.map((s) => Number(s.id));
    await plexCall(srv.slug, () =>
      write.updateSharedServerAll({
        sharedServerId: current!.id,
        invitedUserId: plexUserId,
        on: false,
        librarySectionIds: seededSectionIds,
      }),
    );
    detail.seeded_section_ids = seededSectionIds;
    changed = true;
    event = 'share_all_disabled';
  }

  if (changed && event) {
    await inTransaction(input.db, async (tx) => {
      await tx.insert(plexShareAudit).values({
        userId: input.userId,
        plexLibraryId: null,
        event,
        actorId: input.actorId,
        detail,
      });
    });
  }

  return { changed, event, serverSlug: srv.slug, allActive: input.on };
}
