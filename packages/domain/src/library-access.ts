// ADR-047 / DESIGN-025 (PLAN-028 — Library "Watch/Listen/Read here" deep links). THE INVARIANT: a user
// must NEVER receive a Library item that lives in a Plex library their role cannot access. This module is
// the SERVER-SIDE gate that enforces it. It REUSES the existing effective-library-access resolver
// (effectiveAllowedLibrariesForUser — ADR-024 role_library_grants + role_plex_server_all_grants + admin-
// implies-all), it does NOT reinvent access logic. It adds the *arr-ledger bridge media_items lacks:
//
//   • MATCHED item  → gated by its EXACT Plex library (media_plex_matches.plex_library_id). Precise: an
//     item that matched into a library the role can't access is hidden even if the kind's home is allowed.
//   • UNMATCHED item (no Plex match yet) → gated by its (arr_kind, arr_instance) HOME library, the modal
//     library the kind's matched items cluster in (each *arr feeds one Plex library). Hidden ONLY by
//     access (its home is inaccessible), NEVER by match-failure — PLAN-028's rule for present-but-unmatched.
//   • ADMIN → `unrestricted`: sees everything (admin implies all libraries — the resolver short-circuit).
//
// Cold-start note: if a kind has ZERO matches (home unresolved), it is deny-by-default (the safe direction
// for the invariant — never leak) until the plex-match sync populates ≥1 match for it; the deploy runs the
// sync before members rely on it, and admins are always unrestricted.
import {
  ARR_KINDS,
  mediaItems,
  mediaPlexMatches,
  roles,
  users,
  type ArrKind,
  type DbClient,
} from '@hnet/db';
import { eq, isNull, sql } from 'drizzle-orm';
import { resolveDb } from './db-client';
import { effectiveAllowedLibrariesForUser } from './effective-allowed-libraries';

/** Separator for the (arr_kind, arr_instance) home-library key. Neither field can contain it. */
export const LIBRARY_KIND_KEY_SEP = ':';

/** The stable key a home-library map / the SQL predicate use for a (kind, instance) pair. */
export function libraryKindKey(arrKind: string, arrInstanceId: string): string {
  return `${arrKind}${LIBRARY_KIND_KEY_SEP}${arrInstanceId}`;
}

export interface LibraryAccessGate {
  /** Admin ⇒ true: the caller sees every item; the WHERE/JS gate is a no-op. */
  unrestricted: boolean;
  /** plex_libraries.id the caller's role can access (ADR-024 effective allowed set). */
  allowedLibraryIds: Set<string>;
  /** `${arrKind}:${arrInstanceId}` whose HOME Plex library is accessible — gates UNMATCHED items. */
  allowedKindKeys: Set<string>;
  /** arr_kinds with ≥1 accessible home ⇒ the Movies/TV/Music tab is shown (server-side tab hiding). */
  visibleArrKinds: Set<ArrKind>;
}

/**
 * Resolve the caller's Library access gate. Admin ⇒ unrestricted. Otherwise: the effective allowed Plex
 * libraries (ADR-024) + the per-(kind,instance) HOME library derived from the current match set, filtered
 * to homes the role can access. One small admin-check query + the ADR-024 resolver + one grouped derive.
 */
export async function resolveLibraryAccessGate(
  userId: string,
  dbc?: DbClient,
): Promise<LibraryAccessGate> {
  const q = resolveDb(dbc);

  const [u] = await q
    .select({ isAdmin: roles.isAdmin })
    .from(users)
    .innerJoin(roles, eq(roles.id, users.roleId))
    .where(eq(users.id, userId));

  if (u?.isAdmin === true) {
    return {
      unrestricted: true,
      allowedLibraryIds: new Set(),
      allowedKindKeys: new Set(),
      visibleArrKinds: new Set(ARR_KINDS),
    };
  }

  const libs = await effectiveAllowedLibrariesForUser(userId, dbc);
  const allowedLibraryIds = new Set(libs.map((l) => l.libraryId));

  // The CANDIDATE libraries per (arr_kind, arr_instance): the set of Plex libraries that kind's matched
  // items appear in (a kind can span several — e.g. Movies mirrored across two servers). An UNMATCHED
  // item of that kind will, once Plex imports it, land in one of these — so it is accessible iff the role
  // can access AT LEAST ONE candidate. Live (non-tombstoned) items only.
  const candidateRows = await q
    .select({
      arrKind: mediaItems.arrKind,
      arrInstanceId: mediaItems.arrInstanceId,
      plexLibraryId: mediaPlexMatches.plexLibraryId,
    })
    .from(mediaPlexMatches)
    .innerJoin(mediaItems, eq(mediaItems.id, mediaPlexMatches.mediaItemId))
    .where(isNull(mediaItems.deletedFromArrAt))
    .groupBy(mediaItems.arrKind, mediaItems.arrInstanceId, mediaPlexMatches.plexLibraryId);

  const candidatesByKind = new Map<string, Set<string>>();
  for (const r of candidateRows) {
    const key = libraryKindKey(r.arrKind, r.arrInstanceId);
    (candidatesByKind.get(key) ?? candidatesByKind.set(key, new Set()).get(key)!).add(r.plexLibraryId);
  }

  const allowedKindKeys = new Set<string>();
  const visibleArrKinds = new Set<ArrKind>();
  for (const [key, libIds] of candidatesByKind) {
    if ([...libIds].some((id) => allowedLibraryIds.has(id))) {
      allowedKindKeys.add(key);
      visibleArrKinds.add(key.split(LIBRARY_KIND_KEY_SEP)[0] as ArrKind);
    }
  }

  return { unrestricted: false, allowedLibraryIds, allowedKindKeys, visibleArrKinds };
}

/**
 * The single-item accessibility check (the same rule the SQL predicate enforces, in JS): used by the
 * detail / events / children / poster-proxy paths, which fetch one item by id and must re-gate it so a
 * hidden item can't be reached by direct id. `matchLibraryIds` = every Plex library the item matched into
 * (empty ⇒ unmatched). Matched ⇒ accessible iff the role can access AT LEAST ONE of them; unmatched ⇒
 * accessible iff its kind's home is accessible; admin ⇒ always.
 */
export function isMediaItemAccessible(
  gate: LibraryAccessGate,
  item: { arrKind: string; arrInstanceId: string; matchLibraryIds: string[] },
): boolean {
  if (gate.unrestricted) return true;
  if (item.matchLibraryIds.length > 0) {
    return item.matchLibraryIds.some((id) => gate.allowedLibraryIds.has(id));
  }
  return gate.allowedKindKeys.has(libraryKindKey(item.arrKind, item.arrInstanceId));
}

/**
 * ADR-047 / Q-C — the web deep link to a Plex title:
 * `https://app.plex.tv/desktop/#!/server/<machineIdentifier>/details?key=%2Flibrary%2Fmetadata%2F<ratingKey>`.
 * Reliable cross-platform; hands off to the native Plex app where installed.
 */
export function buildPlexWebDeepLink(machineIdentifier: string, ratingKey: string): string {
  const key = encodeURIComponent(`/library/metadata/${ratingKey}`);
  return `https://app.plex.tv/desktop/#!/server/${machineIdentifier}/details?key=${key}`;
}
