// ADR-114 / DESIGN-055 P4 decisions 26-34 — the Watch Carry's Plex calls, offline, on bodies shaped like the live reads of
// 2026-10-13: Mickey Mouse: Mixed-Up Adventures S01 on HaynesTower (a two-episode file is one item, at its first
// number; `Media[].Part[]` carries the file and its byte size), a friend's state on Paw Patrol S06 (a watched item with
// a resume point), the show's `showOrdering` setting, and plex.tv's shared_servers with each friend's accessToken.
import { describe, expect, it } from 'vitest';
import { PlexReadClient } from '../src/read';
import { PlexWriteClient } from '../src/write';
import { isShowOrdering, parseSharedServerAccess, partName } from '../src/carry-read';
import { parseXml } from '../src/xml';
import { plexStub, TEST_CLIENT_OPTIONS } from './helpers';

const read = (stub: ReturnType<typeof plexStub>, token: string = TEST_CLIENT_OPTIONS.token) =>
  new PlexReadClient({ ...TEST_CLIENT_OPTIONS, token, fetchImpl: stub.fetchImpl });
const write = (stub: ReturnType<typeof plexStub>, token: string = TEST_CLIENT_OPTIONS.token) =>
  new PlexWriteClient({ ...TEST_CLIENT_OPTIONS, token, fetchImpl: stub.fetchImpl });

const LEAVES = [
  {
    ratingKey: '46420',
    guid: 'plex://episode/5d9c184be264b7001fce1972',
    type: 'episode',
    title: 'Agent Double-O-Goof',
    parentIndex: 1,
    index: 7,
    viewCount: 1,
    lastViewedAt: 1764207341,
    viewOffset: 421000,
    Media: [
      {
        id: 1,
        Part: [
          {
            id: 2,
            file: '/media/TV/Mickey Mouse - Mixed-Up Adventures (2017)/Season 01/Mickey Mouse - Mixed-Up Adventures (2017) - S01E07-08 - Agent Double-O-Goof and Egg-xasperating! [WEBDL-1080p][AAC 2.0][h264]-CRFW.mkv',
            size: 1560855497,
          },
        ],
      },
    ],
  },
  {
    ratingKey: '46426',
    guid: 'plex://episode/5fbdae39fd628f002d765968',
    type: 'episode',
    title: 'Ye Olde Royal Heist',
    parentIndex: '1',
    index: '13',
    Media: [{ Part: [{ file: 'C:\\TV\\Mickey\\Season 01\\S01E13-14-15-16.mkv', size: '1377201632' }] }],
  },
  // An item Plex has not numbered and without media: kept, with no parts.
  { ratingKey: '9', type: 'episode', title: 'Extra' },
];

function paged(items: unknown[], total: number | null = items.length) {
  return (url: URL) => {
    const start = Number(url.searchParams.get('X-Plex-Container-Start') ?? 0);
    const size = Number(url.searchParams.get('X-Plex-Container-Size') ?? items.length);
    const Metadata = items.slice(start, start + size);
    return { MediaContainer: { size: Metadata.length, ...(total === null ? {} : { totalSize: total }), Metadata } };
  };
}

describe('PlexReadClient — listLeafFiles (ADR-114 C-01)', () => {
  it('reads every episode with the token account’s state and the files it plays (name and byte size)', async () => {
    const stub = plexStub([{ path: '/library/metadata/46412/allLeaves', body: paged(LEAVES) }]);
    const leaves = await read(stub, 'friend-secret-token').listLeafFiles('46412');
    expect(leaves).toEqual([
      {
        ratingKey: '46420',
        guid: 'plex://episode/5d9c184be264b7001fce1972',
        title: 'Agent Double-O-Goof',
        season: 1,
        episode: 7,
        viewCount: 1,
        viewOffset: 421000,
        lastViewedAt: 1764207341,
        parts: [{ name: 'Mickey Mouse - Mixed-Up Adventures (2017) - S01E07-08 - Agent Double-O-Goof and Egg-xasperating! [WEBDL-1080p][AAC 2.0][h264]-CRFW.mkv', size: 1560855497 }],
      },
      {
        ratingKey: '46426',
        guid: 'plex://episode/5fbdae39fd628f002d765968',
        title: 'Ye Olde Royal Heist',
        season: 1,
        episode: 13,
        viewCount: 0,
        viewOffset: 0,
        lastViewedAt: null,
        parts: [{ name: 'S01E13-14-15-16.mkv', size: 1377201632 }],
      },
      { ratingKey: '9', guid: null, title: 'Extra', season: null, episode: null, viewCount: 0, viewOffset: 0, lastViewedAt: null, parts: [] },
    ]);
    const call = stub.calls[0]!;
    // The friend's token rides only in the header.
    expect(call.headers['X-Plex-Token']).toBe('friend-secret-token');
    expect(call.url.toString()).not.toContain('friend-secret-token');
  });

  it('pages to the server’s total', async () => {
    const many = Array.from({ length: 1203 }, (_, i) => ({ ratingKey: String(i), type: 'episode', title: `E${i}`, parentIndex: 1, index: i + 1 }));
    const stub = plexStub([{ path: '/library/metadata/1/allLeaves', body: paged(many) }]);
    expect(await read(stub).listLeafFiles('1')).toHaveLength(1203);
    expect(stub.calls).toHaveLength(3);
  });

  it('throws rather than answer a listing it could not read completely', async () => {
    const stub = plexStub([{ path: '/library/metadata/1/allLeaves', body: paged(LEAVES.slice(0, 1), 5) }]);
    await expect(read(stub).listLeafFiles('1')).rejects.toThrow(/could not be read completely/);
  });
});

describe('PlexReadClient — getShowOrdering (ADR-114 C-08)', () => {
  it('reads the show’s showOrdering setting with includePreferences=1', async () => {
    const body = {
      MediaContainer: {
        Metadata: [
          {
            ratingKey: '46412',
            Preferences: { Setting: [{ id: 'episodeSort', value: '-1' }, { id: 'showOrdering', value: 'tvdbAiring', default: '' }] },
          },
        ],
      },
    };
    const stub = plexStub([{ path: '/library/metadata/46412', body }]);
    expect(await read(stub).getShowOrdering('46412')).toBe('tvdbAiring');
    expect(stub.calls[0]!.url.searchParams.get('includePreferences')).toBe('1');
  });

  it('answers the library default as empty, and null when the item offers no ordering', async () => {
    const def = { MediaContainer: { Metadata: [{ ratingKey: '1', Preferences: { Setting: [{ id: 'showOrdering', value: '' }] } }] } };
    expect(await read(plexStub([{ path: '/library/metadata/1', body: def }])).getShowOrdering('1')).toBe('');
    const movie = { MediaContainer: { Metadata: [{ ratingKey: '2', Preferences: { Setting: [{ id: 'useOriginalTitle', value: '-1' }] } }] } };
    expect(await read(plexStub([{ path: '/library/metadata/2', body: movie }])).getShowOrdering('2')).toBeNull();
  });
});

describe('PlexReadClient — listSharedServerAccess (ADR-114 C-02)', () => {
  const XML = `<?xml version="1.0" encoding="UTF-8"?>
<MediaContainer friendlyName="myPlex" identifier="com.plexapp.plugins.myplex" machineIdentifier="mid-tower" size="3">
  <SharedServer id="1" username="a" email="a@example.test" userID="16768829" accessToken="friend-token-1" name="HaynesTower" acceptedAt="1" invitedAt="1" allowSync="1" owned="0" allLibraries="0">
    <Section id="11" key="4" title="HNet TV Shows" type="show" shared="1"/>
    <Section id="12" key="5" title="HNet Movies" type="movie" shared="0"/>
  </SharedServer>
  <SharedServer id="2" userID="9631953" accessToken="friend-token-2" allLibraries="1"/>
  <SharedServer id="3" userID="777" accessToken="" allLibraries="1"/>
</MediaContainer>`;

  it('keeps each friend’s id, token and shared section keys, and leaves out a share without a token', async () => {
    const stub = plexStub([{ path: '/api/servers/mid-tower/shared_servers', body: XML }]);
    expect(await read(stub).listSharedServerAccess()).toEqual([
      { userId: '16768829', accessToken: 'friend-token-1', allLibraries: false, sectionKeys: ['4'] },
      { userId: '9631953', accessToken: 'friend-token-2', allLibraries: true, sectionKeys: [] },
    ]);
    expect(stub.calls[0]!.url.origin).toBe('https://plex.tv');
    expect(stub.calls[0]!.headers['X-Plex-Token']).toBe('owner-secret-token');
  });

  it('the token-free listSharedServers still never exposes a token', async () => {
    const stub = plexStub([{ path: '/api/servers/mid-tower/shared_servers', body: XML }]);
    const shares = await read(stub).listSharedServers();
    expect(JSON.stringify(shares)).not.toContain('friend-token');
    expect(parseSharedServerAccess(parseXml(XML))).toHaveLength(2);
  });
});

describe('PlexWriteClient — the Watch Carry writes (ADR-114 C-04, C-08)', () => {
  it('setProgress GETs /:/progress with key, identifier, time and state=stopped, as the token account', async () => {
    const stub = plexStub([{ path: '/:/progress', body: '' }]);
    await write(stub, 'friend-secret-token').setProgress('46420', 421000);
    const call = stub.calls[0]!;
    expect(call.method).toBe('GET');
    expect(Object.fromEntries(call.url.searchParams)).toEqual({ key: '46420', identifier: 'com.plexapp.plugins.library', time: '421000', state: 'stopped' });
    expect(call.headers['X-Plex-Token']).toBe('friend-secret-token');
    expect(call.url.toString()).not.toContain('friend-secret-token');
  });

  it('setProgress refuses a point that is not a positive count', async () => {
    const stub = plexStub([]);
    await expect(write(stub).setProgress('1', 0)).rejects.toThrow(TypeError);
    await expect(write(stub).setProgress('1', Number.NaN)).rejects.toThrow(TypeError);
    expect(stub.calls).toHaveLength(0);
  });

  it('setShowOrdering PUTs the show’s prefs with one of Plex’s values, and refuses anything else', async () => {
    const stub = plexStub([{ method: 'PUT', path: '/library/metadata/482072/prefs', body: '' }]);
    await write(stub).setShowOrdering('482072', 'tvdbAiring');
    const call = stub.callsFor('PUT', '/prefs')[0]!;
    expect(call.url.searchParams.get('showOrdering')).toBe('tvdbAiring');
    await write(stub).setShowOrdering('482072', '');
    expect(stub.callsFor('PUT', '/prefs')[1]!.url.searchParams.get('showOrdering')).toBe('');
    await expect(write(stub).setShowOrdering('482072', 'tvdb; drop')).rejects.toThrow(TypeError);
    expect(stub.callsFor('PUT', '/prefs')).toHaveLength(2);
  });

  it('refreshMetadata PUTs /library/metadata/{key}/refresh', async () => {
    const stub = plexStub([{ method: 'PUT', path: '/library/metadata/482072/refresh', body: '' }]);
    await write(stub).refreshMetadata('482072');
    expect(stub.callsFor('PUT', '/refresh')).toHaveLength(1);
  });
});

describe('helpers', () => {
  it('partName keeps the file name of a Unix or Windows path', () => {
    expect(partName('/a/b/c.mkv')).toBe('c.mkv');
    expect(partName('C:\\a\\b.mkv')).toBe('b.mkv');
    expect(partName('plain.mkv')).toBe('plain.mkv');
  });
  it('isShowOrdering knows Plex’s values', () => {
    expect(['', 'tvdbAiring', 'tmdbAiring', 'tvdbDvd', 'tvdbAbsolute'].every(isShowOrdering)).toBe(true);
    expect(isShowOrdering('tvdb')).toBe(false);
  });
});
