import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  appSettings,
  arrQueueCleanupActions,
  arrQueueCleanupBlockTerms,
  notificationOutbox,
  permissionAudit,
} from '@hnet/db';
import { ArrHttpError } from '@hnet/arr';
import type { SonarrClient, RadarrClient, LidarrClient } from '@hnet/arr/read';
import type { SonarrWriteClient, RadarrWriteClient, LidarrWriteClient } from '@hnet/arr/write';
import { bootMigratedDb, type TestDb } from './helpers';
import { runFailureDigest } from '../src/activity/digest';
import { renderOutboxEmail } from '../src/notify-outbox';
import { JanitorReleaseBlockError, QueueCleanupConfigInvalidError } from '../src/errors';
import {
  JANITOR_BLOCK_SENTINEL,
  deriveJanitorBlockTerm,
  janitorBlockProfileDrift,
  reconcileJanitorReleaseBlock,
  reconcileJanitorReleaseBlockIfDue,
  type JanitorReleaseProfile,
  type JanitorReleaseProfileClient,
} from '../src/janitor-release-block';
import { isGrammarTerm, isWholeNameTerm, renderTerm, termMatchesRaw } from '../src/release-terms';
import {
  ARR_QUEUE_CLEANUP_CONFIG_DEFAULT,
  buildQueueCleanupClients,
  buildQueueCleanupDigestSection,
  classifyQueueItem,
  deriveQueueCleanupLadderLevel,
  evaluateQueueCleanup,
  getArrQueueCleanupConfig,
  getArrQueueCleanupStatus,
  getQueueCleanupLadder,
  groupQueueRecordsByDownload,
  isLidarrAlbumMissing,
  ARR_MANUAL_FAILURE_MESSAGE,
  MANUAL_MATCH_LOOP_LIMIT,
  QUEUE_CLEANUP_LOOP_LIMIT,
  QUEUE_CLEANUP_LOOP_LOG,
  QUEUE_CLEANUP_LOOP_WINDOW_MS,
  queueCleanupCellMode,
  queueCleanupConfigError,
  resolveArrQueueCleanupConfig,
  setArrQueueCleanupConfig,
  type ArrQueueCleanupConfig,
  type ClassifiableQueueItem,
  type QueueCleanupClients,
  type QueueCleanupFailedDownload,
  type QueueCleanupFailedDownloadSource,
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
      // D-12 graduates Lidarr's own match rejections only; a paraphrase is not one of them.
      name: 'unknown: a wording that is not an upstream Lidarr match rejection stays unknown',
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

  // --- DESIGN-046 D-25 — a release held back by the *arr's delay profile is `waiting`, not unknown ---

  describe('D-25 waiting: a delay-profile hold is benign, never unknown', () => {
    // The shape the *arr gives a pending release: status delay, nothing wrong, nothing downloaded.
    const delayed = {
      status: 'delay',
      trackedDownloadStatus: 'ok',
      trackedDownloadState: 'downloading',
      statusMessages: [],
    };

    it('status delay with nothing wrong is waiting (any casing), with no reason', () => {
      expect(classifyQueueItem(delayed)).toEqual({ class: 'waiting', reason: null, confidence: 'high' });
      expect(classifyQueueItem({ status: 'Delay' }).class).toBe('waiting');
      expect(classifyQueueItem({ status: 'delay', statusMessages: null }).class).toBe('waiting');
    });

    it('never masks an actionable class: an error, a failed state or a stuck import still wins', () => {
      expect(classifyQueueItem({ ...delayed, trackedDownloadStatus: 'error' }).class).toBe('bad_release');
      expect(classifyQueueItem({ ...delayed, trackedDownloadState: 'failed' }).class).toBe('bad_release');
      expect(
        classifyQueueItem({ status: 'delay', trackedDownloadState: 'importPending', statusMessages: [] }).class,
      ).toBe('retry_import');
      expect(
        classifyQueueItem({
          status: 'delay',
          trackedDownloadState: 'importBlocked',
          ...msg('x', 'Not an upgrade for existing movie file(s)'),
        }).class,
      ).toBe('have_better');
    });

    it('only `delay` is waiting: a pending state, an unavailable client and an unlisted status stay as they were', () => {
      // `pending` is not an *arr queue status; importPending / failedPending are states and keep their own handling.
      expect(classifyQueueItem({ status: 'pending' }).class).toBe('unknown');
      expect(classifyQueueItem({ trackedDownloadState: 'failedPending' }).class).toBe('unknown');
      expect(classifyQueueItem({ trackedDownloadState: 'importPending', statusMessages: [] }).class).toBe(
        'retry_import',
      );
      // A download client that is down is a fault to see, not a wait to hide.
      expect(classifyQueueItem({ status: 'downloadClientUnavailable' }).class).toBe('unknown');
      expect(classifyQueueItem({ status: 'queued' }).class).toBe('unknown');
    });
  });

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
      // A Lidarr match rejection, so manual_match since D-12 (it was unknown before Q-01 was answered).
      expect(result.class).toBe('manual_match');
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

  // --- DESIGN-046 D-12 (Q-01, 2026-09-28) — Lidarr's queue, fixtures from the live queue and census strings ---

  describe('D-12 Lidarr match rejections → manual_match (its Lidarr enforce cell is D-13); everything else keeps its class', () => {
    const HEADER = 'One or more tracks expected in this release were not imported or missing from the release';
    /** Lidarr's multi-file shape: the header, then one entry per rejected file, titled with the file name. */
    const lidarrFailed = (title: string, perFile: Array<[string, string[]]>): ClassifiableQueueItem => ({
      title,
      status: 'completed',
      trackedDownloadStatus: 'warning',
      trackedDownloadState: 'importFailed',
      statusMessages: [{ title: HEADER, messages: [] }, ...perFile.map(([f, m]) => ({ title: f, messages: m }))],
    });

    it('album match not close enough + "Has missing tracks" → manual_match, the album-match message is the reason', () => {
      const album = 'Album match is not close enough: 73.4 % vs 80 % [artist, country, missing tracks]';
      const result = classifyQueueItem(
        lidarrFailed('Internet_Money-WE_ALL_WE_NEEDED-16BIT-WEBFLAC-2026-Bitcoin', [
          ['01-internet_money-intro.flac', [album, 'Has missing tracks']],
          ['02-internet_money-track.flac', [album, 'Has missing tracks']],
        ]),
      );
      expect(result).toEqual({ class: 'manual_match', reason: album, confidence: 'high' });
    });

    it('"Has missing tracks" alone, and "Has unmatched tracks" alone → manual_match', () => {
      const missing = classifyQueueItem(
        lidarrFailed('Some_Artist-Some_Album-WEB-2026', [
          ['10 - World So Full Of Love (And Not Enough).mp3', ['Has missing tracks']],
        ]),
      );
      expect(missing).toEqual({ class: 'manual_match', reason: 'Has missing tracks', confidence: 'high' });
      const unmatched = classifyQueueItem(
        lidarrFailed('Some_Artist-Some_Album-WEB-2026', [['03 - Bonus.flac', ['Has unmatched tracks']]]),
      );
      expect(unmatched.class).toBe('manual_match');
      expect(unmatched.reason).toBe('Has unmatched tracks');
    });

    it('"Worst track match" → manual_match', () => {
      const text = 'Worst track match: 53.6 % vs 60 % [track title]';
      const result = classifyQueueItem(lidarrFailed('Some_Album-2026', [['01 - Intro.flac', [text]]]));
      expect(result).toEqual({ class: 'manual_match', reason: text, confidence: 'high' });
    });

    it('"Couldn\'t find similar album for [path]" → manual_match (a vinyl rip with one file per side, and a zip)', () => {
      for (const path of [
        '/data/usenet/complete-k8s/music/[003+109] Robert_Plant-Manic_Nirvana-LP-24BIT-FLAC-1990-REETKEVER.part002.rar',
        '/data/usenet/complete-k8s/music/Korpiklaani - Kulkija.zip',
      ]) {
        const text = `Couldn't find similar album for [${path}]`;
        const result = classifyQueueItem(lidarrFailed('Some Album', [['Side A.flac', [text]]]));
        expect(result).toEqual({ class: 'manual_match', reason: text, confidence: 'high' });
      }
    });

    it('"found multiple artists" (a completed download Lidarr could not tie to one artist) → manual_match', () => {
      const release = 'Turnstile-NEVER_ENOUGH_VERSIONS-16BIT-WEB-FLAC-2026-ENRiCH';
      const text =
        'Unable to import automatically, found multiple artists: [351bee54-3ee7-449d-b68e-c94da6798b97][Turnstile], [7b748dac-f5ce-45a7-9b95-c1d8b5b013ed][Turnstile]';
      const result = classifyQueueItem({
        title: release,
        status: 'completed',
        trackedDownloadStatus: 'warning',
        trackedDownloadState: 'downloading',
        statusMessages: [{ title: release, messages: [text] }],
      });
      expect(result).toEqual({ class: 'manual_match', reason: text, confidence: 'high' });
    });

    it('stays unknown: "No files found are eligible for import" (three causes under one message, D-12)', () => {
      // A WavPack rip with a `.wvp` extension Lidarr does not read, a torrent of guitar tabs, and a folder that is
      // gone all say the same thing. Not retry_import (Lidarr already retries it every pass) and not bad_release.
      const release = '[002+114] Jeff_Beck-Blow_by_Blow-LP-32BIT-WAVPACK-1975-REETKEVER.part001.rar';
      const text = `No files found are eligible for import in /data/usenet/complete-k8s/music/${release}`;
      const result = classifyQueueItem({
        title: release,
        status: 'completed',
        trackedDownloadStatus: 'warning',
        trackedDownloadState: 'importPending',
        statusMessages: [{ title: release, messages: [text] }],
      });
      expect(result).toEqual({ class: 'unknown', reason: text, confidence: 'low' });
    });

    it('stays unknown, NEVER have_better: Lidarr importFailed + "Not an upgrade for existing track file(s)"', () => {
      // Live case: the album the grab was for has 0 of 21 tracks on disk, so the "existing track files" belong to
      // another album. Lidarr sets importFailed when any file is rejected and never retries it (D-12).
      const text = 'Not an upgrade for existing track file(s). New Quality is MP3-320';
      const result = classifyQueueItem(
        lidarrFailed('Bryan Ferry - Bete Noire - 01-Bryan Ferry - Limbo', [
          ['01-Bryan Ferry - Limbo.mp3', [text]],
          ['02-Bryan Ferry - Kiss and Tell.mp3', [text]],
        ]),
      );
      expect(result).toEqual({ class: 'unknown', reason: text, confidence: 'low' });
    });

    it('have_better + a match rejection → manual_match, never have_better (its verdict may be about another album)', () => {
      const album = 'Album match is not close enough: 42.1 % vs 80 % [album, year, country, tracks]';
      const result = classifyQueueItem({
        title: 'The Beatles-Bournemouth 1963 [2CD] [2025] FLAC',
        trackedDownloadState: 'importBlocked',
        statusMessages: [
          { title: HEADER, messages: [] },
          { title: '01. Roll Over Beethoven.flac', messages: [album, 'Not an upgrade for existing track file(s)'] },
        ],
      });
      expect(result).toEqual({ class: 'manual_match', reason: album, confidence: 'high' });
    });

    it('precedence: bad_release still wins over a match rejection (an errored transfer, a failed download)', () => {
      const album = 'Album match is not close enough: 68.2 % vs 80 % [country, tracks]';
      expect(
        classifyQueueItem({ ...lidarrFailed('x', [['01.flac', [album]]]), trackedDownloadStatus: 'error' }).class,
      ).toBe('bad_release');
      expect(classifyQueueItem({ ...lidarrFailed('x', [['01.flac', [album]]]), status: 'failed' }).class).toBe(
        'bad_release',
      );
    });

    it('unchanged: Lidarr "Duplicate NZB" (a failed download) stays bad_release; an empty importPending stays retry_import', () => {
      expect(
        classifyQueueItem({
          status: 'failed',
          trackedDownloadStatus: 'error',
          trackedDownloadState: 'downloadFailed',
          errorMessage: 'Duplicate NZB',
        }),
      ).toEqual({ class: 'bad_release', reason: 'Duplicate NZB', confidence: 'high' });
      expect(classifyQueueItem({ trackedDownloadState: 'importPending', statusMessages: [] }).class).toBe(
        'retry_import',
      );
    });
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
  it('L2 when every cell is enforce, Lidarr manual_match included (D-13)', () => {
    const cfg = clone();
    for (const inst of ['sonarr', 'radarr'] as const) {
      cfg.modes[inst] = { have_better: 'enforce', retry_import: 'enforce', bad_release: 'enforce' };
    }
    cfg.modes.lidarr = { have_better: 'enforce', retry_import: 'enforce', bad_release: 'enforce', manual_match: 'census' };
    // The nine shared cells alone are partial now: Lidarr's manual_match cell is still census.
    expect(deriveQueueCleanupLadderLevel(cfg)).toBe(1);
    cfg.modes.lidarr.manual_match = 'enforce';
    expect(deriveQueueCleanupLadderLevel(cfg)).toBe(2);
  });
  it('D-13: the stored L2 config from before D-13 (nine shared cells enforced, no manual_match key) reads L1 until the cell is enforced', () => {
    const stored = {
      modes: {
        sonarr: { have_better: 'enforce', retry_import: 'enforce', bad_release: 'enforce' },
        radarr: { have_better: 'enforce', retry_import: 'enforce', bad_release: 'enforce' },
        lidarr: { have_better: 'enforce', retry_import: 'enforce', bad_release: 'enforce' },
      },
      maxActionsPerRun: 10,
      minItemAgeHours: 2,
      retryEscalateRuns: 6,
    };
    expect(queueCleanupConfigError(stored)).toBeNull();
    const cfg = stored as unknown as ArrQueueCleanupConfig;
    expect(queueCleanupCellMode(cfg, 'lidarr', 'manual_match')).toBe('census');
    expect(deriveQueueCleanupLadderLevel(cfg)).toBe(1);
    const flipped = { ...cfg, modes: { ...cfg.modes, lidarr: { ...cfg.modes.lidarr, manual_match: 'enforce' as const } } };
    expect(deriveQueueCleanupLadderLevel(flipped)).toBe(2);
  });
  it('L1 when only Lidarr manual_match enforces (D-13: the owner-ruled flip on its own)', () => {
    const cfg = clone();
    cfg.modes.lidarr.manual_match = 'enforce';
    expect(deriveQueueCleanupLadderLevel(cfg)).toBe(1);
  });
});

describe('D-14 janitor release block term + drift (pure)', () => {
  const derive = (releaseTitle: string | null, artistName: string | null) =>
    deriveJanitorBlockTerm({ releaseTitle, artistName });
  const term = (title: string, artist: string) => {
    const d = derive(title, artist);
    if (!('term' in d)) throw new Error(`refused: ${d.refused}`);
    return d.term;
  };

  it('the whole-name term matches the same title re-posted (any separators) and nothing longer, shorter or other', () => {
    const t1 = term('Artist - Album (2019) [FLAC]', 'Artist');
    expect(t1.startsWith('/^[^a-z0-9]*artist')).toBe(true);
    expect(t1.endsWith('[^a-z0-9]*$/i')).toBe(true);
    expect(isWholeNameTerm(t1)).toBe(true);
    expect(isGrammarTerm(t1)).toBe(false); // never a Release Block term
    for (const same of ['Artist - Album (2019) [FLAC]', 'Artist.-.Album.(2019).[FLAC]', 'artist_album_2019_flac', '[Artist - Album (2019) [FLAC]]']) {
      expect(termMatchesRaw(t1, same)).toBe(true);
    }
    for (const other of [
      'Artist - Album (2019) [FLAC] [24bit]', // a word more
      'Artist - Album (2019)', // a word less
      'Artist - Album (2019) [MP3]',
      'Other Artist - Album (2019) [FLAC]',
      'Artist - Album (2019) [FLAC]-GRP',
    ]) {
      expect(termMatchesRaw(t1, other)).toBe(false);
    }
  });

  it('writes raw accents, apostrophes and "&" so the raw re-post matches, as the Release Block terms do', () => {
    const t1 = term('Björk - Début (1993) [FLAC]', 'Björk');
    expect(termMatchesRaw(t1, 'Björk - Début (1993) [FLAC]')).toBe(true);
    expect(termMatchesRaw(t1, 'Bjork - Debut (1993) [FLAC]')).toBe(true);
    const t2 = term("Guns N' Roses - Appetite for Destruction (1987)", "Guns N' Roses");
    expect(termMatchesRaw(t2, "Guns N' Roses - Appetite for Destruction (1987)")).toBe(true);
    const t3 = term('Simon & Garfunkel - Bookends (1968)', 'Simon & Garfunkel');
    expect(termMatchesRaw(t3, 'Simon & Garfunkel - Bookends (1968)')).toBe(true);
    expect(termMatchesRaw(t3, 'Simon and Garfunkel - Bookends (1968)')).toBe(true);
  });

  it('the title must name the artist (a leading "The" optional) and say more than the artist, else no term', () => {
    expect('term' in derive('Beatles - 1 (2000) [FLAC]', 'The Beatles')).toBe(true);
    expect('term' in derive('AC/DC - Back in Black (1980)', 'AC/DC')).toBe(true);
    expect(derive(null, 'Artist')).toEqual({ refused: 'no_title' });
    expect(derive('  ', 'Artist')).toEqual({ refused: 'no_title' });
    expect(derive('Artist - Album', null)).toEqual({ refused: 'no_artist' });
    // A title without the artist's name would block every artist's release of that name.
    expect(derive('Greatest Hits (2001) [FLAC]', 'Queen')).toEqual({ refused: 'artist_not_named' });
    expect(derive('Queens of the Stone Age - Era Vulgaris', 'Queen')).toEqual({ refused: 'artist_not_named' });
    expect(derive('Queen', 'Queen')).toEqual({ refused: 'title_is_artist' });
  });

  it('refuses a title with a word the term cannot write (another script), but not a letter inside a written word', () => {
    // SEP would stand in for the whole unwritten word, so "東京" would be blocked too.
    expect(derive('Artist - 日本 (2019) [FLAC]', 'Artist')).toEqual({ refused: 'unwritable' });
    expect(derive('Artist - 愛 (2019)', 'Artist')).toEqual({ refused: 'unwritable' });
    expect(derive('Ørjan Nilsen - Album (2019)', 'Ørjan Nilsen')).toEqual({ refused: 'unwritable' });
    // A symbol that names the album is a word the term cannot write either (÷ would block ×, +, or nothing at all).
    expect(derive('Ed Sheeran - ÷ [FLAC]', 'Ed Sheeran')).toEqual({ refused: 'unwritable' });
    expect(derive('Prince - ♥ (1994) [MP3 320]', 'Prince')).toEqual({ refused: 'unwritable' });
    expect('term' in derive('Ke$ha - Animal (2010) [FLAC]', 'Ke$ha')).toBe(true); // inside a word
    // Inside a written word it stands for one character only.
    const inside = derive('Bjørk Tribute - Straße (2019)', 'Bjørk Tribute');
    expect('term' in inside).toBe(true);
    const t1 = (inside as { term: string }).term;
    expect(termMatchesRaw(t1, 'Bjørk Tribute - Straße (2019)')).toBe(true);
    expect(termMatchesRaw(t1, 'Bjark Tribute - Straße (2019)')).toBe(false);
  });

  it('janitorBlockProfileDrift: missing, duplicate, disabled, edited, terms, or null; a profile without the sentinel is not ours', () => {
    const desired = [JANITOR_BLOCK_SENTINEL, '/^[^a-z0-9]*a[^a-z0-9]*b[^a-z0-9]*$/i'];
    const ours = (o: Partial<JanitorReleaseProfile> = {}): JanitorReleaseProfile => ({
      id: 1,
      enabled: true,
      required: [],
      ignored: [...desired],
      indexerId: 0,
      tags: [],
      ...o,
    });
    const foreign: JanitorReleaseProfile = { id: 9, enabled: true, required: [], ignored: ['x'], indexerId: 0, tags: [] };
    expect(janitorBlockProfileDrift([foreign], desired)).toEqual({ reason: 'missing', missingTerms: 2, extraTerms: 0 });
    expect(janitorBlockProfileDrift([ours(), ours({ id: 2 })], desired)?.reason).toBe('duplicate');
    expect(janitorBlockProfileDrift([ours({ enabled: false })], desired)?.reason).toBe('disabled');
    expect(janitorBlockProfileDrift([ours({ tags: [4] })], desired)?.reason).toBe('edited');
    expect(janitorBlockProfileDrift([ours({ required: ['y'] })], desired)?.reason).toBe('edited');
    expect(janitorBlockProfileDrift([ours({ ignored: [JANITOR_BLOCK_SENTINEL] })], desired)).toEqual({
      reason: 'terms',
      missingTerms: 1,
      extraTerms: 0,
    });
    expect(janitorBlockProfileDrift([ours(), foreign], desired)).toBeNull();
  });
});

describe('D-13 config: Lidarr manual_match cell (pure)', () => {
  it('accepts lidarr.manual_match census or enforce, and a pre-D-13 config that lacks the cell', () => {
    const cfg = clone();
    cfg.modes.lidarr.manual_match = 'enforce';
    expect(queueCleanupConfigError(cfg)).toBeNull();
    const legacy = clone();
    delete (legacy.modes.lidarr as Partial<typeof legacy.modes.lidarr>).manual_match;
    expect(queueCleanupConfigError(legacy)).toBeNull();
  });
  it('rejects a manual_match cell on Sonarr or Radarr (Lidarr only), and a bad manual_match mode', () => {
    const sonarr = clone();
    (sonarr.modes.sonarr as Record<string, unknown>).manual_match = 'census';
    expect(queueCleanupConfigError(sonarr)).toBe("Unknown class 'manual_match' in modes.sonarr.");
    const radarr = clone();
    (radarr.modes.radarr as Record<string, unknown>).manual_match = 'enforce';
    expect(queueCleanupConfigError(radarr)).toBe("Unknown class 'manual_match' in modes.radarr.");
    const bad = clone();
    (bad.modes.lidarr as Record<string, unknown>).manual_match = 'on';
    expect(queueCleanupConfigError(bad)).toBe("modes.lidarr.manual_match must be 'census' or 'enforce'.");
    // `unknown` is never a cell.
    const unknownCell = clone();
    (unknownCell.modes.lidarr as Record<string, unknown>).unknown = 'enforce';
    expect(queueCleanupConfigError(unknownCell)).toMatch(/Unknown class 'unknown'/);
  });
  it('queueCleanupCellMode: census off Lidarr, for unknown, and for an absent cell; enforce only when set', () => {
    const cfg = clone();
    expect(queueCleanupCellMode(cfg, 'lidarr', 'manual_match')).toBe('census');
    cfg.modes.lidarr.manual_match = 'enforce';
    expect(queueCleanupCellMode(cfg, 'lidarr', 'manual_match')).toBe('enforce');
    expect(queueCleanupCellMode(cfg, 'sonarr', 'manual_match')).toBe('census');
    expect(queueCleanupCellMode(cfg, 'radarr', 'manual_match')).toBe('census');
    expect(queueCleanupCellMode(cfg, 'lidarr', 'unknown')).toBe('census');
    delete (cfg.modes.lidarr as Partial<typeof cfg.modes.lidarr>).manual_match;
    expect(queueCleanupCellMode(cfg, 'lidarr', 'manual_match')).toBe('census');
    // The code default ships the cell census (the deploy is inert).
    expect(ARR_QUEUE_CLEANUP_CONFIG_DEFAULT.modes.lidarr.manual_match).toBe('census');
  });
  it('isLidarrAlbumMissing: only Lidarr counts that show fewer track files than tracks', () => {
    const album = (trackFileCount: number, trackCount: number) => ({
      statistics: { trackFileCount, trackCount },
    });
    expect(isLidarrAlbumMissing(album(0, 12))).toBe(true);
    expect(isLidarrAlbumMissing(album(11, 12))).toBe(true);
    expect(isLidarrAlbumMissing(album(12, 12))).toBe(false); // complete
    expect(isLidarrAlbumMissing(album(13, 12))).toBe(false);
    expect(isLidarrAlbumMissing(album(0, 0))).toBe(false); // no tracks known: cannot tell
    expect(isLidarrAlbumMissing({})).toBe(false); // no statistics: cannot tell
    expect(isLidarrAlbumMissing({ statistics: null })).toBe(false);
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
    modes: {
      sonarr: cell(),
      radarr: cell(),
      lidarr: { ...cell(), manual_match: 'census' },
      lazylibrarian: { retry_import: 'census', bad_release: 'census', leftover: 'census' },
      kapowarr: { bad_release: 'census' },
    },
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
    statusMessages: [{ title: 'x', messages: ['Something the classifier has never seen'] }],
  });
/** A Lidarr match rejection in Lidarr's multi-file shape (D-12): report only, like unknown. */
const MANUAL_MATCH_TEXT = 'Album match is not close enough: 75.6 % vs 80 % [album, year, missing tracks]';
const manualMatchItem = (id: number, downloadId?: string, albumId: number | null = 5000 + id) =>
  item({
    queueItemId: id,
    downloadId: downloadId ?? `dl-${id}`,
    targetId: albumId,
    status: 'completed',
    trackedDownloadStatus: 'warning',
    trackedDownloadState: 'importFailed',
    statusMessages: [
      { title: 'One or more tracks expected in this release were not imported or missing from the release', messages: [] },
      { title: '01 - Opening.flac', messages: [MANUAL_MATCH_TEXT, 'Has missing tracks'] },
    ],
  });

/**
 * D-14 — a fake *arr release-profile store (Lidarr's shape: no name). `fail.list` / `fail.put` make those calls throw;
 * `fail.dropWrites` makes a write answer but not land (so the read-back fails). Every call is logged in order.
 */
function makeProfileStore(initial: JanitorReleaseProfile[] = [], order?: string[]) {
  const profiles: JanitorReleaseProfile[] = initial.map((p) => ({ ...p, ignored: [...(p.ignored ?? [])] }));
  const log: string[] = [];
  const writes: Array<{ method: 'POST' | 'PUT'; body: Record<string, unknown> }> = [];
  const fail: { list?: boolean; put?: boolean; dropWrites?: boolean; explode?: boolean } = {};
  let nextId = 100;
  const note = (entry: string) => {
    log.push(entry);
    order?.push(`profile:${entry}`);
  };
  const client: JanitorReleaseProfileClient = {
    async listReleaseProfiles() {
      note('GET');
      if (fail.list) throw new Error('profile list failed');
      return profiles.map((p) => ({ ...p, ignored: [...(p.ignored ?? [])] }));
    },
    async createReleaseProfile(body) {
      note('POST');
      if (fail.explode) throw new Error('census must never write');
      writes.push({ method: 'POST', body: { ...body } });
      if (fail.put) throw new Error('profile write failed');
      if (!fail.dropWrites) profiles.push({ id: nextId++, ...body, ignored: [...body.ignored] });
    },
    async updateReleaseProfile(body) {
      note('PUT');
      if (fail.explode) throw new Error('census must never write');
      writes.push({ method: 'PUT', body: { ...body } });
      if (fail.put) throw new Error('profile write failed');
      if (fail.dropWrites) return;
      const i = profiles.findIndex((p) => p.id === body.id);
      if (i >= 0) profiles[i] = { ...body, ignored: [...body.ignored] };
    },
  };
  return { client, profiles, log, writes, fail };
}
type ProfileStore = ReturnType<typeof makeProfileStore>;

interface InstanceStub {
  client: QueueCleanupInstanceClient;
  profiles: ProfileStore;
  calls: {
    deletes: Array<{ id: number; removeFromClient: boolean; blocklist: boolean; skipRedownload: boolean }>;
    processMonitored: number;
    /** Queue ids of every searched record, flattened across calls. */
    searches: number[];
    /** One entry per search command: the queue ids it covered. */
    searchCalls: number[][];
    monitoredChecks: number;
    /** D-13: one entry per missing-album check, the queue ids it was asked about. */
    missingChecks: number[][];
    /** D-14: the queue ids whose release identity was read. */
    identityReads: number[];
    /** Every write-side call in order: `profile:GET|POST|PUT`, `delete:<id>`, `search:<ids>`. */
    order: string[];
  };
}

/**
 * A stub *arr instance. Like the real *arrs, a removal takes the WHOLE download off the queue: a later DELETE
 * for any record of a removed download answers 404 (ArrHttpError), which is what a season pack did per episode
 * before D-11. `gone` makes every DELETE answer 404 (the download dropped between read and removal).
 */
function makeInstanceStub(
  items: QueueCleanupQueueItem[],
  opts: {
    readError?: boolean;
    monitored?: boolean | ((qi: QueueCleanupQueueItem) => boolean);
    deleteError?: boolean;
    gone?: boolean;
    searchError?: boolean;
    explodeOnWrite?: boolean;
    /** D-13: whether a record's album is monitored AND still missing tracks (default: every album is). */
    missing?: boolean | ((qi: QueueCleanupQueueItem) => boolean);
    /** D-14: the release identity (default: the queue title, else `Artist - Album <id> (2019) [FLAC]`, artist
     *  "Artist"); a thrown error is a failed read. */
    identity?: (qi: QueueCleanupQueueItem) => { releaseTitle: string | null; artistName: string | null };
    /** D-14: the release-profile store (default: an empty one). */
    profiles?: ProfileStore;
  } = {},
): InstanceStub {
  const calls: InstanceStub['calls'] = {
    deletes: [],
    processMonitored: 0,
    searches: [],
    searchCalls: [],
    monitoredChecks: 0,
    missingChecks: [],
    identityReads: [],
    order: [],
  };
  const profiles = opts.profiles ?? makeProfileStore([], calls.order);
  if (opts.explodeOnWrite) profiles.fail.explode = true;
  const removed = new Set<string>();
  const notFound = (id: number) =>
    new ArrHttpError(404, 'DELETE', `http://arr.test/api/v3/queue/${id}`);
  return {
    calls,
    profiles,
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
        calls.order.push(`delete:${qi.queueItemId}`);
        if (opts.gone) throw notFound(qi.queueItemId);
        if (qi.downloadId) {
          if (removed.has(qi.downloadId)) throw notFound(qi.queueItemId);
          removed.add(qi.downloadId);
        }
      },
      async processMonitoredDownloads() {
        if (opts.explodeOnWrite) throw new Error('census must never write');
        calls.processMonitored += 1;
      },
      async monitoredTargets(qis) {
        calls.monitoredChecks += 1;
        const m = opts.monitored ?? false;
        return qis.filter((qi) => (typeof m === 'function' ? m(qi) : m));
      },
      async searchTargets(qis) {
        if (opts.explodeOnWrite) throw new Error('census must never write');
        if (opts.searchError) throw new Error('search failed');
        calls.searchCalls.push(qis.map((qi) => qi.queueItemId));
        calls.searches.push(...qis.map((qi) => qi.queueItemId));
        calls.order.push(`search:${qis.map((qi) => qi.queueItemId).join(',')}`);
      },
      async missingMonitoredTargets(qis) {
        calls.missingChecks.push(qis.map((qi) => qi.queueItemId));
        const m = opts.missing ?? true;
        return qis.filter((qi) => (typeof m === 'function' ? m(qi) : m));
      },
      async releaseIdentity(qi) {
        calls.identityReads.push(qi.queueItemId);
        if (opts.identity) return opts.identity(qi);
        return {
          releaseTitle: qi.title ?? `Artist - Album ${qi.queueItemId} (2019) [FLAC]`,
          artistName: 'Artist',
        };
      },
      releaseProfiles: profiles.client,
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
// Grouping by download (D-11) — pure.
// ---------------------------------------------------------------------------

describe('groupQueueRecordsByDownload (D-11) — pure', () => {
  const r = (queueItemId: number, downloadId: string | null) => ({ queueItemId, downloadId });

  it('groups records sharing a downloadId in first-seen order; null, empty and blank ids are never grouped', () => {
    const groups = groupQueueRecordsByDownload([
      r(1, 'a'),
      r(2, 'b'),
      r(3, 'a'),
      r(4, null),
      r(5, null),
      r(6, ''),
      r(7, '  '),
      r(8, 'a'),
      r(9, 'b'),
      r(10, '  '),
    ]);
    expect(groups.map((g) => g.map((x) => x.queueItemId))).toEqual([
      [1, 3, 8],
      [2, 9],
      [4],
      [5],
      [6],
      [7],
      [10],
    ]);
  });

  it('a queue of distinct downloads is one group per record, in queue order; an empty queue has no groups', () => {
    expect(groupQueueRecordsByDownload([r(1, 'x'), r(2, 'y'), r(3, 'z')])).toEqual([
      [r(1, 'x')],
      [r(2, 'y')],
      [r(3, 'z')],
    ]);
    expect(groupQueueRecordsByDownload([])).toEqual([]);
  });
});

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
    await t.db.delete(arrQueueCleanupBlockTerms);
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
    const sonarr = makeInstanceStub(
      [haveBetter(1), badRelease(2), retryImport(3), unknownItem(4), manualMatchItem(5)],
      { explodeOnWrite: true },
    );
    const report = await evaluateQueueCleanup({
      db: t.db,
      clients: makeClients({ sonarr: sonarr.client }),
      config: clone(),
    });
    expect(report.rowsWritten).toBe(5);
    expect(report.totalFailure).toBe(false);
    expect(sonarr.calls.deletes).toHaveLength(0);
    expect(sonarr.calls.processMonitored).toBe(0);
    expect(sonarr.calls.searches).toHaveLength(0);

    const rows = await t.db.select().from(arrQueueCleanupActions);
    expect(rows).toHaveLength(5);
    expect(rows.every((r) => r.mode === 'census')).toBe(true);
    expect(rows.every((r) => r.outcome === 'observed')).toBe(true);
    expect(rows.every((r) => r.action === 'none')).toBe(true);
    // Each class is represented (the report-only items classified unknown and manual_match, never acted).
    expect(new Set(rows.map((r) => r.actionClass))).toEqual(
      new Set(['have_better', 'bad_release', 'retry_import', 'manual_match', 'unknown']),
    );
  });

  it('D-25 WAITING: delay-profile holds leave the census (no row, not unknown), are counted on the report, and are never acted on', async () => {
    const delayed = (id: number) =>
      item({
        queueItemId: id,
        title: `Held.Show.S01E0${id}.1080p-GRP`,
        status: 'delay',
        trackedDownloadStatus: 'ok',
        trackedDownloadState: 'downloading',
        statusMessages: [],
      });
    const cfg = clone();
    cfg.modes.sonarr.have_better = 'enforce';
    cfg.modes.sonarr.bad_release = 'enforce';
    cfg.modes.sonarr.retry_import = 'enforce';
    const sonarr = makeInstanceStub([delayed(1), delayed(2), haveBetter(3), unknownItem(4), delayed(5)]);
    const report = await evaluateQueueCleanup({
      db: t.db,
      clients: makeClients({ sonarr: sonarr.client }),
      config: cfg,
    });

    const rows = await t.db.select().from(arrQueueCleanupActions).orderBy(arrQueueCleanupActions.queueItemId);
    expect(rows.map((r) => [r.queueItemId, r.actionClass])).toEqual([
      [3, 'have_better'],
      [4, 'unknown'],
    ]);
    const s = report.instances.find((i) => i.instance === 'sonarr')!;
    expect(s.waiting).toBe(3);
    expect(s.itemsObserved).toBe(2);
    expect(s.byClass.unknown.observed).toBe(1); // only the genuinely unknown one
    // Only the have_better item was acted on; a held release was never removed, retried or searched.
    expect(sonarr.calls.deletes.map((d) => d.id)).toEqual([3]);
    expect(sonarr.calls.processMonitored).toBe(0);
    expect(sonarr.calls.searches).toHaveLength(0);
  });

  it('CENSUS DEFAULT (D-13): manual_match is not acted on while its cell is census, even with every other Lidarr cell enforced', async () => {
    const cfg = clone();
    cfg.modes.lidarr = { have_better: 'enforce', retry_import: 'enforce', bad_release: 'enforce', manual_match: 'census' };
    // Two albums of one download (Lidarr lists one record per album) and a lone one, all old enough to act on.
    const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const lidarr = makeInstanceStub(
      [
        { ...manualMatchItem(300, 'dl-mm-pair'), addedAt: old },
        { ...manualMatchItem(301, 'dl-mm-pair'), addedAt: old },
        { ...manualMatchItem(302), addedAt: old },
      ],
      { explodeOnWrite: true },
    );
    const report = await evaluateQueueCleanup({
      db: t.db,
      clients: makeClients({ lidarr: lidarr.client }),
      config: { ...cfg, minItemAgeHours: 2 },
    });

    expect(lidarr.calls.deletes).toHaveLength(0);
    expect(lidarr.calls.processMonitored).toBe(0);
    expect(lidarr.calls.searches).toHaveLength(0);
    const l = report.instances.find((i) => i.instance === 'lidarr')!;
    expect(l).toMatchObject({ itemsObserved: 3, actionsTaken: 0, covered: 0, errors: 0 });
    expect(l.byClass.manual_match).toEqual({ observed: 3, enforced: 0 });
    expect(l.byClass.unknown).toEqual({ observed: 0, enforced: 0 });

    const rows = await t.db.select().from(arrQueueCleanupActions);
    expect(rows).toHaveLength(3);
    for (const r of rows) {
      expect(r).toMatchObject({
        instance: 'lidarr',
        actionClass: 'manual_match',
        mode: 'census',
        action: 'none',
        outcome: 'observed',
        reason: MANUAL_MATCH_TEXT,
        error: null,
      });
    }

    // The digest names the class and its reason.
    const section = await buildQueueCleanupDigestSection({ db: t.db });
    const mm = section!.instances
      .find((i) => i.instance === 'lidarr')!
      .classes.find((c) => c.actionClass === 'manual_match')!;
    expect(mm).toEqual({
      actionClass: 'manual_match',
      census: 3,
      enforced: 0,
      topReasons: [{ reason: MANUAL_MATCH_TEXT, count: 3 }],
    });
  });

  it('D-11 + D-12: a download whose records are have_better and manual_match is left alone (skipped_mixed)', async () => {
    const cfg = clone();
    cfg.modes.lidarr.have_better = 'enforce';
    const lidarr = makeInstanceStub(
      [
        item({
          queueItemId: 310,
          downloadId: 'dl-mixed-mm',
          trackedDownloadState: 'importBlocked',
          statusMessages: [{ title: 'x', messages: ['Not an upgrade for existing track file(s)'] }],
        }),
        manualMatchItem(311, 'dl-mixed-mm'),
      ],
      { explodeOnWrite: true },
    );
    await evaluateQueueCleanup({ db: t.db, clients: makeClients({ lidarr: lidarr.client }), config: cfg });
    expect(lidarr.calls.deletes).toHaveLength(0);
    const rows = await t.db.select().from(arrQueueCleanupActions);
    const byId = new Map(rows.map((r) => [r.queueItemId, r]));
    expect(byId.get(310)).toMatchObject({ actionClass: 'have_better', action: 'skipped_mixed', outcome: 'observed' });
    expect(byId.get(311)).toMatchObject({ actionClass: 'manual_match', action: 'none', outcome: 'observed' });
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
    // Seed 2 prior retry_import RUNS for (sonarr, dl-esc) — the escalation lookback (test dir is exempt from the
    // single-writer guard). Each run stamps its rows with its own createdAt (D-11 counts runs, not rows).
    await t.db.insert(arrQueueCleanupActions).values([
      {
        instance: 'sonarr',
        queueItemId: 1,
        downloadId: 'dl-esc',
        actionClass: 'retry_import',
        mode: 'census',
        action: 'none',
        outcome: 'observed',
        createdAt: new Date('2026-09-27T10:25:00Z'),
      },
      {
        instance: 'sonarr',
        queueItemId: 1,
        downloadId: 'dl-esc',
        actionClass: 'retry_import',
        mode: 'census',
        action: 'none',
        outcome: 'observed',
        createdAt: new Date('2026-09-27T11:25:00Z'),
      },
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

  // --- one action per download (D-11, issue #583 item 1) ---

  /** A season pack: one queue record per episode, all sharing the download's id. */
  const pack = (ids: number[], downloadId: string, make: typeof haveBetter = haveBetter) =>
    ids.map((id) => make(id, downloadId));
  const sonarrReport = (r: Awaited<ReturnType<typeof evaluateQueueCleanup>>) =>
    r.instances.find((i) => i.instance === 'sonarr')!;
  const rowsByQueueId = () =>
    t.db.select().from(arrQueueCleanupActions).orderBy(arrQueueCleanupActions.queueItemId);

  it('PACK (D-11): a have_better season pack gets ONE removal; the other records are covered, never 404 errors', async () => {
    const cfg = clone();
    cfg.modes.sonarr.have_better = 'enforce';
    // The stub removes the whole download on the first DELETE and answers 404 to any later one, as Sonarr does.
    const sonarr = makeInstanceStub(pack([200, 201, 202, 203], 'dl-pack'));
    const report = await evaluateQueueCleanup({
      db: t.db,
      clients: makeClients({ sonarr: sonarr.client }),
      config: cfg,
    });

    expect(sonarr.calls.deletes).toEqual([
      { id: 200, removeFromClient: true, blocklist: true, skipRedownload: true },
    ]);
    const s = sonarrReport(report);
    expect(s).toMatchObject({ itemsObserved: 4, actionsTaken: 1, covered: 3, errors: 0 });
    expect(s.byClass.have_better).toEqual({ observed: 4, enforced: 4 });
    const rows = await rowsByQueueId();
    expect(rows.map((r) => [r.queueItemId, r.downloadId, r.action, r.outcome, r.error])).toEqual([
      [200, 'dl-pack', 'removed_blocklisted', 'done', null],
      [201, 'dl-pack', 'removed_blocklisted', 'done', null],
      [202, 'dl-pack', 'removed_blocklisted', 'done', null],
      [203, 'dl-pack', 'removed_blocklisted', 'done', null],
    ]);
  });

  it('CAP (D-11): the per-run cap counts downloads, not records (records of one pack need not be adjacent)', async () => {
    const cfg = clone({ maxActionsPerRun: 2 });
    cfg.modes.sonarr.have_better = 'enforce';
    const [a1, a2, a3] = pack([210, 211, 212], 'dl-a');
    const [b1, b2] = pack([213, 214], 'dl-b');
    const sonarr = makeInstanceStub([a1!, b1!, a2!, b2!, a3!, haveBetter(215)]);
    const report = await evaluateQueueCleanup({
      db: t.db,
      clients: makeClients({ sonarr: sonarr.client }),
      config: cfg,
    });

    expect(sonarr.calls.deletes.map((d) => d.id)).toEqual([210, 213]); // two downloads, two calls
    expect(sonarrReport(report)).toMatchObject({ actionsTaken: 2, covered: 3, errors: 0 });
    const rows = await rowsByQueueId();
    expect(rows.map((r) => [r.queueItemId, r.action])).toEqual([
      [210, 'removed_blocklisted'],
      [211, 'removed_blocklisted'],
      [212, 'removed_blocklisted'],
      [213, 'removed_blocklisted'],
      [214, 'removed_blocklisted'],
      [215, 'skipped_cap'],
    ]);
  });

  it('CAP (D-11): a pack that meets a spent cap is skipped_cap on every record', async () => {
    const cfg = clone({ maxActionsPerRun: 1 });
    cfg.modes.radarr.have_better = 'enforce';
    const radarr = makeInstanceStub([haveBetter(216), ...pack([217, 218], 'dl-late')]);
    await evaluateQueueCleanup({
      db: t.db,
      clients: makeClients({ radarr: radarr.client }),
      config: cfg,
    });
    expect(radarr.calls.deletes.map((d) => d.id)).toEqual([216]);
    const rows = await rowsByQueueId();
    expect(rows.map((r) => [r.queueItemId, r.action, r.outcome])).toEqual([
      [216, 'removed_blocklisted', 'done'],
      [217, 'skipped_cap', 'observed'],
      [218, 'skipped_cap', 'observed'],
    ]);
  });

  it('MIXED (D-11): an unknown record in a pack holds the whole download (skipped_mixed), nothing is sent', async () => {
    const cfg = clone();
    cfg.modes.sonarr.have_better = 'enforce';
    // Same download, but this record also carries an identity mismatch, so it classifies unknown (D-10).
    const doubtful = item({
      queueItemId: 222,
      downloadId: 'dl-mixed',
      trackedDownloadState: 'importBlocked',
      statusMessages: [
        {
          title: 'x',
          messages: [
            'Episode 1x03 was not found in the grabbed release: Some.Show.S01.1080p',
            'Not an upgrade for existing episode file(s)',
          ],
        },
      ],
    });
    const sonarr = makeInstanceStub(
      [haveBetter(220, 'dl-mixed'), haveBetter(221, 'dl-mixed'), doubtful],
      {
        explodeOnWrite: true,
      },
    );
    const report = await evaluateQueueCleanup({
      db: t.db,
      clients: makeClients({ sonarr: sonarr.client }),
      config: cfg,
    });

    expect(sonarr.calls.deletes).toHaveLength(0);
    expect(sonarrReport(report)).toMatchObject({ actionsTaken: 0, covered: 0, errors: 0 });
    const rows = await rowsByQueueId();
    expect(rows.map((r) => [r.queueItemId, r.actionClass, r.mode, r.action, r.outcome])).toEqual([
      [220, 'have_better', 'enforce', 'skipped_mixed', 'observed'],
      [221, 'have_better', 'enforce', 'skipped_mixed', 'observed'],
      [222, 'unknown', 'census', 'none', 'observed'],
    ]);
  });

  it('MIXED (D-11): a different class (census or enforced) or a record still too young also holds the download', async () => {
    const now = new Date('2026-09-28T12:00:00Z');
    const aged = (qi: QueueCleanupQueueItem): QueueCleanupQueueItem => ({
      ...qi,
      addedAt: new Date(now.getTime() - 5 * 60 * 60 * 1000),
    });
    const cfg = clone({ minItemAgeHours: 2 });
    cfg.modes.sonarr.have_better = 'enforce'; // sonarr bad_release stays census
    cfg.modes.radarr.have_better = 'enforce';
    cfg.modes.radarr.bad_release = 'enforce';
    const fresh = haveBetter(233, 'dl-age');
    fresh.addedAt = new Date(now.getTime() - 30 * 60 * 1000);
    const sonarr = makeInstanceStub(
      [
        aged(haveBetter(230, 'dl-census')),
        aged(badRelease(231, 'dl-census')),
        aged(haveBetter(232, 'dl-age')),
        fresh,
      ],
      { explodeOnWrite: true },
    );
    // Both classes enforced, but they are different actions: still one download, still left alone.
    const radarr = makeInstanceStub(
      [aged(haveBetter(234, 'dl-two')), aged(badRelease(235, 'dl-two'))],
      {
        explodeOnWrite: true,
      },
    );
    await evaluateQueueCleanup({
      db: t.db,
      clients: makeClients({ sonarr: sonarr.client, radarr: radarr.client }),
      config: cfg,
      now,
    });

    expect(sonarr.calls.deletes).toHaveLength(0);
    expect(radarr.calls.deletes).toHaveLength(0);
    const rows = await rowsByQueueId();
    expect(rows.map((r) => [r.queueItemId, r.actionClass, r.action])).toEqual([
      [230, 'have_better', 'skipped_mixed'],
      [231, 'bad_release', 'none'],
      [232, 'have_better', 'skipped_mixed'],
      [233, 'have_better', 'skipped_young'],
      [234, 'have_better', 'skipped_mixed'],
      [235, 'bad_release', 'skipped_mixed'],
    ]);
  });

  it('NO DOWNLOAD ID (D-11): records with a null, empty or blank downloadId are never grouped', async () => {
    const cfg = clone();
    cfg.modes.sonarr.have_better = 'enforce';
    const loose = [240, 241, 242, 243].map((id) => haveBetter(id));
    loose[0]!.downloadId = null;
    loose[1]!.downloadId = null;
    loose[2]!.downloadId = '';
    loose[3]!.downloadId = '   ';
    const sonarr = makeInstanceStub(loose);
    const report = await evaluateQueueCleanup({
      db: t.db,
      clients: makeClients({ sonarr: sonarr.client }),
      config: cfg,
    });

    expect(sonarr.calls.deletes.map((d) => d.id)).toEqual([240, 241, 242, 243]); // each stands alone
    expect(sonarrReport(report)).toMatchObject({ actionsTaken: 4, covered: 0, errors: 0 });
    const rows = await rowsByQueueId();
    expect(rows.every((r) => r.action === 'removed_blocklisted' && r.outcome === 'done')).toBe(
      true,
    );
  });

  it('GONE (D-11): a removal answering 404 is skipped_gone (observed, no error, no search) and still counts the cap', async () => {
    const cfg = clone({ maxActionsPerRun: 2 });
    cfg.modes.radarr.have_better = 'enforce';
    cfg.modes.sonarr.bad_release = 'enforce';
    const radarr = makeInstanceStub([haveBetter(250), haveBetter(251), haveBetter(252)], {
      gone: true,
    });
    const sonarr = makeInstanceStub(pack([253, 254], 'dl-gone', badRelease), {
      gone: true,
      monitored: true,
    });
    const report = await evaluateQueueCleanup({
      db: t.db,
      clients: makeClients({ radarr: radarr.client, sonarr: sonarr.client }),
      config: cfg,
    });

    expect(radarr.calls.deletes.map((d) => d.id)).toEqual([250, 251]); // the third is past the cap
    expect(report.instances.find((i) => i.instance === 'radarr')).toMatchObject({
      actionsTaken: 2,
      errors: 0,
    });
    expect(sonarr.calls.deletes.map((d) => d.id)).toEqual([253]);
    expect(sonarr.calls.monitoredChecks).toBe(0);
    expect(sonarr.calls.searches).toHaveLength(0); // nothing was removed, so nothing is re-searched
    expect(sonarrReport(report)).toMatchObject({ actionsTaken: 1, covered: 1, errors: 0 });
    const rows = await rowsByQueueId();
    expect(rows.map((r) => [r.queueItemId, r.action, r.outcome, r.error])).toEqual([
      [250, 'skipped_gone', 'observed', null],
      [251, 'skipped_gone', 'observed', null],
      [252, 'skipped_cap', 'observed', null],
      [253, 'skipped_gone', 'observed', null],
      [254, 'skipped_gone', 'observed', null],
    ]);
  });

  it('ERROR (D-11): a failed pack removal is ONE error, and every record of the download carries it', async () => {
    const cfg = clone();
    cfg.modes.sonarr.have_better = 'enforce';
    const sonarr = makeInstanceStub(pack([260, 261, 262], 'dl-err'), { deleteError: true });
    const report = await evaluateQueueCleanup({
      db: t.db,
      clients: makeClients({ sonarr: sonarr.client }),
      config: cfg,
    });

    expect(sonarrReport(report)).toMatchObject({ actionsTaken: 1, covered: 2, errors: 1 });
    const rows = await rowsByQueueId();
    expect(rows.map((r) => [r.queueItemId, r.action, r.outcome, r.error])).toEqual([
      [260, 'none', 'error', 'delete failed'],
      [261, 'none', 'error', 'delete failed'],
      [262, 'none', 'error', 'delete failed'],
    ]);
  });

  it('bad_release PACK (D-11): one removal, one search for the monitored episodes only, per-record actions', async () => {
    const cfg = clone();
    cfg.modes.sonarr.bad_release = 'enforce';
    const sonarr = makeInstanceStub(pack([263, 264, 265], 'dl-bad', badRelease), {
      monitored: (qi) => qi.queueItemId !== 264,
    });
    const report = await evaluateQueueCleanup({
      db: t.db,
      clients: makeClients({ sonarr: sonarr.client }),
      config: cfg,
    });

    expect(sonarr.calls.deletes.map((d) => d.id)).toEqual([263]);
    expect(sonarr.calls.monitoredChecks).toBe(1);
    expect(sonarr.calls.searchCalls).toEqual([[263, 265]]);
    expect(sonarrReport(report)).toMatchObject({ actionsTaken: 1, covered: 2, errors: 0 });
    const rows = await rowsByQueueId();
    expect(rows.map((r) => [r.queueItemId, r.action, r.outcome])).toEqual([
      [263, 'blocklisted_searched', 'done'],
      [264, 'removed_blocklisted', 'done'],
      [265, 'blocklisted_searched', 'done'],
    ]);
  });

  it('SEARCH FAILURE (D-11): the removal landed, so the row keeps removed_blocklisted with outcome error', async () => {
    const cfg = clone();
    cfg.modes.sonarr.bad_release = 'enforce';
    const sonarr = makeInstanceStub([badRelease(270)], { monitored: true, searchError: true });
    const report = await evaluateQueueCleanup({
      db: t.db,
      clients: makeClients({ sonarr: sonarr.client }),
      config: cfg,
    });

    expect(sonarr.calls.deletes.map((d) => d.id)).toEqual([270]);
    expect(sonarrReport(report).errors).toBe(1);
    const [row] = await rowsByQueueId();
    expect([row!.action, row!.outcome, row!.error]).toEqual([
      'removed_blocklisted',
      'error',
      'search failed',
    ]);
  });

  it('RETRY PACK (D-11): one ProcessMonitoredDownloads for the download, the other records covered', async () => {
    const cfg = clone();
    cfg.modes.radarr.retry_import = 'enforce';
    const radarr = makeInstanceStub([
      ...pack([275, 276, 277], 'dl-retry', retryImport),
      retryImport(278),
    ]);
    const report = await evaluateQueueCleanup({
      db: t.db,
      clients: makeClients({ radarr: radarr.client }),
      config: cfg,
    });

    expect(radarr.calls.processMonitored).toBe(1);
    // The pack spends the one call (2 covered); the later download is covered by the same estate-wide command.
    expect(report.instances.find((i) => i.instance === 'radarr')).toMatchObject({
      actionsTaken: 1,
      covered: 3,
    });
    const rows = await rowsByQueueId();
    expect(rows.every((r) => r.action === 'retried_import' && r.outcome === 'done')).toBe(true);
  });

  it('ESCALATION (D-11): counts prior RUNS, not rows, so a pack does not escalate after a single run', async () => {
    const cfg = clone({ retryEscalateRuns: 2 });
    cfg.modes.sonarr.bad_release = 'enforce';
    // One prior run of a 3-episode pack: three rows, one run timestamp. Counting rows would read 3 ≥ 2.
    const priorRun = new Date('2026-09-27T10:25:00Z');
    await t.db.insert(arrQueueCleanupActions).values(
      [280, 281, 282].map((queueItemId) => ({
        instance: 'sonarr' as const,
        queueItemId,
        downloadId: 'dl-retry-pack',
        actionClass: 'retry_import' as const,
        mode: 'census' as const,
        action: 'none' as const,
        outcome: 'observed' as const,
        createdAt: priorRun,
      })),
    );
    const now = new Date('2026-09-27T11:25:00Z');
    const sonarr = makeInstanceStub(pack([280, 281, 282], 'dl-retry-pack', retryImport), {
      explodeOnWrite: true,
    });
    await evaluateQueueCleanup({
      db: t.db,
      clients: makeClients({ sonarr: sonarr.client }),
      config: cfg,
      now,
    });
    expect(sonarr.calls.deletes).toHaveLength(0);
    const second = await t.db
      .select()
      .from(arrQueueCleanupActions)
      .where(eq(arrQueueCleanupActions.createdAt, now));
    expect(second.map((r) => r.actionClass)).toEqual([
      'retry_import',
      'retry_import',
      'retry_import',
    ]);

    // Two prior runs now: the third run escalates the whole pack together, and removes it once.
    const escalating = makeInstanceStub(pack([280, 281, 282], 'dl-retry-pack', retryImport), {
      monitored: false,
    });
    const later = new Date('2026-09-27T12:25:00Z');
    await evaluateQueueCleanup({
      db: t.db,
      clients: makeClients({ sonarr: escalating.client }),
      config: cfg,
      now: later,
    });
    expect(escalating.calls.deletes.map((d) => d.id)).toEqual([280]);
    const third = await t.db
      .select()
      .from(arrQueueCleanupActions)
      .where(eq(arrQueueCleanupActions.createdAt, later));
    expect(
      third.every((r) => r.actionClass === 'bad_release' && r.action === 'removed_blocklisted'),
    ).toBe(true);
  });

  it('REAL BUNDLE (D-11): a Sonarr bad_release pack reads the episode list once and searches its monitored episodes in one command', async () => {
    const release = 'Some.Show.S01.1080p.WEB.h264-GRP';
    const sonarrRaw = [101, 102, 103].map((episodeId, i) => ({
      id: 9000 + i,
      downloadId: 'SABnzbd_nzo_pack',
      title: release,
      added: '2026-09-01T00:00:00Z',
      status: 'completed',
      trackedDownloadStatus: 'error',
      trackedDownloadState: 'importFailed',
      errorMessage: null,
      statusMessages: [{ title: release, messages: ['Unable to parse the release title'] }],
      seriesId: 7,
      episodeId,
    }));
    const log = {
      listEpisodes: [] as number[],
      getSeriesById: 0,
      deletes: [] as number[],
      searchEpisodes: [] as number[][],
      searchSeries: [] as number[],
    };
    const emptyQueue = { getQueueAll: async () => [] };
    const clients = buildQueueCleanupClients({
      read: {
        sonarr: {
          getQueueAll: async () => sonarrRaw,
          listEpisodes: async (seriesId: number) => {
            log.listEpisodes.push(seriesId);
            return [
              { id: 101, monitored: true },
              { id: 102, monitored: false },
              { id: 103, monitored: true },
            ];
          },
          getSeriesById: async () => {
            log.getSeriesById += 1;
            return { monitored: true };
          },
        } as unknown as SonarrClient,
        radarr: emptyQueue as unknown as RadarrClient,
        lidarr: emptyQueue as unknown as LidarrClient,
      },
      write: {
        sonarr: {
          deleteQueueItem: async (id: number) => {
            log.deletes.push(id);
          },
          processMonitoredDownloads: async () => ({}),
          searchEpisodes: async (ids: number[]) => {
            log.searchEpisodes.push(ids);
            return {};
          },
          searchSeries: async (id: number) => {
            log.searchSeries.push(id);
            return {};
          },
        } as unknown as SonarrWriteClient,
        radarr: {} as unknown as RadarrWriteClient,
        lidarr: {} as unknown as LidarrWriteClient,
      },
    });
    const cfg = clone();
    cfg.modes.sonarr.bad_release = 'enforce';
    const report = await evaluateQueueCleanup({ db: t.db, clients, config: cfg });

    expect(log.deletes).toEqual([9000]);
    expect(log.listEpisodes).toEqual([7]); // one read for the whole pack
    expect(log.getSeriesById).toBe(0);
    expect(log.searchEpisodes).toEqual([[101, 103]]); // one EpisodeSearch, monitored episodes only
    expect(log.searchSeries).toEqual([]);
    expect(sonarrReport(report)).toMatchObject({ actionsTaken: 1, covered: 2, errors: 0 });
    const rows = await rowsByQueueId();
    expect(rows.map((r) => [r.queueItemId, r.action, r.outcome])).toEqual([
      [9000, 'blocklisted_searched', 'done'],
      [9001, 'removed_blocklisted', 'done'],
      [9002, 'blocklisted_searched', 'done'],
    ]);
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

  // --- D-13: Lidarr manual_match enforce cell, loop guard, loop signal ---

  /** Lidarr's manual_match cell enforced, every other cell census, no age rail. */
  const mmCfg = (): ArrQueueCleanupConfig => {
    const cfg = clone();
    cfg.modes.lidarr.manual_match = 'enforce';
    return cfg;
  };
  const lidarrReport = (r: Awaited<ReturnType<typeof evaluateQueueCleanup>>) =>
    r.instances.find((i) => i.instance === 'lidarr')!;
  const lidarrRows = () =>
    t.db.select().from(arrQueueCleanupActions).orderBy(arrQueueCleanupActions.createdAt, arrQueueCleanupActions.queueItemId);
  /** A captured logger: every line, and the D-13 loop lines by their stable message. */
  const captureLogger = () => {
    const lines: Array<{ level: string; msg: string; meta?: Record<string, unknown> }> = [];
    const push = (level: string) => (msg: string, meta?: Record<string, unknown>) => {
      lines.push({ level, msg, meta });
    };
    return {
      logger: { info: push('info'), warn: push('warn'), error: push('error') },
      loops: () => lines.filter((l) => l.msg === QUEUE_CLEANUP_LOOP_LOG),
    };
  };
  /** A janitor row from an earlier run for one album (default: a landed manual_match removal + search). */
  const priorRow = (
    albumId: number,
    downloadId: string,
    o: { action?: 'removed_blocklisted' | 'blocklisted_searched' | 'skipped_gone' | 'none'; outcome?: 'done' | 'error' | 'observed'; actionClass?: 'manual_match' | 'bad_release' | 'have_better'; createdAt?: Date } = {},
  ) => ({
    instance: 'lidarr' as const,
    queueItemId: 1,
    downloadId,
    title: 'An earlier grab',
    targetId: albumId,
    actionClass: o.actionClass ?? ('manual_match' as const),
    mode: 'enforce' as const,
    action: o.action ?? ('blocklisted_searched' as const),
    outcome: o.outcome ?? ('done' as const),
    // Relative to the clock: a run without `now` uses the real time, and the guard counts the last 30 days (D-23 rule 7).
    createdAt: o.createdAt ?? new Date(Date.now() - 10 * 24 * 60 * 60 * 1000),
  });

  it('ENFORCE manual_match (D-13): removes + blocklists with skipRedownload, then ONE album search for a monitored, still-missing album', async () => {
    const lidarr = makeInstanceStub([manualMatchItem(400)]);
    const report = await evaluateQueueCleanup({
      db: t.db,
      clients: makeClients({ lidarr: lidarr.client }),
      config: mmCfg(),
    });
    expect(lidarr.calls.deletes).toEqual([{ id: 400, removeFromClient: true, blocklist: true, skipRedownload: true }]);
    expect(lidarr.calls.missingChecks).toEqual([[400]]);
    expect(lidarr.calls.searchCalls).toEqual([[400]]);
    expect(lidarr.calls.monitoredChecks).toBe(0); // the bad_release check is not the manual_match one
    expect(lidarrReport(report)).toMatchObject({ actionsTaken: 1, covered: 0, errors: 0 });
    expect(lidarrReport(report).byClass.manual_match).toEqual({ observed: 1, enforced: 1 });
    const [row] = await lidarrRows();
    expect(row).toMatchObject({
      instance: 'lidarr',
      actionClass: 'manual_match',
      mode: 'enforce',
      action: 'blocklisted_searched',
      outcome: 'done',
      targetId: 5400,
      reason: MANUAL_MATCH_TEXT,
    });
  });

  it('ENFORCE manual_match (D-13): an unmonitored or complete album is removed + blocklisted, never searched', async () => {
    const lidarr = makeInstanceStub([manualMatchItem(401)], { missing: false });
    await evaluateQueueCleanup({ db: t.db, clients: makeClients({ lidarr: lidarr.client }), config: mmCfg() });
    expect(lidarr.calls.deletes).toHaveLength(1);
    expect(lidarr.calls.missingChecks).toEqual([[401]]);
    expect(lidarr.calls.searches).toEqual([]);
    const [row] = await lidarrRows();
    expect(row).toMatchObject({ action: 'removed_blocklisted', outcome: 'done', targetId: 5401 });
  });

  it('ENFORCE manual_match (D-13): a record with no album is removed + blocklisted; no album check, no search', async () => {
    const lidarr = makeInstanceStub([manualMatchItem(402, undefined, null)]);
    await evaluateQueueCleanup({ db: t.db, clients: makeClients({ lidarr: lidarr.client }), config: mmCfg() });
    expect(lidarr.calls.deletes).toEqual([{ id: 402, removeFromClient: true, blocklist: true, skipRedownload: true }]);
    expect(lidarr.calls.missingChecks).toEqual([]);
    expect(lidarr.calls.searches).toEqual([]);
    const [row] = await lidarrRows();
    expect(row).toMatchObject({ action: 'removed_blocklisted', outcome: 'done', targetId: null });
  });

  it('ENFORCE manual_match (D-11 + D-13): a multi-album download gets one removal and one search for its missing albums only', async () => {
    const lidarr = makeInstanceStub(
      [manualMatchItem(410, 'dl-multi'), manualMatchItem(411, 'dl-multi'), manualMatchItem(412, 'dl-multi', null)],
      { missing: (qi) => qi.queueItemId === 410 },
    );
    const report = await evaluateQueueCleanup({
      db: t.db,
      clients: makeClients({ lidarr: lidarr.client }),
      config: mmCfg(),
    });
    expect(lidarr.calls.deletes.map((d) => d.id)).toEqual([410]);
    expect(lidarr.calls.missingChecks).toEqual([[410, 411]]); // the album-less record is never asked about
    expect(lidarr.calls.searchCalls).toEqual([[410]]);
    expect(lidarrReport(report)).toMatchObject({ actionsTaken: 1, covered: 2, errors: 0 });
    const rows = await lidarrRows();
    expect(rows.map((r) => [r.queueItemId, r.action, r.outcome, r.targetId])).toEqual([
      [410, 'blocklisted_searched', 'done', 5410],
      [411, 'removed_blocklisted', 'done', 5411],
      [412, 'removed_blocklisted', 'done', null],
    ]);
  });

  it('ENFORCE manual_match (D-13): the age rail and the per-run cap still apply', async () => {
    const now = new Date('2026-09-29T12:00:00Z');
    const lidarr = makeInstanceStub([
      { ...manualMatchItem(415), addedAt: new Date('2026-09-29T11:30:00Z') }, // 30 minutes old
      { ...manualMatchItem(416), addedAt: new Date('2026-09-20T00:00:00Z') },
      { ...manualMatchItem(417), addedAt: new Date('2026-09-20T00:00:00Z') },
    ]);
    await evaluateQueueCleanup({
      db: t.db,
      clients: makeClients({ lidarr: lidarr.client }),
      config: { ...mmCfg(), minItemAgeHours: 2, maxActionsPerRun: 1 },
      now,
    });
    expect(lidarr.calls.deletes.map((d) => d.id)).toEqual([416]);
    const rows = await lidarrRows();
    expect(rows.map((r) => [r.queueItemId, r.action])).toEqual([
      [415, 'skipped_young'],
      [416, 'blocklisted_searched'],
      [417, 'skipped_cap'],
    ]);
  });

  it('LOOP GUARD (D-13): an album removed as manual_match on 2 earlier downloads is skipped_loop, nothing is sent, one loop_detected line', async () => {
    expect(MANUAL_MATCH_LOOP_LIMIT).toBe(2);
    await t.db.insert(arrQueueCleanupActions).values([priorRow(5420, 'dl-a'), priorRow(5420, 'dl-b')]);
    const log = captureLogger();
    const lidarr = makeInstanceStub([{ ...manualMatchItem(420, 'dl-c', 5420), title: 'Artist - Album (2019)' }], {
      explodeOnWrite: true,
    });
    const report = await evaluateQueueCleanup({
      db: t.db,
      clients: makeClients({ lidarr: lidarr.client }),
      config: mmCfg(),
      logger: log.logger,
    });
    expect(lidarr.calls.deletes).toHaveLength(0);
    expect(lidarr.calls.missingChecks).toEqual([[420]]); // the guard asks whether a search would follow
    expect(lidarr.profiles.log).toEqual([]);
    expect(lidarrReport(report)).toMatchObject({ actionsTaken: 0, errors: 0 });
    const current = (await lidarrRows()).filter((r) => r.downloadId === 'dl-c');
    expect(current).toHaveLength(1);
    expect(current[0]).toMatchObject({ mode: 'enforce', action: 'skipped_loop', outcome: 'observed', targetId: 5420 });
    expect(log.loops()).toEqual([
      {
        level: 'warn',
        msg: '[queue-cleanup] loop_detected',
        meta: {
          kind: 'skipped_loop',
          instance: 'lidarr',
          downloadId: 'dl-c',
          title: 'Artist - Album (2019)',
          targetIds: [5420],
          priorRemovals: 2,
        },
      },
    ]);
  });

  it('LOOP GUARD (D-13): an album no longer missing tracks is not held (no search would follow); a failed check holds', async () => {
    await t.db.insert(arrQueueCleanupActions).values([priorRow(5425, 'dl-a'), priorRow(5425, 'dl-b')]);
    // The album imported since (a later upgrade grab failed): removed and blocked, not searched, not held.
    const complete = makeInstanceStub([manualMatchItem(425, 'dl-upgrade', 5425)], { missing: false });
    await evaluateQueueCleanup({ db: t.db, clients: makeClients({ lidarr: complete.client }), config: mmCfg() });
    expect(complete.calls.deletes.map((d) => d.id)).toEqual([425]);
    expect(complete.calls.searches).toEqual([]);
    let [row] = (await lidarrRows()).filter((r) => r.queueItemId === 425);
    expect(row).toMatchObject({ action: 'removed_blocklisted', outcome: 'done' });

    // The completeness read fails: the guard cannot tell, so nothing manual_match is acted on this run.
    await t.db.delete(arrQueueCleanupActions);
    await t.db.insert(arrQueueCleanupActions).values([priorRow(5426, 'dl-a'), priorRow(5426, 'dl-b')]);
    const failing = makeInstanceStub([manualMatchItem(426, 'dl-c', 5426)], { explodeOnWrite: true });
    failing.client.missingMonitoredTargets = async () => {
      throw new Error('album read failed');
    };
    await evaluateQueueCleanup({ db: t.db, clients: makeClients({ lidarr: failing.client }), config: mmCfg() });
    expect(failing.calls.deletes).toEqual([]);
    [row] = (await lidarrRows()).filter((r) => r.queueItemId === 426);
    expect(row).toMatchObject({ mode: 'enforce', action: 'none', outcome: 'observed' });
  });

  it('LOOP GUARD (D-13, D-23): counts only landed tries (a searching class) for the same album on OTHER downloads', async () => {
    await t.db.insert(arrQueueCleanupActions).values([
      priorRow(5430, 'dl-a'), // counts
      priorRow(5430, 'dl-this'), // the record's own download: not an earlier one
      priorRow(5430, 'dl-b', { action: 'removed_blocklisted', outcome: 'error' }), // the search failed: not counted
      priorRow(5430, 'dl-c', { action: 'skipped_gone', outcome: 'observed' }), // nothing was removed
      priorRow(5430, 'dl-d', { action: 'none', outcome: 'observed' }), // census
      priorRow(5430, 'dl-e', { actionClass: 'have_better', action: 'removed_blocklisted' }), // never searches: not a try
      priorRow(9999, 'dl-f'), // another album
      priorRow(9999, 'dl-g'),
    ]);
    const lidarr = makeInstanceStub([manualMatchItem(430, 'dl-this', 5430)]);
    await evaluateQueueCleanup({ db: t.db, clients: makeClients({ lidarr: lidarr.client }), config: mmCfg() });
    expect(lidarr.calls.deletes.map((d) => d.id)).toEqual([430]);
    const [row] = (await lidarrRows()).filter((r) => r.queueItemId === 430);
    expect(row).toMatchObject({ action: 'blocklisted_searched', outcome: 'done' });
  });

  it('LOOP GUARD (D-13): a looping album in a multi-album download holds the whole download (skipped_loop + skipped_mixed)', async () => {
    await t.db.insert(arrQueueCleanupActions).values([priorRow(5450, 'dl-a'), priorRow(5450, 'dl-b')]);
    const log = captureLogger();
    const lidarr = makeInstanceStub(
      [manualMatchItem(450, 'dl-pair', 5450), manualMatchItem(451, 'dl-pair', 5451)],
      { explodeOnWrite: true },
    );
    await evaluateQueueCleanup({
      db: t.db,
      clients: makeClients({ lidarr: lidarr.client }),
      config: mmCfg(),
      logger: log.logger,
    });
    expect(lidarr.calls.deletes).toHaveLength(0);
    const rows = (await lidarrRows()).filter((r) => r.downloadId === 'dl-pair');
    expect(rows.map((r) => [r.queueItemId, r.action])).toEqual([
      [450, 'skipped_loop'],
      [451, 'skipped_mixed'],
    ]);
    expect(log.loops().map((l) => l.meta)).toEqual([
      expect.objectContaining({ kind: 'skipped_loop', downloadId: 'dl-pair', targetIds: [5450] }),
    ]);
  });

  it('LOOP over runs (D-13): two remove-and-search runs, the 2nd logs repeat_search, the 3rd and later hold the album; the digest names both', async () => {
    const t0 = new Date('2026-09-29T10:25:00Z');
    const hour = 60 * 60 * 1000;
    const title = 'Artist - Album (2019)';
    const run = async (queueItemId: number, downloadId: string, at: Date) => {
      const log = captureLogger();
      const lidarr = makeInstanceStub([{ ...manualMatchItem(queueItemId, downloadId, 5440), title }]);
      await evaluateQueueCleanup({
        db: t.db,
        clients: makeClients({ lidarr: lidarr.client }),
        config: mmCfg(),
        now: at,
        logger: log.logger,
      });
      return { calls: lidarr.calls, loops: log.loops() };
    };

    const r1 = await run(441, 'dl-1', t0);
    expect(r1.calls.searchCalls).toEqual([[441]]);
    expect(r1.loops).toEqual([]);

    const r2 = await run(442, 'dl-2', new Date(t0.getTime() + hour));
    expect(r2.calls.searchCalls).toEqual([[442]]);
    expect(r2.loops.map((l) => l.meta)).toEqual([
      {
        kind: 'repeat_search',
        instance: 'lidarr',
        downloadId: 'dl-2',
        title,
        actionClass: 'manual_match',
        targets: [{ targetId: 5440, searches7d: 2 }],
      },
    ]);

    const r3 = await run(443, 'dl-3', new Date(t0.getTime() + 2 * hour));
    expect(r3.calls.deletes).toEqual([]);
    expect(r3.loops.map((l) => l.meta)).toEqual([
      expect.objectContaining({ kind: 'skipped_loop', downloadId: 'dl-3', targetIds: [5440], priorRemovals: 2 }),
    ]);
    const r4 = await run(443, 'dl-3', new Date(t0.getTime() + 3 * hour));
    expect(r4.calls.deletes).toEqual([]);
    // D-21: still held on the next run is a standing loop: recorded (below) and in the digest, not logged again.
    expect(r4.loops).toEqual([]);

    const rows = await lidarrRows();
    expect(rows.map((r) => [r.downloadId, r.action])).toEqual([
      ['dl-1', 'blocklisted_searched'],
      ['dl-2', 'blocklisted_searched'],
      ['dl-3', 'skipped_loop'],
      ['dl-3', 'skipped_loop'],
    ]);

    // The digest shows the held download (2 runs held) and the album searched on 2 runs, and flags the loop.
    const section = await buildQueueCleanupDigestSection({ db: t.db, now: new Date(t0.getTime() + 4 * hour) });
    expect(section!.loops).toEqual({
      skipped: [{ instance: 'lidarr', targetId: 5440, itemRef: null, downloadId: 'dl-3', title, runs: 2 }],
      repeatSearches: [{ instance: 'lidarr', targetId: 5440, downloadId: 'dl-2', title, runs: 2 }],
      failLoops: [],
    });
    expect(section!.loopDetected).toBe(true);
    const mail = renderOutboxEmail({
      eventType: 'activity_failure_digest',
      payload: { to: 'admin@example.test', count: 0, queueCleanup: JSON.parse(JSON.stringify(section)) },
    });
    expect(mail!.subject).toContain('[janitor: loop detected]');
    expect(mail!.text).toContain(` • lidarr album 5440: ${title} (2 runs held)`);
    expect(mail!.text).toContain(` • lidarr album 5440: ${title} (2 searches)`);

    // Outside the windows the lists are empty: held rows age out after 24h, searches after 7 days.
    const later = await buildQueueCleanupDigestSection({ db: t.db, now: new Date(t0.getTime() + 8 * 24 * hour) });
    expect(later).toBeNull(); // nothing observed in 24h, so no section at all
  });

  it('DIGEST (D-13): no loop, no loop tag; a search on one run only is not a repeat', async () => {
    const lidarr = makeInstanceStub([manualMatchItem(460)]);
    await evaluateQueueCleanup({ db: t.db, clients: makeClients({ lidarr: lidarr.client }), config: mmCfg() });
    const section = await buildQueueCleanupDigestSection({ db: t.db });
    expect(section!.loops).toEqual({ skipped: [], repeatSearches: [], failLoops: [] });
    expect(section!.loopDetected).toBe(false);
    const mail = renderOutboxEmail({
      eventType: 'activity_failure_digest',
      payload: { to: 'admin@example.test', count: 0, queueCleanup: JSON.parse(JSON.stringify(section)) },
    });
    expect(mail!.subject).not.toContain('loop');
    expect(mail!.text).not.toContain('Loops held');
  });

  it('CENSUS DEFAULT (D-13): the stored L1 config from before D-13 (no manual_match key) stays valid and never acts on manual_match', async () => {
    const l1 = clone({ minItemAgeHours: 2 });
    l1.modes.sonarr.have_better = 'enforce';
    l1.modes.radarr.have_better = 'enforce';
    await setArrQueueCleanupConfig({ db: t.db, config: l1, actorId: null });
    // Rewrite the row to the exact pre-D-13 shape (three cells per instance), as it is stored live.
    await t.db
      .update(appSettings)
      .set({
        value: {
          modes: {
            sonarr: { have_better: 'enforce', retry_import: 'census', bad_release: 'census' },
            radarr: { have_better: 'enforce', retry_import: 'census', bad_release: 'census' },
            lidarr: { have_better: 'census', retry_import: 'census', bad_release: 'census' },
          },
          maxActionsPerRun: 10,
          minItemAgeHours: 2,
          retryEscalateRuns: 6,
        },
      })
      .where(eq(appSettings.key, 'arr_queue_cleanup_config'));
    const resolved = await resolveArrQueueCleanupConfig(t.db);
    expect(resolved.modes.sonarr.have_better).toBe('enforce'); // still read, not reset to the default
    expect(resolved.modes.lidarr.manual_match).toBe('census');
    expect(deriveQueueCleanupLadderLevel(resolved)).toBe(1);

    const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const lidarr = makeInstanceStub([{ ...manualMatchItem(470), addedAt: old }], { explodeOnWrite: true });
    await evaluateQueueCleanup({ db: t.db, clients: makeClients({ lidarr: lidarr.client }), config: resolved });
    const [row] = await lidarrRows();
    expect(row).toMatchObject({ actionClass: 'manual_match', mode: 'census', action: 'none', outcome: 'observed' });
  });

  it('setArrQueueCleanupConfig (D-13): stores and audits the Lidarr manual_match flip', async () => {
    const cfg = mmCfg();
    await setArrQueueCleanupConfig({ db: t.db, config: cfg, actorId: null });
    const stored = await getArrQueueCleanupConfig(t.db);
    expect(stored?.modes.lidarr.manual_match).toBe('enforce');
    const [audit] = await t.db
      .select()
      .from(permissionAudit)
      .where(eq(permissionAudit.action, 'update_app_setting'));
    const detail = audit!.detail as { key: string; after: { modes: { lidarr: Record<string, string> } } };
    expect(detail.key).toBe('arr_queue_cleanup_config');
    expect(detail.after.modes.lidarr.manual_match).toBe('enforce');
    // A stray manual_match cell on Sonarr is refused at the writer.
    const bad = mmCfg();
    (bad.modes.sonarr as Record<string, unknown>).manual_match = 'enforce';
    await expect(setArrQueueCleanupConfig({ db: t.db, config: bad, actorId: null })).rejects.toBeInstanceOf(
      QueueCleanupConfigInvalidError,
    );
  });

  it('REAL BUNDLE (D-13 + D-14): Lidarr blocks the grab title first, then removes, then searches only the monitored missing album', async () => {
    // The queue title is SABnzbd's job name; the grab history carries the indexer's own title, which the term is built from.
    const release = 'Artist - Box Set (2019) [FLAC] (job name)';
    const grabbed = 'Artist - Box Set (2019) [FLAC]';
    const HEADER = 'One or more tracks expected in this release were not imported or missing from the release';
    const raw = (id: number, albumId: number | null) => ({
      id,
      downloadId: 'SABnzbd_nzo_box',
      title: release,
      added: '2026-09-01T00:00:00Z',
      status: 'completed',
      trackedDownloadStatus: 'warning',
      trackedDownloadState: 'importFailed',
      errorMessage: null,
      statusMessages: [
        { title: HEADER, messages: [] },
        { title: '01 - Opening.flac', messages: [MANUAL_MATCH_TEXT, 'Has missing tracks'] },
      ],
      artistId: 7,
      albumId,
    });
    const log = {
      listAlbums: [] as number[],
      deletes: [] as number[],
      searchAlbums: [] as number[][],
      searchArtist: [] as number[],
      grabs: [] as string[],
      order: [] as string[],
    };
    const lidarrProfiles: Array<Record<string, unknown>> = [
      { id: 3, enabled: true, required: [], ignored: ['someone else'], indexerId: 0, tags: [] },
    ];
    const emptyQueue = { getQueueAll: async () => [] };
    const clients = buildQueueCleanupClients({
      read: {
        sonarr: emptyQueue as unknown as SonarrClient,
        radarr: emptyQueue as unknown as RadarrClient,
        lidarr: {
          getQueueAll: async () => [raw(700, 71), raw(701, 72), raw(702, 73), raw(703, null)],
          listAlbums: async (artistId: number) => {
            log.listAlbums.push(artistId);
            return [
              { id: 71, monitored: true, statistics: { trackFileCount: 0, trackCount: 10, totalTrackCount: 10, sizeOnDisk: 0 } },
              { id: 72, monitored: true, statistics: { trackFileCount: 10, trackCount: 10, totalTrackCount: 10, sizeOnDisk: 1 } },
              { id: 73, monitored: false, statistics: { trackFileCount: 0, trackCount: 10, totalTrackCount: 10, sizeOnDisk: 0 } },
            ];
          },
          getArtistById: async () => ({ monitored: true, artistName: 'Artist' }),
          getDownloadGrabs: async (downloadId: string) => {
            log.grabs.push(downloadId);
            return { page: 1, pageSize: 10, totalRecords: 1, records: [{ sourceTitle: grabbed }] };
          },
        } as unknown as LidarrClient,
      },
      write: {
        sonarr: {} as unknown as SonarrWriteClient,
        radarr: {} as unknown as RadarrWriteClient,
        lidarr: {
          deleteQueueItem: async (id: number) => {
            log.deletes.push(id);
            log.order.push('delete');
          },
          processMonitoredDownloads: async () => ({}),
          searchAlbums: async (ids: number[]) => {
            log.searchAlbums.push(ids);
            log.order.push('search');
            return {};
          },
          listReleaseProfiles: async () => {
            log.order.push('profile:GET');
            return lidarrProfiles.map((p) => ({ ...p }));
          },
          createReleaseProfile: async (body: Record<string, unknown>) => {
            log.order.push('profile:POST');
            lidarrProfiles.push({ ...body, id: 9 });
            return { ...body, id: 9 };
          },
          updateReleaseProfile: async () => {
            throw new Error('no PUT expected');
          },
          searchArtist: async (id: number) => {
            log.searchArtist.push(id);
            return {};
          },
        } as unknown as LidarrWriteClient,
      },
    });
    const report = await evaluateQueueCleanup({ db: t.db, clients, config: mmCfg() });

    expect(log.grabs).toEqual(['SABnzbd_nzo_box']);
    expect(log.order).toEqual(['profile:GET', 'profile:POST', 'profile:GET', 'delete', 'search']);
    const ours = lidarrProfiles.find((p) => p.id === 9)!;
    expect(ours).not.toHaveProperty('name'); // Lidarr's profile has no name
    expect(ours).toMatchObject({ enabled: true, required: [], indexerId: 0, tags: [] });
    const [sentinel, term] = ours.ignored as string[];
    expect(sentinel).toBe(JANITOR_BLOCK_SENTINEL);
    expect(termMatchesRaw(term!, grabbed)).toBe(true);
    expect(termMatchesRaw(term!, release)).toBe(false); // built from the grab's title, not the job name
    expect(lidarrProfiles.find((p) => p.id === 3)!.ignored).toEqual(['someone else']); // other profiles untouched
    const [blockRow] = await t.db.select().from(arrQueueCleanupBlockTerms);
    expect(blockRow).toMatchObject({ instance: 'lidarr', term, releaseTitle: grabbed, downloadId: 'SABnzbd_nzo_box', targetId: 71 });
    expect(log.deletes).toEqual([700]);
    expect(log.listAlbums).toEqual([7]); // one read for the whole download
    expect(log.searchAlbums).toEqual([[71]]); // monitored and missing only
    expect(log.searchArtist).toEqual([]); // never an artist-wide search, even for the album-less record
    expect(lidarrReport(report)).toMatchObject({ actionsTaken: 1, covered: 3, errors: 0 });
    const rows = await lidarrRows();
    expect(rows.map((r) => [r.queueItemId, r.action, r.outcome, r.targetId])).toEqual([
      [700, 'blocklisted_searched', 'done', 71],
      [701, 'removed_blocklisted', 'done', 72], // complete
      [702, 'removed_blocklisted', 'done', 73], // unmonitored
      [703, 'removed_blocklisted', 'done', null], // no album
    ]);
  });

  // --- D-14: the janitor release block ---

  const TERM_TITLE = 'Artist - Album (2019) [FLAC]';
  const termOf = (title: string, artist = 'Artist') => {
    const d = deriveJanitorBlockTerm({ releaseTitle: title, artistName: artist });
    if (!('term' in d)) throw new Error(`no term: ${d.refused}`);
    return d.term;
  };
  const entry = (title: string, downloadId = 'dl-x') => ({
    term: termOf(title),
    releaseTitle: title,
    downloadId,
    targetId: 77,
  });

  it('BLOCK (D-14): the first block creates the profile (sentinel + term), reads it back, and records the term for 365 days', async () => {
    const store = makeProfileStore([{ id: 3, enabled: true, required: [], ignored: ['keep me'], indexerId: 0, tags: [] }]);
    const now = new Date('2026-09-29T12:00:00Z');
    const report = await reconcileJanitorReleaseBlock({
      db: t.db,
      instance: 'lidarr',
      profiles: store.client,
      add: [entry(TERM_TITLE)],
      now,
    });
    expect(store.log).toEqual(['GET', 'POST', 'GET']);
    expect(store.writes[0]!.body).toEqual({
      enabled: true,
      required: [],
      ignored: [JANITOR_BLOCK_SENTINEL, termOf(TERM_TITLE)],
      indexerId: 0,
      tags: [],
    });
    expect(store.profiles.find((p) => p.id === 3)!.ignored).toEqual(['keep me']);
    expect(report).toMatchObject({ instance: 'lidarr', total: 1, added: 1, removed: 0, pruned: 0, wrote: true });
    const [row] = await t.db.select().from(arrQueueCleanupBlockTerms);
    expect(row).toMatchObject({ instance: 'lidarr', term: termOf(TERM_TITLE), releaseTitle: TERM_TITLE, downloadId: 'dl-x', targetId: 77 });
    expect(row!.expiresAt.getTime() - now.getTime()).toBe(365 * 86_400_000);
  });

  it('BLOCK (D-14): a second term is PUT beside the first; the same term again writes nothing but refreshes its life', async () => {
    const store = makeProfileStore();
    const t0 = new Date('2026-09-29T12:00:00Z');
    await reconcileJanitorReleaseBlock({ db: t.db, instance: 'lidarr', profiles: store.client, add: [entry(TERM_TITLE)], now: t0 });
    const other = 'Artist - Other Album (2020) [MP3]';
    await reconcileJanitorReleaseBlock({ db: t.db, instance: 'lidarr', profiles: store.client, add: [entry(other)], now: t0 });
    expect(store.log).toEqual(['GET', 'POST', 'GET', 'GET', 'PUT', 'GET']);
    expect(new Set(store.profiles[0]!.ignored)).toEqual(
      new Set([JANITOR_BLOCK_SENTINEL, termOf(TERM_TITLE), termOf(other)]),
    );
    const later = new Date(t0.getTime() + 100 * 86_400_000);
    const again = await reconcileJanitorReleaseBlock({ db: t.db, instance: 'lidarr', profiles: store.client, add: [entry(TERM_TITLE)], now: later });
    expect(again.wrote).toBe(false);
    expect(store.log.slice(6)).toEqual(['GET', 'GET']);
    const rows = await t.db.select().from(arrQueueCleanupBlockTerms);
    expect(rows.filter((r) => r.term === termOf(TERM_TITLE))).toHaveLength(2); // append-only: one row per block
  });

  it('BLOCK (D-14): a failed write or read-back throws, and no term row is kept (the transaction rolls back)', async () => {
    for (const fail of [{ put: true }, { dropWrites: true }, { list: true }] as const) {
      const store = makeProfileStore();
      Object.assign(store.fail, fail);
      const err = await reconcileJanitorReleaseBlock({ db: t.db, instance: 'lidarr', profiles: store.client, add: [entry(TERM_TITLE)] }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(JanitorReleaseBlockError);
      expect((err as JanitorReleaseBlockError).step).toBe('dropWrites' in fail ? 'read_back' : 'put');
      expect(await t.db.select().from(arrQueueCleanupBlockTerms)).toHaveLength(0);
    }
  });

  it('BLOCK (D-14): two profiles carrying the sentinel refuse (duplicate_profile); a term outside the grammar refuses (validate)', async () => {
    const two = makeProfileStore([
      { id: 1, enabled: true, required: [], ignored: [JANITOR_BLOCK_SENTINEL], indexerId: 0, tags: [] },
      { id: 2, enabled: true, required: [], ignored: [JANITOR_BLOCK_SENTINEL], indexerId: 0, tags: [] },
    ]);
    await expect(
      reconcileJanitorReleaseBlock({ db: t.db, instance: 'lidarr', profiles: two.client, add: [entry(TERM_TITLE)] }),
    ).rejects.toMatchObject({ step: 'duplicate_profile' });
    expect(two.writes).toEqual([]);

    const store = makeProfileStore();
    const exact = renderTerm({ shape: 'exact', tokens: ['artist', 'album', '2019', 'flac'] }); // a prefix term: refused
    await expect(
      reconcileJanitorReleaseBlock({
        db: t.db,
        instance: 'lidarr',
        profiles: store.client,
        add: [{ term: exact, releaseTitle: null, downloadId: null, targetId: null }],
      }),
    ).rejects.toMatchObject({ step: 'validate' });
    expect(store.log).toEqual([]);
    expect(await t.db.select().from(arrQueueCleanupBlockTerms)).toHaveLength(0);
  });

  it('UPKEEP (D-14): nothing at all until the janitor has blocked; then drift (a hand edit, an expired term) is reconciled', async () => {
    const store = makeProfileStore();
    const logs: string[] = [];
    const logger = { warn: (m: string) => logs.push(m), info: (m: string) => logs.push(m) };
    const idle = await reconcileJanitorReleaseBlockIfDue({ db: t.db, instance: 'lidarr', profiles: store.client, logger });
    expect(idle).toEqual({ instance: 'lidarr', drift: null, report: null, error: null });
    expect(store.log).toEqual([]); // never blocked here: not even a GET

    const t0 = new Date('2026-09-29T12:00:00Z');
    await reconcileJanitorReleaseBlock({ db: t.db, instance: 'lidarr', profiles: store.client, add: [entry(TERM_TITLE)], now: t0 });
    // In step: one GET, no write.
    store.log.length = 0;
    const clean = await reconcileJanitorReleaseBlockIfDue({ db: t.db, instance: 'lidarr', profiles: store.client, now: t0 });
    expect(clean.drift).toBeNull();
    expect(store.log).toEqual(['GET']);

    // A hand edit removed the term and disabled the profile: restored.
    store.profiles[0]!.ignored = [JANITOR_BLOCK_SENTINEL];
    store.profiles[0]!.enabled = false;
    const fixed = await reconcileJanitorReleaseBlockIfDue({ db: t.db, instance: 'lidarr', profiles: store.client, now: t0, logger });
    expect(fixed.drift).toBe('disabled');
    expect(fixed.report).toMatchObject({ wrote: true, added: 1 });
    expect(store.profiles[0]).toMatchObject({ enabled: true, ignored: [JANITOR_BLOCK_SENTINEL, termOf(TERM_TITLE)] });
    expect(logs).toContain('[queue-cleanup] block_drift');

    // 366 days on, the term has expired: it leaves the profile; the sentinel stays.
    const expired = await reconcileJanitorReleaseBlockIfDue({
      db: t.db,
      instance: 'lidarr',
      profiles: store.client,
      now: new Date(t0.getTime() + 366 * 86_400_000),
    });
    expect(expired.drift).toBe('terms');
    expect(expired.report).toMatchObject({ removed: 1, total: 0 });
    expect(store.profiles[0]!.ignored).toEqual([JANITOR_BLOCK_SENTINEL]);

    // A failing upkeep never throws.
    store.fail.list = true;
    const failed = await reconcileJanitorReleaseBlockIfDue({ db: t.db, instance: 'lidarr', profiles: store.client, now: t0 });
    expect(failed.error).toMatch(/profile list failed/);
  });

  it('ENFORCE manual_match (D-14): the name is blocked and read back BEFORE the removal, then the album is searched', async () => {
    const lidarr = makeInstanceStub([{ ...manualMatchItem(480), title: TERM_TITLE }]);
    await evaluateQueueCleanup({ db: t.db, clients: makeClients({ lidarr: lidarr.client }), config: mmCfg() });
    expect(lidarr.calls.identityReads).toEqual([480]);
    expect(lidarr.calls.order).toEqual(['profile:GET', 'profile:POST', 'profile:GET', 'delete:480', 'search:480']);
    expect(lidarr.profiles.profiles[0]!.ignored).toEqual([JANITOR_BLOCK_SENTINEL, termOf(TERM_TITLE)]);
    const [row] = await t.db.select().from(arrQueueCleanupBlockTerms);
    expect(row).toMatchObject({ term: termOf(TERM_TITLE), downloadId: 'dl-480', targetId: 5480 });
  });

  it('UNBLOCKABLE (D-14): a title that does not name the artist is skipped_unblockable: no write, no removal, no cap slot', async () => {
    const lidarr = makeInstanceStub(
      [
        { ...manualMatchItem(481), title: 'Greatest Hits (2001) [FLAC]' },
        { ...manualMatchItem(482), title: TERM_TITLE },
      ],
      { identity: (qi) => ({ releaseTitle: qi.title, artistName: 'Artist' }) },
    );
    const logs: Array<{ msg: string; meta?: Record<string, unknown> }> = [];
    const report = await evaluateQueueCleanup({
      db: t.db,
      clients: makeClients({ lidarr: lidarr.client }),
      config: { ...mmCfg(), maxActionsPerRun: 1 },
      logger: { warn: (msg, meta) => logs.push({ msg, meta }) },
    });
    expect(lidarr.calls.deletes.map((d) => d.id)).toEqual([482]); // the cap slot went to the blockable one
    expect(lidarrReport(report)).toMatchObject({ actionsTaken: 1, errors: 0 });
    const rows = await lidarrRows();
    expect(rows.map((r) => [r.queueItemId, r.action, r.outcome])).toEqual([
      [481, 'skipped_unblockable', 'observed'],
      [482, 'blocklisted_searched', 'done'],
    ]);
    expect(logs.find((l) => l.meta?.reason === 'artist_not_named')?.msg).toBe(
      'queue-cleanup: release name cannot be blocked, download left alone',
    );
  });

  it('BLOCK FAILURE (D-14): a failed profile write or a failed identity read removes nothing; the next run tries again', async () => {
    const store = makeProfileStore();
    store.fail.put = true;
    const failing = makeInstanceStub([{ ...manualMatchItem(483), title: TERM_TITLE }], { profiles: store });
    const r1 = await evaluateQueueCleanup({ db: t.db, clients: makeClients({ lidarr: failing.client }), config: mmCfg() });
    expect(failing.calls.deletes).toEqual([]);
    expect(lidarrReport(r1)).toMatchObject({ actionsTaken: 1, errors: 1 });
    let [row] = await lidarrRows();
    expect(row).toMatchObject({ action: 'none', outcome: 'error', error: 'release block put failed on lidarr' });
    expect(await t.db.select().from(arrQueueCleanupBlockTerms)).toHaveLength(0);

    await t.db.delete(arrQueueCleanupActions);
    const unreadable = makeInstanceStub([manualMatchItem(484)], {
      identity: () => {
        throw new Error('history read failed');
      },
    });
    const r2 = await evaluateQueueCleanup({ db: t.db, clients: makeClients({ lidarr: unreadable.client }), config: mmCfg() });
    expect(unreadable.calls.deletes).toEqual([]);
    expect(unreadable.profiles.log).toEqual([]);
    expect(lidarrReport(r2)).toMatchObject({ actionsTaken: 0, errors: 1 });
    [row] = await lidarrRows();
    expect(row).toMatchObject({ action: 'none', outcome: 'error', error: 'release identity: history read failed' });
  });

  it('DIGEST (D-14): the section names the release names blocked in 24h and the terms live now', async () => {
    const lidarr = makeInstanceStub([{ ...manualMatchItem(485), title: TERM_TITLE }]);
    await evaluateQueueCleanup({ db: t.db, clients: makeClients({ lidarr: lidarr.client }), config: mmCfg() });
    const section = await buildQueueCleanupDigestSection({ db: t.db });
    expect(section!.releaseBlock).toEqual([{ instance: 'lidarr', blocked24h: 1, live: 1 }]);
    const mail = renderOutboxEmail({
      eventType: 'activity_failure_digest',
      payload: { to: 'admin@example.test', count: 0, queueCleanup: JSON.parse(JSON.stringify(section)) },
    });
    expect(mail!.text).toContain('Release names blocked on lidarr: 1 in the last 24h, 1 blocked now.');
  });

  // --- D-23 / D-24 (ADR-098): one budget for every janitor search; the failed-download retry ---

  const ARCHIVE = 'Found archive file, might need to be extracted';
  const ABORTED = 'Aborted, cannot be completed - https://sabnzbd.org/not-complete';
  const HOUR = 60 * 60 * 1000;
  /** A bad release of one target (Sonarr's episode, Radarr's movie, Lidarr's album), in the Paw Patrol shape. */
  const targetRelease = (id: number, downloadId: string, targetId: number, o: Partial<QueueCleanupQueueItem> = {}) => {
    const title = 'PAW.Patrol.S05E26.MULTI.1080p.WEB-DL.AAC2.0.x264-GRP';
    return item({
      queueItemId: id,
      downloadId,
      title,
      targetId,
      status: 'completed',
      trackedDownloadStatus: 'warning',
      trackedDownloadState: 'importBlocked',
      statusMessages: [{ title, messages: [ARCHIVE] }],
      ...o,
    });
  };
  /** bad_release enforced on one instance, every other cell census, no age rail. */
  const brCfg = (instance: 'sonarr' | 'radarr' | 'lidarr' = 'sonarr'): ArrQueueCleanupConfig => {
    const cfg = clone();
    cfg.modes[instance].bad_release = 'enforce';
    return cfg;
  };
  const only = (instance: 'sonarr' | 'radarr' | 'lidarr', client: QueueCleanupInstanceClient) =>
    makeClients(
      instance === 'sonarr' ? { sonarr: client } : instance === 'radarr' ? { radarr: client } : { lidarr: client },
    );
  /** A janitor row from an earlier run (default: a landed bad_release removal + search from the queue path). */
  const triedRow = (
    instance: 'sonarr' | 'radarr' | 'lidarr',
    targetId: number,
    downloadId: string,
    o: { action?: 'removed_blocklisted' | 'blocklisted_searched' | 'skipped_loop'; outcome?: 'done' | 'observed'; queueItemId?: number | null; createdAt?: Date } = {},
  ) => ({
    instance,
    queueItemId: o.queueItemId === undefined ? 1 : o.queueItemId,
    downloadId,
    title: 'An earlier grab',
    targetId,
    actionClass: 'bad_release' as const,
    mode: 'enforce' as const,
    action: o.action ?? ('blocklisted_searched' as const),
    outcome: o.outcome ?? ('done' as const),
    reason: ARCHIVE,
    createdAt: o.createdAt ?? new Date(Date.now() - 3 * 24 * HOUR),
  });
  const rowsOf = (instance: 'sonarr' | 'radarr' | 'lidarr') =>
    t.db
      .select()
      .from(arrQueueCleanupActions)
      .where(eq(arrQueueCleanupActions.instance, instance))
      .orderBy(arrQueueCleanupActions.createdAt, arrQueueCleanupActions.queueItemId, arrQueueCleanupActions.downloadId);
  const reportOf = (r: Awaited<ReturnType<typeof evaluateQueueCleanup>>, instance: string) =>
    r.instances.find((i) => i.instance === instance)!;

  it.each(['sonarr', 'radarr', 'lidarr'] as const)(
    'LOOP GUARD (D-23): a %s target the janitor already tried on 2 earlier downloads is held: no removal, no search, one loop_detected line',
    async (instance) => {
      expect(QUEUE_CLEANUP_LOOP_LIMIT).toBe(2);
      await t.db
        .insert(arrQueueCleanupActions)
        .values([triedRow(instance, 46388, 'dl-a'), triedRow(instance, 46388, 'dl-b', { action: 'removed_blocklisted' })]);
      const log = captureLogger();
      const stub = makeInstanceStub([targetRelease(500, 'dl-c', 46388)], { monitored: true, explodeOnWrite: true });
      const report = await evaluateQueueCleanup({
        db: t.db,
        clients: only(instance, stub.client),
        config: brCfg(instance),
        logger: log.logger,
      });
      expect(stub.calls.deletes).toEqual([]);
      expect(stub.calls.searches).toEqual([]);
      expect(stub.calls.monitoredChecks).toBe(1); // the guard asks whether a search would follow
      expect(reportOf(report, instance)).toMatchObject({ actionsTaken: 0, errors: 0 });
      const [row] = (await rowsOf(instance)).filter((r) => r.downloadId === 'dl-c');
      expect(row).toMatchObject({ mode: 'enforce', action: 'skipped_loop', outcome: 'observed', targetId: 46388 });
      expect(log.loops().map((l) => l.meta)).toEqual([
        expect.objectContaining({ kind: 'skipped_loop', instance, downloadId: 'dl-c', targetIds: [46388], priorRemovals: 2 }),
      ]);
    },
  );

  it('LOOP over runs (D-23): the Paw Patrol shape, one episode bad again and again: two removals with one search each, the third removal is never sent and nothing is searched', async () => {
    const t0 = new Date('2026-10-02T06:25:00Z');
    const run = async (n: number) => {
      const log = captureLogger();
      const sonarr = makeInstanceStub([targetRelease(600 + n, `dl-${n}`, 46388)], { monitored: true });
      await evaluateQueueCleanup({
        db: t.db,
        clients: makeClients({ sonarr: sonarr.client }),
        config: brCfg(),
        now: new Date(t0.getTime() + n * HOUR),
        logger: log.logger,
      });
      return { calls: sonarr.calls, loops: log.loops() };
    };
    const r1 = await run(1);
    expect(r1.calls.deletes).toEqual([{ id: 601, removeFromClient: true, blocklist: true, skipRedownload: true }]);
    expect(r1.calls.searchCalls).toEqual([[601]]);
    const r2 = await run(2);
    expect(r2.calls.searchCalls).toEqual([[602]]);
    expect(r2.loops.map((l) => l.meta)).toEqual([
      expect.objectContaining({ kind: 'repeat_search', downloadId: 'dl-2', targets: [{ targetId: 46388, searches7d: 2 }] }),
    ]);
    const r3 = await run(3);
    expect(r3.calls.deletes).toEqual([]);
    expect(r3.calls.searchCalls).toEqual([]);
    expect(r3.loops.map((l) => l.meta)).toEqual([
      expect.objectContaining({ kind: 'skipped_loop', downloadId: 'dl-3', targetIds: [46388], priorRemovals: 2 }),
    ]);
    expect((await rowsOf('sonarr')).map((r) => [r.downloadId, r.action])).toEqual([
      ['dl-1', 'blocklisted_searched'],
      ['dl-2', 'blocklisted_searched'],
      ['dl-3', 'skipped_loop'],
    ]);
  });

  it('WINDOW (D-23 rule 7, Q-08): two tries count for 30 days, so a third try 31 days after the first is allowed, and two in any 30 days hold the next', async () => {
    expect(QUEUE_CLEANUP_LOOP_WINDOW_MS).toBe(30 * 24 * HOUR);
    const day = 24 * HOUR;
    const t0 = new Date('2026-10-02T06:25:00Z');
    const run = async (n: number, at: Date) => {
      const sonarr = makeInstanceStub([targetRelease(650 + n, `dl-${n}`, 46500)], { monitored: true });
      await evaluateQueueCleanup({ db: t.db, clients: makeClients({ sonarr: sonarr.client }), config: brCfg(), now: at });
      return sonarr.calls;
    };
    expect((await run(1, t0)).searchCalls).toEqual([[651]]);
    expect((await run(2, new Date(t0.getTime() + day))).searchCalls).toEqual([[652]]);
    // Day 29: both tries are inside the window, so the third is held.
    const held = await run(3, new Date(t0.getTime() + 29 * day));
    expect(held.deletes).toEqual([]);
    // Day 31: the first try has aged out (one try in 30 days), so the janitor removes and searches once more.
    const third = await run(4, new Date(t0.getTime() + 31 * day));
    expect(third.deletes.map((d) => d.id)).toEqual([654]);
    expect(third.searchCalls).toEqual([[654]]);
    // Day 32: the day-1 try has aged out too (only day 31 counts), so one more try; day 33: days 31 and 32 count, held.
    expect((await run(5, new Date(t0.getTime() + 32 * day))).searchCalls).toEqual([[655]]);
    expect((await run(6, new Date(t0.getTime() + 33 * day))).deletes).toEqual([]);
    expect((await rowsOf('sonarr')).map((r) => [r.downloadId, r.action])).toEqual([
      ['dl-1', 'blocklisted_searched'],
      ['dl-2', 'blocklisted_searched'],
      ['dl-3', 'skipped_loop'],
      ['dl-4', 'blocklisted_searched'],
      ['dl-5', 'blocklisted_searched'],
      ['dl-6', 'skipped_loop'],
    ]);
  });

  it('WINDOW (D-23 rule 7): the Lidarr manual_match hold and the failed-download retry share the 30-day window', async () => {
    const now = new Date('2026-10-03T07:25:00Z');
    const old = new Date(now.getTime() - 31 * 24 * HOUR);
    // manual_match: one try 31 days ago and one 2 days ago is one try in the window, so the album is tried again.
    await t.db
      .insert(arrQueueCleanupActions)
      .values([priorRow(5480, 'dl-old', { createdAt: old }), priorRow(5480, 'dl-new', { createdAt: new Date(now.getTime() - 2 * 24 * HOUR) })]);
    const lidarr = makeInstanceStub([manualMatchItem(480, 'dl-c', 5480)]);
    await evaluateQueueCleanup({ db: t.db, clients: makeClients({ lidarr: lidarr.client }), config: mmCfg(), now });
    expect(lidarr.calls.deletes.map((d) => d.id)).toEqual([480]);
    expect(lidarr.calls.searchCalls).toEqual([[480]]);

    // The retry: two old tries for the episode no longer count, so the failure is searched once.
    await t.db
      .insert(arrQueueCleanupActions)
      .values([triedRow('sonarr', 46501, 'dl-a', { createdAt: old }), triedRow('sonarr', 46501, 'dl-b', { createdAt: old })]);
    const stub = failedStub([failure({ downloadId: 'dl-c', targetId: 46501, failedAt: new Date(now.getTime() - HOUR) })]);
    await retryRun([], stub.source, { now });
    expect(stub.calls.searches).toEqual([[46501]]);
  });

  it('LOOP GUARD (D-23): an unmonitored target over the budget is removed and blocklisted, not held (no search would follow)', async () => {
    await t.db.insert(arrQueueCleanupActions).values([triedRow('sonarr', 46389, 'dl-a'), triedRow('sonarr', 46389, 'dl-b')]);
    const sonarr = makeInstanceStub([targetRelease(510, 'dl-c', 46389)], { monitored: false });
    await evaluateQueueCleanup({ db: t.db, clients: makeClients({ sonarr: sonarr.client }), config: brCfg() });
    expect(sonarr.calls.deletes.map((d) => d.id)).toEqual([510]);
    expect(sonarr.calls.searches).toEqual([]);
    const [row] = (await rowsOf('sonarr')).filter((r) => r.downloadId === 'dl-c');
    expect(row).toMatchObject({ action: 'removed_blocklisted', outcome: 'done' });
  });

  it('LOOP GUARD (D-23): one budget across classes, so a bad_release try and a manual_match try hold a Lidarr album', async () => {
    await t.db
      .insert(arrQueueCleanupActions)
      .values([priorRow(5470, 'dl-a', { actionClass: 'bad_release' }), priorRow(5470, 'dl-b')]);
    const lidarr = makeInstanceStub([manualMatchItem(470, 'dl-c', 5470)], { explodeOnWrite: true });
    await evaluateQueueCleanup({ db: t.db, clients: makeClients({ lidarr: lidarr.client }), config: mmCfg() });
    expect(lidarr.calls.deletes).toEqual([]);
    const [row] = (await lidarrRows()).filter((r) => r.downloadId === 'dl-c');
    expect(row).toMatchObject({ action: 'skipped_loop', outcome: 'observed' });
  });

  it('ONE SEARCH (D-23): each removal sends skipRedownload and one search; a second download of an episode already searched this run is removed, not searched again', async () => {
    // The 2026-10-02 shape: an S05E03E04 pack and an S05E04 single both stuck for the same episode.
    const sonarr = makeInstanceStub(
      [targetRelease(700, 'dl-pack', 103), targetRelease(701, 'dl-pack', 104), targetRelease(702, 'dl-single', 104)],
      { monitored: true },
    );
    await evaluateQueueCleanup({ db: t.db, clients: makeClients({ sonarr: sonarr.client }), config: brCfg() });
    expect(sonarr.calls.deletes).toEqual([
      { id: 700, removeFromClient: true, blocklist: true, skipRedownload: true },
      { id: 702, removeFromClient: true, blocklist: true, skipRedownload: true },
    ]);
    expect(sonarr.calls.searchCalls).toEqual([[700, 701]]);
    expect((await rowsOf('sonarr')).map((r) => [r.queueItemId, r.action, r.outcome])).toEqual([
      [700, 'blocklisted_searched', 'done'],
      [701, 'blocklisted_searched', 'done'],
      [702, 'removed_blocklisted', 'done'],
    ]);
  });

  it('*ARR FAILURE (D-23): a download the *arr marked failed is removed and blocklisted with no search; one it is failing right now (failedPending) waits a run', async () => {
    const sonarr = makeInstanceStub(
      [
        item({ queueItemId: 710, downloadId: 'dl-failed', targetId: 46390, status: 'failed', trackedDownloadState: 'failed' }),
        item({ queueItemId: 711, downloadId: 'dl-pending', targetId: 46391, status: 'failed', trackedDownloadState: 'failedPending' }),
      ],
      { monitored: true },
    );
    await evaluateQueueCleanup({ db: t.db, clients: makeClients({ sonarr: sonarr.client }), config: brCfg() });
    expect(sonarr.calls.deletes).toEqual([{ id: 710, removeFromClient: true, blocklist: true, skipRedownload: true }]);
    expect(sonarr.calls.monitoredChecks).toBe(0);
    expect(sonarr.calls.searches).toEqual([]);
    expect((await rowsOf('sonarr')).map((r) => [r.queueItemId, r.actionClass, r.mode, r.action])).toEqual([
      [710, 'bad_release', 'enforce', 'removed_blocklisted'],
      [711, 'bad_release', 'enforce', 'none'],
    ]);
  });

  /** A failed download as the *arr's history records it (default: SABnzbd aborted it, 2026-10-02 06:26Z). */
  const failure = (
    o: Partial<QueueCleanupFailedDownload> & { downloadId: string; targetId: number },
  ): QueueCleanupFailedDownload => ({
    historyId: 1,
    title: 'PAW.Patrol.S05E16.1080p.SKST.WEB-DL.DD+5.1.H.264-GRP',
    failedAt: new Date('2026-10-02T06:26:22Z'),
    message: ABORTED,
    parentId: 77,
    regrabbed: false,
    ...o,
  });
  /** A stub failed-download source: Redownload Failed off and every target monitored unless told otherwise. */
  const failedStub = (
    failures: QueueCleanupFailedDownload[],
    o: { redownload?: boolean; monitored?: boolean | ((f: QueueCleanupFailedDownload) => boolean); searchError?: boolean } = {},
  ) => {
    const calls = { reads: [] as Date[], configReads: 0, monitoredChecks: [] as number[][], searches: [] as number[][] };
    const source: QueueCleanupFailedDownloadSource = {
      async redownloadFailed() {
        calls.configReads += 1;
        return o.redownload ?? false;
      },
      async failedSince(since) {
        calls.reads.push(since);
        return failures;
      },
      async monitored(fs) {
        calls.monitoredChecks.push(fs.map((f) => f.targetId));
        const m = o.monitored ?? true;
        return fs.filter((f) => (typeof m === 'function' ? m(f) : m));
      },
      async search(fs) {
        if (o.searchError) throw new Error('search failed');
        calls.searches.push(fs.map((f) => f.targetId));
      },
    };
    return { source, calls };
  };
  /** One janitor run on Sonarr with a queue and a failed-download source. */
  const retryRun = async (
    queue: QueueCleanupQueueItem[],
    source: QueueCleanupFailedDownloadSource,
    o: { now?: Date; config?: ArrQueueCleanupConfig; monitored?: boolean } = {},
  ) => {
    const log = captureLogger();
    const sonarr = makeInstanceStub(queue, { monitored: o.monitored ?? true });
    sonarr.client.failedDownloads = source;
    const report = await evaluateQueueCleanup({
      db: t.db,
      clients: makeClients({ sonarr: sonarr.client }),
      config: o.config ?? brCfg(),
      now: o.now ?? new Date('2026-10-02T07:25:00Z'),
      logger: log.logger,
    });
    return { report: reportOf(report, 'sonarr'), calls: sonarr.calls, loops: log.loops() };
  };

  it('RETRY (D-24): one failed download gets exactly one search, recorded once with no queue id; later runs that read it again do nothing', async () => {
    const now = new Date('2026-10-02T07:25:00Z');
    const f = failure({ historyId: 11, downloadId: 'dl-f1', targetId: 46380 });
    const first = failedStub([f]);
    const r1 = await retryRun([], first.source, { now });
    expect(first.calls.reads).toEqual([new Date(now.getTime() - 24 * HOUR)]);
    expect(first.calls.searches).toEqual([[46380]]);
    expect(r1.report).toMatchObject({ actionsTaken: 1, errors: 0, itemsObserved: 1 });
    expect(r1.report.byClass.bad_release).toEqual({ observed: 1, enforced: 1 });
    const rows = await rowsOf('sonarr');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      queueItemId: null,
      downloadId: 'dl-f1',
      targetId: 46380,
      actionClass: 'bad_release',
      mode: 'enforce',
      action: 'blocklisted_searched',
      outcome: 'done',
      reason: ABORTED,
    });
    // The next run's 24-hour read still holds the failure: it is recorded, so nothing is searched or written again.
    const second = failedStub([f]);
    const r2 = await retryRun([], second.source, { now: new Date(now.getTime() + HOUR) });
    expect(second.calls.searches).toEqual([]);
    expect(second.calls.configReads).toBe(0);
    expect(r2.report).toMatchObject({ actionsTaken: 0, itemsObserved: 0 });
    expect(await rowsOf('sonarr')).toHaveLength(1);
  });

  it('RETRY (D-24): the third failure of one episode is not searched (two retries, then held, one loop_detected line)', async () => {
    const t0 = new Date('2026-10-02T06:25:00Z');
    const failures: QueueCleanupFailedDownload[] = [];
    const run = async (n: number) => {
      const at = new Date(t0.getTime() + n * HOUR);
      failures.push(failure({ historyId: n, downloadId: `dl-${n}`, targetId: 46395, failedAt: new Date(at.getTime() - 30 * 60 * 1000) }));
      const stub = failedStub([...failures]);
      const r = await retryRun([], stub.source, { now: at });
      return { searches: stub.calls.searches, loops: r.loops };
    };
    expect((await run(1)).searches).toEqual([[46395]]);
    const r2 = await run(2);
    expect(r2.searches).toEqual([[46395]]);
    expect(r2.loops.map((l) => l.meta)).toEqual([
      expect.objectContaining({ kind: 'repeat_search', downloadId: 'dl-2', actionClass: 'bad_release' }),
    ]);
    const r3 = await run(3);
    expect(r3.searches).toEqual([]);
    expect(r3.loops.map((l) => l.meta)).toEqual([
      expect.objectContaining({ kind: 'skipped_loop', instance: 'sonarr', downloadId: 'dl-3', targetIds: [46395], priorRemovals: 2 }),
    ]);
    expect((await rowsOf('sonarr')).map((r) => [r.downloadId, r.action, r.outcome])).toEqual([
      ['dl-1', 'blocklisted_searched', 'done'],
      ['dl-2', 'blocklisted_searched', 'done'],
      ['dl-3', 'skipped_loop', 'observed'],
    ]);
  });

  it('RETRY (D-24): the queue path and the retry share one budget (one removal + one retry, then the next failure is held)', async () => {
    await t.db
      .insert(arrQueueCleanupActions)
      .values([triedRow('sonarr', 46396, 'dl-a'), triedRow('sonarr', 46396, 'dl-b', { queueItemId: null })]);
    const stub = failedStub([failure({ downloadId: 'dl-c', targetId: 46396 })]);
    await retryRun([], stub.source);
    expect(stub.calls.searches).toEqual([]);
    const [row] = (await rowsOf('sonarr')).filter((r) => r.downloadId === 'dl-c');
    expect(row).toMatchObject({ queueItemId: null, action: 'skipped_loop', outcome: 'observed' });
  });

  it("RETRY (D-24): nothing is searched while the *arr's own Redownload Failed is on or the cell is census; a removal through the *arr's API is never a failure to retry", async () => {
    const arrOn = failedStub([failure({ downloadId: 'dl-on', targetId: 46381 })], { redownload: true });
    await retryRun([], arrOn.source);
    expect(arrOn.calls.configReads).toBe(1);
    expect(arrOn.calls.monitoredChecks).toEqual([]);
    expect(arrOn.calls.searches).toEqual([]);

    const census = failedStub([failure({ downloadId: 'dl-census', targetId: 46382 })]);
    await retryRun([], census.source, { config: clone() });
    expect(census.calls.searches).toEqual([]);

    const manual = failedStub([failure({ downloadId: 'dl-manual', targetId: 46383, message: ARR_MANUAL_FAILURE_MESSAGE })]);
    await retryRun([], manual.source);
    expect(manual.calls.configReads).toBe(0);
    expect(manual.calls.searches).toEqual([]);

    expect((await rowsOf('sonarr')).map((r) => [r.downloadId, r.mode, r.action, r.outcome])).toEqual([
      ['dl-census', 'census', 'none', 'observed'],
      ['dl-on', 'enforce', 'none', 'observed'],
    ]);
  });

  it("RETRY (D-24): a target grabbed again, with another download queued, or searched this run is not searched; a failure whose own download is still queued waits for its removal", async () => {
    const queue = [
      targetRelease(800, 'dl-q', 46400), // the queue path removes it and searches 46400 this run
      { ...unknownItem(801), targetId: 46401 }, // another download of 46401 is still in flight
      { ...unknownItem(802), downloadId: 'dl-own', targetId: 46403 }, // the failure's own download, not removed yet
    ];
    const stub = failedStub([
      failure({ historyId: 1, downloadId: 'dl-x', targetId: 46400 }),
      failure({ historyId: 2, downloadId: 'dl-y', targetId: 46401 }),
      failure({ historyId: 3, downloadId: 'dl-z', targetId: 46402, regrabbed: true }),
      failure({ historyId: 4, downloadId: 'dl-own', targetId: 46403 }),
    ]);
    const r = await retryRun(queue, stub.source);
    expect(r.calls.searchCalls).toEqual([[800]]); // the queue path's one search
    expect(stub.calls.monitoredChecks).toEqual([]);
    expect(stub.calls.searches).toEqual([]);
    const retryRows = (await rowsOf('sonarr')).filter((row) => row.queueItemId === null);
    expect(retryRows.map((row) => [row.downloadId, row.action, row.outcome])).toEqual([
      ['dl-x', 'none', 'observed'],
      ['dl-y', 'none', 'observed'],
      ['dl-z', 'none', 'observed'],
    ]);
  });

  it('RETRY (D-24) + WAITING (D-25): a replacement held on the delay profile counts as queued, so its failed title is not searched again', async () => {
    const held = item({
      queueItemId: 810,
      title: 'Held.Show.S01E01.1080p-GRP',
      status: 'delay',
      trackedDownloadStatus: 'ok',
      trackedDownloadState: 'downloading',
      statusMessages: [],
      targetId: 46420, // the replacement the *arr is waiting out its delay on
    });
    const stub = failedStub([
      failure({ historyId: 1, downloadId: 'dl-a', targetId: 46420 }), // a replacement is already held: no search
      failure({ historyId: 2, downloadId: 'dl-b', targetId: 46421 }), // nothing held: searched once
    ]);
    const r = await retryRun([held], stub.source);
    expect(stub.calls.searches).toEqual([[46421]]);
    // The held record is still left out of the census: no row of its own, nothing counted for it.
    const rows = await rowsOf('sonarr');
    expect(rows.filter((row) => row.queueItemId === 810)).toEqual([]);
    expect(r.report.waiting).toBe(1);
    expect(rows.map((row) => [row.downloadId, row.action]).sort()).toEqual([
      ['dl-a', 'none'],
      ['dl-b', 'blocklisted_searched'],
    ]);
  });

  it('RETRY (D-24): an unmonitored target is none; a spent cap is skipped_cap and a failed search an error, and both are tried again next run', async () => {
    const now = new Date('2026-10-02T07:25:00Z');
    const failures = [
      failure({ historyId: 1, downloadId: 'dl-1', targetId: 46411, failedAt: new Date('2026-10-02T06:10:00Z') }),
      failure({ historyId: 2, downloadId: 'dl-2', targetId: 46412, failedAt: new Date('2026-10-02T06:20:00Z') }),
      failure({ historyId: 3, downloadId: 'dl-3', targetId: 46413, failedAt: new Date('2026-10-02T06:30:00Z') }),
    ];
    const cfg = brCfg();
    cfg.maxActionsPerRun = 1;
    const first = failedStub(failures, { monitored: (f) => f.targetId !== 46413 });
    const r1 = await retryRun([], first.source, { now, config: cfg });
    expect(first.calls.searches).toEqual([[46411]]);
    expect(r1.report.actionsTaken).toBe(1);

    const second = failedStub(failures, { searchError: true });
    const r2 = await retryRun([], second.source, { now: new Date(now.getTime() + HOUR), config: cfg });
    expect(r2.report.errors).toBe(1);

    const third = failedStub(failures);
    await retryRun([], third.source, { now: new Date(now.getTime() + 2 * HOUR), config: cfg });
    expect(third.calls.searches).toEqual([[46412]]);

    expect((await rowsOf('sonarr')).map((r) => [r.downloadId, r.action, r.outcome])).toEqual([
      ['dl-1', 'blocklisted_searched', 'done'],
      ['dl-2', 'skipped_cap', 'observed'],
      ['dl-3', 'none', 'observed'],
      ['dl-2', 'none', 'error'],
      ['dl-2', 'blocklisted_searched', 'done'],
    ]);
  });

  it('REAL BUNDLE (D-24): Sonarr reads Redownload Failed and its failed + grabbed history, then sends ONE EpisodeSearch for the failed download\'s monitored episodes', async () => {
    const now = new Date('2026-10-02T07:25:00Z');
    const failedRecord = (id: number, downloadId: string, episodeId: number, message: string, date = '2026-10-02T06:26:22Z') => ({
      id,
      eventType: 'downloadFailed',
      date,
      sourceTitle: 'Paw.Patrol.S05E19E20.1080p.NICK.WEBRip.AAC2.0.x264-GRP',
      downloadId,
      data: { message },
      episodeId,
      seriesId: 7,
    });
    const log = { history: [] as Array<[string, string | undefined]>, listEpisodes: [] as number[], searchEpisodes: [] as number[][] };
    const emptyQueue = { getQueueAll: async () => [] };
    const clients = buildQueueCleanupClients({
      read: {
        sonarr: {
          getQueueAll: async () => [],
          getDownloadClientConfig: async () => ({ autoRedownloadFailed: false }),
          getHistorySince: async (since: Date, eventType?: string) => {
            log.history.push([since.toISOString(), eventType]);
            return eventType === 'downloadFailed'
              ? [
                  failedRecord(1, 'SABnzbd_nzo_a', 46390, ABORTED),
                  failedRecord(2, 'SABnzbd_nzo_a', 46391, ABORTED),
                  failedRecord(3, 'SABnzbd_nzo_b', 46392, ARR_MANUAL_FAILURE_MESSAGE),
                  failedRecord(4, 'SABnzbd_nzo_c', 46393, ABORTED),
                ]
              : [{ id: 9, eventType: 'grabbed', date: '2026-10-02T06:27:00Z', downloadId: 'SABnzbd_nzo_d', episodeId: 46393, seriesId: 7 }];
          },
          listEpisodes: async (seriesId: number) => {
            log.listEpisodes.push(seriesId);
            return [
              { id: 46390, monitored: true },
              { id: 46391, monitored: false },
              { id: 46393, monitored: true },
            ];
          },
        } as unknown as SonarrClient,
        radarr: emptyQueue as unknown as RadarrClient,
        lidarr: emptyQueue as unknown as LidarrClient,
      },
      write: {
        sonarr: {
          searchEpisodes: async (ids: number[]) => {
            log.searchEpisodes.push(ids);
            return {};
          },
        } as unknown as SonarrWriteClient,
        radarr: {} as unknown as RadarrWriteClient,
        lidarr: {} as unknown as LidarrWriteClient,
      },
    });
    await evaluateQueueCleanup({ db: t.db, clients, config: brCfg(), now });
    const since = new Date(now.getTime() - 24 * HOUR).toISOString();
    expect(log.history).toEqual([
      [since, 'downloadFailed'],
      [since, 'grabbed'],
    ]);
    expect(log.listEpisodes).toEqual([7]);
    expect(log.searchEpisodes).toEqual([[46390]]);
    expect((await rowsOf('sonarr')).map((r) => [r.downloadId, r.targetId, r.action, r.outcome])).toEqual([
      ['SABnzbd_nzo_a', 46390, 'blocklisted_searched', 'done'],
      ['SABnzbd_nzo_a', 46391, 'none', 'observed'],
      ['SABnzbd_nzo_c', 46393, 'none', 'observed'],
    ]);
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

  it('D-13: a payload without loops (written before D-13) renders no loop tag or list', () => {
    const mail = renderOutboxEmail({
      eventType: 'activity_failure_digest',
      payload: { to: 'admin@example.test', count: 0, queueCleanup: section },
    });
    expect(mail!.subject).not.toContain('loop');
    expect(mail!.text).not.toContain('Loops held');
    expect(mail!.text).not.toContain('Searched again');
  });

  it('D-13: loops render in the body and tag the subject, alongside the promotion nag', () => {
    const mail = renderOutboxEmail({
      eventType: 'activity_failure_digest',
      payload: {
        to: 'admin@example.test',
        count: 0,
        queueCleanup: {
          ...section,
          promotionDue: true,
          loops: {
            skipped: [{ instance: 'lidarr', targetId: 12, downloadId: 'd1', title: 'Artist - Album', runs: 5 }],
            repeatSearches: [
              { instance: 'lidarr', targetId: 12, downloadId: 'd0', title: 'Artist - Album', runs: 2 },
              { instance: 'sonarr', targetId: 99, downloadId: 'd2', title: null, runs: 3 },
            ],
          },
          loopDetected: true,
        },
      },
    });
    expect(mail!.subject).toContain('[janitor: promotion due] [janitor: loop detected]');
    expect(mail!.text).toContain('Loops held for a person (the janitor stopped acting on these, last 24h):');
    expect(mail!.text).toContain(' • lidarr album 12: Artist - Album (5 runs held)');
    expect(mail!.text).toContain('Searched again on 2 or more runs (last 7 days):');
    expect(mail!.text).toContain(' • lidarr album 12: Artist - Album (2 searches)');
    expect(mail!.text).toContain(' • sonarr episode 99 (3 searches)');
    expect(mail!.text).not.toContain('—');
  });
});
