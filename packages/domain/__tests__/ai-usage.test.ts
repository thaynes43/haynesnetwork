import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { aiUsageChats } from '@hnet/db';
import { bootMigratedDb, type TestDb } from './helpers';
import {
  getAiUsage,
  syncAiUsage,
  type AiUsageChatInput,
  type AiUsageUserInput,
} from '../src/ai-usage';

// ADR-044 / DESIGN-022 (PLAN-021) — the AI usage vertical. These tests are the plan's acceptance proof:
//   • syncAiUsage upserts the OWUI chat mirror idempotently (re-sync updates in place, never duplicates);
//   • getAiUsage SHAPES the payload by metrics level — `limited` returns aggregate counts + trend ONLY
//     (no byUser/byModel, no activeUsers/identity), `full` ADDS the per-model + per-user breakdown. This
//     is the level-gated attribution seam (ADR-044 C-03 — the user-aware-metrics gating rule).

// A fixed clock so the range windows are deterministic.
const NOW = new Date('2026-07-10T12:00:00.000Z');
const daysAgo = (n: number): Date => new Date(NOW.getTime() - n * 86_400_000);

const USERS: AiUsageUserInput[] = [
  { id: 'u1', name: 'Alice', email: 'alice@example.test', role: 'admin' },
  { id: 'u2', name: 'Bob', email: 'bob@example.test', role: 'user' },
];

const CHATS: AiUsageChatInput[] = [
  {
    owuiChatId: 'chat-a',
    owuiUserId: 'u1',
    title: 'planning',
    models: ['gpt-oss:latest'],
    primaryModel: 'gpt-oss:latest',
    messageCount: 4,
    imageCount: 2,
    totalTokens: 173,
    totalDurationMs: 90_000,
    chatCreatedAt: daysAgo(2),
    chatUpdatedAt: daysAgo(2),
    archived: false,
  },
  {
    owuiChatId: 'chat-b',
    owuiUserId: 'u1',
    title: 'coding help',
    models: ['llama3.3:latest'],
    primaryModel: 'llama3.3:latest',
    messageCount: 6,
    imageCount: 0,
    totalTokens: 500,
    totalDurationMs: 30_000,
    chatCreatedAt: daysAgo(1),
    chatUpdatedAt: daysAgo(1),
    archived: false,
  },
  {
    owuiChatId: 'chat-c',
    owuiUserId: 'u2',
    title: 'art',
    models: ['gpt-oss:latest'],
    primaryModel: 'gpt-oss:latest',
    messageCount: 2,
    imageCount: 5,
    totalTokens: 40,
    totalDurationMs: 5_000,
    chatCreatedAt: daysAgo(10),
    chatUpdatedAt: daysAgo(10),
    archived: false,
  },
];

describe('AI usage (ADR-044 / DESIGN-022)', () => {
  let harness: TestDb;

  beforeAll(async () => {
    harness = await bootMigratedDb();
  });
  afterAll(async () => {
    await harness.stop();
  });
  beforeEach(async () => {
    await harness.db.delete(aiUsageChats);
  });

  describe('syncAiUsage — the single writer', () => {
    it('upserts one row per chat and denormalizes the owner (attribution)', async () => {
      const report = await syncAiUsage({ db: harness.db, chats: CHATS, users: USERS, now: NOW });
      expect(report.chats).toBe(3);
      expect(report.upserted).toBe(3);
      expect(report.imageGenerations).toBe(7); // 2 + 0 + 5
      expect(report.usersResolved).toBe(3); // every chat's owner is a known user

      const rows = await harness.db.select().from(aiUsageChats);
      expect(rows).toHaveLength(3);
      const a = rows.find((r) => r.owuiChatId === 'chat-a')!;
      expect(a.userName).toBe('Alice');
      expect(a.userRole).toBe('admin');
      expect(a.imageCount).toBe(2);
      expect(a.models).toEqual(['gpt-oss:latest']);
      expect(a.totalDurationMs).toBe(90_000);
    });

    it('is idempotent — a re-sync updates in place (no duplicate rows)', async () => {
      await syncAiUsage({ db: harness.db, chats: CHATS, users: USERS, now: NOW });
      // chat-a gains an image on the next poll (OWUI chat was extended).
      const updated = CHATS.map((c) =>
        c.owuiChatId === 'chat-a' ? { ...c, imageCount: 3, messageCount: 6 } : c,
      );
      const report = await syncAiUsage({ db: harness.db, chats: updated, users: USERS, now: NOW });
      expect(report.upserted).toBe(3);
      const rows = await harness.db.select().from(aiUsageChats);
      expect(rows).toHaveLength(3); // still 3, not 6
      const a = rows.find((r) => r.owuiChatId === 'chat-a')!;
      expect(a.imageCount).toBe(3);
      expect(a.messageCount).toBe(6);
    });

    it('leaves attribution null when the owner is not in the users list', async () => {
      const report = await syncAiUsage({ db: harness.db, chats: CHATS, users: [], now: NOW });
      expect(report.usersResolved).toBe(0);
      const rows = await harness.db.select().from(aiUsageChats);
      expect(rows.every((r) => r.userName === null)).toBe(true);
    });
  });

  describe('getAiUsage — the level-gated seam', () => {
    beforeEach(async () => {
      await syncAiUsage({ db: harness.db, chats: CHATS, users: USERS, now: NOW });
    });

    it('limited: aggregate counts + trend ONLY — no user identity, no model breakdown', async () => {
      const m = await getAiUsage({ db: harness.db, level: 'limited', range: '30d', now: NOW });
      expect(m.level).toBe('limited');
      expect(m.totals.chats).toBe(3);
      expect(m.totals.imageGenerations).toBe(7);
      expect(m.totals.messages).toBe(12);
      // The seam: NO user-aware fields at limited.
      expect(m.totals.activeUsers).toBeNull();
      expect(m.byUser).toBeUndefined();
      expect(m.byModel).toBeUndefined();
      // The trend is present at both levels.
      expect(m.series.length).toBeGreaterThan(0);
      const seriesChats = m.series.reduce((n, p) => n + p.chats, 0);
      expect(seriesChats).toBe(3);
    });

    it('full: ADDS the per-model + per-user attribution (who / how long / for what)', async () => {
      const m = await getAiUsage({ db: harness.db, level: 'full', range: '30d', now: NOW });
      expect(m.level).toBe('full');
      expect(m.totals.activeUsers).toBe(2);

      // byModel — gpt-oss (2 chats, 7 images) ranks above llama3.3 (1 chat).
      expect(m.byModel).toBeDefined();
      const gptOss = m.byModel!.find((r) => r.model === 'gpt-oss:latest')!;
      expect(gptOss.chats).toBe(2);
      expect(gptOss.imageGenerations).toBe(7);
      expect(m.byModel![0]!.model).toBe('gpt-oss:latest'); // ordered by chat count desc

      // byUser — Alice (2 chats, 120s across two models), Bob (1 chat, 5 images).
      expect(m.byUser).toBeDefined();
      const alice = m.byUser!.find((u) => u.userId === 'u1')!;
      expect(alice.name).toBe('Alice');
      expect(alice.chats).toBe(2);
      expect(alice.totalDurationMs).toBe(120_000);
      expect(alice.models).toEqual(['gpt-oss:latest', 'llama3.3:latest']);
      const bob = m.byUser!.find((u) => u.userId === 'u2')!;
      expect(bob.imageGenerations).toBe(5);
    });

    it('respects the range window (a 10-day-old chat drops out of 7d)', async () => {
      const m = await getAiUsage({ db: harness.db, level: 'full', range: '7d', now: NOW });
      expect(m.totals.chats).toBe(2); // chat-c (10 days ago) excluded
      expect(m.totals.imageGenerations).toBe(2);
      expect(m.totals.activeUsers).toBe(1); // only Alice in the last 7 days
    });

    it('all-time includes everything (no lower bound)', async () => {
      const m = await getAiUsage({ db: harness.db, level: 'full', range: 'all', now: NOW });
      expect(m.since).toBeNull();
      expect(m.totals.chats).toBe(3);
    });
  });
});
