import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { appSettings, arrQueueCleanupActions, notificationOutbox, permissionAudit } from '@hnet/db';
import { ArrHttpError } from '@hnet/arr';
import type { SonarrClient, RadarrClient, LidarrClient } from '@hnet/arr/read';
import type { SonarrWriteClient, RadarrWriteClient, LidarrWriteClient } from '@hnet/arr/write';
import { bootMigratedDb, type TestDb } from './helpers';
import { runFailureDigest } from '../src/activity/digest';
import { renderOutboxEmail } from '../src/notify-outbox';
import { QueueCleanupConfigInvalidError } from '../src/errors';
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

  describe('D-12 Lidarr match rejections → manual_match (report only); everything else keeps its class', () => {
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
    statusMessages: [{ title: 'x', messages: ['Something the classifier has never seen'] }],
  });
/** A Lidarr match rejection in Lidarr's multi-file shape (D-12): report only, like unknown. */
const MANUAL_MATCH_TEXT = 'Album match is not close enough: 75.6 % vs 80 % [album, year, missing tracks]';
const manualMatchItem = (id: number, downloadId?: string) =>
  item({
    queueItemId: id,
    downloadId: downloadId ?? `dl-${id}`,
    status: 'completed',
    trackedDownloadStatus: 'warning',
    trackedDownloadState: 'importFailed',
    statusMessages: [
      { title: 'One or more tracks expected in this release were not imported or missing from the release', messages: [] },
      { title: '01 - Opening.flac', messages: [MANUAL_MATCH_TEXT, 'Has missing tracks'] },
    ],
  });

interface InstanceStub {
  client: QueueCleanupInstanceClient;
  calls: {
    deletes: Array<{ id: number; removeFromClient: boolean; blocklist: boolean; skipRedownload: boolean }>;
    processMonitored: number;
    /** Queue ids of every searched record, flattened across calls. */
    searches: number[];
    /** One entry per search command: the queue ids it covered. */
    searchCalls: number[][];
    monitoredChecks: number;
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
  } = {},
): InstanceStub {
  const calls: InstanceStub['calls'] = {
    deletes: [],
    processMonitored: 0,
    searches: [],
    searchCalls: [],
    monitoredChecks: 0,
  };
  const removed = new Set<string>();
  const notFound = (id: number) =>
    new ArrHttpError(404, 'DELETE', `http://arr.test/api/v3/queue/${id}`);
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

  it('REPORT ONLY (D-12): manual_match is never acted on, even with every Lidarr cell enforced', async () => {
    const cfg = clone();
    cfg.modes.lidarr = { have_better: 'enforce', retry_import: 'enforce', bad_release: 'enforce' };
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
