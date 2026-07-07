// ADR-017 / DESIGN-007 D-05 — the plex router (claims the reserved `plex` name). Self-service
// add/remove is authedProcedure (own account only — the procedures take no userId, always
// ctx.user.id); the registry refresh + role-grant matrix are adminProcedure. Every mutating
// domain call is wrapped in mapDomainErrors so the D-13 appCodes reach the client; the Plex
// client bundle is injected via resolvePlexBundle (env singleton in prod, stub in tests).
import { asc, eq } from 'drizzle-orm';
import { plexLibraries, plexServers, roleLibraryGrants, rolePlexServerAllGrants, type PlexMediaType, type PlexServerSlug } from '@hnet/db';
import {
  allGrantedServerIdsForUser,
  effectiveAllowedLibrariesForUser,
  refreshPlexRegistry,
  setRoleLibraries,
  setServerAllShare,
  shareLibrary,
  unshareLibrary,
} from '@hnet/domain';
import { EMPTY_PLEX_IDENTITY, type PlexIdentity } from '@hnet/auth';
import { mapDomainErrors, resolvePlexBundle, router } from '../trpc';
import { authedProcedure } from '../trpc';
import { adminProcedure } from '../middleware/role';
import { PlexLibraryInput, RefreshRegistryInput, RoleLibrariesInput, ServerAllInput } from '../schemas';

/**
 * fix/plex-identity-mapping — does a plex.tv account (the server OWNER, from `/api/v2/user`) match
 * the caller? True when its email matches the caller's REAL Plex identity email OR their app/OIDC
 * email, OR its username matches the caller's Plex identity username — all case-insensitive,
 * null-safe. The app-email arm preserves the pre-fix behavior (accounts whose emails already
 * agree); the identity arms fix the owner whose Authentik email differs from their plex.tv email.
 */
function plexAccountMatchesCaller(
  account: { email: string | null; username: string | null },
  identity: PlexIdentity,
  appEmail: string,
): boolean {
  const accEmail = (account.email ?? '').trim().toLowerCase();
  const accUsername = (account.username ?? '').trim().toLowerCase();
  const emails = [identity.email, appEmail].map((e) => (e ?? '').trim().toLowerCase());
  const idUsername = (identity.username ?? '').trim().toLowerCase();
  return (
    (accEmail !== '' && emails.includes(accEmail)) ||
    (accUsername !== '' && idUsername !== '' && accUsername === idUsername)
  );
}

export interface MyLibrary {
  id: string;
  name: string;
  sectionKey: string;
  mediaType: PlexMediaType;
  shared: boolean;
}
export interface MyServer {
  /** plex_servers.id — the key the all-libraries toggle (plex.setServerAll) addresses. */
  id: string;
  slug: PlexServerSlug;
  name: string;
  /** false when the server (or plex.tv) was unreachable while resolving live share state. */
  available: boolean;
  /**
   * ADR-029 — the caller IS this server's Plex OWNER account (the token account). Owners are never
   * in their own friend list, so friend-matching structurally can't match them; when true every
   * library is implicitly theirs and no add/remove/friend controls apply. Detected via plex.tv
   * `GET /api/v2/user`, matched by the caller's REAL Plex identity (id_token claim / admin override)
   * OR their app email (fix/plex-identity-mapping); degrades to `false` (the friend flow) if that
   * lookup fails.
   */
  owner: boolean;
  /**
   * false when the caller matches neither the server OWNER nor any Plex friend on the server
   * account — e.g. a local Authentik account with no Plex identity (Q-06). Matching resolves the
   * caller's real Plex identity (email OR username), falling back to the app email. Always true for
   * the owner (owner takes precedence; the friend lookup is skipped).
   */
  friendMatched: boolean;
  /**
   * ADR-024 — the caller's ROLE grants all-libraries on this server, so they may self-toggle their
   * account between the plex.tv all-libraries state and an explicit per-section list. When false,
   * they can only add/remove the individual libraries their role grants (unchanged from before).
   */
  allGranted: boolean;
  /**
   * ADR-024 — the caller's Plex account is CURRENTLY in the all-libraries state on this server
   * (`allLibraries="1"` — share-everything, incl. future libraries). While true, every library
   * reports `shared` and per-library add/remove is refused (PLEX_ALL_STATE) — the user must leave
   * All first. Toggled via plex.setServerAll.
   */
  allActive: boolean;
  libraries: MyLibrary[];
}

export const plexRouter = router({
  /**
   * The caller's role-allowed libraries grouped by server, each annotated with whether they
   * currently share it (live from the read client). Per server also surfaces `owner` (the caller
   * IS this server's Plex owner — ADR-029; every library is implicitly theirs, no controls apply),
   * `allGranted` (the role grants all-libraries here — ADR-024) and `allActive` (the account is
   * currently in the plex.tv all-libraries state). Degrades gracefully per server: a Plex outage
   * marks that server `available: false` rather than failing the whole page.
   */
  myLibraries: authedProcedure.query(async ({ ctx }): Promise<{ servers: MyServer[] }> => {
    const libs = await effectiveAllowedLibrariesForUser(ctx.user.id, ctx.db);
    const allGrantedServerIds = await allGrantedServerIdsForUser(ctx.user.id, ctx.db);
    const bundle = resolvePlexBundle(ctx);

    const groups = new Map<
      PlexServerSlug,
      { id: string; name: string; libs: Array<(typeof libs)[number]> }
    >();
    for (const lib of libs) {
      const g = groups.get(lib.serverSlug) ?? { id: lib.serverId, name: lib.serverName, libs: [] };
      g.libs.push(lib);
      groups.set(lib.serverSlug, g);
    }

    const appEmail = ctx.user.email.trim().toLowerCase();
    // fix/plex-identity-mapping — the caller's REAL Plex identity (id_token claim → admin override),
    // NOT the OIDC email. Owner + friend matching resolve against it, falling back to the app email.
    const identity = ctx.user.plexIdentity ?? EMPTY_PLEX_IDENTITY;
    const servers: MyServer[] = [];
    for (const [slug, group] of groups) {
      let available = true;
      let owner = false;
      let friendMatched = true;
      let allActive = false;
      const sharedKeys = new Set<string>();
      try {
        const read = bundle.read[slug];
        // ADR-029 — the server OWNER (the token account) is never in their own friend list, so
        // friend-matching can't match them. Detect the owner explicitly via plex.tv /api/v2/user;
        // if that lookup fails, degrade to the friend flow (today's behavior) rather than breaking
        // the page. fix/plex-identity-mapping: match the owner account by the caller's real Plex
        // identity (email OR username) — the owner's Authentik email (admin@haynesnetwork.com)
        // differs from their plex.tv email (manofoz@gmail.com), so app-email matching missed them.
        let ownerAccount: { email: string | null; username: string | null } | null = null;
        try {
          ownerAccount = await read.getOwnerAccount();
        } catch {
          ownerAccount = null;
        }
        if (ownerAccount && plexAccountMatchesCaller(ownerAccount, identity, appEmail)) {
          // The owner implicitly has every library — no friend/share lookup applies.
          owner = true;
        } else {
          const friend = await read.findFriendByIdentity(identity, ctx.user.email);
          if (!friend) {
            friendMatched = false;
          } else {
            const current = await read.findSharedServerForUser(friend.id);
            if (current) {
              // In the all-libraries state every library (incl. future ones) is shared; surface the
              // live flag and treat every library as shared (ADR-024).
              allActive = current.allLibraries;
              for (const s of current.sections) if (s.shared) sharedKeys.add(s.key);
            }
          }
        }
      } catch {
        available = false;
      }
      servers.push({
        id: group.id,
        slug,
        name: group.name,
        available,
        owner,
        friendMatched,
        allGranted: allGrantedServerIds.has(group.id),
        allActive,
        libraries: group.libs.map((l) => ({
          id: l.libraryId,
          name: l.name,
          sectionKey: l.sectionKey,
          mediaType: l.mediaType,
          // The owner owns every library; the all-libraries state shares every library.
          shared: owner || allActive || sharedKeys.has(l.sectionKey),
        })),
      });
    }
    return { servers };
  }),

  /** Self-add a library share on the caller's own Plex account (role-gated in-domain). */
  addLibrary: authedProcedure.input(PlexLibraryInput).mutation(async ({ ctx, input }) => {
    return mapDomainErrors(() =>
      shareLibrary({
        db: ctx.db,
        plex: resolvePlexBundle(ctx),
        userId: ctx.user.id,
        libraryId: input.libraryId,
        actorId: ctx.user.id,
      }),
    );
  }),

  /** Self-remove a library share from the caller's own Plex account. */
  removeLibrary: authedProcedure.input(PlexLibraryInput).mutation(async ({ ctx, input }) => {
    return mapDomainErrors(() =>
      unshareLibrary({
        db: ctx.db,
        plex: resolvePlexBundle(ctx),
        userId: ctx.user.id,
        libraryId: input.libraryId,
        actorId: ctx.user.id,
      }),
    );
  }),

  /**
   * ADR-024 — self-toggle the all-libraries state on the caller's OWN account for a server their
   * role all-grants (role-gated in-domain). `on:true` enters the plex.tv all-libraries state;
   * `on:false` leaves it, demoting to an explicit list seeded with the account's current full set
   * (no access loss). Returns `{ changed, event, serverSlug, allActive }`.
   */
  setServerAll: authedProcedure.input(ServerAllInput).mutation(async ({ ctx, input }) => {
    return mapDomainErrors(() =>
      setServerAllShare({
        db: ctx.db,
        plex: resolvePlexBundle(ctx),
        userId: ctx.user.id,
        serverId: input.serverId,
        on: input.on,
        actorId: ctx.user.id,
      }),
    );
  }),

  /**
   * Admin: refresh the library registry from the live servers (all, or a subset). Returns the
   * DESIGN-007 D-12 per-server summary `{ ok, servers: [{ slug, name, ok, libraryCount?, error? }] }`
   * — a single unreachable server degrades to `ok: false` for that row (the others still commit)
   * rather than failing the whole call. mapDomainErrors still surfaces the genuinely fatal cases
   * (config missing, an unexpected media type) as client errors.
   */
  refreshRegistry: adminProcedure.input(RefreshRegistryInput).mutation(async ({ ctx, input }) => {
    return mapDomainErrors(() =>
      refreshPlexRegistry({ db: ctx.db, plex: resolvePlexBundle(ctx), slugs: input.slugs }),
    );
  }),

  /**
   * Admin: the per-role library grant matrix — every library grouped by server + per-role grants.
   * `grantsByRole` maps roleId → granted library ids; `allGrantsByRole` maps roleId → the server
   * ids the role all-grants (ADR-024). Each server carries its `id` so the UI can address the
   * per-server all-grant toggle.
   */
  roleLibraryGrants: adminProcedure.query(async ({ ctx }) => {
    const libRows = await ctx.db
      .select({
        id: plexLibraries.id,
        name: plexLibraries.name,
        sectionKey: plexLibraries.sectionKey,
        mediaType: plexLibraries.mediaType,
        available: plexLibraries.available,
        serverId: plexServers.id,
        serverSlug: plexServers.slug,
        serverName: plexServers.name,
      })
      .from(plexLibraries)
      .innerJoin(plexServers, eq(plexServers.id, plexLibraries.serverId))
      .orderBy(asc(plexServers.slug), asc(plexLibraries.name));

    const grantRows = await ctx.db
      .select({ roleId: roleLibraryGrants.roleId, libraryId: roleLibraryGrants.plexLibraryId })
      .from(roleLibraryGrants);

    const allGrantRows = await ctx.db
      .select({ roleId: rolePlexServerAllGrants.roleId, serverId: rolePlexServerAllGrants.plexServerId })
      .from(rolePlexServerAllGrants);

    const servers = new Map<
      PlexServerSlug,
      { id: string; slug: PlexServerSlug; name: string; libraries: Array<Omit<(typeof libRows)[number], 'serverId' | 'serverSlug' | 'serverName'>> }
    >();
    for (const row of libRows) {
      const { serverId, serverSlug, serverName, ...lib } = row;
      const s = servers.get(serverSlug) ?? { id: serverId, slug: serverSlug, name: serverName, libraries: [] };
      s.libraries.push(lib);
      servers.set(serverSlug, s);
    }

    const grantsByRole: Record<string, string[]> = {};
    for (const g of grantRows) (grantsByRole[g.roleId] ??= []).push(g.libraryId);

    const allGrantsByRole: Record<string, string[]> = {};
    for (const g of allGrantRows) (allGrantsByRole[g.roleId] ??= []).push(g.serverId);

    return { servers: [...servers.values()], grantsByRole, allGrantsByRole };
  }),

  /**
   * Admin: replace a role's whole Plex library grant set (audited 'update_role_libraries'). Sets
   * the per-library allow-list AND, when `allServerIds` is provided, the per-server all-libraries
   * grants (ADR-024). Omitting `allServerIds` leaves the role's existing all-grants untouched.
   */
  setRoleLibraryGrants: adminProcedure.input(RoleLibrariesInput).mutation(async ({ ctx, input }) => {
    return mapDomainErrors(() =>
      setRoleLibraries({
        db: ctx.db,
        roleId: input.roleId,
        libraryIds: input.libraryIds,
        allServerIds: input.allServerIds,
        actorId: ctx.user.id,
      }),
    );
  }),
});
