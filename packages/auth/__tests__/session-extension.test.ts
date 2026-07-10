import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { account } from '@hnet/db';
import { MESSAGE_ACTIONS, SEEDED_ROLE_IDS, TRASH_ACTIONS } from '@hnet/db/schema';
import { assignRole, createRole, setRoleTrashActions, setSectionPermission } from '@hnet/domain';
import { getSessionExtension } from '../src/index';
import { OIDC_PROVIDER_ID } from '../src/env';
import { bootMigratedDb, createUser, type TestDb } from './helpers';

/** Build a JWT-shaped id_token whose payload carries `claims` (decode-only, no verification). */
function idTokenWith(claims: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64(claims)}.sig`;
}

describe('session extension (DESIGN-002 D-06 / DESIGN-003 D-01, ADR-012)', () => {
  let t: TestDb;

  beforeAll(async () => {
    t = await bootMigratedDb();
  });

  afterAll(async () => {
    await t?.stop();
  });

  it('hydrates the Default role + displayName for a new user (role.isAdmin false)', async () => {
    const user = await createUser(t.db, { displayName: 'Owner Haynes' });
    expect(await getSessionExtension(user.id, t.db)).toEqual({
      role: {
        id: SEEDED_ROLE_IDS.default,
        name: 'Default',
        isAdmin: false,
        // ADR-021 — no rows ⇒ the documented section defaults (ADR-032 flipped ledger to
        // disabled; bulletin stays read_only — the Feed is for everyone; ADR-037 metrics disabled).
        sectionPermissions: {
          ledger: 'disabled',
          trash: 'disabled',
          bulletin: 'read_only',
          metrics: 'disabled',
          ytdlsub: 'disabled',
        },
        // ADR-023 — no grant rows ⇒ no Trash actions.
        trashActions: [],
        // ADR-026 — no grant rows ⇒ no Bulletin message actions.
        messageActions: [],
        // ADR-037 — the default role's stored metrics_level column (default 'limited').
        metricsLevel: 'limited',
      },
      displayName: 'Owner Haynes',
      // fix/plex-identity-mapping — no claim, no override ⇒ empty (matcher falls back to app email).
      plexIdentity: { userId: null, email: null, username: null },
    });
  });

  it('hydrates the Admin role after assignment (role.isAdmin true)', async () => {
    const user = await createUser(t.db, { displayName: 'Admin Ada' });
    await assignRole({
      db: t.db,
      userId: user.id,
      toRoleId: SEEDED_ROLE_IDS.admin,
      initiator: { id: null, kind: 'system' },
    });
    expect(await getSessionExtension(user.id, t.db)).toEqual({
      role: {
        id: SEEDED_ROLE_IDS.admin,
        name: 'Admin',
        isAdmin: true,
        // ADR-021 C-03 — admin implies Edit on every section (no rows).
        sectionPermissions: {
          ledger: 'edit',
          trash: 'edit',
          bulletin: 'edit',
          metrics: 'edit',
          ytdlsub: 'edit',
        },
        // ADR-023 C-03 — admin implies EVERY Trash action (no rows).
        trashActions: [...TRASH_ACTIONS],
        // ADR-026 C-04 — admin implies EVERY Bulletin message action (no rows).
        messageActions: [...MESSAGE_ACTIONS],
        // ADR-037 C-01 — admin implies 'full' metrics access.
        metricsLevel: 'full',
      },
      displayName: 'Admin Ada',
      plexIdentity: { userId: null, email: null, username: null },
    });
  });

  it('hydrates a non-default section level after setSectionPermission (ADR-021 C-02)', async () => {
    const { roleId } = await createRole({
      db: t.db,
      name: 'Ledger-Locked',
      appIds: [],
      actorId: null,
    });
    const user = await createUser(t.db, { displayName: 'Locked Lou', roleId });
    // Custom role, no rows yet ⇒ the ledger default (disabled — ADR-032).
    const before = await getSessionExtension(user.id, t.db);
    expect(before!.role.sectionPermissions.ledger).toBe('disabled');
    await setSectionPermission({
      db: t.db,
      roleId,
      sectionId: 'ledger',
      level: 'read_only',
      actorId: null,
    });
    const after = await getSessionExtension(user.id, t.db);
    expect(after!.role.sectionPermissions).toEqual({
      ledger: 'read_only',
      trash: 'disabled',
      bulletin: 'read_only',
      metrics: 'disabled',
      ytdlsub: 'disabled',
    });
  });

  it('hydrates the fine-grained Trash action grants after setRoleTrashActions (ADR-023 C-03)', async () => {
    const { roleId } = await createRole({
      db: t.db,
      name: 'Trash Saver',
      appIds: [],
      actorId: null,
    });
    const user = await createUser(t.db, { displayName: 'Save Sam', roleId });
    // No grant rows yet ⇒ empty action set.
    const before = await getSessionExtension(user.id, t.db);
    expect(before!.role.trashActions).toEqual([]);
    await setRoleTrashActions({
      db: t.db,
      roleId,
      actions: ['save_exclude', 'remove_exclude'],
      actorId: null,
    });
    const after = await getSessionExtension(user.id, t.db);
    // Canonical order preserved (TRASH_ACTIONS order), grants reflected.
    expect(after!.role.trashActions).toEqual(['save_exclude', 'remove_exclude']);
  });

  it('returns null (fail closed) for a missing user', async () => {
    expect(await getSessionExtension('00000000-0000-0000-0000-000000000000', t.db)).toBeNull();
  });

  // fix/plex-identity-mapping — the session carries the caller's REAL Plex identity, resolved
  // claim → override → empty. This is what lets My Plex recognize the owner whose Authentik email
  // (admin@haynesnetwork.com) differs from their plex.tv email (manofoz@gmail.com).
  describe('plexIdentity hydration', () => {
    it('resolves from the admin override columns when there is no linked account / claim', async () => {
      const user = await createUser(t.db, {
        displayName: 'Owner',
        plexEmail: 'Manofoz@Gmail.com',
        plexUsername: 'Manofoz',
      });
      const ext = await getSessionExtension(user.id, t.db);
      expect(ext!.plexIdentity).toEqual({
        userId: null,
        email: 'manofoz@gmail.com',
        username: 'manofoz',
      });
    });

    it('resolves from the id_token plex_* claim, which wins over the override', async () => {
      const user = await createUser(t.db, {
        displayName: 'Owner Linked',
        plexEmail: 'override@plex.tv',
        plexUsername: 'overrideuser',
      });
      await t.db.insert(account).values({
        userId: user.id,
        providerId: OIDC_PROVIDER_ID,
        accountId: `sub-${user.id}`,
        idToken: idTokenWith({
          sub: `sub-${user.id}`,
          email: 'admin@haynesnetwork.com',
          plex_email: 'manofoz@gmail.com',
          plex_username: 'manofoz',
        }),
      });
      const ext = await getSessionExtension(user.id, t.db);
      expect(ext!.plexIdentity).toEqual({
        userId: null,
        email: 'manofoz@gmail.com',
        username: 'manofoz',
      });
    });

    // fix/plex-numeric-id — the RECOMMENDED automatic path: the id_token carries plex_user_id (the
    // Authentik provider scope mapping reads it off the Plex source connection). This is exactly the
    // owner's live shape — a numeric id, no plex_email/plex_username — and it must hydrate onto the
    // session so My Plex recognizes him from the id alone.
    it('hydrates the numeric userId from the plex_user_id claim (id-only, owner shape)', async () => {
      const user = await createUser(t.db, { displayName: 'Owner By Id' });
      await t.db.insert(account).values({
        userId: user.id,
        providerId: OIDC_PROVIDER_ID,
        accountId: `sub-id-${user.id}`,
        idToken: idTokenWith({
          sub: `sub-id-${user.id}`,
          email: 'admin@haynesnetwork.com',
          plex_user_id: '12874060',
        }),
      });
      const ext = await getSessionExtension(user.id, t.db);
      expect(ext!.plexIdentity).toEqual({ userId: '12874060', email: null, username: null });
    });

    it('is empty for a linked account whose token carries no plex_* claim and no override', async () => {
      const user = await createUser(t.db, { displayName: 'Plain Member' });
      await t.db.insert(account).values({
        userId: user.id,
        providerId: OIDC_PROVIDER_ID,
        accountId: `sub2-${user.id}`,
        idToken: idTokenWith({ sub: `sub2-${user.id}`, email: 'member@example.test' }),
      });
      const ext = await getSessionExtension(user.id, t.db);
      expect(ext!.plexIdentity).toEqual({ userId: null, email: null, username: null });
    });
  });
});
