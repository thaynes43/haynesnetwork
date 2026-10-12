// ADR-109 C-05 / DESIGN-055 D-01, D-07 (PLAN-077 P2) — the queue-aware Force Search step's pure rules
// (lib/force-search-guide.ts): which presses read the queue first, the words for each plan state and each Import Check
// reason, the confirm and "gone afterwards" wording, the outcome lines, and the staff ticket's text. The copy rules are
// checked over every string the module can produce: no em-dashes, no time-grounding.
import { describe, expect, it } from 'vitest';
import { MEDIA_ACTIONS } from '@hnet/ui';
import {
  arrMessages,
  confirmText,
  defectText,
  downloadStatusText,
  fileFacts,
  importTargetLabels,
  joinLabels,
  outcomeSearched,
  outcomeText,
  progressDetail,
  progressPercent,
  readsQueueFirst,
  removalGoneLine,
  replacedGoneLine,
  staffText,
  staffTicketText,
  stepHeading,
  timeLeftText,
  titleEvidenceText,
  type ImportCheckReasonCode,
  type SearchPlan,
  type SearchPlanCheck,
} from '../force-search-guide';

const EPISODE = { scope: 'episode' as const, childId: 50110, label: 'S01E10 · Chapter 10' };
const PAPER_FILE = 'The_Paper_2025_S02E06_125_Years_Young_2160p_PCOK_WEB-DL_DDP5_1_Atmos_DV_HDR_H_265-FLUX.mkv';

function check(o: Partial<SearchPlanCheck> = {}): SearchPlanCheck {
  return {
    verdict: 'importable',
    reason: 'ok',
    detail: null,
    file: {
      fileName: PAPER_FILE,
      sizeBytes: 6_442_450_944,
      qualityName: 'WEBDL-2160p',
      languages: ['English'],
      releaseGroup: 'FLUX',
      targetIds: [85215],
    },
    title: { verdict: 'agrees', bestEpisodeId: 85215, bestScore: 1, againstScore: 1, conflictingYear: null },
    ...o,
  };
}

function plan(o: Partial<SearchPlan> = {}): SearchPlan {
  return {
    queueAware: true,
    state: 'import',
    targetLabel: 'S02E06 · 125 Years Young',
    download: {
      downloadId: 'SABnzbd_nzo_paper',
      title: 'The.Paper.2025.S02E06.2160p.PCOK.WEB-DL.DDP5.1.Atmos.DV.HDR.H.265-FLUX',
      status: 'completed',
      trackedState: 'importBlocked',
      progress: 1,
      timeLeft: null,
      messages: ['Episodes 2x07, 2x08, 2x09, 2x10 were unexpected considering the The_Paper_2025 folder name'],
    },
    check: check(),
    ontoChoices: [],
    replaces: [],
    removeWhy: null,
    digest: 'abc123abc123abc123abc123',
    ...o,
  };
}

const ALL_REASONS: ImportCheckReasonCode[] = [
  'ok',
  'archive',
  'no_files',
  'only_sample',
  'defect',
  'have_better',
  'temporary',
  'rejected',
  'no_mapping',
  'other_series',
  'no_file_for_target',
  'several_files',
  'missing_quality',
  'mapping_conflict',
  'uncovered_targets',
  'title_disagrees',
  'title_ambiguous',
  'year_conflict',
];

describe('readsQueueFirst: which presses read the queue (the client mirror of queueAwareEligible)', () => {
  it('one episode or the movie, only with the import_check remedy on', () => {
    expect(readsQueueFirst({ arrKind: 'sonarr', target: EPISODE, importCheckOn: true })).toBe(true);
    expect(readsQueueFirst({ arrKind: 'radarr', target: null, importCheckOn: true })).toBe(true);
    expect(readsQueueFirst({ arrKind: 'radarr', target: { scope: 'item', label: 'Stub Runner' }, importCheckOn: true })).toBe(true);
    expect(readsQueueFirst({ arrKind: 'sonarr', target: EPISODE, importCheckOn: false })).toBe(false);
    expect(readsQueueFirst({ arrKind: 'radarr', target: null, importCheckOn: false })).toBe(false);
  });

  it('a season, a whole show, an album or music keep today search-only dialog', () => {
    expect(readsQueueFirst({ arrKind: 'sonarr', target: { scope: 'season', seasonNumber: 2, label: 'Season 2' }, importCheckOn: true })).toBe(false);
    expect(readsQueueFirst({ arrKind: 'sonarr', target: { scope: 'show', label: 'Whole show' }, importCheckOn: true })).toBe(false);
    expect(readsQueueFirst({ arrKind: 'sonarr', target: null, importCheckOn: true })).toBe(false);
    expect(readsQueueFirst({ arrKind: 'lidarr', target: { scope: 'album', childId: 1, label: 'An album' }, importCheckOn: true })).toBe(false);
  });
});

describe('the download on its way', () => {
  it('says where the download is in plain words', () => {
    expect(downloadStatusText({ status: 'downloading', trackedState: 'downloading' })).toBe('Downloading');
    expect(downloadStatusText({ status: 'queued', trackedState: 'downloading' })).toBe('Waiting its turn in the download queue');
    expect(downloadStatusText({ status: 'delay', trackedState: null })).toBe('Waiting a little while in case a better release turns up');
    expect(downloadStatusText({ status: 'completed', trackedState: 'importing' })).toBe('Downloaded and being added to the library');
    expect(downloadStatusText({ status: null, trackedState: null })).toBe('In the download queue');
  });

  it('reads the *arr timeleft roughly, and the progress as a whole percent', () => {
    expect(timeLeftText('00:12:20')).toBe('about 12 minutes left');
    expect(timeLeftText('02:31:00')).toBe('about 3 hours left');
    expect(timeLeftText('1.04:00:00')).toBe('about 1 day left');
    expect(timeLeftText('00:00:40')).toBe('less than a minute left');
    expect(timeLeftText('00:00:00')).toBeNull();
    expect(timeLeftText('soon')).toBeNull();
    expect(timeLeftText(null)).toBeNull();
    expect(progressPercent(0.454)).toBe(45);
    expect(progressPercent(null)).toBeNull();
    expect(progressDetail({ progress: 0.45, timeLeft: '00:12:00' })).toBe('45% · about 12 minutes left');
    expect(progressDetail({ progress: null, timeLeft: null })).toBe('');
  });
});

describe('what it found: the evidence', () => {
  it('lists the file facts the Import Check judged, each one labelled', () => {
    expect(fileFacts(check().file)).toEqual([
      { label: 'File', value: PAPER_FILE },
      { label: 'Size', value: '6.0 GB' },
      { label: 'Quality', value: 'WEBDL-2160p' },
      { label: 'Audio', value: 'English' },
      { label: 'Release group', value: 'FLUX' },
    ]);
    expect(fileFacts(null)).toEqual([]);
  });

  it('keeps the *arr words, without the lines that only name the file or the download', () => {
    const d = plan().download!;
    const withFile = { ...d, messages: [PAPER_FILE, ...d.messages, d.title!, 'Some.Release/file.part1.rar'] };
    expect(arrMessages(withFile, check())).toEqual(d.messages);
    expect(arrMessages(null, null)).toEqual([]);
  });

  it('says what the file name says about the title: agrees or silent, never a mismatch', () => {
    expect(titleEvidenceText(check(), 'sonarr')).toBe('The file name matches the episode title');
    expect(titleEvidenceText(check({ title: { verdict: 'silent', bestEpisodeId: null, bestScore: null, againstScore: null, conflictingYear: null } }), 'sonarr')).toBe(
      'The file name carries no episode title',
    );
    expect(titleEvidenceText(check(), 'radarr')).toBe('The file name matches the movie title');
    expect(titleEvidenceText(check({ title: null }), 'sonarr')).toBeNull();
  });

  it('names every episode a multi-episode file lands on, the target first', () => {
    const labels: Record<number, string> = { 11: 'S01E11 · Two', 12: 'S01E12 · Three' };
    expect(importTargetLabels([10], { id: 10, label: 'S01E10 · One' }, () => null)).toEqual(['S01E10 · One']);
    expect(importTargetLabels([12, 10, 11], { id: 10, label: 'S01E10 · One' }, (id) => labels[id] ?? null)).toEqual([
      'S01E10 · One',
      'S01E12 · Three',
      'S01E11 · Two',
    ]);
    expect(importTargetLabels([10, 99], { id: 10, label: 'S01E10 · One' }, () => null)).toEqual(['S01E10 · One', 'another episode']);
    expect(joinLabels(['A', 'B', 'C'])).toBe('A, B and C');
    expect(joinLabels(['A'])).toBe('A');
  });
});

describe('the step for each state (D-07)', () => {
  const t = 'S02E06 · 125 Years Young';
  it('heads each step with what it found', () => {
    expect(stepHeading(plan({ state: 'search' }), t, null)).toBe(`Nothing for ${t} is in the download queue.`);
    expect(stepHeading(plan({ state: 'on_its_way' }), t, null)).toBe('Already on its way');
    expect(stepHeading(plan({ state: 'import' }), t, null)).toBe(`A finished download for ${t} is waiting to be added`);
    expect(stepHeading(plan({ state: 'import_onto' }), t, 'S02E07 · Dueling Pencils')).toBe(
      "This download's name says it is S02E07 · Dueling Pencils",
    );
    expect(stepHeading(plan({ state: 'remove_and_search', removeWhy: 'failed' }), t, null)).toBe(`The last download for ${t} failed.`);
    expect(stepHeading(plan({ state: 'remove_and_search', removeWhy: 'defect' }), t, null)).toBe(`The download for ${t} is broken.`);
  });

  it('names the confirm after the action; "Import it" is the registry verb', () => {
    expect(confirmText('import', null)).toBe(MEDIA_ACTIONS.importDownload.label);
    expect(confirmText('import', null)).toBe('Import it');
    expect(confirmText('import_onto', 'S02E07 · Dueling Pencils')).toBe('Import onto S02E07 · Dueling Pencils');
    expect(confirmText('remove_and_search', null)).toBe('Remove it and search again');
    expect(confirmText('search', null)).toBe('Force search');
    expect(confirmText('on_its_way', null)).toBeNull();
    expect(confirmText('staff', null)).toBeNull();
  });

  it('a file the import replaces is named as gone, with its quality and size (D-01 preview contract)', () => {
    expect(
      replacedGoneLine({ label: 'S01E03 · Episode 3', qualityName: 'Bluray-1080p', sizeBytes: 829_771_748 }),
    ).toMatch(/^The current file of S01E03 · Episode 3 \(Bluray-1080p, [\d.]+ MB\), which this download replaces$/);
    expect(replacedGoneLine({ label: 'GoodFellas', qualityName: null, sizeBytes: null })).toBe(
      'The current file of GoodFellas, which this download replaces',
    );
  });

  it('the removal line names the release it blocks', () => {
    expect(removalGoneLine(plan().download)).toBe(
      'Remove The.Paper.2025.S02E06.2160p.PCOK.WEB-DL.DDP5.1.Atmos.DV.HDR.H.265-FLUX and block that release so it is not downloaded again',
    );
    expect(removalGoneLine(null)).toBe('Remove this download and block that release so it is not downloaded again');
  });

  it('puts a release defect in plain words, with the *arr text as the fallback', () => {
    expect(defectText('Sample', 'sonarr')).toBe('It is only a short sample, not the episode.');
    expect(defectText('Unable to parse file', 'radarr')).toBe('Radarr cannot read its file name.');
    expect(defectText('Password protected archive', 'sonarr')).toBe('It is locked with a password.');
    expect(defectText('Something odd', 'sonarr')).toBe('Sonarr says: “Something odd”');
    expect(defectText(null, 'sonarr')).toBeNull();
  });
});

describe('the staff path: one sentence per Import Check reason', () => {
  const t = 'S02E06 · 125 Years Young';
  it('the archive and the name mismatches use the D-07 words', () => {
    expect(staffText({ check: check({ reason: 'archive' }), targetLabel: t, kind: 'sonarr' })).toBe(
      'This download has to be unpacked before it can be added, and that needs staff for now.',
    );
    for (const reason of ['title_ambiguous', 'mapping_conflict', 'title_disagrees'] as const) {
      expect(staffText({ check: check({ reason }), targetLabel: t, kind: 'sonarr' })).toBe(
        `This download's name does not match ${t}, so it will not be added automatically.`,
      );
    }
    const year = check({
      reason: 'year_conflict',
      title: { verdict: 'agrees', bestEpisodeId: null, bestScore: null, againstScore: null, conflictingYear: 1991 },
    });
    expect(staffText({ check: year, targetLabel: t, kind: 'sonarr' })).toBe(
      `This download's name does not match ${t}, so it will not be added automatically. It names a show from 1991.`,
    );
    expect(staffText({ check: check({ reason: 'rejected', detail: 'Not enough free space' }), targetLabel: t, kind: 'radarr' })).toBe(
      'Radarr turned this download down: “Not enough free space”',
    );
  });

  it('every reason has a sentence, and none breaks the copy rules', () => {
    for (const reason of ALL_REASONS) {
      const text = staffText({ check: check({ reason, detail: 'detail' }), targetLabel: t, kind: 'sonarr' });
      expect(text.length, reason).toBeGreaterThan(10);
      expect(text, reason).not.toMatch(/—|\btoday\b|\byesterday\b|\btomorrow\b|Kubernetes/i);
    }
    expect(staffText({ check: null, targetLabel: t, kind: 'sonarr' })).toBe(
      `A download for ${t} is stuck in the queue, and it cannot be added on its own.`,
    );
  });
});

describe('the outcome line (D-07)', () => {
  const t = 'S02E06 · 125 Years Young';
  it('says what happened in plain words', () => {
    expect(outcomeText({ outcome: 'imported', removeWhy: null, targetLabel: t })).toBe('Found a finished download and imported it.');
    expect(outcomeText({ outcome: 'importing', removeWhy: null, targetLabel: t })).toBe(
      `Found a finished download and started the import. ${t} shows up here when it finishes.`,
    );
    expect(outcomeText({ outcome: 'removed_and_searched', removeWhy: 'failed', targetLabel: t })).toBe(
      'Removed a failed download and searched again.',
    );
    expect(outcomeText({ outcome: 'removed_and_searched', removeWhy: 'defect', targetLabel: t })).toBe(
      'Removed a bad download and searched again.',
    );
    expect(outcomeText({ outcome: 'on_its_way', removeWhy: null, targetLabel: t })).toBe('Already on its way.');
    expect(outcomeText({ outcome: 'searched', removeWhy: null, targetLabel: t })).toContain('search is running');
  });

  it('only a search hands over to the live progress view', () => {
    expect(outcomeSearched('searched')).toBe(true);
    expect(outcomeSearched('removed_and_searched')).toBe(true);
    expect(outcomeSearched('imported')).toBe(false);
    expect(outcomeSearched('importing')).toBe(false);
    expect(outcomeSearched('on_its_way')).toBe(false);
  });
});

describe('the staff ticket text', () => {
  it('says what Force Search found, with the download, the file and the *arr words', () => {
    const text = staffTicketText({
      plan: plan({ state: 'staff', check: check({ reason: 'archive', verdict: 'archive' }) }),
      targetLabel: 'S02E06 · 125 Years Young',
      kind: 'sonarr',
      reasonLine: 'This download has to be unpacked before it can be added, and that needs staff for now.',
    });
    expect(text.subject).toBe('Stuck download: S02E06 · 125 Years Young');
    expect(text.note.split('\n')).toEqual([
      'Force Search found a download for S02E06 · 125 Years Young that it could not add on its own.',
      '',
      'This download has to be unpacked before it can be added, and that needs staff for now.',
      '',
      'Download: The.Paper.2025.S02E06.2160p.PCOK.WEB-DL.DDP5.1.Atmos.DV.HDR.H.265-FLUX',
      `File: ${PAPER_FILE}`,
      'Sonarr says: Episodes 2x07, 2x08, 2x09, 2x10 were unexpected considering the The_Paper_2025 folder name',
    ]);
  });
});
