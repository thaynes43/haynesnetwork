// ADR-110 C-04, C-05, C-08 / DESIGN-055 D-05 (PLAN-077 P4) — the Mislabel Block: the series + group term (grammar,
// compile check, the real Case A names), and its single writer on embedded Postgres against a stub Sonarr profile
// surface (the re-map offer's checks, the write and read-back with the row in the read-back's transaction, a failed
// read-back, idempotency, the cap, expiry, drift repair, staff removal with its audit row, and the adoption).
// ADR-113 (DESIGN-055 Q-10 ruling) — the mislabelled-name terms (pair, double, alias): grammar, the Case A hand
// profile's five names, the refusals, and the same writer for them (add, dry run, refuse, roll back, remove).
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mislabelBlockTerms, permissionAudit, repairRequests } from '@hnet/db/schema';
import {
  MISLABEL_BLOCK_PROFILE_NAME,
  MISLABEL_BLOCK_SENTINEL,
  MISLABEL_TERM_CAP,
  MislabelBlockError,
  addMislabelNameTerm,
  addMislabelTermFromRemap,
  adoptMislabelTerm,
  deriveMislabelNameTerm,
  deriveMislabelTerm,
  isMislabelBlockTerm,
  listMislabelTerms,
  mislabelBlockUpkeep,
  mislabelTermsForSeries,
  parseMislabelName,
  reconcileMislabelBlock,
  removeMislabelTerm,
  type MislabelBlockSonarr,
  type MislabelReleaseProfile,
  type MislabelReleaseProfileBody,
} from '../src/mislabel-block';
import {
  compileTerm,
  isGrammarTerm,
  isMislabelNameTerm,
  isMislabelTerm,
  isWholeNameTerm,
  mislabelNameKindOf,
  renderMislabelNameTerm,
  renderMislabelTerm,
  termMatchesRaw,
  type MislabelNameKind,
} from '../src/release-terms';
import { silentDomainLogger, upsertMediaItemsBatch } from '../src/index';
import { bootMigratedDb, createUser, type TestDb } from './helpers';

const LOST_TAPES = 'Regular Show: The Lost Tapes';
const BIOMA_E11 = 'Regular.Show.The.Lost.Tapes.S01E11.1080p.AMZN.WEB-DL.DDP5.1.H.264.DUAL-BiOMA';
const OLDT_E10 = 'Regular.Show.The.Lost.Tapes.S01E10.Spice.It.Up.1080p.HMAX.WEB-DL.DDP2.0.H.265-OldT';
const OTHER_BIOMA = 'Some.Other.Show.S01E01.1080p.DUAL-BiOMA';
const BIOMAX = 'Regular.Show.The.Lost.Tapes.S01E11.1080p.AMZN.WEB-DL.DDP5.1.H.264.DUAL-BiOMAX';
/** Sonarr's alternate title for series 1061 (seasonNumber -1), read 2026-10-13. */
const GERMAN_TITLE = 'Regular Show Die verlorenen Videos';
const GERMAN_GRAB = 'Regular.Show.Die.verlorenen.Videos.S01E11.GERMAN.DL.1080P.WEB.H264-WAYNE';
/** A stub season: the titles each number really has (E12 is Secret Menu Item, E23 All You Can Fit). */
const LOST_TAPES_EPISODES = [
  { seasonNumber: 1, episodeNumber: 10, title: 'Tenth Title' },
  { seasonNumber: 1, episodeNumber: 11, title: 'Spice It Up' },
  { seasonNumber: 1, episodeNumber: 12, title: 'Secret Menu Item' },
  { seasonNumber: 1, episodeNumber: 13, title: 'Thirteenth Title' },
  { seasonNumber: 1, episodeNumber: 14, title: 'Smoke Alarm' },
  { seasonNumber: 1, episodeNumber: 23, title: 'All You Can Fit' },
  { seasonNumber: 1, episodeNumber: 24, title: 'Twenty-Fourth Title' },
];
/** The Case A hand profile's five non-group blocks (profile id 3, read 2026-10-13), as the name terms that replace them. */
const HAND_NAMES: Array<[MislabelNameKind, string]> = [
  ['alias', GERMAN_TITLE],
  ['double', 'S01E13E14'],
  ['pair', 'S01E11 Secret Menu'],
  ['pair', 'S01E13 Smoke Alarm'],
  ['pair', 'S01E24 All You Can Fit'],
];

const termOf = (seriesTitle: string, releaseGroup: string, otherSeriesTitles?: string[]) => {
  const d = deriveMislabelTerm({ seriesTitle, releaseGroup, otherSeriesTitles });
  if (!('term' in d)) throw new Error(`refused: ${d.refused}`);
  return d.term;
};
const refusalOf = (seriesTitle: string | null, releaseGroup: string | null, otherSeriesTitles?: string[]) => {
  const d = deriveMislabelTerm({ seriesTitle, releaseGroup, otherSeriesTitles });
  return 'refused' in d ? d.refused : null;
};

describe('the Mislabel Block term (D-05, pure)', () => {
  it('Case A: blocks BiOMA on the Lost Tapes and nothing else', () => {
    const term = termOf(LOST_TAPES, 'BiOMA');
    expect(term).toBe(
      '/^(?=.*(?<![a-z0-9])regular[^a-z0-9]*show[^a-z0-9]*the[^a-z0-9]*lost[^a-z0-9]*tapes(?![a-z0-9]))' +
        '(?=.*(?<![a-z0-9])bioma(?![a-z0-9]))/i',
    );
    // Sonarr runs the term as a case-insensitive regex against the raw release title.
    expect(termMatchesRaw(term, BIOMA_E11)).toBe(true);
    expect(termMatchesRaw(term, 'regular show the lost tapes s01e12 1080p web-dl - bioma')).toBe(true);
    expect(termMatchesRaw(term, 'Regular_Show_The_Lost_Tapes_S01E12_1080p_DUAL_BiOMA')).toBe(true); // `\b` would miss `_`
    expect(termMatchesRaw(term, 'Regular Show - The Lost Tapes - S01E13 [BiOMA]')).toBe(true);
    expect(termMatchesRaw(term, OLDT_E10)).toBe(false); // another group on the same show
    expect(termMatchesRaw(term, OTHER_BIOMA)).toBe(false); // the same group on another show
    expect(termMatchesRaw(term, BIOMAX)).toBe(false); // a group that merely contains the token
    expect(termMatchesRaw(term, 'Regular.Show.S08E01.1080p.WEB-DL-BiOMA')).toBe(false); // the parent show
  });

  it('is its own grammar and compiles; the Release Block and janitor validators never accept it', () => {
    const term = termOf(LOST_TAPES, 'BiOMA');
    expect(isMislabelTerm(term)).toBe(true);
    expect(compileTerm(term)).not.toBeNull();
    expect(isGrammarTerm(term)).toBe(false);
    expect(isWholeNameTerm(term)).toBe(false);
    // Only `[^a-z0-9]` separators and lookaround boundaries: no `\b` / `\W`, which differ between .NET and JavaScript.
    expect(term).not.toMatch(/\\[bBwW]/);
    // Off-template or uncompilable terms fail the check the writer runs before every write.
    expect(isMislabelTerm(term.replace('bioma(?!', 'bioma((?!'))).toBe(false);
    expect(isMislabelTerm(term.replace(/\/i$/, '/'))).toBe(false);
    expect(isMislabelTerm(term.replace('bioma', 'bio.*ma'))).toBe(false);
    expect(isMislabelTerm(MISLABEL_BLOCK_SENTINEL)).toBe(false);
    expect(isMislabelTerm('/^(?=.*(?<![a-z0-9])x(?![a-z0-9]))(?=.*(?<![a-z0-9])bioma(?![a-z0-9]))/i')).toBe(true);
    expect(() => renderMislabelTerm(['regular'], 'BiOMA')).toThrow(); // the group is written lower case
    expect(() => renderMislabelTerm([], 'bioma')).toThrow();
  });

  it("writes a title's apostrophes, accented letters and `&` the way release names spell them", () => {
    const bobs = termOf("Bob's Burgers", 'FLUX');
    for (const name of [
      'Bobs.Burgers.S14E01.1080p.WEB-DL-FLUX',
      "Bob's Burgers S14E01 1080p FLUX",
      'Bob&#39;s.Burgers.S14E01.FLUX',
    ]) {
      expect(termMatchesRaw(bobs, name), name).toBe(true);
    }
    expect(termMatchesRaw(bobs, 'Bob.Burgers.S01E01-FLUX')).toBe(false);

    const poke = termOf('Pokémon Horizons: The Series', 'VARYG');
    expect(termMatchesRaw(poke, 'Pokemon.Horizons.The.Series.S01E01.1080p.NF.WEB-DL-VARYG')).toBe(true);
    expect(termMatchesRaw(poke, 'Pokémon Horizons The Series S01E01 VARYG')).toBe(true);

    const robots = termOf('Love, Death & Robots', 'NTb');
    for (const name of [
      'Love.Death.and.Robots.S01E01.1080p.NF.WEB-DL-NTb',
      'Love Death & Robots S01E01 NTb',
      'Love.Death.Robots.S01E01-NTb',
    ]) {
      expect(termMatchesRaw(robots, name), name).toBe(true);
    }
  });

  it('writes a dotted or hyphenated group literally', () => {
    const dotted = termOf(LOST_TAPES, 'Ao.Sora');
    expect(dotted).toContain('ao\\.sora');
    expect(termMatchesRaw(dotted, 'Regular.Show.The.Lost.Tapes.S01E11-Ao.Sora')).toBe(true);
    expect(termMatchesRaw(dotted, 'Regular.Show.The.Lost.Tapes.S01E11-AoXSora')).toBe(false);
    const hyphen = termOf(LOST_TAPES, 'D-Z0N3');
    expect(termMatchesRaw(hyphen, 'Regular.Show.The.Lost.Tapes.S01E11.1080p.WEB-DL-D-Z0N3')).toBe(true);
    expect(isMislabelTerm(dotted) && isMislabelTerm(hyphen)).toBe(true);
  });

  it('refuses what it cannot block safely', () => {
    expect(refusalOf(LOST_TAPES, '')).toBe('no_group');
    expect(refusalOf(LOST_TAPES, null)).toBe('no_group');
    expect(refusalOf(LOST_TAPES, 'X')).toBe('group_too_short');
    for (const g of ['BiO MA', 'BiOMA!', '.BiOMA', 'BiOMA-', 'Bi..OMA', 'BiOMA[1]', 'Ünï', '264', '5.1']) {
      expect(refusalOf(LOST_TAPES, g), g).toBe('group_unwritable');
    }
    // A group ordinary names of the show already carry would block the whole series.
    for (const g of ['WEB-DL', 'x264', 'H.264', 'AMZN', 'DUAL', '1080p', 'Lost', 'tapes', 'S01E01']) {
      expect(refusalOf(LOST_TAPES, g), g).toBe('group_too_broad');
    }
    expect(refusalOf('', 'BiOMA')).toBe('no_title');
    expect(refusalOf('進撃の巨人', 'BiOMA')).toBe('no_title');
    expect(refusalOf('Shōgun ÷', 'BiOMA')).toBe('title_unwritable');
    // A term for "Lost" would also block that group's "Lost Girl" releases.
    const other = deriveMislabelTerm({ seriesTitle: 'Lost', releaseGroup: 'BiOMA', otherSeriesTitles: ['Lost Girl'] });
    expect(other).toEqual({ refused: 'names_other_series', otherSeries: 'Lost Girl' });
    // The Lost Tapes' term does not reach the parent show.
    expect(refusalOf(LOST_TAPES, 'BiOMA', ['Regular Show', 'Lost', 'The Lost Tapes'])).toBeNull();
  });
});

const nameTermOf = (kind: MislabelNameKind, name: string, o: Partial<Parameters<typeof deriveMislabelNameTerm>[0]> = {}) => {
  const d = deriveMislabelNameTerm({
    seriesTitle: LOST_TAPES,
    kind,
    name,
    alternateTitles: [GERMAN_TITLE],
    episodes: LOST_TAPES_EPISODES,
    ...o,
  });
  if (!('term' in d)) throw new Error(`refused: ${d.refused}`);
  return d;
};
const nameRefusalOf = (kind: MislabelNameKind, name: string, o: Partial<Parameters<typeof deriveMislabelNameTerm>[0]> = {}) => {
  const d = deriveMislabelNameTerm({
    seriesTitle: LOST_TAPES,
    kind,
    name,
    alternateTitles: [GERMAN_TITLE],
    episodes: LOST_TAPES_EPISODES,
    ...o,
  });
  return 'refused' in d ? d.refused : null;
};
const SERIES_LOOK = '(?=.*(?<![a-z0-9])regular[^a-z0-9]*show[^a-z0-9]*the[^a-z0-9]*lost[^a-z0-9]*tapes(?![a-z0-9]))';

describe('mislabelled-name terms (ADR-113, pure)', () => {
  it('pair: blocks the number with the wrong title on the Lost Tapes, and nothing else', () => {
    const { term, nameToken } = nameTermOf('pair', 'S01E11 Secret Menu');
    expect(nameToken).toBe('S01E11 Secret Menu');
    expect(term).toBe(`/^${SERIES_LOOK}(?=.*(?<![a-z0-9])s0*1e0*11[^a-z0-9]*secret[^a-z0-9]*menu(?![a-z0-9]))/i`);
    for (const name of [
      'Regular.Show..The.Lost.Tapes.S01E11.Secret.Menu.1080p.AMZN.WEB-DL.DDP2.0.H.264-NTb',
      'Regular Show The Lost Tapes S01E11 Secret Menu Item 1080p WEB-DL-NTb',
      'Regular_Show_The_Lost_Tapes_S1E11_Secret_Menu_720p',
      'regular show - the lost tapes - s01e11 - secret menu [GRP]',
    ]) {
      expect(termMatchesRaw(term, name), name).toBe(true);
    }
    for (const name of [
      'Regular.Show..The.Lost.Tapes.S01E12.Secret.Menu.Item.1080p.AMZN.WEB-DL-NTb', // the right number
      'Regular.Show.The.Lost.Tapes.S01E11.Spice.It.Up.1080p.HMAX.WEB-DL-OldT', // E11's own title
      'Regular.Show.The.Lost.Tapes.S01E110.Secret.Menu.1080p', // another number
      'Regular.Show.The.Lost.Tapes.S11E11.Secret.Menu.1080p',
      BIOMA_E11,
      OLDT_E10,
      'Regular.Show.S08E11.Secret.Menu.1080p.WEB-DL-NTb', // the parent show
    ]) {
      expect(termMatchesRaw(term, name), name).toBe(false);
    }
    expect(nameTermOf('pair', 'S01E13 Smoke Alarm').term).toContain('s0*1e0*13[^a-z0-9]*smoke[^a-z0-9]*alarm');
    const fit = nameTermOf('pair', 'S01E24 All You Can Fit').term;
    expect(termMatchesRaw(fit, 'Regular.Show.The.Lost.Tapes.S01E24.All.You.Can.Fit.1080p.DSNP.WEB-DL.DDP5.1.H.264-FLUX')).toBe(true);
    expect(termMatchesRaw(fit, 'Regular.Show.The.Lost.Tapes.S01E23.All.You.Can.Fit.1080p.DSNP.WEB-DL.DDP5.1.H.264-FLUX')).toBe(false);
  });

  it('double: blocks the double-episode token on the Lost Tapes, not either episode alone', () => {
    const { term, nameToken } = nameTermOf('double', 's01e13-e14');
    expect(nameToken).toBe('S01E13E14');
    expect(term).toBe(`/^${SERIES_LOOK}(?=.*(?<![a-z0-9])s0*1e0*13[^a-z0-9]*e0*14(?![a-z0-9]))/i`);
    for (const name of [
      'Regular Show The Lost Tapes S01E13E14 1080p WEB-DL-GRP',
      'Regular.Show.The.Lost.Tapes.S01E13-E14.1080p.AMZN.WEB-DL-GRP',
    ]) {
      expect(termMatchesRaw(term, name), name).toBe(true);
    }
    for (const name of [
      'Regular.Show.The.Lost.Tapes.S01E13.Thirteenth.Title.1080p-GRP',
      'Regular.Show.The.Lost.Tapes.S01E14.Smoke.Alarm.1080p-GRP',
      'Regular.Show.The.Lost.Tapes.S01E12E13.1080p-GRP',
      'Regular.Show.The.Lost.Tapes.S01E14E15.1080p-GRP',
      'Some.Other.Show.S01E13E14.1080p-GRP',
    ]) {
      expect(termMatchesRaw(term, name), name).toBe(false);
    }
  });

  it("alias: blocks the series' German title, never its own title", () => {
    const { term, nameToken } = nameTermOf('alias', 'regular show die verlorenen videos');
    expect(nameToken).toBe(GERMAN_TITLE); // Sonarr's spelling
    expect(term).toBe(
      '/^(?=.*(?<![a-z0-9])regular[^a-z0-9]*show[^a-z0-9]*die[^a-z0-9]*verlorenen[^a-z0-9]*videos(?![a-z0-9]))/i',
    );
    expect(termMatchesRaw(term, GERMAN_GRAB)).toBe(true);
    expect(termMatchesRaw(term, 'Regular Show - Die verlorenen Videos - S01E02 [GER]')).toBe(true);
    for (const name of [BIOMA_E11, OLDT_E10, 'Regular.Show..The.Lost.Tapes.S01E11.Secret.Menu.1080p', 'Regular.Show.S01E01.GERMAN-WAYNE']) {
      expect(termMatchesRaw(term, name), name).toBe(false);
    }
  });

  it('is its own grammar: each kind validates and compiles; no other validator accepts it', () => {
    const terms = HAND_NAMES.map(([kind, name]) => [kind, nameTermOf(kind, name).term] as const);
    for (const [kind, term] of terms) {
      expect(mislabelNameKindOf(term), term).toBe(kind);
      expect(isMislabelNameTerm(term)).toBe(true);
      expect(isMislabelBlockTerm(term)).toBe(true);
      expect(compileTerm(term)).not.toBeNull();
      expect(isMislabelTerm(term)).toBe(false);
      expect(isGrammarTerm(term)).toBe(false);
      expect(isWholeNameTerm(term)).toBe(false);
      // Only `[^a-z0-9]` separators and lookaround boundaries: no `\b` / `\W`, which differ between .NET and JavaScript.
      expect(term).not.toMatch(/\\[bBwW]/);
    }
    const group = termOf(LOST_TAPES, 'BiOMA');
    expect(mislabelNameKindOf(group)).toBeNull();
    expect(isMislabelBlockTerm(group)).toBe(true);
    expect(isMislabelBlockTerm(MISLABEL_BLOCK_SENTINEL)).toBe(true);
    // The hand profile's own terms (and anything else off-template) are refused before any write.
    for (const hand of [
      '/\\bDUAL[ ._-]BiOMA\\b/i',
      '/\\bverlorenen[ ._-]Videos\\b/i',
      '/\\bS01E13[ ._-]?E14\\b/i',
      '/\\bS01E11[ ._-]+Secret[ ._-]+Menu\\b/i',
      '/bioma/i',
    ]) {
      expect(isMislabelBlockTerm(hand), hand).toBe(false);
    }
    const [, pair] = terms[2]!;
    expect(isMislabelNameTerm(pair.replace('s0*1e0*11', 's0*1e0*011'))).toBe(false); // a leading zero
    expect(isMislabelNameTerm(pair.replace('s0*1e0*11', 's0*1e.*'))).toBe(false);
    expect(isMislabelNameTerm(pair.replace('menu(?!', 'menu((?!'))).toBe(false); // .NET cannot compile it
    expect(isMislabelNameTerm(pair.replace(/\/i$/, '/'))).toBe(false);
    expect(isMislabelNameTerm(`${pair.slice(0, -2)}(?=.*x)/i`)).toBe(false);
    const [, alias] = terms[0]!;
    expect(isMislabelNameTerm(alias.replace('videos', 'vid.*eos'))).toBe(false);
    // The renderer refuses parts outside the grammar.
    expect(() => renderMislabelNameTerm({ kind: 'pair', series: ['x'], season: 1, episode: 0, title: ['y'] })).toThrow();
    expect(() => renderMislabelNameTerm({ kind: 'pair', series: ['x'], season: 1, episode: 1, title: [] })).toThrow();
    expect(() => renderMislabelNameTerm({ kind: 'pair', series: ['X'], season: 1, episode: 1, title: ['y'] })).toThrow();
    expect(() => renderMislabelNameTerm({ kind: 'double', series: ['x'], season: 1, episode: 14, lastEpisode: 13 })).toThrow();
    expect(() => renderMislabelNameTerm({ kind: 'alias', alias: [] })).toThrow();
  });

  it('reads the name the way staff give it', () => {
    expect(parseMislabelName('pair', '  s1e11   Secret  Menu ')).toEqual({
      kind: 'pair',
      nameToken: 'S01E11 Secret Menu',
      season: 1,
      episode: 11,
      title: 'Secret Menu',
    });
    expect(parseMislabelName('double', 'S01E13 E14')).toMatchObject({ nameToken: 'S01E13E14', episode: 13, lastEpisode: 14 });
    for (const [kind, name] of [
      ['pair', 'Secret Menu'],
      ['pair', 'S01E11'],
      ['pair', 'S01E11E12 Secret Menu'],
      ['pair', 'S01E00 Secret Menu'],
      ['pair', 'S01E11 日本'],
      ['double', 'S01E14E13'],
      ['double', 'S01E13'],
      ['double', 'S01E13E14 Smoke'],
      ['alias', '   '],
      ['alias', '進撃の巨人'],
    ] as const) {
      expect(parseMislabelName(kind, name), `${kind} ${name}`).toBeNull();
    }
  });

  it('refuses what it cannot block safely', () => {
    expect(nameRefusalOf('pair', 'Secret Menu')).toBe('name_unwritable');
    expect(nameRefusalOf('double', 'S01E13')).toBe('name_unwritable');
    expect(nameRefusalOf('pair', 'S01E11 Secret Menu', { seriesTitle: '' })).toBe('no_title');
    // An alias must be Sonarr's, and not the show's own title.
    expect(nameRefusalOf('alias', 'Regular Show: The Lost Tapes')).toBe('alias_is_title');
    expect(nameRefusalOf('alias', 'Regular Show Las cintas perdidas')).toBe('alias_not_listed');
    expect(nameRefusalOf('alias', GERMAN_TITLE, { alternateTitles: [] })).toBe('alias_not_listed');
    // An alias, or a pair's words, that ordinary releases of the show carry would block good downloads.
    expect(nameRefusalOf('alias', 'Regular Show', { alternateTitles: ['Regular Show'] })).toBe('name_too_broad');
    expect(nameRefusalOf('alias', 'The Lost Tapes', { alternateTitles: ['The Lost Tapes'] })).toBe('name_too_broad');
    for (const name of ['S01E11 1080p', 'S01E11 WEB-DL', 'S01E11 AMZN', 'S01E11 x264']) {
      expect(nameRefusalOf('pair', name), name).toBe('name_too_broad');
    }
    // A pair whose number really has that title would stop the right release.
    expect(nameRefusalOf('pair', 'S01E12 Secret Menu Item')).toBe('name_is_correct');
    expect(nameRefusalOf('pair', 'S01E12 Secret Menu')).toBe('name_is_correct');
    expect(nameRefusalOf('pair', 'S01E23 All You Can Fit')).toBe('name_is_correct');
    expect(nameRefusalOf('pair', 'S01E23 All You Can Fit', { episodes: [] })).toBeNull(); // nothing to compare with
    // Another library show the term would also reach.
    expect(
      deriveMislabelNameTerm({ seriesTitle: 'Lost', kind: 'pair', name: 'S01E11 Secret Menu', otherSeriesTitles: ['Lost Girl'] }),
    ).toEqual({ refused: 'names_other_series', otherSeries: 'Lost Girl' });
    expect(
      deriveMislabelNameTerm({
        seriesTitle: 'Lost',
        kind: 'alias',
        name: 'Perdidos',
        alternateTitles: ['Perdidos'],
        otherSeriesTitles: ['Perdidos en el espacio'],
      }),
    ).toEqual({ refused: 'names_other_series', otherSeries: 'Perdidos en el espacio' });
    // The five Case A names reach neither the parent show nor any other.
    for (const [kind, name] of HAND_NAMES) {
      expect(nameRefusalOf(kind, name, { otherSeriesTitles: ['Regular Show', 'Lost', 'The Lost Tapes'] }), name).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// The writer
// ---------------------------------------------------------------------------

interface StubOptions {
  failList?: boolean;
  failPut?: boolean;
  /** Sonarr answers the write but keeps nothing (the read-back then disagrees). */
  dropWrites?: boolean;
  /** The GET after a write throws. */
  failReadBack?: boolean;
  onReadBack?: () => Promise<void>;
  /** The series read throws. */
  failSeries?: boolean;
}

function stubSonarr(initial: MislabelReleaseProfile[] = [], opts: StubOptions = {}) {
  const profiles: MislabelReleaseProfile[] = initial.map((p) => ({ ...p, ignored: [...(p.ignored ?? [])] }));
  const log: string[] = [];
  let nextId = 40;
  let wrote = false;
  const copy = () => profiles.map((p) => ({ ...p, ignored: [...(p.ignored ?? [])], tags: [...(p.tags ?? [])] }));
  const sonarr: MislabelBlockSonarr = {
    read: {
      async findSeries(id: number) {
        log.push(`series ${id}`);
        if (opts.failSeries) throw new Error('sonarr down');
        return id === 1061 ? { title: LOST_TAPES, alternateTitles: [{ title: GERMAN_TITLE }] } : null;
      },
      async listEpisodes(id: number) {
        log.push(`episodes ${id}`);
        return id === 1061 ? LOST_TAPES_EPISODES : [];
      },
    },
    write: {
      async listReleaseProfiles() {
        log.push('GET');
        if (opts.failList) throw new Error('sonarr down');
        if (wrote) {
          wrote = false;
          if (opts.failReadBack) throw new Error('read-back failed');
          await opts.onReadBack?.();
        }
        return copy();
      },
      async createReleaseProfile(body: MislabelReleaseProfileBody) {
        log.push('POST');
        if (opts.failPut) throw new Error('POST refused');
        wrote = true;
        const created = { ...body, ignored: [...body.ignored], id: nextId++ };
        if (!opts.dropWrites) profiles.push(created);
        return created;
      },
      async updateReleaseProfile(body: MislabelReleaseProfileBody & { id: number }) {
        log.push(`PUT ${body.id}`);
        if (opts.failPut) throw new Error('PUT refused');
        wrote = true;
        const i = profiles.findIndex((p) => p.id === body.id);
        if (!opts.dropWrites && i >= 0) profiles[i] = { ...body, ignored: [...body.ignored] };
        return body;
      },
    },
  };
  const ours = () => profiles.filter((p) => p.name === MISLABEL_BLOCK_PROFILE_NAME);
  return { sonarr, profiles, log, ours };
}

/** Profiles that are not ours: the Release Block's and Case A's hand-made per-series one. */
const othersProfiles = (): MislabelReleaseProfile[] => [
  { id: 3, name: 'haynesnetwork: deleted releases (managed, do not edit)', enabled: true, required: [], ignored: ['hnet-release-block-sentinel'], indexerId: 0, tags: [] },
  { id: 31, name: 'lost tapes', enabled: true, required: [], ignored: ['/bioma/i'], indexerId: 0, tags: [12] },
];

const T0 = new Date('2026-10-12T12:00:00Z');
const DAY = 86_400_000;

describe('the Mislabel Block writer (ADR-110 C-04, C-05, C-08)', () => {
  let t: TestDb;
  let requesterId: string;
  let otherId: string;
  let adminId: string;
  let lostTapesId: string;
  let lostId: string;

  const remapRepair = async (o: Partial<typeof repairRequests.$inferInsert> = {}) => {
    const [row] = await t.db
      .insert(repairRequests)
      .values({
        requesterId,
        mediaItemId: lostTapesId,
        kind: 'remap',
        scope: 'season',
        seasonNumber: 1,
        status: 'completed',
        preview: {
          claim: { kind: 'shift', fromEpisodeNumber: 12, throughEpisodeNumber: 20, by: -1 },
          digest: 'd1',
          seriesId: 1061,
          seriesTitle: LOST_TAPES,
          moves: [],
          vacatedEpisodeIds: [],
          mislabelGroups: [
            { releaseGroup: 'BiOMA', fileCount: 8 },
            { releaseGroup: 'OldT', fileCount: 1 },
          ],
        },
        ...o,
      })
      .returning({ id: repairRequests.id });
    return row!.id;
  };

  const offer = (sonarr: MislabelBlockSonarr, repairRequestId: string, o: Partial<Parameters<typeof addMislabelTermFromRemap>[0]> = {}) =>
    addMislabelTermFromRemap({
      db: t.db,
      sonarr,
      repairRequestId,
      releaseGroup: 'BiOMA',
      requesterId,
      requesterIsAdmin: false,
      now: T0,
      logger: silentDomainLogger,
      ...o,
    });

  const rows = () => t.db.select().from(mislabelBlockTerms);
  const activeRows = () => t.db.select().from(mislabelBlockTerms).where(eq(mislabelBlockTerms.state, 'active'));

  beforeAll(async () => {
    t = await bootMigratedDb();
    requesterId = (await createUser(t.db, { email: 'remapper@example.com', displayName: 'Remapper' })).id;
    otherId = (await createUser(t.db, { email: 'other@example.com', displayName: 'Other' })).id;
    adminId = (await createUser(t.db, { email: 'staff@example.com', displayName: 'Staff' })).id;
    const base = { monitored: true, qualityProfileId: 1, qualityProfileName: 'Any', rootFolder: '/tv' };
    await upsertMediaItemsBatch({
      db: t.db,
      arrKind: 'sonarr',
      items: [
        { arrItemId: 1061, tvdbId: 451234, title: LOST_TAPES, sortTitle: 'regular show lost tapes', ...base },
        { arrItemId: 77, tvdbId: 73739, title: 'Lost', sortTitle: 'lost', ...base },
        { arrItemId: 78, tvdbId: 182181, title: 'Lost Girl', sortTitle: 'lost girl', ...base },
      ],
    });
    const items = await t.db.query.mediaItems.findMany();
    lostTapesId = items.find((i) => i.arrItemId === 1061)!.id;
    lostId = items.find((i) => i.arrItemId === 77)!.id;
  }, 240_000);

  afterAll(async () => {
    await t.stop();
  });

  beforeEach(async () => {
    await t.db.delete(mislabelBlockTerms);
    await t.db.delete(permissionAudit).where(eq(permissionAudit.action, 'remove_mislabel_term'));
    await t.db.delete(repairRequests);
  });

  it('writes the one profile, reads it back, then inserts the row in that transaction', async () => {
    let rowsAtReadBack = -1;
    const s = stubSonarr(othersProfiles(), {
      onReadBack: async () => {
        rowsAtReadBack = (await rows()).length;
      },
    });
    const id = await remapRepair();
    const result = await offer(s.sonarr, id);
    const term = termOf(LOST_TAPES, 'BiOMA');
    expect(result).toMatchObject({ saved: true, term, alreadyActive: false });
    expect(s.log).toEqual(['GET', 'POST', 'GET']);
    // Nothing is committed before the read-back; the failed read-back cases below show the row rolls back with it.
    expect(rowsAtReadBack).toBe(0);
    expect(s.ours()).toEqual([
      { id: 40, name: MISLABEL_BLOCK_PROFILE_NAME, enabled: true, required: [], ignored: [MISLABEL_BLOCK_SENTINEL, term], indexerId: 0, tags: [] },
    ]);
    // Never another profile.
    expect(s.profiles.filter((p) => p.id !== 40)).toEqual(othersProfiles());
    const [row] = await rows();
    expect(row).toMatchObject({
      id: (result as { termId: string }).termId,
      instance: 'sonarr',
      seriesId: 1061,
      mediaItemId: lostTapesId,
      seriesTitle: LOST_TAPES,
      releaseGroup: 'BiOMA',
      term,
      state: 'active',
      origin: 'remap',
      repairRequestId: id,
      createdBy: requesterId,
      endedAt: null,
    });
    expect(row!.expiresAt.getTime() - T0.getTime()).toBe(365 * DAY);
  });

  it('answers a repeated offer with the existing term and writes nothing', async () => {
    const s = stubSonarr();
    const id = await remapRepair();
    const first = await offer(s.sonarr, id);
    s.log.length = 0;
    const again = await offer(s.sonarr, id, { releaseGroup: 'bioma' });
    expect(again).toEqual({ saved: true, term: (first as { term: string }).term, termId: (first as { termId: string }).termId, alreadyActive: true });
    expect(s.log).toEqual([]);
    expect(await rows()).toHaveLength(1);
  });

  it("checks the offer: a completed shift re-map, the requester or staff, a group with two or more files", async () => {
    const s = stubSonarr();
    const reasons = async (id: string, o: Partial<Parameters<typeof addMislabelTermFromRemap>[0]> = {}) => {
      const r = await offer(s.sonarr, id, o);
      return r.saved ? 'saved' : r.reason;
    };
    expect(await reasons('00000000-0000-4000-8000-000000000000')).toBe('not_found');
    expect(await reasons(await remapRepair({ kind: 'import_download' }))).toBe('not_remap');
    expect(await reasons(await remapRepair({ status: 'actioned' }))).toBe('not_completed');
    expect(await reasons(await remapRepair({ status: 'failed' }))).toBe('not_completed');
    expect(await reasons(await remapRepair(), { requesterId: otherId })).toBe('not_requester');
    expect(
      await reasons(
        await remapRepair({
          preview: { claim: { kind: 'single', fromEpisodeId: 1, toEpisodeId: 2 }, seriesId: 1061, mislabelGroups: [{ releaseGroup: 'BiOMA', fileCount: 2 }] },
        }),
      ),
    ).toBe('not_shift');
    expect(await reasons(await remapRepair({ preview: { claim: { kind: 'shift' } } }))).toBe('preview_invalid');
    expect(
      await reasons(
        await remapRepair({ preview: { claim: { kind: 'shift' }, seriesId: 999, mislabelGroups: [{ releaseGroup: 'BiOMA', fileCount: 8 }] } }),
      ),
    ).toBe('preview_invalid');
    expect(await reasons(await remapRepair(), { releaseGroup: 'OldT' })).toBe('too_few_files');
    expect(await reasons(await remapRepair(), { releaseGroup: 'NTb' })).toBe('group_not_offered');
    expect(s.log).toEqual([]); // nothing was read or written
    expect(await rows()).toHaveLength(0);
    // Staff may save it for the requester; the creator is whoever confirmed it.
    const r = await offer(s.sonarr, await remapRepair(), { requesterId: adminId, requesterIsAdmin: true });
    expect(r.saved).toBe(true);
    expect((await rows())[0]!.createdBy).toBe(adminId);
  });

  it('refuses a term that would also block another library show, before any write', async () => {
    const s = stubSonarr();
    const id = await remapRepair({ mediaItemId: lostId, preview: { claim: { kind: 'shift' }, seriesId: 77, mislabelGroups: [{ releaseGroup: 'BiOMA', fileCount: 3 }] } });
    const r = await offer(s.sonarr, id);
    expect(r).toMatchObject({ saved: false, reason: 'names_other_series' });
    expect(s.log).toEqual([]);
  });

  it('stops at 500 active terms', async () => {
    await t.db.insert(mislabelBlockTerms).values(
      Array.from({ length: MISLABEL_TERM_CAP }, (_, i) => ({
        seriesId: 10_000 + i,
        seriesTitle: `Show ${i}`,
        releaseGroup: 'GRP',
        term: `/^(?=.*(?<![a-z0-9])show[^a-z0-9]*n${i}(?![a-z0-9]))(?=.*(?<![a-z0-9])grp(?![a-z0-9]))/i`,
        origin: 'adoption' as const,
        expiresAt: new Date(T0.getTime() + 100 * DAY),
      })),
    );
    const s = stubSonarr();
    const r = await offer(s.sonarr, await remapRepair());
    expect(r).toMatchObject({ saved: false, reason: 'cap_reached' });
    expect(s.log).toEqual([]);
  });

  it('runs the grammar check on every term before any write', async () => {
    await t.db.insert(mislabelBlockTerms).values({
      seriesId: 5,
      seriesTitle: 'Broken',
      releaseGroup: 'BAD',
      term: '/^(?=.*(?<![a-z0-9])broken(?![a-z0-9]))(?=.*bad(/i', // .NET cannot compile it: it would stop every grab
      origin: 'adoption',
      expiresAt: new Date(T0.getTime() + 100 * DAY),
    });
    const s = stubSonarr();
    const r = await offer(s.sonarr, await remapRepair());
    expect(r).toMatchObject({ saved: false, reason: 'invalid_terms' });
    const err = await reconcileMislabelBlock({ db: t.db, sonarr: s.sonarr, now: T0, logger: silentDomainLogger }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MislabelBlockError);
    expect((err as MislabelBlockError).step).toBe('validate');
    expect(s.log).toEqual([]); // not even a GET
    expect(await activeRows()).toHaveLength(1); // only the seeded row
  });

  it('a write that cannot be read back answers "not saved" and leaves no active term', async () => {
    const term = termOf(LOST_TAPES, 'BiOMA');
    for (const [opts, reason, log] of [
      [{ dropWrites: true }, 'read_back_failed', ['GET', 'POST', 'GET']],
      [{ failReadBack: true }, 'read_back_failed', ['GET', 'POST', 'GET']],
      [{ failPut: true }, 'write_failed', ['GET', 'POST']],
    ] as const) {
      await t.db.delete(mislabelBlockTerms);
      const s = stubSonarr([], opts);
      const r = await offer(s.sonarr, await remapRepair());
      expect(r).toMatchObject({ saved: false, reason });
      expect((r as { message: string }).message).toMatch(/not saved|nothing was saved/);
      expect(s.log).toEqual(log);
      expect(await activeRows()).toHaveLength(0);
      // The attempt is recorded as `removed`.
      expect(await rows()).toEqual([
        expect.objectContaining({ term, state: 'removed', endedReason: reason, endedAt: T0, repairRequestId: expect.any(String) }),
      ]);
    }
    // Sonarr unreachable before anything was sent: refused, nothing recorded.
    await t.db.delete(mislabelBlockTerms);
    const down = stubSonarr([], { failList: true });
    expect(await offer(down.sonarr, await remapRepair())).toMatchObject({ saved: false, reason: 'sonarr_unavailable' });
    expect(await rows()).toHaveLength(0);
    // A healthy retry then saves (the removed row does not hold the (series, group) slot).
    const ok = stubSonarr();
    expect(await offer(ok.sonarr, await remapRepair())).toMatchObject({ saved: true, alreadyActive: false });
  });

  it('expires a term after 365 days and takes it out of the profile', async () => {
    const s = stubSonarr();
    const saved = await offer(s.sonarr, await remapRepair());
    expect(saved.saved).toBe(true);
    s.log.length = 0;

    const before = await mislabelBlockUpkeep({ db: t.db, sonarr: s.sonarr, now: new Date(T0.getTime() + 364 * DAY), logger: silentDomainLogger });
    expect(before).toEqual({ expiring: 0, drift: null, report: null, error: null });
    expect(s.log).toEqual(['GET']);

    s.log.length = 0;
    const at = new Date(T0.getTime() + 365 * DAY + 60_000);
    const due = await mislabelBlockUpkeep({ db: t.db, sonarr: s.sonarr, now: at, logger: silentDomainLogger });
    expect(due).toMatchObject({ expiring: 1, error: null, report: { expired: 1, total: 0, removed: 1, wrote: true } });
    expect(s.log).toEqual(['GET', 'GET', 'PUT 40', 'GET']);
    expect(s.ours()[0]!.ignored).toEqual([MISLABEL_BLOCK_SENTINEL]);
    expect(await rows()).toEqual([expect.objectContaining({ state: 'expired', endedAt: at, endedReason: 'expired' })]);

    s.log.length = 0;
    expect(await mislabelBlockUpkeep({ db: t.db, sonarr: s.sonarr, now: at, logger: silentDomainLogger })).toEqual({
      expiring: 0,
      drift: null,
      report: null,
      error: null,
    });
    expect(s.log).toEqual(['GET']);
  });

  it('upkeep reads nothing before the first term', async () => {
    const s = stubSonarr();
    expect(await mislabelBlockUpkeep({ db: t.db, sonarr: s.sonarr, now: T0, logger: silentDomainLogger })).toEqual({
      expiring: 0,
      drift: null,
      report: null,
      error: null,
    });
    expect(s.log).toEqual([]);
    expect(s.ours()).toEqual([]);
  });

  it('repairs drift: a deleted profile, edited terms, a disabled or tagged profile; refuses a copy', async () => {
    const s = stubSonarr(othersProfiles());
    const saved = await offer(s.sonarr, await remapRepair());
    const term = (saved as { term: string }).term;
    const upkeep = () => mislabelBlockUpkeep({ db: t.db, sonarr: s.sonarr, now: T0, logger: silentDomainLogger });
    const desired = { name: MISLABEL_BLOCK_PROFILE_NAME, enabled: true, required: [], ignored: [MISLABEL_BLOCK_SENTINEL, term], indexerId: 0, tags: [] };

    // Deleted by hand: re-created.
    s.profiles.splice(s.profiles.findIndex((p) => p.name === MISLABEL_BLOCK_PROFILE_NAME), 1);
    expect(await upkeep()).toMatchObject({ drift: 'missing', report: { wrote: true, added: 1 }, error: null });
    expect(s.ours()).toEqual([{ ...desired, id: 41 }]);

    // Terms edited by hand (ours dropped, another added): put back exactly.
    s.ours()[0]!.ignored = [MISLABEL_BLOCK_SENTINEL, '/hand/i'];
    expect(await upkeep()).toMatchObject({ drift: 'terms', report: { wrote: true, added: 1, removed: 1 } });
    expect(s.ours()).toEqual([{ ...desired, id: 41 }]);

    // Disabled, then tagged / required by hand.
    s.ours()[0]!.enabled = false;
    expect(await upkeep()).toMatchObject({ drift: 'disabled', report: { wrote: true } });
    Object.assign(s.ours()[0]!, { tags: [12], required: ['/x/i'] });
    expect(await upkeep()).toMatchObject({ drift: 'edited', report: { wrote: true } });
    expect(s.ours()).toEqual([{ ...desired, id: 41 }]);

    // A copy of the profile: reported, never merged or deleted; every write refuses until staff remove it.
    s.profiles.push({ ...desired, id: 99, ignored: [MISLABEL_BLOCK_SENTINEL] });
    s.log.length = 0;
    const dup = await upkeep();
    expect(dup.drift).toBe('duplicate');
    expect(dup.error).toMatch(/duplicate_profile/);
    expect(s.log.filter((l) => l !== 'GET')).toEqual([]);
    const other = await offer(s.sonarr, await remapRepair({ preview: { claim: { kind: 'shift' }, seriesId: 1061, mislabelGroups: [{ releaseGroup: 'NTb', fileCount: 2 }] } }), { releaseGroup: 'NTb' });
    expect(other).toMatchObject({ saved: false, reason: 'duplicate_profile' });
    expect(s.log.filter((l) => l !== 'GET')).toEqual([]);
    // Other profiles were never touched.
    expect(s.profiles.filter((p) => p.id === 3 || p.id === 31)).toEqual(othersProfiles());
  });

  it('reconcile --dry-run reports the drift and writes nothing', async () => {
    const s = stubSonarr();
    await offer(s.sonarr, await remapRepair());
    s.profiles.length = 0;
    s.log.length = 0;
    const report = await reconcileMislabelBlock({ db: t.db, sonarr: s.sonarr, now: T0, dryRun: true, logger: silentDomainLogger });
    expect(report).toMatchObject({ dryRun: true, drift: 'missing', wrote: false, added: 1, total: 1 });
    expect(s.log).toEqual(['GET']);
  });

  it('staff removal writes the profile without the term, then the row and its audit row', async () => {
    const s = stubSonarr();
    const saved = await offer(s.sonarr, await remapRepair());
    const termId = (saved as { termId: string }).termId;
    const term = (saved as { term: string }).term;

    // A failed write leaves the term active and audits nothing.
    const broken = stubSonarr(s.profiles, { failPut: true });
    expect(await removeMislabelTerm({ db: t.db, sonarr: broken.sonarr, termId, actorId: adminId, now: T0, logger: silentDomainLogger })).toMatchObject({
      removed: false,
      reason: 'write_failed',
    });
    expect(await activeRows()).toHaveLength(1);
    expect(await t.db.select().from(permissionAudit).where(eq(permissionAudit.action, 'remove_mislabel_term'))).toHaveLength(0);

    const at = new Date(T0.getTime() + DAY);
    const r = await removeMislabelTerm({ db: t.db, sonarr: s.sonarr, termId, actorId: adminId, note: '  BiOMA fixed their numbering  ', now: at, logger: silentDomainLogger });
    expect(r).toEqual({ removed: true, termId, seriesId: 1061, kind: 'group', releaseGroup: 'BiOMA', nameToken: null, term });
    expect(s.ours()[0]!.ignored).toEqual([MISLABEL_BLOCK_SENTINEL]);
    expect(await rows()).toEqual([expect.objectContaining({ id: termId, state: 'removed', endedAt: at, endedReason: 'staff_removed' })]);
    const audit = await t.db
      .select()
      .from(permissionAudit)
      .where(and(eq(permissionAudit.action, 'remove_mislabel_term'), eq(permissionAudit.actorId, adminId)));
    expect(audit).toHaveLength(1);
    expect(audit[0]!.detail).toEqual({
      termId,
      seriesId: 1061,
      seriesTitle: LOST_TAPES,
      kind: 'group',
      releaseGroup: 'BiOMA',
      nameToken: null,
      term,
      note: 'BiOMA fixed their numbering',
    });

    expect(await removeMislabelTerm({ db: t.db, sonarr: s.sonarr, termId, actorId: adminId, logger: silentDomainLogger })).toMatchObject({
      removed: false,
      reason: 'not_active',
    });
  });

  it("adopts Case A's hand-made profile as one term; the dry run writes nothing", async () => {
    const s = stubSonarr(othersProfiles());
    const dry = await adoptMislabelTerm({ db: t.db, sonarr: s.sonarr, seriesId: 1061, releaseGroup: 'BiOMA', dryRun: true, logger: silentDomainLogger });
    expect(dry).toEqual({ saved: false, dryRun: true, seriesTitle: LOST_TAPES, term: termOf(LOST_TAPES, 'BiOMA'), alreadyActive: false });
    expect(s.log).toEqual(['series 1061']);
    expect(await rows()).toHaveLength(0);

    const r = await adoptMislabelTerm({ db: t.db, sonarr: s.sonarr, seriesId: 1061, releaseGroup: 'BiOMA', now: T0, logger: silentDomainLogger });
    expect(r).toMatchObject({ saved: true, alreadyActive: false });
    expect(await rows()).toEqual([
      expect.objectContaining({ origin: 'adoption', repairRequestId: null, createdBy: null, seriesId: 1061, mediaItemId: lostTapesId, state: 'active' }),
    ]);
    // The hand-made profile is left for the hand removal (PLAN-077 P4).
    expect(s.profiles.find((p) => p.id === 31)).toEqual(othersProfiles()[1]);
    expect(await adoptMislabelTerm({ db: t.db, sonarr: s.sonarr, seriesId: 1061, releaseGroup: 'bioma', dryRun: true, logger: silentDomainLogger })).toMatchObject({
      alreadyActive: true,
    });
    expect(await adoptMislabelTerm({ db: t.db, sonarr: s.sonarr, seriesId: 1061, releaseGroup: 'BiOMA', logger: silentDomainLogger })).toMatchObject({
      saved: true,
      alreadyActive: true,
    });
    expect(await adoptMislabelTerm({ db: t.db, sonarr: s.sonarr, seriesId: 4242, releaseGroup: 'BiOMA', logger: silentDomainLogger })).toMatchObject({
      saved: false,
      reason: 'not_a_series',
    });
  });

  it('lists terms for staff and for one series', async () => {
    const s = stubSonarr();
    const saved = await offer(s.sonarr, await remapRepair());
    await removeMislabelTerm({ db: t.db, sonarr: s.sonarr, termId: (saved as { termId: string }).termId, actorId: adminId, now: T0, logger: silentDomainLogger });
    await offer(s.sonarr, await remapRepair(), { now: new Date(T0.getTime() + 60_000) });

    const all = await listMislabelTerms({ db: t.db });
    expect(all.map((r) => r.state)).toEqual(['active', 'removed']); // newest first
    expect(all[0]).toMatchObject({ seriesId: 1061, releaseGroup: 'BiOMA', createdByName: 'Remapper', origin: 'remap' });
    expect(await listMislabelTerms({ db: t.db, state: 'removed' })).toHaveLength(1);
    const forSeries = await mislabelTermsForSeries({ db: t.db, seriesId: 1061 });
    expect(forSeries.map((r) => r.state)).toEqual(['active']);
    expect(await mislabelTermsForSeries({ db: t.db, seriesId: 1061, state: 'all' })).toHaveLength(2);
    expect(await mislabelTermsForSeries({ db: t.db, seriesId: 77 })).toEqual([]);
  });

  // ADR-113 — the mislabelled-name terms through the same writer.
  const addName = (sonarr: MislabelBlockSonarr, kind: MislabelNameKind, name: string, o: Partial<Parameters<typeof addMislabelNameTerm>[0]> = {}) =>
    addMislabelNameTerm({ db: t.db, sonarr, seriesId: 1061, kind, name, origin: 'adoption', now: T0, logger: silentDomainLogger, ...o });

  it("adopts the hand profile's five names beside the group term, each written and read back", async () => {
    const s = stubSonarr(othersProfiles());
    const group = await adoptMislabelTerm({ db: t.db, sonarr: s.sonarr, seriesId: 1061, releaseGroup: 'BiOMA', now: T0, logger: silentDomainLogger });
    expect(group.saved).toBe(true);
    s.log.length = 0;

    // The dry run derives and reports, and writes nothing.
    const dry = await addName(s.sonarr, 'pair', 'S01E11 Secret Menu', { dryRun: true });
    expect(dry).toEqual({
      saved: false,
      dryRun: true,
      seriesTitle: LOST_TAPES,
      term: nameTermOf('pair', 'S01E11 Secret Menu').term,
      alreadyActive: false,
      kind: 'pair',
      nameToken: 'S01E11 Secret Menu',
    });
    expect(s.log).toEqual(['series 1061', 'episodes 1061']);
    expect(await activeRows()).toHaveLength(1);

    const saved: string[] = [];
    for (const [kind, name] of HAND_NAMES) {
      s.log.length = 0;
      const r = await addName(s.sonarr, kind, name);
      expect(r, name).toMatchObject({ saved: true, alreadyActive: false, kind });
      // Sonarr's series read (and a pair's episodes), then the profile write and its read-back.
      expect(s.log).toEqual([...(kind === 'pair' ? ['series 1061', 'episodes 1061'] : ['series 1061']), 'GET', 'PUT 40', 'GET']);
      saved.push((r as { term: string }).term);
    }
    // The sentinel first, then every active term (rows made in the same instant come in id order).
    expect(s.ours()[0]!.ignored![0]).toBe(MISLABEL_BLOCK_SENTINEL);
    expect([...s.ours()[0]!.ignored!].sort()).toEqual([MISLABEL_BLOCK_SENTINEL, termOf(LOST_TAPES, 'BiOMA'), ...saved].sort());
    // Every blocked Case A name is now caught by the managed profile; the right releases are not.
    const blocks = (name: string) => s.ours()[0]!.ignored!.some((term) => termMatchesRaw(term, name));
    for (const name of [
      GERMAN_GRAB,
      BIOMA_E11,
      'Regular.Show..The.Lost.Tapes.S01E11.Secret.Menu.1080p.AMZN.WEB-DL.DDP2.0.H.264-NTb',
      'Regular.Show.The.Lost.Tapes.S01E13E14.1080p.HMAX.WEB-DL-GRP',
      'Regular.Show.The.Lost.Tapes.S01E13.Smoke.Alarm.1080p-GRP',
      'Regular.Show.The.Lost.Tapes.S01E24.All.You.Can.Fit.1080p.DSNP.WEB-DL-FLUX',
    ]) {
      expect(blocks(name), name).toBe(true);
    }
    for (const name of [
      OLDT_E10,
      'Regular.Show.The.Lost.Tapes.S01E12.Secret.Menu.Item.1080p.AMZN.WEB-DL-NTb',
      'Regular.Show.The.Lost.Tapes.S01E14.Smoke.Alarm.1080p-GRP',
      'Regular.Show.The.Lost.Tapes.S01E23.All.You.Can.Fit.1080p.DSNP.WEB-DL-FLUX',
    ]) {
      expect(blocks(name), name).toBe(false);
    }
    // Other profiles (the Release Block and the hand profile) were never touched.
    expect(s.profiles.filter((p) => p.id === 3 || p.id === 31)).toEqual(othersProfiles());

    const names = await mislabelTermsForSeries({ db: t.db, seriesId: 1061 });
    expect(names).toHaveLength(6);
    expect(names.find((r) => r.kind === 'alias')).toMatchObject({
      releaseGroup: null,
      nameToken: GERMAN_TITLE,
      origin: 'adoption',
      repairRequestId: null,
      createdBy: null,
      mediaItemId: lostTapesId,
      state: 'active',
    });
    expect(names.filter((r) => r.kind === 'pair').map((r) => r.nameToken).sort()).toEqual([
      'S01E11 Secret Menu',
      'S01E13 Smoke Alarm',
      'S01E24 All You Can Fit',
    ]);
    expect(names.find((r) => r.kind === 'group')).toMatchObject({ releaseGroup: 'BiOMA', nameToken: null });

    // Again, in another spelling: already active, nothing written.
    s.log.length = 0;
    expect(await addName(s.sonarr, 'pair', 's1e11 secret  menu', { origin: 'staff' })).toMatchObject({ saved: true, alreadyActive: true });
    expect(await addName(s.sonarr, 'double', 'S01E13-E14', { dryRun: true })).toMatchObject({ alreadyActive: true });
    expect(s.log.filter((l) => !l.startsWith('series') && !l.startsWith('episodes'))).toEqual([]);
    expect(await activeRows()).toHaveLength(6);

    // The upkeep keeps the profile with name terms in it.
    s.log.length = 0;
    expect(await mislabelBlockUpkeep({ db: t.db, sonarr: s.sonarr, now: T0, logger: silentDomainLogger })).toEqual({
      expiring: 0,
      drift: null,
      report: null,
      error: null,
    });
    s.ours()[0]!.ignored = [MISLABEL_BLOCK_SENTINEL];
    expect(await mislabelBlockUpkeep({ db: t.db, sonarr: s.sonarr, now: T0, logger: silentDomainLogger })).toMatchObject({
      drift: 'terms',
      report: { wrote: true, added: 6 },
      error: null,
    });
  });

  it('a staff name is refused before any write, and a write that is not read back leaves no active term', async () => {
    const s = stubSonarr();
    for (const [kind, name, reason] of [
      ['alias', 'Regular Show Las cintas perdidas', 'alias_not_listed'],
      ['alias', LOST_TAPES, 'alias_is_title'],
      ['pair', 'S01E12 Secret Menu Item', 'name_is_correct'],
      ['pair', 'S01E11 1080p', 'name_too_broad'],
      ['pair', 'Secret Menu', 'name_unwritable'],
    ] as const) {
      expect(await addName(s.sonarr, kind, name, { origin: 'staff' }), name).toMatchObject({ saved: false, reason });
    }
    expect(await addName(s.sonarr, 'alias', GERMAN_TITLE, { seriesId: 4242 })).toMatchObject({ saved: false, reason: 'not_a_series' });
    const down = stubSonarr([], { failSeries: true });
    expect(await addName(down.sonarr, 'alias', GERMAN_TITLE)).toMatchObject({ saved: false, reason: 'sonarr_unavailable' });
    expect(s.log.filter((l) => l === 'GET' || l.startsWith('P'))).toEqual([]);
    expect(await rows()).toHaveLength(0);

    const broken = stubSonarr([], { dropWrites: true });
    const r = await addName(broken.sonarr, 'double', 'S01E13E14', { origin: 'staff' });
    expect(r).toMatchObject({ saved: false, reason: 'read_back_failed' });
    expect(await rows()).toEqual([
      expect.objectContaining({
        kind: 'double',
        nameToken: 'S01E13E14',
        releaseGroup: null,
        origin: 'staff',
        state: 'removed',
        endedReason: 'read_back_failed',
      }),
    ]);
    // A healthy retry saves it (the removed row does not hold the slot).
    expect(await addName(s.sonarr, 'double', 'S01E13E14', { origin: 'staff' })).toMatchObject({ saved: true, alreadyActive: false });
  });

  it('staff remove a name term with its audit row', async () => {
    const s = stubSonarr();
    const saved = await addName(s.sonarr, 'pair', 'S01E24 All You Can Fit', { origin: 'staff' });
    const termId = (saved as { termId: string }).termId;
    const term = (saved as { term: string }).term;
    expect(s.ours()[0]!.ignored).toEqual([MISLABEL_BLOCK_SENTINEL, term]);
    const r = await removeMislabelTerm({ db: t.db, sonarr: s.sonarr, termId, actorId: adminId, now: T0, logger: silentDomainLogger });
    expect(r).toEqual({ removed: true, termId, seriesId: 1061, kind: 'pair', releaseGroup: null, nameToken: 'S01E24 All You Can Fit', term });
    expect(s.ours()[0]!.ignored).toEqual([MISLABEL_BLOCK_SENTINEL]);
    const [audit] = await t.db
      .select()
      .from(permissionAudit)
      .where(and(eq(permissionAudit.action, 'remove_mislabel_term'), eq(permissionAudit.actorId, adminId)));
    expect(audit!.detail).toMatchObject({ termId, kind: 'pair', releaseGroup: null, nameToken: 'S01E24 All You Can Fit', term, note: null });
    expect(await listMislabelTerms({ db: t.db })).toEqual([
      expect.objectContaining({ id: termId, kind: 'pair', origin: 'staff', state: 'removed', endedReason: 'staff_removed' }),
    ]);
  });
});
