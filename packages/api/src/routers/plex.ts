// ADR-017 / DESIGN-007 D-05 — the plex router (claims the reserved `plex` name). Self-service
// add/remove is authedProcedure (own account only — the procedures take no userId, always
// ctx.user.id); the registry refresh + role-grant matrix are adminProcedure. Every mutating
// domain call is wrapped in mapDomainErrors so the D-13 appCodes reach the client; the Plex
// client bundle is injected via resolvePlexBundle (env singleton in prod, stub in tests).
import { asc, eq } from 'drizzle-orm';
import { plexLibraries, plexServers, roleLibraryGrants, type PlexMediaType, type PlexServerSlug } from '@hnet/db';
import {
  effectiveAllowedLibrariesForUser,
  refreshPlexRegistry,
  setRoleLibraries,
  shareLibrary,
  unshareLibrary,
} from '@hnet/domain';
import { mapDomainErrors, resolvePlexBundle, router } from '../trpc';
import { authedProcedure } from '../trpc';
import { adminProcedure } from '../middleware/role';
import { PlexLibraryInput, RefreshRegistryInput, RoleLibrariesInput } from '../schemas';

export interface MyLibrary {
  id: string;
  name: string;
  sectionKey: string;
  mediaType: PlexMediaType;
  shared: boolean;
}
export interface MyServer {
  slug: PlexServerSlug;
  name: string;
  /** false when the server (or plex.tv) was unreachable while resolving live share state. */
  available: boolean;
  /** false when the caller's email has no matching Plex friend on the server account (Q-06). */
  friendMatched: boolean;
  libraries: MyLibrary[];
}

export const plexRouter = router({
  /**
   * The caller's role-allowed libraries grouped by server, each annotated with whether they
   * currently share it (live from the read client). Degrades gracefully per server: a Plex
   * outage marks that server `available: false` rather than failing the whole page.
   */
  myLibraries: authedProcedure.query(async ({ ctx }): Promise<{ servers: MyServer[] }> => {
    const libs = await effectiveAllowedLibrariesForUser(ctx.user.id, ctx.db);
    const bundle = resolvePlexBundle(ctx);

    const groups = new Map<
      PlexServerSlug,
      { name: string; libs: Array<(typeof libs)[number]> }
    >();
    for (const lib of libs) {
      const g = groups.get(lib.serverSlug) ?? { name: lib.serverName, libs: [] };
      g.libs.push(lib);
      groups.set(lib.serverSlug, g);
    }

    const servers: MyServer[] = [];
    for (const [slug, group] of groups) {
      let available = true;
      let friendMatched = true;
      const sharedKeys = new Set<string>();
      try {
        const read = bundle.read[slug];
        const friend = await read.findFriendByEmail(ctx.user.email);
        if (!friend) {
          friendMatched = false;
        } else {
          const current = await read.findSharedServerForUser(friend.id);
          if (current) {
            for (const s of current.sections) if (s.shared) sharedKeys.add(s.key);
          }
        }
      } catch {
        available = false;
      }
      servers.push({
        slug,
        name: group.name,
        available,
        friendMatched,
        libraries: group.libs.map((l) => ({
          id: l.libraryId,
          name: l.name,
          sectionKey: l.sectionKey,
          mediaType: l.mediaType,
          shared: sharedKeys.has(l.sectionKey),
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

  /** Admin: refresh the library registry from the live servers (all, or a subset). */
  refreshRegistry: adminProcedure.input(RefreshRegistryInput).mutation(async ({ ctx, input }) => {
    return mapDomainErrors(() =>
      refreshPlexRegistry({ db: ctx.db, plex: resolvePlexBundle(ctx), slugs: input.slugs }),
    );
  }),

  /** Admin: the per-role library grant matrix — every library grouped by server + grants per role. */
  roleLibraryGrants: adminProcedure.query(async ({ ctx }) => {
    const libRows = await ctx.db
      .select({
        id: plexLibraries.id,
        name: plexLibraries.name,
        sectionKey: plexLibraries.sectionKey,
        mediaType: plexLibraries.mediaType,
        available: plexLibraries.available,
        serverSlug: plexServers.slug,
        serverName: plexServers.name,
      })
      .from(plexLibraries)
      .innerJoin(plexServers, eq(plexServers.id, plexLibraries.serverId))
      .orderBy(asc(plexServers.slug), asc(plexLibraries.name));

    const grantRows = await ctx.db
      .select({ roleId: roleLibraryGrants.roleId, libraryId: roleLibraryGrants.plexLibraryId })
      .from(roleLibraryGrants);

    const servers = new Map<
      PlexServerSlug,
      { slug: PlexServerSlug; name: string; libraries: Array<Omit<(typeof libRows)[number], 'serverSlug' | 'serverName'>> }
    >();
    for (const row of libRows) {
      const { serverSlug, serverName, ...lib } = row;
      const s = servers.get(serverSlug) ?? { slug: serverSlug, name: serverName, libraries: [] };
      s.libraries.push(lib);
      servers.set(serverSlug, s);
    }

    const grantsByRole: Record<string, string[]> = {};
    for (const g of grantRows) (grantsByRole[g.roleId] ??= []).push(g.libraryId);

    return { servers: [...servers.values()], grantsByRole };
  }),

  /** Admin: replace a role's whole Plex library grant set (audited 'update_role_libraries'). */
  setRoleLibraryGrants: adminProcedure.input(RoleLibrariesInput).mutation(async ({ ctx, input }) => {
    return mapDomainErrors(() =>
      setRoleLibraries({
        db: ctx.db,
        roleId: input.roleId,
        libraryIds: input.libraryIds,
        actorId: ctx.user.id,
      }),
    );
  }),
});
