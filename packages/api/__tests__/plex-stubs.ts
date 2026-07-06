// A stateful fake PlexClientBundle for the plex router tests (ADR-010 — fully offline).
// Mirrors the arr-stubs intent (an injected bundle, recorded write calls) but models the Plex
// sharing surface with an in-memory per-server state so add → myLibraries reflects the change.
import type { PlexClientBundle, PlexServerName } from '@hnet/domain';

export interface FakeServerConfig {
  machineIdentifier: string;
  friends: Array<{ id: string; email: string }>;
  /** plex.tv section map: server section `key` → plex.tv section `id`. */
  serverSections: Array<{ id: string; key: string }>;
  /** PMS `/library/sections`. */
  librarySections: Array<{ key: string; title: string; type: string }>;
  /** Seeded current shares: userId → shared plex.tv section ids. */
  shared?: Record<string, { id: string; sectionIds: number[] }>;
}

export interface RecordedPlexWrite {
  slug: PlexServerName;
  kind: 'create' | 'update' | 'delete';
  invitedUserId?: number;
  sharedServerId?: string;
  librarySectionIds?: number[];
}

export interface ApiPlexStub {
  bundle: PlexClientBundle;
  writes: RecordedPlexWrite[];
}

function makeServer(slug: PlexServerName, cfg: FakeServerConfig, writes: RecordedPlexWrite[]) {
  const shared = new Map<string, { id: string; sectionIds: Set<number> }>();
  for (const [uid, s] of Object.entries(cfg.shared ?? {})) {
    shared.set(uid, { id: s.id, sectionIds: new Set(s.sectionIds) });
  }
  const keyForId = new Map(cfg.serverSections.map((s) => [Number(s.id), s.key]));

  const read = {
    machineIdentifier: cfg.machineIdentifier,
    async listSections() {
      return cfg.librarySections.map((s) => ({ ...s, agent: '' }));
    },
    async getIdentity() {
      return { machineIdentifier: cfg.machineIdentifier, version: '1.43.2' };
    },
    async findFriendByEmail(email: string) {
      const f = cfg.friends.find((x) => x.email.toLowerCase() === email.trim().toLowerCase());
      return f ? { id: f.id, email: f.email, username: null, title: null } : null;
    },
    async listServerSections() {
      return cfg.serverSections.map((s) => ({ id: s.id, key: s.key, title: '', type: 'movie' }));
    },
    async findSharedServerForUser(userId: string) {
      const s = shared.get(userId);
      if (!s) return null;
      return {
        id: s.id,
        userID: userId,
        email: null,
        username: null,
        allLibraries: false,
        sections: [...s.sectionIds].map((id) => ({
          id: String(id),
          key: keyForId.get(id) ?? '',
          shared: true,
        })),
      };
    },
  };

  const write = {
    async createSharedServer(input: { invitedUserId: number; librarySectionIds: number[] }) {
      const id = `ss-${input.invitedUserId}`;
      shared.set(String(input.invitedUserId), { id, sectionIds: new Set(input.librarySectionIds) });
      writes.push({ slug, kind: 'create', invitedUserId: input.invitedUserId, librarySectionIds: input.librarySectionIds });
      return { sharedServerId: id };
    },
    async updateSharedServer(input: { sharedServerId: string; librarySectionIds: number[] }) {
      for (const s of shared.values()) {
        if (s.id === input.sharedServerId) s.sectionIds = new Set(input.librarySectionIds);
      }
      writes.push({ slug, kind: 'update', sharedServerId: input.sharedServerId, librarySectionIds: input.librarySectionIds });
    },
    async deleteSharedServer(sharedServerId: string) {
      for (const [uid, s] of shared) if (s.id === sharedServerId) shared.delete(uid);
      writes.push({ slug, kind: 'delete', sharedServerId });
    },
  };

  return { read, write };
}

const EMPTY: FakeServerConfig = {
  machineIdentifier: 'mid-empty',
  friends: [],
  serverSections: [],
  librarySections: [],
};

/** Build the injected bundle; only the slugs you pass get real config (others are empty). */
export function makeApiPlexStub(config: Partial<Record<PlexServerName, FakeServerConfig>>): ApiPlexStub {
  const writes: RecordedPlexWrite[] = [];
  const slugs: PlexServerName[] = ['haynestower', 'haynesops', 'hayneskube'];
  const read = {} as PlexClientBundle['read'];
  const write = {} as PlexClientBundle['write'];
  for (const slug of slugs) {
    const s = makeServer(slug, config[slug] ?? EMPTY, writes);
    read[slug] = s.read as unknown as PlexClientBundle['read'][PlexServerName];
    write[slug] = s.write as unknown as PlexClientBundle['write'][PlexServerName];
  }
  return { bundle: { read, write }, writes };
}
