import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { appSettings, arrQueueCleanupActions, notificationOutbox, permissionAudit } from '@hnet/db';
import { bootMigratedDb, type TestDb } from './helpers';
import { runFailureDigest } from '../src/activity/digest';
import { renderOutboxEmail } from '../src/notify-outbox';
import { QueueCleanupConfigInvalidError } from '../src/errors';
import {
  ARR_QUEUE_CLEANUP_CONFIG_DEFAULT,
  buildQueueCleanupDigestSection,
  classifyQueueItem,
  deriveQueueCleanupLadderLevel,
  evaluateQueueCleanup,
  getArrQueueCleanupConfig,
  getArrQueueCleanupStatus,
  getQueueCleanupLadder,
  queueCleanupConfigError,
  resolveArrQueueCleanupConfig,
  setArrQueueCleanupConfig,
  type ArrQueueCleanupConfig,
  type ClassifiableQueueItem,
  type QueueCleanupClients,
  type QueueCleanupInstanceClient,
  type QueueCleanupModeCells,
  type QueueCleanupQueueItem,
} from '../src/queue-cleanup';

// ADR-083 / DESIGN-046 (PLAN-065 — *arr queue janitor). The plan's acceptance proof: the classifier assigns
// exactly one Action Class (first-match order, unknown fallback); the census-first evaluator writes one
// append-only row per item and NEVER touches an *arr while a cell is census; enforce honors the rails (cap /
// min-age / monitored-check / retry-escalation) and continues past an *arr write failure (outcome 'error');
// the config validates + audits same-tx and resolves DB-first fail-safe to all-census; and the digest folds
// in the janitor rollup, firing on a clean ledger when the janitor observed anything and nagging when due.

// ---------------------------------------------------------------------------
// Classifier (D-03) — table-driven over synthetic queue records per class per *arr.
// ---------------------------------------------------------------------------

describe('classifyQueueItem (D-03, pure)', () => {
  const msg = (title: string, ...messages: string[]) => ({
    statusMessages: [{ title, messages }],
  });

  const cases: Array<{ name: string; item: ClassifiableQueueItem; class: string }> = [
    // have_better (per *arr)
    {
      name: 'radarr have_better: importBlocked + "Not an upgrade for existing"',
      item: {
        trackedDownloadState: 'importBlocked',
        trackedDownloadStatus: 'warning',
        ...msg('Not an upgrade', 'Not an upgrade for existing movie file(s)'),
      },
      class: 'have_better',
    },
    {
      name: 'sonarr have_better: importBlocked + "Not a Custom Format upgrade"',
      item: {
        trackedDownloadState: 'importBlocked',
        ...msg('Blocked', 'Not a Custom Format upgrade for existing episode file(s)'),
      },
      class: 'have_better',
    },
    {
      name: 'sonarr have_better: cutoff already met',
      item: {
        trackedDownloadState: 'importPending',
        ...msg('Blocked', 'Quality and Language cutoff has already been met'),
      },
      class: 'have_better',
    },
    // bad_release (per *arr / per signal)
    {
      name: 'radarr bad_release: trackedDownloadStatus error',
      item: { trackedDownloadStatus: 'error', trackedDownloadState: 'importFailed' },
      class: 'bad_release',
    },
    {
      name: 'sonarr bad_release: "Unable to parse"',
      item: { trackedDownloadState: 'importBlocked', ...msg('Failed', 'Unable to parse the release title') },
      class: 'bad_release',
    },
    {
      // The single-result shape (RejectedImportService): the release's ONE file is a sample, so the "Sample"
      // rejection sits on the entry titled with the download's own title — the release IS a sample (D-10).
      name: 'radarr bad_release: the whole release is a sample ("Sample" on the release-level entry)',
      item: {
        title: 'Some.Movie.2024.1080p.WEB-DL.DDP5.1.H.264-GRP',
        trackedDownloadState: 'importBlocked',
        trackedDownloadStatus: 'warning',
        ...msg('Some.Movie.2024.1080p.WEB-DL.DDP5.1.H.264-GRP', 'Sample'),
      },
      class: 'bad_release',
    },
    {
      name: 'sonarr bad_release: upstream archive rejection ("Found archive file, might need to be extracted")',
      item: {
        trackedDownloadState: 'importBlocked',
        ...msg('Some.Show.S01E01.1080p.WEB.h264-GRP', 'Found archive file, might need to be extracted'),
      },
      class: 'bad_release',
    },
    {
      name: 'radarr bad_release: password-protected archive',
      item: { ...msg('Rejected', 'The archive is password protected') },
      class: 'bad_release',
    },
    {
      name: 'sonarr bad_release: status failed',
      item: { status: 'failed' },
      class: 'bad_release',
    },
    // retry_import
    {
      name: 'radarr retry_import: importPending + "Waiting to import"',
      item: { trackedDownloadState: 'importPending', ...msg('Pending', 'Waiting to import...') },
      class: 'retry_import',
    },
    {
      name: 'sonarr retry_import: importBlocked with no messages',
      item: { trackedDownloadState: 'importBlocked', statusMessages: [] },
      class: 'retry_import',
    },
    // unknown
    {
      name: 'lidarr unknown: match ambiguity (Q-01, stays unknown initially)',
      item: {
        trackedDownloadState: 'importPending',
        ...msg('Manual import', 'Found matching artist but no album could be found that was close enough'),
      },
      class: 'unknown',
    },
    {
      name: 'unknown fallthrough: a warning with an unrecognized message',
      item: { status: 'warning', ...msg('Note', 'Something the classifier has never seen') },
      class: 'unknown',
    },
  ];

  for (const c of cases) {
    it(c.name, () => {
      const result = classifyQueueItem(c.item);
      expect(result.class).toBe(c.class);
      expect(result.confidence).toBe(c.class === 'unknown' ? 'low' : 'high');
    });
  }

  it('precedence: have_better wins over bad_release when BOTH signals are present', () => {
    const result = classifyQueueItem({
      trackedDownloadState: 'importBlocked',
      trackedDownloadStatus: 'error', // a bad_release signal
      statusMessages: [{ title: 'x', messages: ['Not an upgrade for existing episode file(s)'] }],
    });
    expect(result.class).toBe('have_better');
  });

  it('precedence: bad_release wins over retry_import for a stuck import with an error status', () => {
    const result = classifyQueueItem({
      trackedDownloadState: 'importPending',
      trackedDownloadStatus: 'error',
      statusMessages: [{ title: 'x', messages: ['Waiting to import...'] }],
    });
    expect(result.class).toBe('bad_release');
  });

  // --- DESIGN-046 D-10 (2026-09-25 spot-check) — fixtures from the real census strings ---

  describe('D-10 identity-mismatch guard: have_better + an identity mismatch → unknown (report only)', () => {
    // Real case: 8 "Lioness.2023 S01E01–08" releases grabbed for "Lioness (2021)", a different show missing those
    // episodes; the items ALSO carried CF-score "not an upgrade" messages. Removing them could lose wanted episodes.
    const LIONESS = 'Lioness.2023.S01E03.1080p.WEB.h264-ETHEL';
    const NOT_CF_UPGRADE =
      'Not a Custom Format upgrade for existing episode file(s). New: [] do not improve on Existing: [WEB-DL, x264]';
    const mismatchCases: Array<{ name: string; mismatch: string; hb: string }> = [
      {
        name: 'sonarr: "not found in the grabbed release" (MatchesGrabSpecification)',
        mismatch: `Episode 1x03 was not found in the grabbed release: ${LIONESS}`,
        hb: NOT_CF_UPGRADE,
      },
      {
        name: 'sonarr: "matched to series by ID" (CompletedDownloadService)',
        mismatch:
          'Found matching series via grab history, but release was matched to series by ID. Automatic import is not possible. See the FAQ for details.',
        hb: 'Not an upgrade for existing episode file(s). Existing quality: WEBDL-1080p. New quality WEBDL-1080p.',
      },
      {
        name: 'radarr: "matched to movie by ID" (CompletedDownloadService)',
        mismatch:
          'Found matching movie via grab history, but release was matched to movie by ID. Manual Import required.',
        hb: 'Not an upgrade for existing movie file(s)',
      },
      {
        name: 'sonarr: "unexpected considering the … folder name" (MatchesFolderSpecification)',
        mismatch: `Episode 1x05 was unexpected considering the ${LIONESS} folder name`,
        hb: 'Quality and Language cutoff has already been met',
      },
    ];

    for (const c of mismatchCases) {
      it(c.name, () => {
        const result = classifyQueueItem({
          title: LIONESS,
          status: 'completed',
          trackedDownloadStatus: 'warning',
          trackedDownloadState: 'importBlocked',
          statusMessages: [
            {
              title: 'One or more episodes expected in this release were not imported or missing from the release',
              messages: [],
            },
            { title: `${LIONESS}.mkv`, messages: [c.mismatch, c.hb] },
          ],
        });
        expect(result.class).toBe('unknown');
        expect(result.confidence).toBe('low');
        expect(result.reason).toBe(c.mismatch); // the identity doubt is the reason reported
      });
    }

    it('the guard only vetoes have_better: the same item WITHOUT the mismatch is still have_better', () => {
      const result = classifyQueueItem({
        title: LIONESS,
        trackedDownloadState: 'importBlocked',
        statusMessages: [{ title: `${LIONESS}.mkv`, messages: [NOT_CF_UPGRADE] }],
      });
      expect(result.class).toBe('have_better');
      expect(result.reason).toBe(NOT_CF_UPGRADE);
    });
  });

  describe('D-10 reason: the stored reason is a MESSAGE, never a release or file name', () => {
    it('a plain warning (entry titled with the release name) stores the message, not the release name', () => {
      const release = 'Some.Show.S02E04.1080p.WEB.h264-GRP';
      const text =
        'Found matching series via grab history, but release was matched to series by ID. Automatic import is not possible. See the FAQ for details.';
      const result = classifyQueueItem({
        title: release,
        trackedDownloadState: 'importBlocked',
        statusMessages: [{ title: release, messages: [text] }],
      });
      expect(result.class).toBe('unknown');
      expect(result.reason).toBe(text);
    });

    it('a multi-file set stores a per-file rejection, not the file name and not the generic header', () => {
      const result = classifyQueueItem({
        title: 'Some.Show.S02.1080p.WEB.h264-GRP',
        trackedDownloadState: 'importBlocked',
        statusMessages: [
          {
            title: 'One or more episodes expected in this release were not imported or missing from the release',
            messages: [],
          },
          { title: 'Some.Show.S02E01.1080p.WEB.h264-GRP.mkv', messages: ['Locked file, try again later'] },
        ],
      });
      expect(result.class).toBe('unknown');
      expect(result.reason).toBe('Locked file, try again later');
    });

    it('the download client error comes first when present', () => {
      const result = classifyQueueItem({
        title: 'Some.Movie.2024.1080p-GRP',
        status: 'warning',
        errorMessage: 'The download is stalled with no connections',
        statusMessages: [{ title: 'Some.Movie.2024.1080p-GRP', messages: ['Something the classifier has never seen'] }],
      });
      expect(result.reason).toBe('The download is stalled with no connections');
    });

    it('a title-borne message (an entry with no messages, Lidarr single-result shape) is still a reason', () => {
      const text = 'Album match is not close enough: 58.3% vs 80% [Title 0.12, Track Count 0.40]';
      const result = classifyQueueItem({
        title: 'Some Artist - Some Album (2019) [FLAC]',
        trackedDownloadState: 'importPending',
        statusMessages: [{ title: text, messages: [] }],
      });
      expect(result.class).toBe('unknown');
      expect(result.reason).toBe(text);
    });

    it('only the generic multi-file header present → it is the reason of last resort', () => {
      const header = 'One or more movies expected in this release were not imported or missing';
      const result = classifyQueueItem({
        trackedDownloadState: 'importBlocked',
        statusMessages: [{ title: header, messages: [] }],
      });
      expect(result.class).toBe('unknown');
      expect(result.reason).toBe(header);
    });
  });

  describe('D-10 sample: only a release-level "Sample" verdict is a bad_release signal', () => {
    // Real cases: The Gentlemen, Star Wars Visions — per-file "…-sample.mkv" status TITLES inside otherwise good
    // releases were briefly classed bad_release by the old \bsample\b (title-inclusive) pattern.
    const GENTLEMEN = 'The.Gentlemen.2024.S01.1080p.NF.WEB-DL.DDP5.1.H.264-FLUX';

    it('a per-file "…-sample.mkv" TITLE is a name, not a verdict', () => {
      const result = classifyQueueItem({
        title: GENTLEMEN,
        status: 'completed',
        trackedDownloadStatus: 'warning',
        trackedDownloadState: 'importing',
        statusMessages: [
          {
            title: 'The.Gentlemen.2024.S01E01.1080p.NF.WEB-DL.DDP5.1.H.264-FLUX-sample.mkv',
            messages: ['Locked file, try again later'],
          },
        ],
      });
      expect(result.class).toBe('unknown');
      expect(result.reason).toBe('Locked file, try again later');
    });

    it('a per-file "Sample" rejection among real files (multi-file set) does not condemn the release', () => {
      const result = classifyQueueItem({
        title: 'Star.Wars.Visions.S03.2160p.DSNP.WEB-DL.DDP5.1.H.265-FLUX',
        status: 'completed',
        trackedDownloadStatus: 'warning',
        trackedDownloadState: 'importBlocked',
        statusMessages: [
          {
            title: 'One or more episodes expected in this release were not imported or missing from the release',
            messages: [],
          },
          {
            title: 'Star.Wars.Visions.S03E01.2160p.DSNP.WEB-DL.DDP5.1.H.265-FLUX-sample.mkv',
            messages: ['Sample'],
          },
          {
            title: 'Star.Wars.Visions.S03E02.2160p.DSNP.WEB-DL.DDP5.1.H.265-FLUX.mkv',
            messages: ['Locked file, try again later'],
          },
        ],
      });
      expect(result.class).toBe('unknown');
    });

    it('a sample-named FILE among real files still classes have_better on the files\' own verdict', () => {
      const hb = 'Not a Custom Format upgrade for existing episode file(s). New: [] do not improve on Existing: [DV]';
      const result = classifyQueueItem({
        title: GENTLEMEN,
        trackedDownloadState: 'importBlocked',
        statusMessages: [
          {
            title: 'One or more episodes expected in this release were not imported or missing from the release',
            messages: [],
          },
          { title: 'The.Gentlemen.2024.S01E01.1080p.NF.WEB-DL.DDP5.1.H.264-FLUX-sample.mkv', messages: ['Sample'] },
          { title: 'The.Gentlemen.2024.S01E01.1080p.NF.WEB-DL.DDP5.1.H.264-FLUX.mkv', messages: [hb] },
        ],
      });
      expect(result.class).toBe('have_better');
      expect(result.reason).toBe(hb);
    });

    it('a stand-alone file-named entry (no item title) is treated as per-file — conservative', () => {
      const result = classifyQueueItem({
        trackedDownloadState: 'importBlocked',
        statusMessages: [{ title: 'Some.Show.S01E01-sample.mkv', messages: ['Sample'] }],
      });
      expect(result.class).toBe('unknown');
    });

    it('a single-file download named like a file IS the release when the item title matches', () => {
      const name = 'Some.Show.S01E01.1080p-GRP.mkv';
      const result = classifyQueueItem({
        title: name,
        trackedDownloadState: 'importBlocked',
        statusMessages: [{ title: name, messages: ['Sample'] }],
      });
      expect(result.class).toBe('bad_release');
      expect(result.reason).toBe('Sample');
    });

    it('"Unable to determine if file is a sample" (SampleIndeterminate) is not a sample verdict', () => {
      const result = classifyQueueItem({
        title: 'Some.Movie.2024.1080p-GRP',
        trackedDownloadState: 'importBlocked',
        statusMessages: [
          { title: 'Some.Movie.2024.1080p-GRP', messages: ['Unable to determine if file is a sample'] },
        ],
      });
      expect(result.class).toBe('unknown');
    });
  });

  describe('D-10 release-defect patterns read release-level messages only (sibling of the sample fix)', () => {
    it('"archive" inside a release name or path embedded in a message is not an archive verdict (Archive 81)', () => {
      const release = 'Archive.81.S01E03.1080p.WEB.H264-GLHF';
      const result = classifyQueueItem({
        title: release,
        trackedDownloadState: 'importBlocked',
        statusMessages: [
          { title: release, messages: [`No files found are eligible for import in /data/downloads/complete/${release}`] },
        ],
      });
      expect(result.class).toBe('unknown');
    });

    it('a release NAME that contains "archive" never classifies on its own', () => {
      const release = 'Archive.81.S01E04.1080p.WEB.H264-GLHF';
      const result = classifyQueueItem({
        title: release,
        status: 'completed',
        trackedDownloadState: 'importing',
        statusMessages: [{ title: release, messages: ['Something the classifier has never seen'] }],
      });
      expect(result.class).toBe('unknown');
    });

    it('a per-file "Unable to parse" among real files does not condemn the release', () => {
      const result = classifyQueueItem({
        title: 'Some.Show.S01.1080p.WEB.h264-GRP',
        trackedDownloadState: 'importBlocked',
        statusMessages: [
          {
            title: 'One or more episodes expected in this release were not imported or missing from the release',
            messages: [],
          },
          { title: 'Some.Show.S01.Featurette.1080p.WEB.h264-GRP.mkv', messages: ['Unable to parse file'] },
        ],
      });
      expect(result.class).toBe('unknown');
    });

    it('a download-client failure (errorMessage) still reads as a release defect', () => {
      const result = classifyQueueItem({
        title: 'Some.Movie.2024.1080p-GRP',
        status: 'completed',
        trackedDownloadState: 'importing',
        errorMessage: 'Unpacking failed, archive requires a password',
      });
      expect(result.class).toBe('bad_release');
      expect(result.reason).toBe('Unpacking failed, archive requires a password');
    });
  });

  it('carries the driving message as the reason (≤500 chars)', () => {
    const result = classifyQueueItem({
      trackedDownloadState: 'importBlocked',
      statusMessages: [{ title: 'x', messages: ['Not an upgrade for existing movie file(s)'] }],
    });
    expect(result.reason).toContain('Not an upgrade');
  });
});

// ---------------------------------------------------------------------------
// Config validation (D-05) — pure matrix.
// ---------------------------------------------------------------------------

describe('queueCleanupConfigError (D-05, pure)', () => {
  it('accepts the all-census default', () => {
    expect(queueCleanupConfigError(ARR_QUEUE_CLEANUP_CONFIG_DEFAULT)).toBeNull();
  });
  it('rejects a non-object', () => {
    expect(queueCleanupConfigError(null)).toMatch(/must be an object/);
  });
  it('rejects an unknown instance', () => {
    const cfg = clone();
    (cfg.modes as Record<string, unknown>).plex = cell();
    expect(queueCleanupConfigError(cfg)).toMatch(/Unknown instance/);
  });
  it('rejects an unknown class', () => {
    const cfg = clone();
    (cfg.modes.sonarr as Record<string, unknown>).mystery = 'census';
    expect(queueCleanupConfigError(cfg)).toMatch(/Unknown class/);
  });
  it('rejects a bad mode value', () => {
    const cfg = clone();
    (cfg.modes.sonarr as Record<string, unknown>).have_better = 'on';
    expect(queueCleanupConfigError(cfg)).toMatch(/census.*enforce/);
  });
  it('rejects maxActionsPerRun out of range', () => {
    expect(queueCleanupConfigError({ ...clone(), maxActionsPerRun: 0 })).toMatch(/1\.\.100/);
    expect(queueCleanupConfigError({ ...clone(), maxActionsPerRun: 101 })).toMatch(/1\.\.100/);
  });
  it('rejects minItemAgeHours out of range', () => {
    expect(queueCleanupConfigError({ ...clone(), minItemAgeHours: -1 })).toMatch(/0\.\.168/);
    expect(queueCleanupConfigError({ ...clone(), minItemAgeHours: 200 })).toMatch(/0\.\.168/);
  });
  it('rejects retryEscalateRuns out of range', () => {
    expect(queueCleanupConfigError({ ...clone(), retryEscalateRuns: 0 })).toMatch(/1\.\.48/);
    expect(queueCleanupConfigError({ ...clone(), retryEscalateRuns: 49 })).toMatch(/1\.\.48/);
  });
});

describe('deriveQueueCleanupLadderLevel (D-05, pure)', () => {
  it('L0 when all census', () => {
    expect(deriveQueueCleanupLadderLevel(clone())).toBe(0);
  });
  it('L1 on partial enforcement (have_better on Sonarr + Radarr)', () => {
    const cfg = clone();
    cfg.modes.sonarr.have_better = 'enforce';
    cfg.modes.radarr.have_better = 'enforce';
    expect(deriveQueueCleanupLadderLevel(cfg)).toBe(1);
  });
  it('L2 when every enforceable cell is enforce', () => {
    const cfg = clone();
    for (const inst of ['sonarr', 'radarr', 'lidarr'] as const) {
      cfg.modes[inst] = { have_better: 'enforce', retry_import: 'enforce', bad_release: 'enforce' };
    }
    expect(deriveQueueCleanupLadderLevel(cfg)).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Test helpers.
// ---------------------------------------------------------------------------

function cell(o: Partial<QueueCleanupModeCells> = {}): QueueCleanupModeCells {
  return { have_better: 'census', retry_import: 'census', bad_release: 'census', ...o };
}

/** A fresh config (deep-cloned so a test can mutate cells without leaking). minItemAgeHours 0 unless set. */
function clone(o: Partial<ArrQueueCleanupConfig> = {}): ArrQueueCleanupConfig {
  return {
    modes: { sonarr: cell(), radarr: cell(), lidarr: cell() },
    maxActionsPerRun: 10,
    minItemAgeHours: 0,
    retryEscalateRuns: 6,
    ...o,
  };
}

function item(overrides: Partial<QueueCleanupQueueItem> & { queueItemId: number }): QueueCleanupQueueItem {
  return {
    downloadId: null,
    title: null,
    addedAt: null,
    status: null,
    trackedDownloadStatus: null,
    trackedDownloadState: null,
    errorMessage: null,
    statusMessages: null,
    ...overrides,
  };
}

const haveBetter = (id: number, downloadId?: string) =>
  item({
    queueItemId: id,
    downloadId: downloadId ?? `dl-${id}`,
    trackedDownloadState: 'importBlocked',
    statusMessages: [{ title: 'x', messages: ['Not an upgrade for existing movie file(s)'] }],
  });
const badRelease = (id: number, downloadId?: string) =>
  item({
    queueItemId: id,
    downloadId: downloadId ?? `dl-${id}`,
    trackedDownloadStatus: 'error',
    trackedDownloadState: 'importFailed',
    statusMessages: [{ title: 'x', messages: ['Unable to parse the release title'] }],
  });
const retryImport = (id: number, downloadId?: string) =>
  item({
    queueItemId: id,
    downloadId: downloadId ?? `dl-${id}`,
    trackedDownloadState: 'importPending',
    statusMessages: [{ title: 'x', messages: ['Waiting to import...'] }],
  });
const unknownItem = (id: number) =>
  item({
    queueItemId: id,
    downloadId: `dl-${id}`,
    trackedDownloadState: 'importPending',
    statusMessages: [{ title: 'x', messages: ['no album could be found that was close enough'] }],
  });

interface InstanceStub {
  client: QueueCleanupInstanceClient;
  calls: {
    deletes: Array<{ id: number; removeFromClient: boolean; blocklist: boolean; skipRedownload: boolean }>;
    processMonitored: number;
    searches: number[];
    monitoredChecks: number;
  };
}

function makeInstanceStub(
  items: QueueCleanupQueueItem[],
  opts: { readError?: boolean; monitored?: boolean; deleteError?: boolean; explodeOnWrite?: boolean } = {},
): InstanceStub {
  const calls = { deletes: [] as InstanceStub['calls']['deletes'], processMonitored: 0, searches: [] as number[], monitoredChecks: 0 };
  return {
    calls,
    client: {
      async getQueueAll() {
        if (opts.readError) throw new Error('queue read failed');
        return items;
      },
      async deleteQueueItem(qi, o) {
        if (opts.explodeOnWrite) throw new Error('census must never write');
        if (opts.deleteError) throw new Error('delete failed');
        calls.deletes.push({
          id: qi.queueItemId,
          removeFromClient: o.removeFromClient,
          blocklist: o.blocklist,
          skipRedownload: o.skipRedownload,
        });
      },
      async processMonitoredDownloads() {
        if (opts.explodeOnWrite) throw new Error('census must never write');
        calls.processMonitored += 1;
      },
      async isTargetMonitored() {
        calls.monitoredChecks += 1;
        return opts.monitored ?? false;
      },
      async searchTarget(qi) {
        if (opts.explodeOnWrite) throw new Error('census must never write');
        calls.searches.push(qi.queueItemId);
      },
    },
  };
}

function makeClients(map: Partial<Record<'sonarr' | 'radarr' | 'lidarr', QueueCleanupInstanceClient>>): QueueCleanupClients {
  const empty = () => makeInstanceStub([]).client;
  return {
    sonarr: map.sonarr ?? empty(),
    radarr: map.radarr ?? empty(),
    lidarr: map.lidarr ?? empty(),
  };
}

// ---------------------------------------------------------------------------
// Evaluator + config resolution + digest (embedded Postgres).
// ---------------------------------------------------------------------------

describe('evaluateQueueCleanup + config + digest (embedded Postgres)', () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await bootMigratedDb();
  });
  afterAll(async () => {
    await t.stop();
  });
  beforeEach(async () => {
    await t.db.delete(arrQueueCleanupActions);
    await t.db.delete(notificationOutbox);
    await t.db.delete(permissionAudit);
    await t.db.delete(appSettings);
  });

  // --- config resolution + audit (D-05) ---

  it('setArrQueueCleanupConfig stores the config AND an update_app_setting audit row in the same tx', async () => {
    const cfg = clone();
    cfg.modes.sonarr.have_better = 'enforce';
    const res = await setArrQueueCleanupConfig({ db: t.db, config: cfg, actorId: null });
    expect(res.changed).toBe(true);

    const stored = await getArrQueueCleanupConfig(t.db);
    expect(stored?.modes.sonarr.have_better).toBe('enforce');
    const audits = await t.db
      .select()
      .from(permissionAudit)
      .where(eq(permissionAudit.action, 'update_app_setting'));
    expect(audits).toHaveLength(1);
    expect((audits[0]!.detail as { key?: string }).key).toBe('arr_queue_cleanup_config');
  });

  it('rejects an invalid config at the writer (QueueCleanupConfigInvalidError) and stores NO row', async () => {
    await expect(
      setArrQueueCleanupConfig({ db: t.db, config: { ...clone(), maxActionsPerRun: 999 }, actorId: null }),
    ).rejects.toBeInstanceOf(QueueCleanupConfigInvalidError);
    expect(await getArrQueueCleanupConfig(t.db)).toBeNull();
    expect(
      await t.db.select().from(permissionAudit).where(eq(permissionAudit.action, 'update_app_setting')),
    ).toHaveLength(0);
  });

  it('resolves DB row → default; a garbage stored row fails SAFE to all-census', async () => {
    // No row ⇒ the all-census default.
    expect(await resolveArrQueueCleanupConfig(t.db)).toEqual(ARR_QUEUE_CLEANUP_CONFIG_DEFAULT);

    // A valid stored row wins.
    const cfg = clone({ maxActionsPerRun: 5 });
    cfg.modes.radarr.bad_release = 'enforce';
    await setArrQueueCleanupConfig({ db: t.db, config: cfg, actorId: null });
    const resolved = await resolveArrQueueCleanupConfig(t.db);
    expect(resolved.maxActionsPerRun).toBe(5);
    expect(resolved.modes.radarr.bad_release).toBe('enforce');

    // A hand-edited garbage row reads as null ⇒ all-census (a malformed cell can never accidentally enforce).
    await t.db
      .update(appSettings)
      .set({ value: { modes: 'garbage' } })
      .where(eq(appSettings.key, 'arr_queue_cleanup_config'));
    expect(await getArrQueueCleanupConfig(t.db)).toBeNull();
    expect(await resolveArrQueueCleanupConfig(t.db)).toEqual(ARR_QUEUE_CLEANUP_CONFIG_DEFAULT);
  });

  // --- evaluator (D-04/D-06) ---

  it('CENSUS: writes one row per item, NEVER calls an *arr write, all mode census', async () => {
    const sonarr = makeInstanceStub([haveBetter(1), badRelease(2), retryImport(3), unknownItem(4)], {
      explodeOnWrite: true,
    });
    const report = await evaluateQueueCleanup({
      db: t.db,
      clients: makeClients({ sonarr: sonarr.client }),
      config: clone(),
    });
    expect(report.rowsWritten).toBe(4);
    expect(report.totalFailure).toBe(false);
    expect(sonarr.calls.deletes).toHaveLength(0);
    expect(sonarr.calls.processMonitored).toBe(0);
    expect(sonarr.calls.searches).toHaveLength(0);

    const rows = await t.db.select().from(arrQueueCleanupActions);
    expect(rows).toHaveLength(4);
    expect(rows.every((r) => r.mode === 'census')).toBe(true);
    expect(rows.every((r) => r.outcome === 'observed')).toBe(true);
    expect(rows.every((r) => r.action === 'none')).toBe(true);
    // Each class is represented (the unknown item classified unknown, never acted).
    expect(new Set(rows.map((r) => r.actionClass))).toEqual(
      new Set(['have_better', 'bad_release', 'retry_import', 'unknown']),
    );
  });

  it('ENFORCE have_better: removes + blocklists with skipRedownload, no re-search (action removed_blocklisted)', async () => {
    const radarr = makeInstanceStub([haveBetter(10)]);
    const cfg = clone();
    cfg.modes.radarr.have_better = 'enforce';
    await evaluateQueueCleanup({ db: t.db, clients: makeClients({ radarr: radarr.client }), config: cfg });

    // D-10: skipRedownload so the *arr's own "Redownload Failed" never re-searches behind the janitor's back.
    expect(radarr.calls.deletes).toEqual([{ id: 10, removeFromClient: true, blocklist: true, skipRedownload: true }]);
    expect(radarr.calls.searches).toHaveLength(0);
    const [row] = await t.db.select().from(arrQueueCleanupActions);
    expect(row!.action).toBe('removed_blocklisted');
    expect(row!.outcome).toBe('done');
  });

  it('ENFORCE bad_release: monitored → blocklist + re-search; unmonitored → blocklist only', async () => {
    const cfg = clone();
    cfg.modes.sonarr.bad_release = 'enforce';

    const monitored = makeInstanceStub([badRelease(20)], { monitored: true });
    await evaluateQueueCleanup({ db: t.db, clients: makeClients({ sonarr: monitored.client }), config: cfg });
    // D-10: the *arr's automatic re-search is suppressed; the janitor's own monitored-checked search is the one.
    expect(monitored.calls.deletes).toEqual([{ id: 20, removeFromClient: true, blocklist: true, skipRedownload: true }]);
    expect(monitored.calls.searches).toEqual([20]);
    let rows = await t.db.select().from(arrQueueCleanupActions);
    expect(rows[0]!.action).toBe('blocklisted_searched');

    await t.db.delete(arrQueueCleanupActions);
    const unmonitored = makeInstanceStub([badRelease(21)], { monitored: false });
    await evaluateQueueCleanup({ db: t.db, clients: makeClients({ sonarr: unmonitored.client }), config: cfg });
    expect(unmonitored.calls.deletes).toEqual([
      { id: 21, removeFromClient: true, blocklist: true, skipRedownload: true },
    ]);
    expect(unmonitored.calls.searches).toHaveLength(0);
    rows = await t.db.select().from(arrQueueCleanupActions);
    expect(rows[0]!.action).toBe('removed_blocklisted');
  });

  it('ENFORCE retry_import: runs ProcessMonitoredDownloads at most ONCE per instance per run', async () => {
    const cfg = clone();
    cfg.modes.radarr.retry_import = 'enforce';
    const radarr = makeInstanceStub([retryImport(30, 'a'), retryImport(31, 'b')]);
    await evaluateQueueCleanup({ db: t.db, clients: makeClients({ radarr: radarr.client }), config: cfg });
    expect(radarr.calls.processMonitored).toBe(1); // one estate-wide command covers both
    const rows = await t.db.select().from(arrQueueCleanupActions);
    expect(rows.every((r) => r.action === 'retried_import' && r.outcome === 'done')).toBe(true);
  });

  it('RAIL cap: maxActionsPerRun stops further actions (skipped_cap), census row still written', async () => {
    const cfg = clone({ maxActionsPerRun: 1 });
    cfg.modes.radarr.have_better = 'enforce';
    const radarr = makeInstanceStub([haveBetter(40), haveBetter(41)]);
    await evaluateQueueCleanup({ db: t.db, clients: makeClients({ radarr: radarr.client }), config: cfg });
    expect(radarr.calls.deletes).toHaveLength(1); // capped at 1
    const rows = await t.db.select().from(arrQueueCleanupActions).orderBy(arrQueueCleanupActions.queueItemId);
    expect(rows.map((r) => r.action)).toEqual(['removed_blocklisted', 'skipped_cap']);
  });

  it('RAIL min-age: a freshly-added item is skipped_young and never acted on', async () => {
    const now = new Date('2026-08-01T12:00:00Z');
    const cfg = clone({ minItemAgeHours: 2 });
    cfg.modes.radarr.have_better = 'enforce';
    const fresh = haveBetter(50);
    fresh.addedAt = new Date(now.getTime() - 30 * 60 * 1000); // 30 min old < 2h
    const radarr = makeInstanceStub([fresh]);
    await evaluateQueueCleanup({ db: t.db, clients: makeClients({ radarr: radarr.client }), config: cfg, now });
    expect(radarr.calls.deletes).toHaveLength(0);
    const [row] = await t.db.select().from(arrQueueCleanupActions);
    expect(row!.action).toBe('skipped_young');
    expect(row!.outcome).toBe('observed');
  });

  it('ERROR-CONTINUE: an *arr write failure records outcome error, counts the cap, and the run continues', async () => {
    const cfg = clone();
    cfg.modes.radarr.have_better = 'enforce';
    const radarr = makeInstanceStub([haveBetter(60), haveBetter(61)], { deleteError: true });
    const report = await evaluateQueueCleanup({
      db: t.db,
      clients: makeClients({ radarr: radarr.client }),
      config: cfg,
    });
    expect(report.instances.find((i) => i.instance === 'radarr')!.errors).toBe(2);
    const rows = await t.db.select().from(arrQueueCleanupActions);
    expect(rows).toHaveLength(2); // both observed despite the write failures
    expect(rows.every((r) => r.outcome === 'error' && r.error !== null)).toBe(true);
  });

  it('ESCALATION: a retry_import at/over retryEscalateRuns prior runs is handled as bad_release', async () => {
    const cfg = clone({ retryEscalateRuns: 2 });
    cfg.modes.sonarr.bad_release = 'enforce';
    // Seed 2 prior retry_import observations for (sonarr, dl-esc) — the escalation lookback (test dir is
    // exempt from the single-writer guard).
    await t.db.insert(arrQueueCleanupActions).values([
      { instance: 'sonarr', queueItemId: 1, downloadId: 'dl-esc', actionClass: 'retry_import', mode: 'census', action: 'none', outcome: 'observed' },
      { instance: 'sonarr', queueItemId: 1, downloadId: 'dl-esc', actionClass: 'retry_import', mode: 'census', action: 'none', outcome: 'observed' },
    ]);
    const sonarr = makeInstanceStub([retryImport(70, 'dl-esc')], { monitored: false });
    await evaluateQueueCleanup({ db: t.db, clients: makeClients({ sonarr: sonarr.client }), config: cfg });
    // It escalated to bad_release + acted (delete, unmonitored ⇒ no search).
    expect(sonarr.calls.deletes).toHaveLength(1);
    const latest = await t.db
      .select()
      .from(arrQueueCleanupActions)
      .where(eq(arrQueueCleanupActions.queueItemId, 70));
    expect(latest[0]!.actionClass).toBe('bad_release');
  });

  it('totalFailure when EVERY instance queue read fails, and no rows are written', async () => {
    const report = await evaluateQueueCleanup({
      db: t.db,
      clients: {
        sonarr: makeInstanceStub([], { readError: true }).client,
        radarr: makeInstanceStub([], { readError: true }).client,
        lidarr: makeInstanceStub([], { readError: true }).client,
      },
      config: clone(),
    });
    expect(report.totalFailure).toBe(true);
    expect(report.rowsWritten).toBe(0);
    expect(await t.db.select().from(arrQueueCleanupActions)).toHaveLength(0);
  });

  it('getArrQueueCleanupStatus reports the resolved config, ladder, and 7-day summary', async () => {
    await evaluateQueueCleanup({
      db: t.db,
      clients: makeClients({ sonarr: makeInstanceStub([haveBetter(80), badRelease(81)]).client }),
      config: clone(),
    });
    const status = await getArrQueueCleanupStatus({ db: t.db });
    expect(status.source).toBe('default');
    expect(status.ladder.level).toBe(0);
    const hb = status.summary.find((c) => c.instance === 'sonarr' && c.actionClass === 'have_better');
    expect(hb?.observed).toBe(1);
  });

  // --- digest (D-07) ---

  it('DIGEST: fires on a CLEAN failure ledger when the janitor observed anything (OR-enqueue)', async () => {
    await evaluateQueueCleanup({
      db: t.db,
      clients: makeClients({ sonarr: makeInstanceStub([haveBetter(90), unknownItem(91)]).client }),
      config: clone(),
    });
    const report = await runFailureDigest({ db: t.db, adminEmail: 'admin@example.test' });
    expect(report.openCount).toBe(0);
    expect(report.enqueued).toBe(1);
    expect(report.queueObserved).toBe(2);

    const [row] = await t.db.select().from(notificationOutbox);
    const payload = row!.payload as Record<string, unknown>;
    expect(payload.count).toBe(0);
    expect(payload.queueCleanup).toBeTruthy();
  });

  it('DIGEST: a clean ledger AND a janitor-silent 24h enqueues NOTHING', async () => {
    const report = await runFailureDigest({ db: t.db, adminEmail: 'admin@example.test' });
    expect(report.enqueued).toBe(0);
    expect(await t.db.select().from(notificationOutbox)).toHaveLength(0);
  });

  it('DIGEST section payload rolls up per instance × class with top reasons', async () => {
    await evaluateQueueCleanup({
      db: t.db,
      clients: makeClients({ radarr: makeInstanceStub([haveBetter(100), haveBetter(101), badRelease(102)]).client }),
      config: clone(),
    });
    const section = await buildQueueCleanupDigestSection({ db: t.db });
    expect(section).not.toBeNull();
    expect(section!.observed).toBe(3);
    const radarr = section!.instances.find((i) => i.instance === 'radarr')!;
    const hb = radarr.classes.find((c) => c.actionClass === 'have_better')!;
    expect(hb.census).toBe(2);
    expect(hb.topReasons[0]!.count).toBe(2);
  });

  it('REASON (D-10): rows store the message as reason (release name only in title); digest top reasons are messages', async () => {
    const release = 'Some.Show.S02E04.1080p.WEB.h264-GRP';
    const text =
      'Found matching series via grab history, but release was matched to series by ID. Automatic import is not possible. See the FAQ for details.';
    const orphan = (id: number) =>
      item({
        queueItemId: id,
        downloadId: `dl-${id}`,
        title: release,
        trackedDownloadState: 'importBlocked',
        statusMessages: [{ title: release, messages: [text] }],
      });
    await evaluateQueueCleanup({
      db: t.db,
      clients: makeClients({ sonarr: makeInstanceStub([orphan(110), orphan(111)]).client }),
      config: clone(),
    });
    const rows = await t.db.select().from(arrQueueCleanupActions);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.actionClass === 'unknown' && r.reason === text && r.title === release)).toBe(true);

    const section = await buildQueueCleanupDigestSection({ db: t.db });
    const unknown = section!.instances
      .find((i) => i.instance === 'sonarr')!
      .classes.find((c) => c.actionClass === 'unknown')!;
    expect(unknown.topReasons).toEqual([{ reason: text, count: 2 }]);
  });

  it('GUARD (D-10): an identity-mismatched "have better" item is never removed, even with have_better enforced', async () => {
    const release = 'Lioness.2023.S01E01.1080p.WEB.h264-ETHEL';
    const lioness = item({
      queueItemId: 120,
      downloadId: 'dl-lioness',
      title: release,
      trackedDownloadState: 'importBlocked',
      statusMessages: [
        {
          title: `${release}.mkv`,
          messages: [
            `Episode 1x01 was not found in the grabbed release: ${release}`,
            'Not a Custom Format upgrade for existing episode file(s). New: [] do not improve on Existing: [WEB-DL]',
          ],
        },
      ],
    });
    const cfg = clone();
    cfg.modes.sonarr.have_better = 'enforce';
    const sonarr = makeInstanceStub([lioness], { explodeOnWrite: true });
    await evaluateQueueCleanup({ db: t.db, clients: makeClients({ sonarr: sonarr.client }), config: cfg });
    expect(sonarr.calls.deletes).toHaveLength(0);
    const [row] = await t.db.select().from(arrQueueCleanupActions);
    expect(row!.actionClass).toBe('unknown');
    expect(row!.action).toBe('none');
    expect(row!.outcome).toBe('observed');
  });

  it('LADDER nag: promotionDue when census data spans ≥3 distinct days at L0', async () => {
    const now = new Date('2026-08-15T00:00:00Z');
    const day = (d: string) =>
      ({
        instance: 'sonarr' as const,
        queueItemId: 1,
        downloadId: 'd',
        actionClass: 'have_better' as const,
        mode: 'census' as const,
        action: 'none' as const,
        outcome: 'observed' as const,
        createdAt: new Date(d),
      });
    await t.db.insert(arrQueueCleanupActions).values([
      day('2026-08-12T00:00:00Z'),
      day('2026-08-13T00:00:00Z'),
      day('2026-08-14T00:00:00Z'),
    ]);
    const ladder = await getQueueCleanupLadder({ db: t.db, config: clone(), now });
    expect(ladder.level).toBe(0);
    expect(ladder.promotionDue).toBe(true);

    // Only one day of census ⇒ not due.
    await t.db.delete(arrQueueCleanupActions);
    await t.db.insert(arrQueueCleanupActions).values([day('2026-08-14T00:00:00Z')]);
    const ladder2 = await getQueueCleanupLadder({ db: t.db, config: clone(), now });
    expect(ladder2.promotionDue).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Render (D-07) — the digest email subject + body, pure.
// ---------------------------------------------------------------------------

describe('renderOutboxEmail — activity_failure_digest janitor section (D-07)', () => {
  const section = {
    observed: 5,
    actions: 2,
    instances: [
      {
        instance: 'radarr',
        classes: [
          { actionClass: 'have_better', census: 3, enforced: 0, topReasons: [{ reason: 'Not an upgrade', count: 3 }] },
        ],
      },
    ],
    ladder: { level: 0, ageDays: 4, nextCriteria: 'L0→L1: enforce have_better…' },
    promotionDue: false,
  };

  it('renders a janitor-only census subject + body when the failure ledger is clean (count 0)', () => {
    const mail = renderOutboxEmail({
      eventType: 'activity_failure_digest',
      payload: { to: 'admin@example.test', count: 0, queueCleanup: section },
    });
    expect(mail).not.toBeNull();
    expect(mail!.subject).toContain('Queue janitor census — 5 observed');
    expect(mail!.subject).not.toContain('promotion due');
    expect(mail!.text).toContain('Queue janitor (last 24h): 5 observed, 2 actioned.');
    expect(mail!.text).toContain('have better: 3 census');
    expect(mail!.text).toContain('/admin/janitor');
  });

  it('appends [janitor: promotion due] to the subject when the nag fires (alongside open failures)', () => {
    const mail = renderOutboxEmail({
      eventType: 'activity_failure_digest',
      payload: {
        to: 'admin@example.test',
        count: 2,
        items: [{ title: 'Stuck', failureKind: 'import_blocked', sourceApp: 'radarr' }],
        queueCleanup: { ...section, promotionDue: true },
      },
    });
    expect(mail!.subject).toContain('2 stuck imports need attention');
    expect(mail!.subject).toContain('[janitor: promotion due]');
    // Both blocks present.
    expect(mail!.text).toContain('Open import failures at digest time');
    expect(mail!.text).toContain('Queue janitor (last 24h)');
  });
});
