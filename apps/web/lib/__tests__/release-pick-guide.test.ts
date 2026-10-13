// ADR-109 C-06 / DESIGN-055 D-01, D-06 (PLAN-077 P5): the Release Pick step's pure rules (lib/release-pick-guide.ts):
// where "See every release" is offered, one row in plain words (facts, the name's evidence, the reasons and their tone,
// the *arr's own words), the list's order and lead, the budget, the confirm's preview lines, the outcomes and what comes
// after a grab, and the staff ticket. The copy rules are checked over every string the module can produce: no
// em-dashes, no time-grounding, no guid or URL as the explanation.
import { describe, expect, it } from 'vitest';
import { MEDIA_ACTIONS } from '@hnet/ui';
import {
  ASK_STAFF_TAIL,
  BLOCKED_NOTE,
  CONFIRM_HEADING,
  CONFIRM_LABEL,
  EVERY_SITE_REFUSED_TEXT,
  NOTHING_TO_PICK_NOTE,
  PICK_ENTRY_NOTE,
  PICK_ENTRY_SHORT_NOTE,
  SEARCHING_NOTE,
  SITE_REFUSED_TEXT,
  STALE_NOTE,
  TRY_ANOTHER_SITE_NOTE,
  arrWords,
  arrWordsLabel,
  askStaffTicket,
  bestChoiceWhy,
  blockedSummary,
  budgetAfter,
  budgetText,
  confirmPlan,
  displayReasons,
  evidenceText,
  grabOutcomeText,
  listLead,
  listSections,
  nextKey,
  offersReleasePick,
  reasonTone,
  resultFollowUp,
  rowFacts,
  rowStateTag,
  searchingText,
  siteName,
  sizeText,
  statusStepText,
  type ReleaseGrabOutcome,
  type ReleaseList,
  type ReleaseRow,
} from '../release-pick-guide';

const SPICE = 'S01E11 · Spice It Up';
const GB = 1024 ** 3;

function row(o: Partial<ReleaseRow> = {}): ReleaseRow {
  return {
    key: 'a1a1a1a1a1a1a1a1',
    keys: ['a1a1a1a1a1a1a1a1'],
    title: 'Regular.Show.The.Lost.Tapes.S01E11.Spice.It.Up.1080p.WEB-DL.DDP5.1.H.264-GOOD',
    sizeBytes: 1.4 * GB,
    qualityName: 'WEBDL-1080p',
    qualityPlain: '1080p',
    languages: ['English'],
    customFormatScore: 0,
    ageHours: 30,
    indexer: 'NZBgeek (Prowlarr)',
    protocol: 'usenet',
    releaseGroup: 'GOOD',
    state: 'grab',
    reasons: [],
    evidence: { verdict: 'agrees', namedLabel: null },
    numberedAs: null,
    recommended: false,
    ...o,
  };
}

const SCORE = {
  code: 'score_below_minimum' as const,
  class: 'overridable' as const,
  text: 'Lower quality than the library usually keeps',
  arrText: 'Custom Formats HMAX, x265 (HD) have score -9925 below Series profile minimum 0',
};
const NOT_WANTED = {
  code: 'quality_not_wanted' as const,
  class: 'overridable' as const,
  text: 'Not a quality the library usually keeps (720p)',
  arrText: 'WEBDL-720p is not wanted in profile',
};
const BLOCKLISTED = {
  code: 'blocklisted' as const,
  class: 'hard' as const,
  text: 'Blocked after an earlier download of it failed or was removed',
  arrText: 'Release is blocklisted',
};
const NUMBERED = {
  code: 'numbered_other_episode' as const,
  class: 'overridable' as const,
  text: 'Numbered as S01E10, but its title is this episode’s',
  arrText: null,
};
const PACK = { code: 'pack' as const, class: 'other' as const, text: 'Holds more than this one episode', arrText: null };

// Case A's Spice It Up: no approved release; OldT's release numbered for E10 whose title is E11 (the hand fix), a 720p
// one, a blocklisted BiOMA pack.
const OLDT = row({
  key: 'b3b3b3b3b3b3b3b3',
  keys: ['b3b3b3b3b3b3b3b3'],
  title: 'Regular.Show.The.Lost.Tapes.S01E10.Spice.It.Up.1080p.HMAX.WEB-DL.DDP5.1.H.265-OldT',
  state: 'override',
  reasons: [SCORE, NUMBERED],
  evidence: { verdict: 'agrees', namedLabel: SPICE },
  numberedAs: 'S01E10 · Chapter 10',
  customFormatScore: -9925,
  recommended: true,
});
const WVF = row({
  key: 'b2b2b2b2b2b2b2b2',
  keys: ['b2b2b2b2b2b2b2b2', 'c2c2c2c2c2c2c2c2'],
  title: 'Regular.Show.The.Lost.Tapes.S01E11.720p.WEB.h264-WvF',
  qualityName: 'WEBDL-720p',
  qualityPlain: '720p',
  sizeBytes: 0.6 * GB,
  state: 'override',
  reasons: [NOT_WANTED],
  evidence: { verdict: 'silent', namedLabel: null },
});
const BIOMA = row({
  key: 'b4b4b4b4b4b4b4b4',
  keys: ['b4b4b4b4b4b4b4b4'],
  title: 'Regular.Show.The.Lost.Tapes.S01.1080p.WEB-DL-BiOMA',
  state: 'not_allowed',
  reasons: [BLOCKLISTED, PACK],
  evidence: null,
});

function list(rows: ReleaseRow[], o: Partial<ReleaseList> = {}): ReleaseList {
  return {
    status: 'list',
    kind: 'sonarr',
    targetLabel: SPICE,
    listId: '11111111-1111-4111-8111-111111111111',
    searchedAt: '2026-10-13T12:00:00.000Z',
    rows,
    recommendedKey: rows.find((r) => r.recommended)?.key ?? null,
    counts: { grab: 0, override: 0, notAllowed: 0, sources: rows.length, dropped: 0 },
    budget: { limit: 10, used: 3, left: 7 },
    canPick: true,
    download: null,
    reasonsVersion: 1,
    ...o,
  };
}

const COPY_BREAKS = /—|\btoday\b|\byesterday\b|\btomorrow\b|\brecently\b|right now|Kubernetes|https?:\/\//i;

describe('where "See every release" is offered', () => {
  it('one episode or the movie, with the remedy on; never a season, a whole show or music', () => {
    const episode = { scope: 'episode' as const, childId: 50505, label: SPICE };
    expect(offersReleasePick({ arrKind: 'sonarr', target: episode, releasePickOn: true })).toBe(true);
    expect(offersReleasePick({ arrKind: 'sonarr', target: episode, releasePickOn: false })).toBe(false);
    expect(offersReleasePick({ arrKind: 'sonarr', target: { scope: 'season', seasonNumber: 1, label: 'Season 1' }, releasePickOn: true })).toBe(false);
    expect(offersReleasePick({ arrKind: 'sonarr', target: null, releasePickOn: true })).toBe(false);
    expect(offersReleasePick({ arrKind: 'radarr', target: null, releasePickOn: true })).toBe(true);
    expect(offersReleasePick({ arrKind: 'radarr', target: { scope: 'item', label: 'A Movie' }, releasePickOn: true })).toBe(true);
    expect(offersReleasePick({ arrKind: 'lidarr', target: null, releasePickOn: true })).toBe(false);
  });

  it('says what it lists and what it costs before anyone presses it', () => {
    expect(PICK_ENTRY_NOTE).toContain('including ones the library would not normally take');
    expect(PICK_ENTRY_NOTE).toContain('one hourly media action');
    expect(PICK_ENTRY_SHORT_NOTE).toContain('one hourly media action');
  });
});

describe('one row in plain words', () => {
  it('shows the site without the indexer manager suffix', () => {
    expect(siteName('NZBgeek (Prowlarr)')).toBe('NZBgeek');
    expect(siteName('TorrentLeech')).toBe('TorrentLeech');
    expect(siteName(' (Prowlarr)')).toBeNull();
    expect(siteName(null)).toBeNull();
  });

  it('gives the size in GB, a small one in MB, and nothing when unknown', () => {
    expect(sizeText(1.4 * GB)).toBe('1.4 GB');
    expect(sizeText(14.2 * GB)).toBe('14 GB');
    expect(sizeText(40 * 1024 ** 2)).toBe('40 MB');
    expect(sizeText(null)).toBeNull();
    expect(sizeText(0)).toBeNull();
  });

  it('lists quality, size, languages, site and how many sites have it', () => {
    expect(rowFacts(WVF)).toEqual(['720p', '0.6 GB', 'English', 'NZBgeek', 'found on 2 sites']);
    expect(rowFacts(row({ sizeBytes: null, languages: [], indexer: null }))).toEqual(['1080p']);
  });

  it('puts the name evidence in words, and the numbered-as line once', () => {
    expect(evidenceText(OLDT, 'sonarr')).toEqual({
      text: 'Numbered as S01E10, but its title is this episode’s',
      tone: 'good',
    });
    expect(displayReasons(OLDT).map((r) => r.code)).toEqual(['score_below_minimum']);
    expect(evidenceText(row(), 'sonarr')).toEqual({ text: 'Its name matches this episode', tone: 'good' });
    expect(evidenceText(row(), 'radarr')).toEqual({ text: 'Its name matches this movie', tone: 'good' });
    expect(evidenceText(WVF, 'sonarr')).toEqual({ text: 'Its name gives no episode title', tone: 'quiet' });
    expect(evidenceText(row({ evidence: { verdict: 'silent', namedLabel: null } }), 'radarr')).toBeNull();
    expect(evidenceText(row({ evidence: { verdict: 'ambiguous', namedLabel: null } }), 'sonarr')?.tone).toBe('quiet');
    // A name that says it is another episode is the hard reason's line, in the alert tone, not the badge's.
    expect(evidenceText(row({ evidence: { verdict: 'disagrees', namedLabel: 'S01E02 · X' } }), 'sonarr')).toBeNull();
    expect(evidenceText(BIOMA, 'sonarr')).toBeNull();
  });

  it('colours a hard reason as an alert, a blocking one as a warning, an overridable one neutral', () => {
    expect(reasonTone(BLOCKLISTED)).toBe('hard');
    expect(reasonTone(PACK)).toBe('blocks');
    expect(reasonTone(SCORE)).toBe('neutral');
  });

  it('keeps the *arr words (and the score) under their own disclosure, each once', () => {
    expect(arrWordsLabel('sonarr')).toBe('What Sonarr says');
    expect(arrWordsLabel('radarr')).toBe('What Radarr says');
    expect(arrWords(OLDT)).toEqual([SCORE.arrText, 'Custom format score: -9925']);
    expect(arrWords(row({ reasons: [SCORE, SCORE], customFormatScore: 0 }))).toEqual([SCORE.arrText]);
    expect(arrWords(row())).toEqual([]);
  });

  it('tags each row by what it allows', () => {
    expect(rowStateTag(row())).toBe('Fits the library’s rules');
    expect(rowStateTag(WVF)).toBe('Outside the usual rules');
    expect(rowStateTag(BIOMA)).toBe('Can’t be picked');
  });

  it('says why the best choice is best, in one line', () => {
    expect(bestChoiceWhy(row(), 'sonarr')).toBe(
      'It’s the one the library would pick on its own, and its name matches this episode.',
    );
    expect(bestChoiceWhy(row({ evidence: { verdict: 'silent', namedLabel: null } }), 'sonarr')).toBe(
      'It’s the one the library would pick on its own.',
    );
    expect(bestChoiceWhy(OLDT, 'sonarr')).toBe(
      'The closest to what the library usually keeps, and its title is this episode’s.',
    );
    expect(bestChoiceWhy(WVF, 'sonarr')).toBe('The closest to what the library usually keeps.');
    expect(bestChoiceWhy({ ...WVF, evidence: { verdict: 'agrees', namedLabel: null } }, 'radarr')).toBe(
      'The closest to what the library usually keeps, and its name matches this movie.',
    );
  });
});

describe('the list', () => {
  it('puts the recommended row first, then the others the person can pick, then the ones nobody can', () => {
    const s = listSections(list([WVF, OLDT, BIOMA]));
    expect(s.best?.key).toBe(OLDT.key);
    expect(s.others.map((r) => r.key)).toEqual([WVF.key]);
    expect(s.blocked.map((r) => r.key)).toEqual([BIOMA.key]);
  });

  it('never makes a row nobody can pick the best choice', () => {
    const s = listSections(list([BIOMA, WVF], { recommendedKey: BIOMA.key }));
    expect(s.best).toBeNull();
    expect(s.others).toHaveLength(1);
  });

  it('leads with how many releases there are and how many can be picked', () => {
    expect(listLead(listSections(list([WVF, OLDT, BIOMA])), SPICE)).toBe(
      `Found 3 releases of ${SPICE}. You can pick 2 of them.`,
    );
    expect(listLead(listSections(list([OLDT])), SPICE)).toBe(`Found 1 release of ${SPICE}. You can pick it.`);
    expect(listLead(listSections(list([OLDT, WVF])), SPICE)).toBe(`Found 2 releases of ${SPICE}. You can pick any of them.`);
    expect(listLead(listSections(list([BIOMA])), SPICE)).toBe(
      `The sites have 1 release of ${SPICE}, but none of them can be picked.`,
    );
    expect(listLead(listSections(list([])), SPICE)).toBe(`No site has a release of ${SPICE}.`);
  });

  it('counts the closed list in its summary', () => {
    expect(blockedSummary(3)).toBe('Releases you can’t pick (3)');
  });
});

describe('the hourly budget', () => {
  it('says what is left, and why picking is paused when nothing is', () => {
    expect(budgetText({ limit: 10, left: 7 }, true)).toBe('Picking a release uses one hourly media action. You have 7 left.');
    expect(budgetText({ limit: null, left: null }, true)).toBeNull();
    expect(budgetText({ limit: 10, left: 0 }, false)).toBe(
      'You have used all your hourly media actions, so picking is paused. Give it a little while and try again.',
    );
    expect(budgetText({ limit: 0, left: 0 }, false)).toContain('turned off for your role');
  });

  it('counts each grab press made from the list, and never limits someone with no limit', () => {
    expect(budgetAfter({ limit: 5, used: 3, left: 2 }, 1)).toEqual({ limit: 5, used: 4, left: 1, canPick: true });
    expect(budgetAfter({ limit: 5, used: 3, left: 2 }, 2)).toEqual({ limit: 5, used: 5, left: 0, canPick: false });
    expect(budgetAfter({ limit: null, used: 0, left: null }, 9).canPick).toBe(true);
  });
});

describe('the confirm (D-01 preview contract)', () => {
  it('names the button with the registry verb', () => {
    expect(CONFIRM_LABEL).toBe(MEDIA_ACTIONS.grabRelease.label);
    expect(CONFIRM_LABEL).toBe('Grab this release');
    expect(CONFIRM_HEADING).toBe('Grab this release?');
  });

  it('an approved release: download it for the target, nothing deleted or blocked, one hourly action', () => {
    expect(confirmPlan(row(), { kind: 'sonarr', targetLabel: SPICE, limited: true })).toEqual([
      { text: `Download this release for ${SPICE}.`, sub: [] },
      { text: 'Nothing is deleted or blocked.', sub: [] },
      { text: 'It uses one of your hourly media actions.', sub: [] },
    ]);
    expect(confirmPlan(row(), { kind: 'radarr', targetLabel: 'A Movie', limited: false })).toHaveLength(2);
  });

  it('an override: says plainly it is outside the usual rules, and which ones', () => {
    const lines = confirmPlan(WVF, { kind: 'sonarr', targetLabel: SPICE, limited: true });
    expect(lines[1]).toEqual({
      text: 'It is outside the library’s usual rules, so the library would not take it on its own. Grabbing it makes an exception for this one episode.',
      sub: ['Not a quality the library usually keeps (720p)'],
    });
    expect(lines.map((l) => l.text)).toContain('Nothing is deleted or blocked.');
  });

  it('a release numbered for another episode: the app adds it to the right one, and Force Search if it gets stuck', () => {
    const lines = confirmPlan(OLDT, { kind: 'sonarr', targetLabel: SPICE, limited: false });
    expect(lines[1]!.sub).toEqual(['Lower quality than the library usually keeps']);
    expect(lines[2]!.text).toBe(
      `Its name numbers it as S01E10, so once it arrives the app adds it to ${SPICE}. If it gets stuck on the way, Force Search on this episode adds it.`,
    );
  });
});

describe('after the press', () => {
  it('says what each outcome means', () => {
    expect(grabOutcomeText({ outcome: 'grabbed', targetLabel: SPICE, override: false })).toBe(`Grabbed it for ${SPICE}.`);
    expect(grabOutcomeText({ outcome: 'grabbed', targetLabel: SPICE, override: true })).toBe(
      `Grabbed it for ${SPICE}, as an exception to the library’s usual rules.`,
    );
    expect(grabOutcomeText({ outcome: 'grab_failed', targetLabel: SPICE, override: false })).toBe(SITE_REFUSED_TEXT);
    expect(grabOutcomeText({ outcome: 'unsure', targetLabel: SPICE, override: false })).toMatch(/isn’t certain .* went through/);
    expect(grabOutcomeText({ outcome: 'list_stale', targetLabel: SPICE, override: false })).toBe(
      'This list is out of date, so nothing was grabbed.',
    );
    expect(grabOutcomeText({ outcome: 'has_file', targetLabel: SPICE, override: false })).toBe(
      `${SPICE} has a file, so nothing was grabbed.`,
    );
    expect(grabOutcomeText({ outcome: 'on_its_way', targetLabel: SPICE, override: false })).toContain('already downloading');
    expect(grabOutcomeText({ outcome: 'not_allowed', targetLabel: SPICE, override: false })).toContain('ask staff');
  });

  it('tries the sites a release was found on in order, skipping the ones that refused', () => {
    expect(nextKey(WVF, [])).toBe('b2b2b2b2b2b2b2b2');
    expect(nextKey(WVF, ['b2b2b2b2b2b2b2b2'])).toBe('c2c2c2c2c2c2c2c2');
    expect(nextKey(WVF, ['b2b2b2b2b2b2b2b2', 'c2c2c2c2c2c2c2c2'])).toBeNull();
  });

  it('follows the live phase: another pick after a failure, Force Search when it needs a hand, done when added', () => {
    const ctx = { kind: 'sonarr' as const, targetLabel: SPICE };
    expect(resultFollowUp('failed', ctx)).toMatchObject({ next: 'pick_again', tone: 'alert' });
    expect(resultFollowUp('failed', ctx).text).toContain('blocked and won’t be tried again');
    expect(resultFollowUp('failed', ctx).text).toContain('one more hourly media action');
    expect(resultFollowUp('nothing_found', ctx).next).toBe('pick_again');
    expect(resultFollowUp('stalled', ctx)).toMatchObject({
      text: 'It finished downloading but needs a hand to be added. Force Search on this episode checks the download and adds it.',
      next: 'force_search',
    });
    expect(resultFollowUp('completed', ctx)).toEqual({ text: `Added to ${SPICE}.`, next: null, tone: 'done' });
    expect(resultFollowUp('downloading', ctx).next).toBeNull();
    expect(resultFollowUp(null, ctx).next).toBeNull();
  });

  it('a list with nothing to show costs nothing and says why', () => {
    expect(statusStepText('has_file', SPICE).heading).toBe(`${SPICE} already has a file`);
    expect(statusStepText('on_its_way', SPICE).heading).toBe('Already on its way');
    expect(statusStepText('on_its_way', SPICE).body).toContain('is in the queue');
    // A pick still open with nothing in the queue: its download is being added, or failed unrecorded.
    expect(statusStepText('on_its_way', SPICE, false).body).toContain(
      `A release picked for ${SPICE} is still on its way or being added`,
    );
    expect(statusStepText('queue_stuck', SPICE).body).toContain('Force Search');
    for (const s of ['has_file', 'on_its_way', 'queue_stuck'] as const) {
      expect(statusStepText(s, SPICE).body).toContain('no hourly media action was used');
    }
  });
});

describe('Ask staff', () => {
  it('prefills a ticket naming the target, the release, the site and why it cannot be picked', () => {
    const t = askStaffTicket({ row: BIOMA, targetLabel: SPICE, kind: 'sonarr' });
    expect(t.subject).toBe(`Release for ${SPICE}: ${BIOMA.title}`);
    expect(t.note.split('\n')).toEqual([
      `The release list for ${SPICE} found a release that can’t be picked from the app.`,
      '',
      `Release: ${BIOMA.title}`,
      'Found on: NZBgeek',
      '',
      'Why it can’t be picked:',
      `- ${BLOCKLISTED.text}`,
      `- ${PACK.text}`,
      'Sonarr says: Release is blocklisted',
    ]);
  });

  it('a list with nothing to pick still opens a ticket for the target', () => {
    const t = askStaffTicket({ row: null, targetLabel: SPICE, kind: 'sonarr' });
    expect(t.subject).toBe(`No release to pick for ${SPICE}`);
    expect(t.note).toContain(SPICE);
  });
});

describe('the copy rules', () => {
  it('no string the module can produce breaks them', () => {
    const ctx = { kind: 'sonarr' as const, targetLabel: SPICE };
    const outcomes: ReleaseGrabOutcome[] = ['grabbed', 'list_stale', 'grab_failed', 'has_file', 'on_its_way', 'not_allowed'];
    const strings: string[] = [
      PICK_ENTRY_NOTE,
      PICK_ENTRY_SHORT_NOTE,
      SEARCHING_NOTE,
      searchingText(SPICE),
      BLOCKED_NOTE,
      NOTHING_TO_PICK_NOTE,
      ASK_STAFF_TAIL,
      STALE_NOTE,
      TRY_ANOTHER_SITE_NOTE,
      EVERY_SITE_REFUSED_TEXT,
      CONFIRM_HEADING,
      ...(['has_file', 'on_its_way', 'queue_stuck'] as const).flatMap((s) => [
        ...Object.values(statusStepText(s, SPICE)),
        ...Object.values(statusStepText(s, SPICE, false)),
      ]),
      ...[OLDT, WVF, BIOMA, row()].flatMap((r) => [
        bestChoiceWhy(r, 'sonarr'),
        bestChoiceWhy(r, 'radarr'),
        rowStateTag(r),
        evidenceText(r, 'sonarr')?.text ?? '',
        ...confirmPlan(r, { ...ctx, limited: true }).flatMap((l) => [l.text, ...l.sub]),
      ]),
      ...outcomes.flatMap((o) => [
        grabOutcomeText({ outcome: o, targetLabel: SPICE, override: false }),
        grabOutcomeText({ outcome: o, targetLabel: SPICE, override: true }),
      ]),
      ...['failed', 'nothing_found', 'stalled', 'completed', 'downloading', null].map((p) => resultFollowUp(p, ctx).text),
      budgetText({ limit: 10, left: 3 }, true) ?? '',
      budgetText({ limit: 10, left: 0 }, false) ?? '',
      budgetText({ limit: 0, left: 0 }, false) ?? '',
      listLead(listSections(list([OLDT, WVF, BIOMA])), SPICE),
      listLead(listSections(list([BIOMA])), SPICE),
      listLead(listSections(list([])), SPICE),
    ];
    for (const text of strings) expect(text, text).not.toMatch(COPY_BREAKS);
  });
});
