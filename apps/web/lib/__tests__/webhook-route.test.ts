// ADR-026 / DESIGN-012 D-03 — the generic webhook receiver's SECURITY contract, tested at the
// route-handler level (the @hnet/domain single-writer is mocked; the parsers/secret helpers are
// the real ones). The load-bearing assertions: per-source secret ISOLATION (one source's secret
// never authenticates another source's route), unknown source → 404 BEFORE any secret work,
// fail-closed 503 when a source's secret is unconfigured, the hard body cap (declared AND
// undeclared/chunked), and that the sanitizing parser is what reaches the single writer.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const recordNotification = vi.hoisted(() => vi.fn());
const refreshSeerrIssueFromEnv = vi.hoisted(() => vi.fn());
const runSeerrIssueBridgeFromEnv = vi.hoisted(() => vi.fn());
vi.mock('@hnet/domain', () => ({ recordNotification, refreshSeerrIssueFromEnv, runSeerrIssueBridgeFromEnv }));
// PLAN-077 P7 — `after` runs once the response is sent; here it is captured and run by the test.
const afterTasks = vi.hoisted(() => [] as Array<() => Promise<void>>);
vi.mock('next/server', () => ({ after: (fn: () => Promise<void>) => afterTasks.push(fn) }));

import { POST } from '../../app/api/webhooks/[source]/route';
import { MAX_WEBHOOK_BODY_BYTES } from '../webhook-sources';

const SEERR = 's33rr-secret';
const TAUTULLI = 'taut-secret';
const MAINTAINERR = 'maint-secret';

function call(
  source: string,
  opts: { headers?: Record<string, string>; body?: BodyInit; query?: string; duplex?: boolean } = {},
): Promise<Response> {
  const req = new Request(`http://receiver.local/api/webhooks/${source}${opts.query ?? ''}`, {
    method: 'POST',
    headers: opts.headers,
    body: opts.body ?? JSON.stringify({ notification_type: 'X' }),
    // Node's fetch Request requires duplex:'half' for stream bodies (the chunked-sender case).
    ...(opts.duplex ? { duplex: 'half' } : {}),
  } as RequestInit);
  return POST(req, { params: Promise.resolve({ source }) });
}

beforeEach(() => {
  vi.stubEnv('SEERR_WEBHOOK_SECRET', SEERR);
  vi.stubEnv('TAUTULLI_WEBHOOK_SECRET', TAUTULLI);
  vi.stubEnv('MAINTAINERR_WEBHOOK_SECRET', MAINTAINERR);
  recordNotification.mockReset();
  recordNotification.mockResolvedValue({ id: 'n-1', deduped: false });
  refreshSeerrIssueFromEnv.mockReset();
  refreshSeerrIssueFromEnv.mockResolvedValue({ outcome: 'inserted' });
  runSeerrIssueBridgeFromEnv.mockReset();
  runSeerrIssueBridgeFromEnv.mockResolvedValue({ status: 'ok', comments: {}, resolves: {} });
  afterTasks.length = 0;
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('POST /api/webhooks/[source] — source routing', () => {
  it('an unknown source is 404 BEFORE any secret work (even carrying a valid secret)', async () => {
    const res = await call('evil', { headers: { 'x-webhook-secret': SEERR } });
    expect(res.status).toBe(404);
    // …and with NO secrets configured at all it is still 404 (never the 503 fail-closed branch,
    // which would leak that the source-name gate ran after the secret lookup).
    vi.unstubAllEnvs();
    const bare = await call('evil');
    expect(bare.status).toBe(404);
    expect(recordNotification).not.toHaveBeenCalled();
  });

  it('each known source resolves (202) under its OWN secret', async () => {
    for (const [source, secret] of [
      ['seerr', SEERR],
      ['tautulli', TAUTULLI],
      ['maintainerr', MAINTAINERR],
    ] as const) {
      const res = await call(source, { headers: { 'x-webhook-secret': secret } });
      expect(res.status).toBe(202);
      await expect(res.json()).resolves.toMatchObject({ ok: true, id: 'n-1', deduped: false });
    }
    expect(recordNotification).toHaveBeenCalledTimes(3);
  });
});

describe('POST /api/webhooks/[source] — per-source secret ISOLATION', () => {
  it("one source's secret NEVER authenticates another source's route", async () => {
    const probes: Array<[string, string]> = [
      ['tautulli', SEERR],
      ['seerr', TAUTULLI],
      ['seerr', MAINTAINERR],
      ['maintainerr', SEERR],
      ['tautulli', MAINTAINERR],
      ['maintainerr', TAUTULLI],
    ];
    for (const [source, wrongSecret] of probes) {
      const res = await call(source, { headers: { 'x-webhook-secret': wrongSecret } });
      expect(res.status, `${wrongSecret} must not open /${source}`).toBe(401);
    }
    expect(recordNotification).not.toHaveBeenCalled();
  });

  it('a missing/empty secret is 401', async () => {
    expect((await call('seerr')).status).toBe(401);
    expect((await call('seerr', { headers: { 'x-webhook-secret': '   ' } })).status).toBe(401);
    expect(recordNotification).not.toHaveBeenCalled();
  });

  it('an UNCONFIGURED source fails closed (503) while its siblings stay up', async () => {
    vi.stubEnv('TAUTULLI_WEBHOOK_SECRET', '');
    const down = await call('tautulli', { headers: { 'x-webhook-secret': TAUTULLI } });
    expect(down.status).toBe(503);
    const up = await call('seerr', { headers: { 'x-webhook-secret': SEERR } });
    expect(up.status).toBe(202);
    expect(recordNotification).toHaveBeenCalledTimes(1);
  });

  it('accepts the secret via x-webhook-secret, raw Authorization, Bearer, or ?token=', async () => {
    const channels: Array<Parameters<typeof call>[1]> = [
      { headers: { 'x-webhook-secret': MAINTAINERR } },
      { headers: { authorization: MAINTAINERR } },
      { headers: { authorization: `Bearer ${MAINTAINERR}` } },
      { query: `?token=${encodeURIComponent(MAINTAINERR)}` },
    ];
    for (const opts of channels) {
      expect((await call('maintainerr', opts)).status).toBe(202);
    }
  });
});

describe('POST /api/webhooks/[source] — body cap + parse rejection', () => {
  it('rejects an oversize DECLARED body with 413 (nothing persisted)', async () => {
    const res = await call('seerr', {
      headers: { 'x-webhook-secret': SEERR },
      body: JSON.stringify({ notification_type: 'X', message: 'B'.repeat(MAX_WEBHOOK_BODY_BYTES) }),
    });
    expect(res.status).toBe(413);
    expect(recordNotification).not.toHaveBeenCalled();
  });

  it('rejects an oversize STREAMED body (no content-length — a lying/chunked sender) with 413', async () => {
    const chunk = new TextEncoder().encode('C'.repeat(16 * 1024));
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < 8; i++) controller.enqueue(chunk); // 128KB, never declared
        controller.close();
      },
    });
    const res = await call('seerr', {
      headers: { 'x-webhook-secret': SEERR },
      body: stream,
      duplex: true,
    });
    expect(res.status).toBe(413);
    expect(recordNotification).not.toHaveBeenCalled();
  });

  it('rejects malformed JSON (400) and a non-object body (400)', async () => {
    const bad = await call('seerr', { headers: { 'x-webhook-secret': SEERR }, body: '{nope' });
    expect(bad.status).toBe(400);
    const scalar = await call('seerr', { headers: { 'x-webhook-secret': SEERR }, body: '42' });
    expect(scalar.status).toBe(400);
    expect(recordNotification).not.toHaveBeenCalled();
  });

  it('persists ONLY the sanitized known-key subset (arbitrary/proto keys never reach the writer)', async () => {
    const res = await call('seerr', {
      headers: { 'x-webhook-secret': SEERR },
      // Hand-built JSON: a `__proto__` key in an object LITERAL would set the prototype instead
      // of serializing, so the hostile payload is written as a raw string.
      body:
        '{"notification_type":"MEDIA_APPROVED","subject":"Clean","message":"ok",' +
        '"__proto__":{"polluted":true},"constructor":{"evil":1},' +
        `"arbitrary_dump":"${'x'.repeat(1024)}"}`,
    });
    expect(res.status).toBe(202);
    expect(recordNotification).toHaveBeenCalledTimes(1);
    const arg = recordNotification.mock.calls[0]![0] as {
      source: string;
      payload: Record<string, unknown>;
    };
    expect(arg.source).toBe('seerr');
    expect(Object.keys(arg.payload).sort()).toEqual(['message', 'notification_type', 'subject']);
    expect('arbitrary_dump' in arg.payload).toBe(false);
    expect(Object.getPrototypeOf(arg.payload)).toBe(Object.prototype);
  });
});

describe('POST /api/webhooks/seerr — issue notifications (DESIGN-055 D-10)', () => {
  const issueBody = (type: string, issueId: string) =>
    JSON.stringify({
      notification_type: type,
      subject: 'The Paper (2025)',
      message: 'Missing episode 6',
      media: { media_type: 'tv', tmdbId: '253941', tvdbId: '449872' },
      issue: { issue_id: issueId, issue_type: 'VIDEO', issue_status: 'OPEN', reportedBy_email: 'a@example.com' },
    });

  it('an issue notification triggers one fresh read of that issue and is never stored as a Feed notification', async () => {
    for (const type of ['ISSUE_CREATED', 'ISSUE_COMMENT', 'ISSUE_RESOLVED', 'ISSUE_REOPENED']) {
      const res = await call('seerr', { headers: { 'x-webhook-secret': SEERR }, body: issueBody(type, '3') });
      expect(res.status).toBe(202);
      await expect(res.json()).resolves.toEqual({ ok: true, seerrIssueId: 3, outcome: 'inserted' });
    }
    expect(refreshSeerrIssueFromEnv).toHaveBeenCalledTimes(4);
    expect(refreshSeerrIssueFromEnv).toHaveBeenCalledWith({ seerrIssueId: 3 });
    expect(recordNotification).not.toHaveBeenCalled();
  });

  it('an unreachable Seerr still answers 202 (the sync catches up)', async () => {
    refreshSeerrIssueFromEnv.mockResolvedValue({ outcome: 'unavailable' });
    const res = await call('seerr', { headers: { 'x-webhook-secret': SEERR }, body: issueBody('ISSUE_CREATED', '9') });
    expect(res.status).toBe(202);
    await expect(res.json()).resolves.toMatchObject({ seerrIssueId: 9, outcome: 'unavailable' });
  });

  it('media notifications, and an issue notification without an id, keep the Feed path', async () => {
    await call('seerr', {
      headers: { 'x-webhook-secret': SEERR },
      body: JSON.stringify({ notification_type: 'MEDIA_AVAILABLE', subject: 'x', media: { media_type: 'movie', tmdbId: '1' } }),
    });
    await call('seerr', { headers: { 'x-webhook-secret': SEERR }, body: issueBody('ISSUE_CREATED', '') });
    expect(refreshSeerrIssueFromEnv).not.toHaveBeenCalled();
    expect(recordNotification).toHaveBeenCalledTimes(2);
  });

  it('the issue read needs the secret like everything else', async () => {
    const res = await call('seerr', { headers: { 'x-webhook-secret': 'wrong' }, body: issueBody('ISSUE_CREATED', '3') });
    expect(res.status).toBe(401);
    expect(refreshSeerrIssueFromEnv).not.toHaveBeenCalled();
    expect(afterTasks).toHaveLength(0);
  });

  it('PLAN-077 P7: a read that changed the mirror runs the bridge pass for that one issue after the response', async () => {
    const res = await call('seerr', { headers: { 'x-webhook-secret': SEERR }, body: issueBody('ISSUE_CREATED', '3') });
    expect(res.status).toBe(202);
    expect(runSeerrIssueBridgeFromEnv).not.toHaveBeenCalled();
    expect(afterTasks).toHaveLength(1);
    await afterTasks[0]!();
    expect(runSeerrIssueBridgeFromEnv).toHaveBeenCalledWith({ issueIds: [3] });
  });

  it('PLAN-077 P7: no bridge pass when the read changed nothing or Seerr was unreachable; a failed pass is only logged', async () => {
    for (const outcome of ['unchanged', 'unavailable', 'not_found', 'unconfigured']) {
      refreshSeerrIssueFromEnv.mockResolvedValue({ outcome });
      await call('seerr', { headers: { 'x-webhook-secret': SEERR }, body: issueBody('ISSUE_COMMENT', '3') });
    }
    expect(afterTasks).toHaveLength(0);
    refreshSeerrIssueFromEnv.mockResolvedValue({ outcome: 'updated' });
    runSeerrIssueBridgeFromEnv.mockRejectedValue(new Error('db down'));
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    await call('seerr', { headers: { 'x-webhook-secret': SEERR }, body: issueBody('ISSUE_COMMENT', '3') });
    await expect(afterTasks[0]!()).resolves.toBeUndefined();
    expect(quiet).toHaveBeenCalled();
    quiet.mockRestore();
  });
});
