// fix/plex-identity-mapping — the pure identity resolver: the id_token plex_* claim wins, else the
// admin override column, else empty (the matcher then falls back to the app email). No DB.
import { describe, expect, it } from 'vitest';
import {
  EMPTY_PLEX_IDENTITY,
  normalizePlexField,
  normalizePlexUserId,
  plexIdentityFromIdToken,
  resolvePlexIdentity,
} from '../src/hooks/plex-identity';

/** Build a JWT-shaped token whose payload carries `claims` (signature is irrelevant — we decode). */
function idTokenWith(claims: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64(claims)}.sig-not-verified`;
}

describe('plexIdentityFromIdToken', () => {
  it('extracts plex_email + plex_username, trimmed + lowercased (no numeric id → userId null)', () => {
    const token = idTokenWith({
      sub: 'x',
      email: 'admin@haynesnetwork.com',
      plex_email: '  Manofoz@Gmail.com ',
      plex_username: ' MANOFOZ ',
    });
    expect(plexIdentityFromIdToken(token)).toEqual({
      userId: null,
      email: 'manofoz@gmail.com',
      username: 'manofoz',
    });
  });

  // fix/plex-numeric-id — the plex.tv numeric id is the strongest identity Authentik holds for a
  // source-linked account. It is NOT lowercased (digits) and rides on the id_token `plex_user_id`.
  it('extracts the plex.tv numeric user id from plex_user_id (string or number)', () => {
    expect(plexIdentityFromIdToken(idTokenWith({ plex_user_id: '12874060' }))).toEqual({
      userId: '12874060',
      email: null,
      username: null,
    });
    // Authentik emits the identifier as a string, but tolerate a numeric claim too.
    expect(plexIdentityFromIdToken(idTokenWith({ plex_user_id: 12874060 }))).toEqual({
      userId: '12874060',
      email: null,
      username: null,
    });
  });

  it('carries the numeric id alongside email/username when all three claims are present', () => {
    const token = idTokenWith({
      plex_user_id: ' 12874060 ',
      plex_email: 'Manofoz@Gmail.com',
      plex_username: 'manofoz',
    });
    expect(plexIdentityFromIdToken(token)).toEqual({
      userId: '12874060',
      email: 'manofoz@gmail.com',
      username: 'manofoz',
    });
  });

  it('yields the empty identity when the claims are absent', () => {
    const token = idTokenWith({ sub: 'x', email: 'a@b.com' });
    expect(plexIdentityFromIdToken(token)).toEqual(EMPTY_PLEX_IDENTITY);
  });

  it('is tolerant of null/empty/malformed/non-JWT tokens', () => {
    expect(plexIdentityFromIdToken(null)).toEqual(EMPTY_PLEX_IDENTITY);
    expect(plexIdentityFromIdToken(undefined)).toEqual(EMPTY_PLEX_IDENTITY);
    expect(plexIdentityFromIdToken('')).toEqual(EMPTY_PLEX_IDENTITY);
    expect(plexIdentityFromIdToken('not-a-jwt')).toEqual(EMPTY_PLEX_IDENTITY);
    expect(plexIdentityFromIdToken('a.!!!not-base64-json!!!.c')).toEqual(EMPTY_PLEX_IDENTITY);
  });

  it('drops a blank/non-string claim to null', () => {
    const token = idTokenWith({ plex_email: '   ', plex_username: 42, plex_user_id: '  ' });
    expect(plexIdentityFromIdToken(token)).toEqual(EMPTY_PLEX_IDENTITY);
  });
});

describe('resolvePlexIdentity — claim → override → empty', () => {
  it('claim present wins over the override', () => {
    const token = idTokenWith({ plex_email: 'claim@plex.tv', plex_username: 'claimuser' });
    expect(
      resolvePlexIdentity({
        idToken: token,
        overrideEmail: 'override@plex.tv',
        overrideUsername: 'overrideuser',
      }),
    ).toEqual({ userId: null, email: 'claim@plex.tv', username: 'claimuser' });
  });

  it('falls back to the admin override when no claim is present', () => {
    expect(
      resolvePlexIdentity({
        idToken: idTokenWith({ sub: 'x' }),
        overrideEmail: 'Manofoz@Gmail.com',
        overrideUsername: 'Manofoz',
      }),
    ).toEqual({ userId: null, email: 'manofoz@gmail.com', username: 'manofoz' });
  });

  it('resolves per-field: a claim carrying only username still picks up the override email', () => {
    const token = idTokenWith({ plex_username: 'claimuser' });
    expect(
      resolvePlexIdentity({ idToken: token, overrideEmail: 'override@plex.tv' }),
    ).toEqual({ userId: null, email: 'override@plex.tv', username: 'claimuser' });
  });

  // fix/plex-numeric-id — the numeric id is claim-only (Authentik holds it reliably; no override
  // column). It rides through resolve untouched, independent of the email/username override merge.
  it('carries the numeric id from the claim (no override column) alongside the merged email', () => {
    const token = idTokenWith({ plex_user_id: '12874060' });
    expect(
      resolvePlexIdentity({ idToken: token, overrideEmail: 'Manofoz@Gmail.com' }),
    ).toEqual({ userId: '12874060', email: 'manofoz@gmail.com', username: null });
  });

  it('is empty when neither the claim nor the override has a value (→ app-email fallback)', () => {
    expect(resolvePlexIdentity({ idToken: null })).toEqual(EMPTY_PLEX_IDENTITY);
    expect(resolvePlexIdentity({ overrideEmail: '', overrideUsername: null })).toEqual(
      EMPTY_PLEX_IDENTITY,
    );
  });
});

describe('normalizePlexField', () => {
  it('trims + lowercases; blank/non-string → null', () => {
    expect(normalizePlexField('  Foo@Bar.COM ')).toBe('foo@bar.com');
    expect(normalizePlexField('   ')).toBeNull();
    expect(normalizePlexField(null)).toBeNull();
    expect(normalizePlexField(123)).toBeNull();
  });
});

describe('normalizePlexUserId', () => {
  it('coerces a finite number or non-blank string to a trimmed string; else null', () => {
    expect(normalizePlexUserId('12874060')).toBe('12874060');
    expect(normalizePlexUserId(' 12874060 ')).toBe('12874060');
    expect(normalizePlexUserId(12874060)).toBe('12874060');
    expect(normalizePlexUserId('   ')).toBeNull();
    expect(normalizePlexUserId(null)).toBeNull();
    expect(normalizePlexUserId(undefined)).toBeNull();
    expect(normalizePlexUserId(Number.NaN)).toBeNull();
    expect(normalizePlexUserId({})).toBeNull();
  });
});
