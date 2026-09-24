// ADR-091 / DESIGN-050 D-05 steps 6–7 / D-14 — the consent page and its server action (@hnet/auth, @hnet/domain,
// @hnet/watch mocked): the session gate, the expired / missing states, the verbatim D-14 copy with the redirect
// host and the per-user `watch:write` line, Approve and Deny as two DIFFERENT bound actions (never a button value
// — cigar-journal #29), and the action re-deriving the user from the session.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RedirectSignal, elements, expand, textOf } from './oauth-helpers';

const getServerSession = vi.hoisted(() => vi.fn());
const getConsentView = vi.hoisted(() => vi.fn());
const grantConsent = vi.hoisted(() => vi.fn());
const denyConsent = vi.hoisted(() => vi.fn());
const selectWatchAccountForUser = vi.hoisted(() => vi.fn());
const headersFn = vi.hoisted(() => vi.fn());
vi.mock('@hnet/auth', () => ({ getServerSession }));
vi.mock('@hnet/domain', () => ({ getConsentView, grantConsent, denyConsent }));
vi.mock('@hnet/watch', () => ({ selectWatchAccountForUser }));
vi.mock('@hnet/db', () => ({ db: { marker: 'db' } }));
vi.mock('next/headers', () => ({ headers: headersFn }));
vi.mock('next/navigation', () => ({
  redirect: (location: string) => {
    throw new RedirectSignal(location);
  },
}));
vi.mock('react-dom', () => ({ useFormStatus: () => ({ pending: false }) }));

import ConsentPage from '../../app/oauth/consent/page';
import { decide } from '../../app/oauth/consent/actions';
import { ConsentForm } from '../../app/oauth/consent/consent-form';
import { ExpiredCard, OAuthCard } from '../../app/oauth/oauth-message';

const ISSUER = 'https://haynesnetwork.com';
const TXN = '22222222-2222-4222-8222-222222222222';
const VIEW = {
  txnId: TXN,
  clientId: 'a'.repeat(32),
  clientName: 'ChatGPT',
  redirectHost: 'chatgpt.com',
  scopes: ['watch:read', 'watch:write', 'offline_access'],
};

const render = (txn: string | undefined = TXN) =>
  ConsentPage({ searchParams: Promise.resolve(txn === undefined ? {} : { txn }) });
const deep = (node: unknown) =>
  expand(node as never, ['OAuthCard', 'ExpiredCard', 'ConsentForm', 'Buttons']);

let logs: string[];
beforeEach(() => {
  vi.stubEnv('BETTER_AUTH_URL', ISSUER);
  headersFn.mockResolvedValue(new Headers());
  getServerSession
    .mockReset()
    .mockResolvedValue({ user: { id: 'user-1', email: 'owner@example.test' } });
  getConsentView.mockReset().mockResolvedValue({ status: 'ok', view: VIEW });
  grantConsent.mockReset();
  denyConsent.mockReset();
  selectWatchAccountForUser
    .mockReset()
    .mockResolvedValue({ plexAccountId: 12874060, role: 'owner' });
  logs = [];
  vi.spyOn(console, 'log').mockImplementation((l: string) => void logs.push(l));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('the consent page (D-05 step 6)', () => {
  it('no session ⇒ sign in and come back to this consent', async () => {
    getServerSession.mockResolvedValue(null);
    await expect(render()).rejects.toMatchObject({
      location: `${ISSUER}/login?next=${encodeURIComponent(`/oauth/consent?txn=${TXN}`)}`,
    });
    expect(getConsentView).not.toHaveBeenCalled();
  });

  it('D-14 copy, verbatim, for the server owner — the client name, the redirect host, one line per scope', async () => {
    const page = deep(await render());
    expect(getConsentView).toHaveBeenCalledWith({ txnId: TXN, userId: 'user-1' });
    expect(selectWatchAccountForUser).toHaveBeenCalledWith({ marker: 'db' }, 'user-1');
    const text = textOf(page);
    expect(text).toContain('Connect ChatGPT');
    expect(text).toContain(
      'ChatGPT wants to use your watch history on haynesnetwork. It will act as your account and can only do what you approve below.',
    );
    expect(text).toContain('Sends you back to chatgpt.com.');
    const items = elements(page).filter(
      (e) => (e.props as { className?: string }).className === 'oauth-scopes__item',
    );
    expect(items.map((e) => textOf(e))).toEqual([
      'See what you have watched and what is unfinished',
      'Mark titles watched or dismissed, and change them in Plex',
      'Stay connected without signing in again',
    ]);
    expect(text).toContain('Approve');
    expect(text).toContain('Deny');
    expect(logs).toEqual([
      `[auth] consent_shown {"client_id":"${'a'.repeat(32)}","txn":"${TXN}","scopes":["watch:read","watch:write","offline_access"]}`,
    ]);
  });

  it('for anyone else, watch:write says the history only (Plex write-back is owner-only)', async () => {
    for (const account of [null, { plexAccountId: 7, role: 'household' }]) {
      selectWatchAccountForUser.mockResolvedValue(account);
      const items = elements(deep(await render())).filter(
        (e) => (e.props as { className?: string }).className === 'oauth-scopes__item',
      );
      expect(items.map((e) => textOf(e))[1]).toBe(
        'Mark titles watched or dismissed in your history',
      );
    }
  });

  it('an expired request names the client; a missing / foreign / malformed one says "your app"', async () => {
    getConsentView.mockResolvedValue({ status: 'expired', clientName: 'Codex' });
    const expired = await render();
    expect(elements(expired).find((e) => e.type === ExpiredCard)?.props).toEqual({
      clientName: 'Codex',
    });
    expect(textOf(deep(expired))).toBe(
      'This request expired Start the connection again from Codex.',
    );
    getConsentView.mockResolvedValue({ status: 'missing' });
    expect(textOf(deep(await render('not-a-uuid')))).toBe(
      'This request expired Start the connection again from your app.',
    );
    expect(logs).toEqual([]); // consent_shown only for a real consent
  });

  it('Approve and Deny are two DIFFERENT bound actions — the decision never rides a button value', async () => {
    const page = await render();
    const form = elements(page).find((e) => e.type === ConsentForm)!;
    const { approve, deny } = form.props as {
      approve: () => Promise<void>;
      deny: () => Promise<void>;
    };
    expect(approve).not.toBe(deny);
    grantConsent.mockResolvedValue({
      status: 'redirect',
      redirectUrl: 'https://chatgpt.com/connector/oauth/abc?code=c&state=s',
      clientId: 'x',
    });
    denyConsent.mockResolvedValue({
      status: 'redirect',
      redirectUrl: 'https://chatgpt.com/connector/oauth/abc?error=access_denied&state=s',
      clientId: 'x',
    });
    await expect(approve()).rejects.toMatchObject({
      location: 'https://chatgpt.com/connector/oauth/abc?code=c&state=s',
    });
    expect(grantConsent).toHaveBeenCalledWith({ txnId: TXN, userId: 'user-1' });
    expect(denyConsent).not.toHaveBeenCalled();
    await expect(deny()).rejects.toMatchObject({
      location: 'https://chatgpt.com/connector/oauth/abc?error=access_denied&state=s',
    });
    expect(denyConsent).toHaveBeenCalledWith({ txnId: TXN, userId: 'user-1' });
    expect(grantConsent).toHaveBeenCalledTimes(1);
  });

  it('the form: both buttons submit their own formAction, fixed labels, same reserved-width class (ADR-015)', () => {
    const approve = async () => {};
    const deny = async () => {};
    const tree = expand(ConsentForm({ approve, deny }), ['Buttons']);
    const buttons = elements(tree).filter((e) => e.type === 'button');
    expect(buttons.map((b) => textOf(b))).toEqual(['Approve', 'Deny']);
    expect(buttons.map((b) => (b.props as { formAction: unknown }).formAction)).toEqual([
      approve,
      deny,
    ]);
    for (const b of buttons) {
      expect((b.props as { className: string }).className).toContain('oauth-actions__btn');
      expect((b.props as { type: string }).type).toBe('submit');
      expect(b.props).not.toHaveProperty('name');
      expect(b.props).not.toHaveProperty('value');
    }
    expect(elements(tree).some((e) => e.type === 'form')).toBe(true);
  });
});

describe('the consent action (D-05 step 7)', () => {
  it('re-derives the user from the session — none ⇒ sign in and come back', async () => {
    getServerSession.mockResolvedValue(null);
    await expect(decide('approve', TXN)).rejects.toMatchObject({
      location: `${ISSUER}/login?next=${encodeURIComponent(`/oauth/consent?txn=${TXN}`)}`,
    });
    expect(grantConsent).not.toHaveBeenCalled();
  });

  it('an expired or already-decided request lands back on the consent page (which shows the expired state)', async () => {
    grantConsent.mockResolvedValue({ status: 'expired', clientName: 'ChatGPT' });
    await expect(decide('approve', TXN)).rejects.toMatchObject({
      location: `${ISSUER}/oauth/consent?txn=${TXN}`,
    });
    denyConsent.mockResolvedValue({ status: 'missing' });
    await expect(decide('deny', TXN)).rejects.toMatchObject({
      location: `${ISSUER}/oauth/consent?txn=${TXN}`,
    });
  });

  it('refuses a forged decision value without touching the transaction', async () => {
    await expect(decide('grant-everything' as never, TXN)).rejects.toMatchObject({
      location: `${ISSUER}/oauth/consent?txn=${TXN}`,
    });
    expect(grantConsent).not.toHaveBeenCalled();
    expect(denyConsent).not.toHaveBeenCalled();
  });

  it('the card and the expired card share the login card chrome', () => {
    expect(
      elements(OAuthCard({ children: 'x', testId: 't' })).some(
        (e) => (e.props as { className?: string }).className === 'card login-card oauth-card',
      ),
    ).toBe(true);
  });
});
