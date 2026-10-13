// ADR-109 C-07 / DESIGN-055 D-08 (PLAN-077 P6) — the Audio Preference's Plex calls, on bodies shaped like the live reads of
// 2026-10-13: Regular Show: The Lost Tapes (a show, `audioLanguage` set to en-US on HaynesOps, rating key 106050),
// GoodFellas (a movie: no audio-language setting, DESIGN-055 Q-08) and The Lost Tapes S01E12 (Portuguese first and
// the file's default, English second).
import { describe, expect, it } from 'vitest';
import { PlexReadClient } from '../src/read';
import { PlexWriteClient } from '../src/write';
import { parseEnumValues } from '../src/schemas';
import { plexStub, TEST_CLIENT_OPTIONS } from './helpers';

const ENUM =
  ':Account default|en-US:English|pt-BR:Português|ca-ES:català|en-US:English|en-AU:English (Australia)|en-GB:English (UK)|es-ES:Español|es-MX:Español (México)|pt-BR:Português|pt-PT:Português (Portugal)|bg-BG:български|ja-JP:日本語';

export const LOST_TAPES_PREFS = {
  MediaContainer: {
    size: 1,
    Metadata: [
      {
        ratingKey: '106050',
        type: 'show',
        title: 'Regular Show: The Lost Tapes',
        Preferences: {
          Setting: [
            { id: 'episodeSort', label: 'Episode sorting', type: 'int', default: '-1', value: '-1', enumValues: '-1:Library default|0:Oldest first|1:Newest first' },
            { id: 'languageOverride', type: 'text', default: '', value: '' },
            { id: 'audioLanguage', label: 'Preferred audio language', type: 'text', default: '', value: 'en-US', enumValues: ENUM },
            { id: 'subtitleLanguage', type: 'text', default: '', value: '' },
            { id: 'subtitleMode', type: 'int', default: '-1', value: '-1' },
          ],
        },
      },
    ],
  },
};

const GOODFELLAS_PREFS = {
  MediaContainer: {
    size: 1,
    Metadata: [
      {
        ratingKey: '8452',
        type: 'movie',
        title: 'GoodFellas',
        Preferences: {
          Setting: [
            { id: 'languageOverride', type: 'text', default: '', value: '' },
            { id: 'useOriginalTitle', type: 'int', default: '-1', value: '-1' },
            { id: 'enableCreditsMarkerGeneration', type: 'int', default: '-1', value: '-1' },
          ],
        },
      },
    ],
  },
};

const S01E12_STREAMS = {
  MediaContainer: {
    size: 1,
    Metadata: [
      {
        ratingKey: '106075',
        type: 'episode',
        title: 'Secret Menu Item',
        index: 12,
        parentIndex: 1,
        Media: [
          {
            id: 1,
            Part: [
              {
                id: 2,
                Stream: [
                  { id: 10, streamType: 1, index: 0, displayTitle: '1080p (H.264)' },
                  { id: 11, streamType: 2, index: 1, languageCode: 'por', languageTag: 'pt-BR', default: true, displayTitle: 'Português (EAC3 5.1)' },
                  { id: 12, streamType: 2, index: 2, languageCode: 'eng', languageTag: 'en-US', selected: true, displayTitle: 'English (EAC3 5.1)' },
                  { id: 13, streamType: 3, index: 3, languageCode: 'eng', displayTitle: 'English (SRT)' },
                ],
              },
            ],
          },
        ],
      },
    ],
  },
};

const read = (stub: ReturnType<typeof plexStub>) => new PlexReadClient({ ...TEST_CLIENT_OPTIONS, fetchImpl: stub.fetchImpl });
const write = (stub: ReturnType<typeof plexStub>) => new PlexWriteClient({ ...TEST_CLIENT_OPTIONS, fetchImpl: stub.fetchImpl });

describe('parseEnumValues', () => {
  it('keeps Plex order, drops repeats, and keeps "Account default" as the empty value', () => {
    const options = parseEnumValues(ENUM);
    expect(options[0]).toEqual({ value: '', label: 'Account default' });
    expect(options[1]).toEqual({ value: 'en-US', label: 'English' });
    expect(options.filter((o) => o.value === 'en-US')).toHaveLength(1);
    expect(options.filter((o) => o.value === 'pt-BR')).toHaveLength(1);
    expect(options.map((o) => o.value)).toContain('ja-JP');
  });
  it('answers [] for nothing', () => {
    expect(parseEnumValues(null)).toEqual([]);
    expect(parseEnumValues('')).toEqual([]);
  });
});

describe('PlexReadClient — getAudioLanguagePreference (DESIGN-055 D-08)', () => {
  it('reads a show’s audioLanguage with includePreferences=1, token in the header only', async () => {
    const stub = plexStub([{ path: '/library/metadata/106050', body: LOST_TAPES_PREFS }]);
    const pref = await read(stub).getAudioLanguagePreference('106050');
    expect(pref).toMatchObject({ ratingKey: '106050', type: 'show', offered: true, value: 'en-US' });
    expect(pref!.options.some((o) => o.value === 'bg-BG')).toBe(true);
    const call = stub.calls[0]!;
    expect(call.url.searchParams.get('includePreferences')).toBe('1');
    expect(call.headers['X-Plex-Token']).toBe('owner-secret-token');
    expect(call.url.toString()).not.toContain('owner-secret-token');
  });

  it('a movie offers no audio language (Q-08)', async () => {
    const stub = plexStub([{ path: '/library/metadata/8452', body: GOODFELLAS_PREFS }]);
    const pref = await read(stub).getAudioLanguagePreference('8452');
    expect(pref).toEqual({ ratingKey: '8452', type: 'movie', offered: false, value: '', options: [] });
  });

  it('a missing item is null', async () => {
    const stub = plexStub([{ path: '/library/metadata/1', body: { MediaContainer: { size: 0 } } }]);
    expect(await read(stub).getAudioLanguagePreference('1')).toBeNull();
  });
});

describe('PlexReadClient — getAudioTracks (DESIGN-055 D-08)', () => {
  it('lists the audio tracks in file order with the default flag and Plex’s own names', async () => {
    const stub = plexStub([{ path: '/library/metadata/106075', body: S01E12_STREAMS }]);
    expect(await read(stub).getAudioTracks('106075')).toEqual([
      { position: 1, languageCode: 'por', displayTitle: 'Português (EAC3 5.1)', isDefault: true },
      { position: 2, languageCode: 'eng', displayTitle: 'English (EAC3 5.1)', isDefault: false },
    ]);
  });
});

describe('PlexWriteClient — setAudioLanguagePreference (ADR-109 C-07)', () => {
  it('PUTs /library/metadata/{key}/prefs?audioLanguage=<locale> on the server, token header-only', async () => {
    const stub = plexStub([{ method: 'PUT', path: '/library/metadata/106050/prefs', body: '' }]);
    await write(stub).setAudioLanguagePreference('106050', 'en-US');
    const call = stub.callsFor('PUT', '/prefs')[0]!;
    expect(call.url.origin + call.url.pathname).toBe('http://plexops.test:32400/library/metadata/106050/prefs');
    expect(call.url.searchParams.get('audioLanguage')).toBe('en-US');
    expect([...call.url.searchParams.keys()]).toEqual(['audioLanguage']);
    expect(call.headers['X-Plex-Token']).toBe('owner-secret-token');
    expect(call.url.toString()).not.toContain('owner-secret-token');
  });

  it('refuses a value that is not a Plex language value, and a blank key, before any request', async () => {
    const stub = plexStub([]);
    await expect(write(stub).setAudioLanguagePreference('106050', 'en-US&subtitleMode=2')).rejects.toThrow(TypeError);
    await expect(write(stub).setAudioLanguagePreference(' ', 'en-US')).rejects.toThrow(TypeError);
    expect(stub.calls).toHaveLength(0);
  });

  it('retries a 503 like a read (the stored value is idempotent)', async () => {
    const stub = plexStub([{ method: 'PUT', path: '/library/metadata/106050/prefs', body: '' }]);
    let calls = 0;
    const fetchImpl = (async (input: unknown, init?: RequestInit) => {
      calls += 1;
      if (calls === 1) return new Response('busy', { status: 503 });
      return stub.fetchImpl(input as string, init);
    }) as typeof fetch;
    await new PlexWriteClient({ ...TEST_CLIENT_OPTIONS, fetchImpl }).setAudioLanguagePreference('106050', 'en-US');
    expect(calls).toBe(2);
    expect(stub.callsFor('PUT', '/prefs')).toHaveLength(1);
  });
});
