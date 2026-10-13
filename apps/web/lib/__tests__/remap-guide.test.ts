// ADR-109 C-02 / ADR-110 C-03, C-04 / DESIGN-055 D-01, D-04, D-05 (PLAN-077 P4) — the Episode Re-map step's pure rules
// (lib/remap-guide.ts): when Fix offers a re-map, what each question pre-fills, the preview's lines (each move in run
// order, what the file's name says, the episodes left empty), the confirm's name, the result's lines, the Mislabel offer
// and the Title Check flag. A re-map never deletes a file, so nothing here is ever a "gone afterwards" line.
import { describe, expect, it } from 'vitest';
import {
  REMAP_CHOICE_LABELS,
  REMAP_NOTHING_LOST,
  REMAP_WATCHED_NOTE,
  episodeLabelOf,
  flagsByEpisode,
  joinEpisodeLabels,
  mislabelButtonLabel,
  mislabelNotSavedText,
  mislabelOfferTitle,
  mislabelOfferWhy,
  mislabelSavedText,
  moveLine,
  nameEvidenceLine,
  remapConfirmLabel,
  remapConfirmable,
  remapKindFor,
  resultLead,
  resultNotes,
  shiftClaim,
  shiftDefaults,
  shiftFromOptions,
  shiftThroughOptions,
  suggestedTarget,
  targetOptions,
  titleFlagClaim,
  titleFlagText,
  vacatedNote,
  vacatedResultNote,
  type RemapMove,
  type RemapSeason,
  type RemapSeasonEpisode,
  TITLE_FLAG_STAFF_LINE,
  titleFlagStaffTicket,
} from '../remap-guide';

const ref = (id: number, n: number, title: string) => ({
  id,
  episodeNumber: n,
  title,
  label: `S01E${String(n).padStart(2, '0')} · ${title}`,
});

/** A Lost Tapes-like season: files on E11 and E13..E18 one slot low, E12 and E19 free (Case A). */
const TITLES: Record<number, string> = {
  10: 'Spice It Up',
  11: 'Prank Callers',
  12: 'Secret Menu Item',
  13: 'Time Out',
  14: 'Rap It Up',
  15: 'Night Shift',
  16: 'Bad Signal',
  17: 'Lost Remote',
  18: 'Thats Funny',
  19: 'Cool Boss',
};
const ON_DISK = new Set([10, 11, 13, 14, 15, 16, 17, 18]);
const episodes: RemapSeasonEpisode[] = Object.entries(TITLES).map(([n, title]) => {
  const num = Number(n);
  const hasFile = ON_DISK.has(num);
  return {
    ...ref(1000 + num, num, title),
    hasFile,
    fileName: hasFile ? `Lost Tapes - S01E${num} - ${title}-BiOMA.mkv` : null,
    multiEpisode: false,
  };
});

const season = (suggestion: RemapSeason['suggestion']): Pick<RemapSeason, 'episodes' | 'suggestion'> => ({
  episodes,
  suggestion,
});

describe('remapKindFor (when Fix offers a re-map)', () => {
  it('offers a single move on a TV episode and a shift on a TV season, only with the remedy on', () => {
    expect(remapKindFor({ remapOn: true, arrKind: 'sonarr', target: { scope: 'episode' } })).toBe('single');
    expect(remapKindFor({ remapOn: true, arrKind: 'sonarr', target: { scope: 'season' } })).toBe('shift');
    expect(remapKindFor({ remapOn: false, arrKind: 'sonarr', target: { scope: 'episode' } })).toBeNull();
  });

  it('offers nothing for a movie, a whole show, or a bare TV Fix before the episode is picked', () => {
    expect(remapKindFor({ remapOn: true, arrKind: 'radarr', target: null })).toBeNull();
    expect(remapKindFor({ remapOn: true, arrKind: 'radarr', target: { scope: 'item' } })).toBeNull();
    expect(remapKindFor({ remapOn: true, arrKind: 'sonarr', target: { scope: 'show' } })).toBeNull();
    expect(remapKindFor({ remapOn: true, arrKind: 'sonarr', target: null })).toBeNull();
  });

  it('words the choices for people', () => {
    expect(REMAP_CHOICE_LABELS.single).toBe("It's a different episode of this show");
    expect(REMAP_CHOICE_LABELS.shift).toMatch(/^They're all off by one/);
    for (const label of Object.values(REMAP_CHOICE_LABELS)) expect(label).not.toMatch(/[—–]/);
  });
});

describe('"Which episode is this really?"', () => {
  const flagged = { fileId: 7, on: [ref(1024, 24, 'Disney Plus')], best: ref(1023, 23, 'All You Can Fit'), name: 'x' };

  it('preselects the episode the file name points at, only for the flagged file', () => {
    expect(suggestedTarget(season({ claim: null, flagged: [flagged] }), 1024)?.id).toBe(1023);
    expect(suggestedTarget(season({ claim: null, flagged: [flagged] }), 1011)).toBeNull();
    expect(suggestedTarget(season({ claim: null, flagged: [] }), 1024)).toBeNull();
  });

  it('lists every other episode and marks the ones holding a file of their own', () => {
    const options = targetOptions(episodes, 1011);
    expect(options.map((o) => o.id)).not.toContain(1011);
    expect(options.find((o) => o.id === 1012)?.label).toBe('S01E12 · Secret Menu Item');
    expect(options.find((o) => o.id === 1013)?.label).toBe('S01E13 · Time Out (has its own file)');
  });

  it("does not call the other half of a two-episode file another file", () => {
    const multi: RemapSeasonEpisode[] = [
      { ...ref(5, 5, 'Five'), hasFile: true, fileName: 'S05E05-E06.mkv', multiEpisode: true },
      { ...ref(6, 6, 'Six'), hasFile: true, fileName: 'S05E05-E06.mkv', multiEpisode: true },
      { ...ref(7, 7, 'Seven'), hasFile: false, fileName: null, multiEpisode: false },
    ];
    expect(targetOptions(multi, 6).map((o) => o.label)).toEqual(['S01E05 · Five', 'S01E07 · Seven']);
  });
});

describe('"They\'re all off by one"', () => {
  it('pre-fills the shift the names suggest, with the last file read as "to the end"', () => {
    const s = season({ claim: { kind: 'shift', fromEpisodeNumber: 11, throughEpisodeNumber: 18, by: 1 }, flagged: [] });
    expect(shiftDefaults(s)).toEqual({ fromEpisodeNumber: 11, throughEpisodeNumber: null, by: 1 });
  });

  it('keeps a suggested last episode short of the season end', () => {
    const s = season({ claim: { kind: 'shift', fromEpisodeNumber: 13, throughEpisodeNumber: 15, by: -1 }, flagged: [] });
    expect(shiftDefaults(s)).toEqual({ fromEpisodeNumber: 13, throughEpisodeNumber: 15, by: -1 });
  });

  it('without a suggestion starts at the first file, one slot later, to the end', () => {
    expect(shiftDefaults(season({ claim: null, flagged: [] }))).toEqual({ fromEpisodeNumber: 10, throughEpisodeNumber: null, by: 1 });
    expect(shiftDefaults({ episodes: [], suggestion: { claim: null, flagged: [] } })).toBeNull();
  });

  it('starts only from an episode with a file, and ends only after it', () => {
    expect(shiftFromOptions(episodes).map((e) => e.episodeNumber)).toEqual([10, 11, 13, 14, 15, 16, 17, 18]);
    expect(shiftThroughOptions(episodes, 15).map((e) => e.episodeNumber)).toEqual([16, 17, 18]);
  });

  it('builds the claim, dropping a last episode before the first', () => {
    expect(shiftClaim({ fromEpisodeNumber: 11, throughEpisodeNumber: null, by: 1 })).toEqual({
      kind: 'shift',
      fromEpisodeNumber: 11,
      throughEpisodeNumber: null,
      by: 1,
    });
    expect(shiftClaim({ fromEpisodeNumber: 11, throughEpisodeNumber: 15, by: -1 })).toMatchObject({ throughEpisodeNumber: 15, by: -1 });
    expect(shiftClaim({ fromEpisodeNumber: 15, throughEpisodeNumber: 11, by: 1 })).toMatchObject({ throughEpisodeNumber: null });
  });
});

describe('the preview', () => {
  const move = (over: Partial<RemapMove> = {}): RemapMove => ({
    fileId: 18,
    fileName: 'Lost Tapes - S01E18 - Thats Funny-BiOMA.mkv',
    size: 1,
    releaseGroup: 'BiOMA',
    qualityName: 'WEBDL-1080p',
    from: [ref(1018, 18, 'Thats Funny')],
    to: [ref(1019, 19, 'Cool Boss')],
    nameSays: null,
    ...over,
  });

  it('says what moves where, one line per file', () => {
    expect(moveLine(move())).toBe('The file on S01E18 · Thats Funny moves to S01E19 · Cool Boss.');
    const pair = move({ from: [ref(5, 5, 'A'), ref(6, 6, 'B')], to: [ref(6, 6, 'B'), ref(7, 7, 'C')] });
    expect(moveLine(pair)).toBe('The file on S01E05 · A and S01E06 · B moves to S01E06 · B and S01E07 · C.');
    expect(joinEpisodeLabels([ref(1, 1, 'A'), ref(2, 2, 'B'), ref(3, 3, 'C')])).toBe('S01E01 · A, S01E02 · B and S01E03 · C');
  });

  it("shows what the file's own name says only when it names an episode", () => {
    const agrees = move({ nameSays: { name: 'n', verdict: 'agrees', best: ref(1019, 19, 'Cool Boss') } });
    expect(nameEvidenceLine(agrees)).toEqual({ text: 'Its name says Cool Boss.', tone: 'agrees' });
    const disagrees = move({ nameSays: { name: 'n', verdict: 'disagrees', best: ref(1023, 23, 'All You Can Fit') } });
    expect(nameEvidenceLine(disagrees)).toEqual({ text: 'Its name says All You Can Fit, which is a different episode.', tone: 'disagrees' });
    expect(nameEvidenceLine(move({ nameSays: { name: 'n', verdict: 'silent', best: null } }))).toBeNull();
    expect(nameEvidenceLine(move({ nameSays: { name: 'n', verdict: 'ambiguous', best: ref(1, 1, 'X') } }))).toBeNull();
    expect(nameEvidenceLine(move())).toBeNull();
  });

  it('names the confirm by the files it moves, and promises nothing is lost', () => {
    expect(remapConfirmLabel(1)).toBe('Move 1 file');
    expect(remapConfirmLabel(7)).toBe('Move 7 files');
    expect(REMAP_NOTHING_LOST).toBe('Nothing is downloaded or deleted.');
    expect(REMAP_WATCHED_NOTE).toMatch(/Plex keeps watched marks with the episode number/);
    expect(vacatedNote(1)).toBe('You can search for it afterwards.');
    expect(vacatedNote(2)).toBe('You can search for them afterwards.');
    expect(vacatedResultNote(1)).toBe('Search for it here, or later from the episode list. A search blocks no release and removes no file.');
    expect(vacatedResultNote(2)).toMatch(/^Search for them here, or later/);
  });

  it('offers the confirm only for a plan without a refusal, with the remedy on', () => {
    expect(remapConfirmable({ refusal: null, moves: [move()], remapOn: true })).toBe(true);
    expect(remapConfirmable({ refusal: 'occupied', moves: [move()], remapOn: true })).toBe(false);
    expect(remapConfirmable({ refusal: null, moves: [], remapOn: true })).toBe(false);
    expect(remapConfirmable({ refusal: null, moves: [move()], remapOn: false })).toBe(false);
  });
});

describe('the result', () => {
  it('says how many moved, in plain words', () => {
    expect(resultLead({ outcome: 'moved', moved: 7, stoppedText: null })).toBe('Moved 7 files. Each one is on the right episode now.');
    expect(resultLead({ outcome: 'moved', moved: 1, stoppedText: null })).toBe('Moved 1 file. It is on the right episode now.');
    expect(resultNotes({ outcome: 'moved', moved: 7, planned: 7, renamed: true })).toEqual([]);
  });

  it('says when Sonarr kept an old name', () => {
    expect(resultNotes({ outcome: 'moved', moved: 7, planned: 7, renamed: false })).toEqual([
      'Sonarr kept the old name on at least one file, so Plex may still show it on its old episode until staff rename it.',
    ]);
  });

  it('after a stop, says why, how many landed, and that nothing was lost', () => {
    const stopped = { outcome: 'stopped' as const, moved: 2, planned: 7, renamed: true, stoppedText: 'Sonarr could not finish one of the moves, so the rest were not sent.' };
    expect(resultLead(stopped)).toBe(stopped.stoppedText);
    expect(resultNotes(stopped)).toEqual(['2 of 7 files moved, each onto its right episode. Nothing was lost.']);
    expect(resultNotes({ ...stopped, moved: 0 })).toEqual(['No file was moved, so nothing changed and nothing was lost.']);
  });
});

describe('the Mislabel offer', () => {
  it('names the group, says why in one sentence, and answers saved or not saved', () => {
    expect(mislabelOfferTitle('BiOMA')).toBe('Stop BiOMA from filing this show again');
    expect(mislabelOfferWhy('BiOMA', 7)).toBe(
      "7 of the files that moved came from BiOMA, so Sonarr would skip BiOMA's releases of this show and pick another group's instead.",
    );
    expect(mislabelButtonLabel('BiOMA')).toBe('Block BiOMA for this show');
    expect(mislabelSavedText('BiOMA')).toBe("Saved. Sonarr will skip BiOMA's releases of this show.");
    expect(mislabelSavedText('BiOMA', true)).toBe("Already saved. Sonarr skips BiOMA's releases of this show.");
    expect(mislabelNotSavedText('Sonarr did not keep the change.')).toBe('Not saved. Sonarr did not keep the change.');
    expect(mislabelNotSavedText(null)).toBe('Not saved. Nothing was changed in Sonarr.');
  });
});

describe('the Title Check flag', () => {
  const flag = {
    titleCheckId: 'a',
    seasonNumber: 1,
    episodeId: 1024,
    episodeIds: [1024],
    episodeNumber: 24,
    episodeTitle: 'Disney Plus',
    episodeFileId: 9,
    sourceTitle: 'Regular.Show.The.Lost.Tapes.S01E24.All.You.Can.Fit.1080p.DSNP.WEB-DL-FLUX',
    best: { episodeId: 1023, episodeNumber: 23, title: 'All You Can Fit' },
    score: 0,
    bestScore: 1,
  };

  it('says what the name says and opens the single move it points at', () => {
    expect(titleFlagText(flag)).toBe("This file's name says it's S01E23 · All You Can Fit");
    expect(titleFlagClaim(flag)).toEqual({ kind: 'single', fromEpisodeId: 1024, toEpisodeId: 1023 });
  });

  it('shows nothing for a flag that points nowhere', () => {
    expect(titleFlagText({ ...flag, best: null })).toBeNull();
    expect(titleFlagClaim({ ...flag, best: null })).toBeNull();
    expect(titleFlagClaim({ ...flag, best: { ...flag.best, episodeId: 1024 } })).toBeNull();
  });

  it('keeps one flag per episode and labels an untitled episode by its number', () => {
    const map = flagsByEpisode([flag, { ...flag, titleCheckId: 'b' }, { ...flag, episodeId: 1, best: null }]);
    expect([...map.keys()]).toEqual([1024]);
    expect(map.get(1024)?.titleCheckId).toBe('a');
    expect(episodeLabelOf(2, 6, null)).toBe('S02E06');
    expect(episodeLabelOf(2, 6, ' 125 Years Young ')).toBe('S02E06 · 125 Years Young');
  });
});

describe('a flag whose move cannot run (DESIGN-055 P4 decision 15)', () => {
  it('hands it to staff with the evidence, worded for people', () => {
    const t = titleFlagStaffTicket({
      seasonNumber: 1,
      episodeNumber: 8,
      episodeTitle: 'Work Family',
      sourceTitle: 'Abbott.Elementary.2021.S01E08.Step.Class.1080p.HMAX.WEB-DL.DDP5.1.H.264-FUZEER',
      best: { episodeNumber: 9, title: 'Step Class' },
    });
    expect(t.subject).toBe('S01E08 · Work Family plays another episode');
    expect(t.note).toContain('named for S01E09 · Step Class');
    expect(TITLE_FLAG_STAFF_LINE).toBe('That episode already has a file, so staff need to move this one.');
    expect(`${t.subject} ${t.note} ${TITLE_FLAG_STAFF_LINE}`).not.toMatch(/—/);
  });
});
