// ADR-060 follow-up (PLAN-048 tail) — the nightly admin failure DIGEST: one email-channel outbox
// row summarizing OPEN activity_import_failures; a clean ledger enqueues NOTHING. Embedded PG16.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { activityImportFailures, notificationOutbox } from '@hnet/db';
import {
  evaluateActivityFailures,
  renderOutboxEmail,
  runFailureDigest,
  type ActivityFailureInput,
} from '../src/index';
import { bootMigratedDb, type TestDb } from './helpers';

let t: TestDb;
beforeAll(async () => {
  t = await bootMigratedDb();
});
afterAll(async () => {
  await t?.stop();
});
beforeEach(async () => {
  await t.db.delete(notificationOutbox);
  await t.db.delete(activityImportFailures);
});

function failure(overrides: Partial<ActivityFailureInput> & { sourceRef: string; title: string }): ActivityFailureInput {
  return {
    source: 'books',
    kind: 'book',
    section: 'books',
    failureKind: 'stranded_import',
    failureReason: 'downloaded but never imported',
    year: null,
    sourceApp: 'lazylibrarian',
    downstreamUrl: 'http://ll',
    ...overrides,
  };
}

describe('runFailureDigest (ADR-060 follow-up)', () => {
  it('a clean ledger enqueues NOTHING', async () => {
    const report = await runFailureDigest({ db: t.db });
    expect(report).toEqual({ openCount: 0, enqueued: 0 });
    expect(await t.db.select().from(notificationOutbox)).toHaveLength(0);
  });

  it('open failures enqueue ONE email row with the count + item lines; resolved rows are excluded', async () => {
    await evaluateActivityFailures({
      db: t.db,
      failures: [
        failure({ sourceRef: 'a', title: 'The Other Emily' }),
        failure({ sourceRef: 'b', title: 'Hornet Flight', failureKind: 'download_failed' }),
      ],
      scannedSources: ['books'],
    });
    // Resolve one by re-scanning without it — only the survivor may appear in the digest.
    await evaluateActivityFailures({
      db: t.db,
      failures: [failure({ sourceRef: 'a', title: 'The Other Emily' })],
      scannedSources: ['books'],
    });

    const report = await runFailureDigest({ db: t.db, adminEmail: 'admin@haynesnetwork.com' });
    expect(report).toEqual({ openCount: 1, enqueued: 1 });

    const rows = await t.db.select().from(notificationOutbox);
    const digest = rows.filter((r) => r.eventType === 'activity_failure_digest');
    expect(digest).toHaveLength(1);
    expect(digest[0]!.channel).toBe('email');
    expect(digest[0]!.payload).toMatchObject({ to: 'admin@haynesnetwork.com', count: 1 });

    const mail = renderOutboxEmail(digest[0]!)!;
    expect(mail.subject).toContain('1 stuck import');
    expect(mail.text).toContain('The Other Emily');
    expect(mail.text).not.toContain('Hornet Flight'); // resolved — excluded
    expect(mail.text).toContain('https://haynesnetwork.com/library/activity');
  });
});
