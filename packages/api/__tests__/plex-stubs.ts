// A stateful fake PlexClientBundle for the plex router tests (ADR-010 — fully offline).
// Mirrors the arr-stubs intent (an injected bundle, recorded write calls) but models the Plex
// sharing surface with an in-memory per-server state so add → myLibraries reflects the change.
import type { PlexClientBundle, PlexServerName } from '@hnet/domain';

export interface FakeServerConfig {
  machineIdentifier: string;
  /** fix/plex-numeric-id — the OWNER's plex.tv NUMERIC id (`/api/v2/user`.id). Defaults 'owner-id'. */
  ownerId?: string;
  /** ADR-029 — the server OWNER's plex.tv account email (the token account). Absent = no owner. */
  ownerEmail?: string;
  /** fix/plex-identity-mapping — the OWNER's plex.tv username (identity-username match). */
  ownerUsername?: string;
  friends: Array<{ id: string; email: string; username?: string }>;
  /** plex.tv section map: server section `key` → plex.tv section `id`. */
  serverSections: Array<{ id: string; key: string }>;
  /** PMS `/library/sections`. */
  librarySections: Array<{ key: string; title: string; type: string }>;
  /** ADR-038 — PMS `/library/sections/{key}/all` per section key (the ytdl-sub shows). */
  sectionContents?: Record<
    string,
    Array<{
      ratingKey: string;
      title: string;
      type?: string;
      thumb?: string;
      childCount?: number;
      leafCount?: number;
      year?: number;
      addedAt?: number;
      summary?: string;
    }>
  >;
  /** DESIGN-017 D-09 (drill-in) — `/library/metadata/{key}/children` per parent ratingKey. */
  metadataChildren?: Record<
    string,
    Array<{
      ratingKey: string;
      title: string;
      type?: string;
      thumb?: string;
      index?: number;
      leafCount?: number;
      duration?: number;
      originallyAvailableAt?: string;
    }>
  >;
  /** D-09 — the owning section key per metadata ratingKey (the confinement check's source). */
  metadataSection?: Record<string, string>;
  /** Seeded current shares: userId → shared plex.tv section ids (+ optional all-libraries flag). */
  shared?: Record<string, { id: string; sectionIds: number[]; allLibraries?: boolean }>;
}

export interface RecordedPlexWrite {
  slug: PlexServerName;
  kind: 'create' | 'update' | 'delete' | 'setAll';
  invitedUserId?: number;
  sharedServerId?: string;
  librarySectionIds?: number[];
  /** ADR-024 — for kind 'setAll': the target all-libraries state. */
  on?: boolean;
}

export interface ApiPlexStub {
  bundle: PlexClientBundle;
  writes: RecordedPlexWrite[];
}

function makeServer(slug: PlexServerName, cfg: FakeServerConfig, writes: RecordedPlexWrite[]) {
  const shared = new Map<string, { id: string; sectionIds: Set<number>; allLibraries?: boolean }>();
  for (const [uid, s] of Object.entries(cfg.shared ?? {})) {
    shared.set(uid, { id: s.id, sectionIds: new Set(s.sectionIds), allLibraries: s.allLibraries });
  }
  const keyForId = new Map(cfg.serverSections.map((s) => [Number(s.id), s.key]));

  const read = {
    machineIdentifier: cfg.machineIdentifier,
    async listSections() {
      return cfg.librarySections.map((s) => ({ ...s, agent: '' }));
    },
    // ADR-038 — the ytdl-sub section-contents read (a section's shows).
    async listSectionContents(sectionKey: string) {
      return (cfg.sectionContents?.[sectionKey] ?? []).map((i) => ({ type: 'show', ...i }));
    },
    // DESIGN-017 D-09 — the drill-in reads. A missing ratingKey mirrors the real client's 404 by
    // returning null (getMetadataItem) / an empty, section-less container (listMetadataChildren).
    async getMetadataItem(ratingKey: string) {
      for (const [sectionKey, items] of Object.entries(cfg.sectionContents ?? {})) {
        const hit = items.find((i) => i.ratingKey === ratingKey);
        if (hit) {
          return {
            item: { type: 'show', ...hit },
            librarySectionId: cfg.metadataSection?.[ratingKey] ?? sectionKey,
          };
        }
      }
      for (const items of Object.values(cfg.metadataChildren ?? {})) {
        const hit = items.find((i) => i.ratingKey === ratingKey);
        if (hit) {
          return {
            item: { type: 'season', ...hit },
            librarySectionId: cfg.metadataSection?.[ratingKey] ?? null,
          };
        }
      }
      return null;
    },
    async listMetadataChildren(ratingKey: string) {
      const items = cfg.metadataChildren?.[ratingKey] ?? [];
      return {
        items: items.map((i) => ({ type: 'season', ...i })),
        librarySectionId: cfg.metadataSection?.[ratingKey] ?? null,
        totalSize: items.length,
      };
    },
    async getIdentity() {
      return { machineIdentifier: cfg.machineIdentifier, version: '1.43.2' };
    },
    async getOwnerAccount() {
      return {
        id: cfg.ownerId ?? 'owner-id',
        email: cfg.ownerEmail ?? null,
        username: cfg.ownerUsername ?? null,
      };
    },
    async getOwnerEmail() {
      return cfg.ownerEmail ? cfg.ownerEmail.trim().toLowerCase() : null;
    },
    async findFriendByEmail(email: string) {
      const f = cfg.friends.find((x) => x.email.toLowerCase() === email.trim().toLowerCase());
      return f ? { id: f.id, email: f.email, username: f.username ?? null, title: null } : null;
    },
    // fix/plex-numeric-id — mirror PlexReadClient.findFriendById: exact string match on the
    // friend's plex.tv numeric id.
    async findFriendById(plexUserId: string) {
      const needle = plexUserId.trim();
      const f = needle ? cfg.friends.find((x) => x.id === needle) : undefined;
      return f ? { id: f.id, email: f.email, username: f.username ?? null, title: null } : null;
    },
    // fix/plex-identity-mapping — mirror PlexReadClient.findFriendByIdentity: match by (email OR
    // username, case-insensitive) from the resolved Plex identity, falling back to the app email.
    async findFriendByIdentity(
      identity: { email: string | null; username: string | null },
      fallbackEmail: string,
    ) {
      const emails = new Set(
        [identity.email, fallbackEmail]
          .map((e) => (e ?? '').trim().toLowerCase())
          .filter((e) => e.length > 0),
      );
      const username = (identity.username ?? '').trim().toLowerCase();
      const f = cfg.friends.find((x) => {
        const fe = x.email.trim().toLowerCase();
        const fu = (x.username ?? '').trim().toLowerCase();
        return emails.has(fe) || (username !== '' && fu === username);
      });
      return f ? { id: f.id, email: f.email, username: f.username ?? null, title: null } : null;
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
        allLibraries: s.allLibraries ?? false,
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
    async updateSharedServerAll(input: {
      sharedServerId: string | null;
      invitedUserId: number;
      on: boolean;
      librarySectionIds?: number[];
    }) {
      if (input.on) {
        let entry = [...shared.values()].find((s) => s.id === input.sharedServerId);
        if (!entry) {
          const id = input.sharedServerId ?? `ss-${input.invitedUserId}`;
          entry = { id, sectionIds: new Set<number>(), allLibraries: true };
          shared.set(String(input.invitedUserId), entry);
        } else {
          entry.allLibraries = true;
        }
        writes.push({ slug, kind: 'setAll', on: true, sharedServerId: entry.id, invitedUserId: input.invitedUserId });
        return { sharedServerId: entry.id };
      }
      for (const s of shared.values()) {
        if (s.id === input.sharedServerId) {
          s.allLibraries = false;
          s.sectionIds = new Set(input.librarySectionIds ?? []);
        }
      }
      writes.push({
        slug,
        kind: 'setAll',
        on: false,
        sharedServerId: input.sharedServerId ?? undefined,
        librarySectionIds: input.librarySectionIds,
      });
      return { sharedServerId: input.sharedServerId };
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
