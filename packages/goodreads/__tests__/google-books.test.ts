import { describe, expect, it, vi } from 'vitest';
import {
  GoogleBooksClient,
  classifyComic,
  gbAuthorsMatch,
  gbQueryTitle,
  gbResolveTitleMatches,
  gbIsOmnibusVolume,
  isComicCategory,
  isComicText,
  nextBackoffMs,
  titleVolumeNumbers,
  volumeNumbersAgree,
} from '../src/index';

function volResponse(items: unknown[]): Response {
  return new Response(JSON.stringify({ totalItems: items.length, items }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function volumeResponse(volume: unknown): Response {
  return new Response(JSON.stringify(volume), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('isComicCategory', () => {
  it('detects the GB comics category', () => {
    expect(isComicCategory(['Comics & Graphic Novels'])).toBe(true);
    expect(isComicCategory(['Comics'])).toBe(true);
    // The /volumes GET returns suffixed BISAC forms — still a comic (the Scott Pilgrim full-record shape).
    expect(isComicCategory(['Comics & Graphic Novels / Literary'])).toBe(true);
    expect(isComicCategory(['Fiction', 'Science Fiction'])).toBe(false);
    expect(isComicCategory(undefined)).toBe(false);
  });
});

describe('isComicText (PLAN-044 live-leak fix — signals GB categories miss)', () => {
  it('detects a comic publisher / imprint / format marker in shelved text', () => {
    // The Batman leak: GB resolved a category-less volume; the shelved title carries "DC Comics".
    expect(isComicText('Zero Year: Part 1 (DC Comics - The Legend of Batman #1)')).toBe(true);
    expect(isComicText('Saga, Volume 1', 'Brian K. Vaughan', 'Image Comics')).toBe(true);
    expect(isComicText('Watchmen (graphic novel)')).toBe(true);
    expect(isComicText('Berserk, Vol. 1', null, 'Dark Horse Comics')).toBe(true);
  });

  it('does not false-positive on prose novels', () => {
    expect(isComicText('Dune (Dune, #1)', 'Frank Herbert')).toBe(false);
    expect(isComicText('Project Hail Mary', 'Andy Weir')).toBe(false);
    expect(isComicText('Hooked: How to Build Habit-Forming Products', 'Nir Eyal')).toBe(false);
    expect(isComicText(null, undefined)).toBe(false);
  });

  it('classifyComic unions the category + text signals', () => {
    expect(classifyComic({ categories: ['Fiction'], title: 'Batman: Year One (DC Comics)' })).toBe(true);
    expect(classifyComic({ categories: ['Comics & Graphic Novels'], title: 'anything' })).toBe(true);
    expect(classifyComic({ categories: ['Fiction'], title: 'Dune', author: 'Frank Herbert' })).toBe(false);
  });
});

describe('gbQueryTitle / gbResolveTitleMatches (the 2026-07-16 wrong-work resolve guard)', () => {
  it('strips only the trailing Goodreads series parenthetical', () => {
    expect(gbQueryTitle('The Serpent and the Wings of Night (Crowns of Nyaxia, #1)')).toBe(
      'The Serpent and the Wings of Night',
    );
    expect(gbQueryTitle('Zero Year: Part 1 (DC Comics - The Legend of Batman #1)')).toBe('Zero Year: Part 1');
    expect(gbQueryTitle('Project Hail Mary')).toBe('Project Hail Mary');
    expect(gbQueryTitle('(anonymous)')).toBe('(anonymous)'); // never strip to empty
  });

  it('rejects a resolved volume whose title does not cover the queried one', () => {
    // The live incident shape: a prose novel resolving to an unrelated comic-categorized volume.
    expect(gbResolveTitleMatches('The Serpent and the Wings of Night (Crowns of Nyaxia, #1)', 'Wings')).toBe(false);
    expect(gbResolveTitleMatches('Kingdom of Ash (Throne of Glass, #7)', 'Kingdom Hearts')).toBe(false);
    expect(gbResolveTitleMatches('Dune', undefined)).toBe(false);
  });

  it('accepts near-identical and subtitle-extended titles', () => {
    expect(
      gbResolveTitleMatches('The Serpent and the Wings of Night (Crowns of Nyaxia, #1)', 'The Serpent & the Wings of Night'),
    ).toBe(true);
    expect(gbResolveTitleMatches('Zero Year: Part 1 (DC Comics - The Legend of Batman #1)', 'Zero Year')).toBe(true);
    expect(gbResolveTitleMatches('Hooked', 'Hooked: How to Build Habit-Forming Products')).toBe(true);
  });
});

describe('gbQueryTitle series-index prefix + gbAuthorsMatch (the 2026-07-17 fix-path hardening)', () => {
  it('strips a leading series-index prefix, never bare numeric titles', () => {
    expect(gbQueryTitle('02 - Grave Surprise')).toBe('Grave Surprise');
    expect(gbQueryTitle('1. The Colour of Magic')).toBe('The Colour of Magic');
    expect(gbQueryTitle('1984')).toBe('1984');
    expect(gbQueryTitle('11/22/63')).toBe('11/22/63');
  });

  // PLAN-059 — the pairing-resolve gap: Kavita/ABS file-derived library titles carry series/volume
  // prefixes and bracket annotations GB never indexes under; these are the real stuck-want titles.
  it('strips library series/volume prefixes and bracket annotations (the pairing file-titles)', () => {
    // A bracket/hash index prefix ([09]:, #05 -) — the work title trails it.
    expect(gbQueryTitle("Wheel of Time [09]: Winter's Heart")).toBe("Winter's Heart");
    expect(gbQueryTitle("Lily Bard #05 - Shakespeare's Counselor")).toBe("Shakespeare's Counselor");
    // A series word + a bare 1-3 digit index + a dash.
    expect(gbQueryTitle('Expanse 05 - Nemesis Games')).toBe('Nemesis Games');
    expect(gbQueryTitle('Broken Wings 2 - Midnight Flight')).toBe('Midnight Flight');
    // A trailing bracket annotation.
    expect(gbQueryTitle('The Summer I Turned Pretty [Summer, Book 1]')).toBe('The Summer I Turned Pretty');
  });

  it('leaves integral-number titles and colon subtitles intact (no over-strip)', () => {
    // A BARE number + colon is NOT a series prefix (only bracket/hash may use ':') — "Beacon 23" survives.
    expect(gbQueryTitle('Beacon 23: Part One: Little Noises')).toBe('Beacon 23: Part One: Little Noises');
    expect(gbQueryTitle('Fahrenheit 451')).toBe('Fahrenheit 451');
    expect(gbQueryTitle('Project Hail Mary')).toBe('Project Hail Mary');
  });

  it('author guard: shared surname accepts, disjoint authors reject, noise never rejects', () => {
    expect(gbAuthorsMatch('Dean Koontz', ['Simon Beckett'])).toBe(false);
    expect(gbAuthorsMatch('Charlaine Harris', ['Charlaine Harris'])).toBe(true);
    expect(gbAuthorsMatch('C. Harris', ['Charlaine Harris'])).toBe(true);
    expect(gbAuthorsMatch('..', ['Anyone'])).toBe(true);
  });
});

describe('GoogleBooksClient.resolveVolume (fix-path hardening)', () => {
  it('rejects a same-title DIFFERENT-author resolve (the Whispers wrong-book incident)', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes('intitle')) {
        return volResponse([
          { id: 'gb-wrong-author', volumeInfo: { title: 'Whispers of the Dead', authors: ['Simon Beckett'] } },
        ]);
      }
      return volResponse([]);
    }) as unknown as typeof fetch;
    const gb = new GoogleBooksClient({ baseUrl: 'http://stub/books/v1', apiKey: 'k', fetchImpl });
    expect(await gb.resolveVolume({ title: 'Whispers', author: 'Dean Koontz' })).toBeNull();
  });

  it('falls back to the pre-colon title on a full-title miss (Dead Ever After)', async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      calls.push(decodeURIComponent(url).replace(/\+/g, ' '));
      if (url.includes('intitle') && !decodeURIComponent(url).includes('Sookie')) {
        return volResponse([
          { id: 'gb-dea', volumeInfo: { title: 'Dead Ever After', authors: ['Charlaine Harris'] } },
        ]);
      }
      return volResponse([]);
    }) as unknown as typeof fetch;
    const gb = new GoogleBooksClient({ baseUrl: 'http://stub/books/v1', apiKey: 'k', fetchImpl });
    const res = await gb.resolveVolume({
      title: 'Dead Ever After: A Sookie Stackhouse Novel',
      author: 'Charlaine Harris',
    });
    expect(res?.volumeId).toBe('gb-dea');
    expect(calls.length).toBe(2); // full title missed, pre-colon hit
  });
});

describe('GoogleBooksClient onCall meter (DESIGN-039 D-21 — the daily call-budget hook)', () => {
  it('fires onCall once per PHYSICAL request — one per outbound leg when none retry', async () => {
    let calls = 0;
    // The ISBN leg MISSES, so resolveVolume falls through to the title leg — two outbound queries.
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes('isbn')) return volResponse([]); // isbn miss → one leg
      return volResponse([{ id: 'gb-hit', volumeInfo: { title: 'Real Book', authors: ['A'] } }]);
    });
    const gb = new GoogleBooksClient({
      baseUrl: 'http://stub/books/v1',
      apiKey: 'k',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      onCall: () => {
        calls += 1;
      },
    });
    const res = await gb.resolveVolume({ isbn: '123', title: 'Real Book', author: 'A' });
    expect(res?.volumeId).toBe('gb-hit');
    // Two legs (isbn + title), each succeeds first try ⇒ two physical requests ⇒ two onCall invocations.
    expect(calls).toBe(2);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  // 2026-07-20 physical-accounting fix: a 503-retried query counts EACH physical attempt, because
  // Google Books meters every HTTP request against the daily quota. Counting the logical query once
  // (the prior behaviour) undercounted retries and let the real quota exhaust at ~half the counted
  // budget — the 2026-07-20 13:32 UTC breaker trip at only 484 counted vs the ~1000/day cap.
  it('counts a 503-retried query per PHYSICAL attempt (each metered retry is counted)', async () => {
    let calls = 0;
    let attempt = 0;
    const fetchImpl = vi.fn(async () => {
      attempt += 1;
      if (attempt === 1) return new Response('backendFailed', { status: 503 }); // transient — retried
      return volResponse([{ id: 'gb-ok', volumeInfo: { title: 'By ISBN' } }]);
    });
    const gb = new GoogleBooksClient({
      baseUrl: 'http://stub/books/v1',
      apiKey: 'k',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      backoffMs: 0,
      sleepImpl: async () => {},
      onCall: () => {
        calls += 1;
      },
    });
    const res = await gb.resolveVolume({ isbn: '123', title: 'By ISBN' });
    expect(res?.volumeId).toBe('gb-ok');
    expect(fetchImpl).toHaveBeenCalledTimes(2); // one 503 + one success
    expect(calls).toBe(2); // BOTH physical requests counted — Google metered both
  });

  it('counts the secondary /volumes/{id} comic-confirm fetch as its own physical request', async () => {
    let calls = 0;
    // Title leg resolves to a volume whose (truncated) search categories are non-comic → the client
    // fires a /volumes/{id} confirm GET for the full BISAC list. That secondary fetch is a separate
    // metered request and must be counted too.
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes('/volumes/')) {
        return volumeResponse({ id: 'gb-c', volumeInfo: { title: 'Real Book', categories: ['Fiction'] } });
      }
      return volResponse([
        { id: 'gb-c', volumeInfo: { title: 'Real Book', authors: ['A'], categories: ['Fiction'] } },
      ]);
    });
    const gb = new GoogleBooksClient({
      baseUrl: 'http://stub/books/v1',
      apiKey: 'k',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      onCall: () => {
        calls += 1;
      },
    });
    const res = await gb.resolveVolume({ title: 'Real Book', author: 'A' });
    expect(res?.volumeId).toBe('gb-c');
    // One title search + one /volumes/{id} confirm ⇒ two physical requests ⇒ two onCall invocations.
    expect(calls).toBe(2);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe('GoogleBooksClient.resolveVolume', () => {
  it('rejects a title-search resolve of a DIFFERENT work (no wrong-work volume id, no misclassification)', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('intitle')) {
        // GB's fuzzy title match returning an unrelated comic — the Serpent incident shape.
        return volResponse([
          { id: 'gb-wrong', volumeInfo: { title: 'Wings', categories: ['Comics & Graphic Novels'] } },
        ]);
      }
      return volResponse([]);
    });
    const fetchImpl = fetchMock as unknown as typeof fetch;
    const gb = new GoogleBooksClient({ baseUrl: 'http://stub/books/v1', apiKey: 'k', fetchImpl });
    const res = await gb.resolveVolume({
      title: 'The Serpent and the Wings of Night (Crowns of Nyaxia, #1)',
      author: 'Carissa Broadbent',
    });
    expect(res).toBeNull();
    // The query itself must carry the de-noised title (no series parenthetical).
    const calledUrl = fetchMock.mock.calls[0]?.[0] ?? '';
    const decoded = decodeURIComponent(calledUrl).replace(/\+/g, ' ');
    expect(decoded).toContain('The Serpent and the Wings of Night');
    expect(decoded).not.toContain('Nyaxia');
  });

  it('resolves by ISBN first and flags comics', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes('isbn')) {
        return volResponse([
          {
            id: 'gb-sp',
            volumeInfo: {
              title: 'Scott Pilgrim',
              categories: ['Comics & Graphic Novels'],
              industryIdentifiers: [{ type: 'ISBN_13', identifier: '9781932664089' }],
            },
          },
        ]);
      }
      return volResponse([]);
    }) as unknown as typeof fetch;
    const gb = new GoogleBooksClient({ baseUrl: 'http://stub/books/v1', apiKey: 'k', fetchImpl });
    const res = await gb.resolveVolume({ isbn: '9781932664089', title: 'Scott Pilgrim' });
    expect(res).toEqual({
      volumeId: 'gb-sp',
      isbn13: '9781932664089',
      categories: ['Comics & Graphic Novels'],
      isComic: true,
      language: null,
      title: 'Scott Pilgrim',
      subtitle: null,
      authors: [],
    });
  });

  it('falls back to a title+author query when no ISBN', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes('intitle')) {
        return volResponse([{ id: 'gb-x', volumeInfo: { title: 'X', categories: ['Fiction'] } }]);
      }
      return volResponse([]);
    }) as unknown as typeof fetch;
    const gb = new GoogleBooksClient({ baseUrl: 'http://stub/books/v1', apiKey: 'k', fetchImpl });
    const res = await gb.resolveVolume({ title: 'X', author: 'Y' });
    expect(res?.volumeId).toBe('gb-x');
    expect(res?.isComic).toBe(false);
  });

  it('retries transient 503s with backoff (mandatory GB retry/backoff)', async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      if (calls < 3) return new Response('backendFailed', { status: 503 });
      return volResponse([{ id: 'gb-ok', volumeInfo: {} }]);
    }) as unknown as typeof fetch;
    const gb = new GoogleBooksClient({
      baseUrl: 'http://stub/books/v1',
      apiKey: 'k',
      fetchImpl,
      backoffMs: 1,
      sleepImpl: async () => {},
    });
    const res = await gb.resolveVolume({ isbn: '123', title: 'Z' });
    expect(res?.volumeId).toBe('gb-ok');
    expect(calls).toBe(3);
  });

  // ADR-067 (PLAN-055) — a DAILY-quota 429 cannot succeed before the reset: retrying it is
  // pointless by definition, so it throws IMMEDIATELY (one call, body preserved for the
  // domain-side breaker classification). A per-minute 429 keeps the backoff loop above.
  it('does NOT retry a daily-quota 429 (throws immediately with the body snippet)', async () => {
    let calls = 0;
    const dailyBody = `Quota exceeded for quota metric 'Queries' and limit 'Queries per day' of service 'books.googleapis.com'`;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      return new Response(dailyBody, { status: 429 });
    }) as unknown as typeof fetch;
    const gb = new GoogleBooksClient({
      baseUrl: 'http://stub/books/v1',
      apiKey: 'k',
      fetchImpl,
      backoffMs: 1,
      sleepImpl: async () => {},
    });
    await expect(gb.resolveVolume({ isbn: '123', title: 'Z' })).rejects.toMatchObject({
      status: 429,
      bodySnippet: expect.stringContaining('Queries per day') as unknown,
    });
    expect(calls).toBe(1);
  });

  it('still retries a PER-MINUTE 429 with backoff (transient burst quota)', async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      if (calls < 2) return new Response(`limit 'Queries per minute' exceeded`, { status: 429 });
      return volResponse([{ id: 'gb-ok', volumeInfo: {} }]);
    }) as unknown as typeof fetch;
    const gb = new GoogleBooksClient({
      baseUrl: 'http://stub/books/v1',
      apiKey: 'k',
      fetchImpl,
      backoffMs: 1,
      sleepImpl: async () => {},
    });
    const res = await gb.resolveVolume({ isbn: '123', title: 'Z' });
    expect(res?.volumeId).toBe('gb-ok');
    expect(calls).toBe(2);
  });

  // A per-minute burst 429 whose retries are exhausted throws a GoodreadsHttpError carrying the
  // BODY snippet (per-minute wording), so the domain breaker classifies it 'minute' — even when the
  // queried book title contains "daily". Guards against the URL-in-message false-daily 24h arm.
  it('a per-minute 429 on a "daily"-titled book throws a body snippet that is NOT a daily signal', async () => {
    const fetchImpl = vi.fn(
      async () => new Response(`limit 'Queries per minute per user' exceeded`, { status: 429 }),
    ) as unknown as typeof fetch;
    const gb = new GoogleBooksClient({
      baseUrl: 'http://stub/books/v1',
      apiKey: 'k',
      fetchImpl,
      retries: 1,
      backoffMs: 1,
      sleepImpl: async () => {},
    });
    await expect(gb.resolveVolume({ title: 'The Daily Stoic', author: 'Ryan Holiday' })).rejects.toMatchObject(
      { status: 429, bodySnippet: expect.not.stringMatching(/per day|daily limit/i) as unknown },
    );
  });

  describe('nextBackoffMs (jitter + Retry-After)', () => {
    it('honors a numeric Retry-After (seconds → ms), capped at 5s', () => {
      expect(nextBackoffMs(500, 1, '2')).toBe(2_000);
      expect(nextBackoffMs(500, 1, '3600')).toBe(5_000); // capped, can't wedge a run
    });
    it('ignores a missing/garbage Retry-After and jitters the linear backoff within ±25%', () => {
      for (const header of [null, undefined, '', 'soon']) {
        for (let attempt = 1; attempt <= 3; attempt += 1) {
          const base = 500 * attempt;
          const ms = nextBackoffMs(500, attempt, header);
          expect(ms).toBeGreaterThanOrEqual(Math.round(base * 0.75));
          expect(ms).toBeLessThanOrEqual(Math.round(base * 1.25));
        }
      }
    });
  });

  // Regression — PLAN-044 v0.49.0 live acceptance leaked BOTH of the owner's comics into LazyLibrarian.
  it('flags a comic from a "DC Comics" title marker when the resolved GB volume has NO categories', async () => {
    // The Batman Zero Year leak: the intitle match was a sparse Eaglemoss catalog volume with no categories.
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes('intitle')) {
        return volResponse([
          { id: 'gb-batman', volumeInfo: { title: 'Zero Year', publisher: 'Eaglemoss Collections' } },
        ]);
      }
      return volResponse([]);
    }) as unknown as typeof fetch;
    const gb = new GoogleBooksClient({ baseUrl: 'http://stub/books/v1', apiKey: 'k', fetchImpl });
    const res = await gb.resolveVolume({
      title: 'Zero Year: Part 1 (DC Comics - The Legend of Batman #1)',
      author: 'Scott Snyder',
    });
    expect(res?.volumeId).toBe('gb-batman');
    expect(res?.isComic).toBe(true);
  });

  it('confirms a comic via the full-volume GET when the search category is truncated to "Fiction"', async () => {
    // The Scott Pilgrim leak: `isbn:` search returned ["Fiction"]; the /volumes GET carries the full BISAC.
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes('/volumes/gb-sp2')) {
        return volumeResponse({
          id: 'gb-sp2',
          volumeInfo: {
            title: 'Scott Pilgrim’s Precious Little Life: Volume 1',
            publisher: 'HarperCollins UK',
            categories: ['Fiction / Humorous / General', 'Comics & Graphic Novels / Literary'],
          },
        });
      }
      if (url.includes('isbn')) {
        return volResponse([
          {
            id: 'gb-sp2',
            volumeInfo: {
              title: 'Scott Pilgrim',
              categories: ['Fiction'],
              industryIdentifiers: [{ type: 'ISBN_13', identifier: '9780007362998' }],
            },
          },
        ]);
      }
      return volResponse([]);
    }) as unknown as typeof fetch;
    const gb = new GoogleBooksClient({ baseUrl: 'http://stub/books/v1', apiKey: 'k', fetchImpl });
    const res = await gb.resolveVolume({
      isbn: '9780007362998',
      title: "Scott Pilgrim's Precious Little Life (Scott Pilgrim, #1)",
      author: "Bryan Lee O'Malley",
    });
    expect(res?.volumeId).toBe('gb-sp2');
    expect(res?.isComic).toBe(true);
    expect(res?.categories).toContain('Comics & Graphic Novels / Literary');
  });
});

describe('gbIsOmnibusVolume (the 2026-10-03 bundle-resolve guard)', () => {
  it('rejects a bundle whose subtitle lists the queried work (Odd Interlude -> 7-Book Bundle)', () => {
    const vol = {
      title: 'The Odd Thomas Series 7-Book Bundle',
      subtitle: 'Odd Thomas, Forever Odd, Brother Odd, Odd Hours, Odd Apocalypse, Odd Interlude, Deeply Odd',
    };
    // The coverage guard alone PASSES this (the subtitle carries both query tokens) — the omnibus guard is the stop.
    expect(gbResolveTitleMatches('Odd Interlude #1', `${vol.title} ${vol.subtitle}`)).toBe(true);
    expect(gbIsOmnibusVolume(vol, 'Odd Interlude #1')).toBe(true);
  });

  it('rejects a contents-list compilation (title is the author, subtitle lists works)', () => {
    expect(gbIsOmnibusVolume({ title: 'Dean Koontz', subtitle: 'Winter Moon; Icebound' }, 'Dean R Koontz - Winter Moon')).toBe(true);
  });

  it('allows the same shapes when the query itself asks for a set', () => {
    const boxed = { title: 'The Dark Artifices, the Complete Collection', subtitle: undefined };
    expect(gbIsOmnibusVolume(boxed, 'The Dark Artifices, the Complete Collection')).toBe(false);
    expect(gbIsOmnibusVolume({ title: 'Red Queen Box Set' }, 'Red Queen Box Set')).toBe(false);
  });

  it('keeps single books whose subtitle carries series positioning; tests the query per title', () => {
    expect(gbIsOmnibusVolume({ title: 'Shadow and Bone', subtitle: 'The Grisha Trilogy, Book 1' }, 'Shadow and Bone')).toBe(false);
    expect(gbIsOmnibusVolume({ title: 'Night Shift', subtitle: 'A Collection of Stories' }, 'Night Shift')).toBe(false);
    // Two commas in the query must not double into a fake contents list when passed twice.
    expect(gbIsOmnibusVolume({ title: 'Eat, Pray, Love', subtitle: 'Eat, Pray, Love; Committed' }, 'Eat, Pray, Love', 'Eat, Pray, Love')).toBe(true);
    expect(gbIsOmnibusVolume({ title: 'The Silo Series Collection' }, 'Wool')).toBe(true);
  });

  it('a raw query with a series-suffix parenthetical is not a request for a set', () => {
    const boxed = { title: 'The Grisha Trilogy Box Set', subtitle: 'Shadow and Bone, Siege and Storm, Ruin and Rising' };
    expect(gbIsOmnibusVolume(boxed, 'Shadow and Bone (The Grisha Trilogy, #1)', 'Shadow and Bone')).toBe(true);
  });

  it('leaves ordinary single works and normal subtitles alone', () => {
    expect(gbIsOmnibusVolume({ title: 'Hooked', subtitle: 'How to Build Habit-Forming Products' }, 'Hooked')).toBe(false);
    expect(gbIsOmnibusVolume({ title: 'Three Kings', subtitle: 'A Wild Cards Mosaic Novel (Book Two of the British Arc)' }, 'Three Kings')).toBe(false);
    expect(gbIsOmnibusVolume({ title: 'Winter Moon' }, 'Dean R Koontz - Winter Moon')).toBe(false);
    expect(gbIsOmnibusVolume({ title: 'Odd Interlude' }, 'Odd Interlude #1')).toBe(false);
  });
});

describe('GoogleBooksClient.resolveVolume omnibus guard', () => {
  it('title leg returns null for a bundle that lists the queried work; the ISBN leg is unguarded', async () => {
    const bundle = {
      id: 'qwNlBAAAQBAJ',
      volumeInfo: {
        title: 'The Odd Thomas Series 7-Book Bundle',
        subtitle: 'Odd Thomas, Forever Odd, Brother Odd, Odd Hours, Odd Apocalypse, Odd Interlude, Deeply Odd',
        authors: ['Dean Koontz'],
      },
    };
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ totalItems: 1, items: [bundle] }), { status: 200 }));
    const gb = new GoogleBooksClient({ baseUrl: 'http://stub/books/v1', apiKey: 'k', fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(await gb.resolveVolume({ title: 'Odd Interlude #1', author: 'Dean Koontz' })).toBeNull();
    // An exact ISBN hit is the book the caller named — never second-guessed.
    expect((await gb.resolveVolume({ isbn: '9780804180733', title: 'Odd Thomas Series 7-Book Bundle' }))?.volumeId).toBe('qwNlBAAAQBAJ');
  });
});

describe('the volume guard (issue #693 — a title that names its volume resolves to that volume)', () => {
  it('reads the volume a title names for itself, not its series position', () => {
    expect([...titleVolumeNumbers('Court of Thorns and Roses bk 2')]).toEqual([2]);
    expect([...titleVolumeNumbers('Harry Potter Book Two')]).toEqual([2]);
    expect([...titleVolumeNumbers('Beacon 23: Part Four: Company (Kindle Single)')]).toEqual([4]);
    expect([...titleVolumeNumbers('Court of Thorns and Roses: Vol. 3')]).toEqual([3]);
    // Series decoration: a later segment, a series parenthetical, a leading index, a "Book N of" position.
    expect(titleVolumeNumbers("Caliban's War: The Expanse, Book 2").size).toBe(0);
    expect(titleVolumeNumbers('A Court of Mist and Fury (A Court of Thorns and Roses, #2)').size).toBe(0);
    expect(titleVolumeNumbers('Lily Bard #05 - Shakespeare\'s Counselor').size).toBe(0);
    expect(titleVolumeNumbers("Caliban's War: Book Two of the Expanse series").size).toBe(0);
    expect(titleVolumeNumbers('Wild Cards XI: Dealer\'s Choice - Book Three of the Rox Triad').size).toBe(0);
    // Not a volume marker.
    expect(titleVolumeNumbers('No Country for Old Men').size).toBe(0);
    expect(titleVolumeNumbers('Catch-22').size).toBe(0);
    expect(titleVolumeNumbers('Mostly Harmless: 5').size).toBe(0);
  });

  it('agrees only when the candidate names the same volume (or the first is unnumbered)', () => {
    // The ACOTAR bk 2 shape: book 1 names no volume, so it is not book 2.
    expect(volumeNumbersAgree('Court of Thorns and Roses bk 2', 'A Court of Thorns and Roses')).toBe(false);
    expect(volumeNumbersAgree('Court of Thorns and Roses bk 2', 'A Court of Mist and Fury: A Court of Thorns and Roses, Book 2')).toBe(true);
    expect(volumeNumbersAgree('Harry Potter Book Two', 'Harry Potter and the Chamber of Secrets (Book 2)')).toBe(true);
    expect(volumeNumbersAgree('Court of Thorns and Roses bk 2', 'A Court of Thorns and Roses: Book 3')).toBe(false);
    expect(volumeNumbersAgree('Wild Cards bk 2', 'Wild Cards 2: Aces High')).toBe(true);
    // Book 1 is often unnumbered; a numbered other volume still disagrees.
    expect(volumeNumbersAgree('Mistborn Book One', 'Mistborn: The Final Empire')).toBe(true);
    expect(volumeNumbersAgree('Mistborn Book One', 'The Well of Ascension: Mistborn Book Two')).toBe(false);
    // A count after "of" is not the volume: "Book 1 of 2" is volume 1.
    expect(volumeNumbersAgree('Court of Thorns and Roses bk 2', 'A Court of Thorns and Roses: Book 1 of 2')).toBe(false);
    expect(volumeNumbersAgree('Court of Thorns and Roses bk 2', 'A Court of Mist and Fury: Book 2 of 5')).toBe(true);
    // A title that names no volume agrees with anything.
    expect(volumeNumbersAgree('A Court of Mist and Fury', 'A Court of Thorns and Roses, Book 2')).toBe(true);
  });

  it('rejects a title-search resolve of another volume, on the pre-colon fallback too', async () => {
    const queries: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      queries.push(decodeURIComponent(url).replace(/\+/g, ' '));
      if (url.includes('intitle')) {
        return volResponse([
          { id: 'E-kdBQAAQBAJ', volumeInfo: { title: 'A Court of Thorns and Roses', authors: ['Sarah J. Maas'] } },
        ]);
      }
      return volResponse([]);
    }) as unknown as typeof fetch;
    const gb = new GoogleBooksClient({ baseUrl: 'http://stub/books/v1', apiKey: 'k', fetchImpl });
    expect(await gb.resolveVolume({ title: 'Court of Thorns and Roses bk 2', author: 'Sarah J. Maas' })).toBeNull();
    expect(await gb.resolveVolume({ title: 'Court of Thorns and Roses: Book 2', author: 'Sarah J. Maas' })).toBeNull();
    // The pre-colon fallback ran ("Court of Thorns and Roses") and was still refused.
    expect(queries.some((q) => q.includes('intitle:Court of Thorns and Roses inauthor'))).toBe(true);
    // The same volume for the book it is resolves as before.
    const res = await gb.resolveVolume({ title: 'A Court of Thorns and Roses', author: 'Sarah J. Maas' });
    expect(res?.volumeId).toBe('E-kdBQAAQBAJ');
  });
});

describe('GoogleBooksClient.resolveVolume with a language restriction (issue #719 — the English edition)', () => {
  const decoded = (url: string) => decodeURIComponent(url).replace(/\+/g, ' ');

  it('asks for langRestrict=en by title and author, never by ISBN, and takes the first English volume that passes every guard', async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      calls.push(decoded(url));
      return volResponse([
        // Ranked first but Spanish: a restricted resolve walks past it.
        { id: 'PitFPgAACAAJ', volumeInfo: { title: 'Azazel', authors: ['Isaac Asimov'], language: 'es' } },
        { id: 'en-azazel', volumeInfo: { title: 'Azazel', authors: ['Isaac Asimov'], language: 'en', categories: ['Fiction'] } },
      ]);
    }) as unknown as typeof fetch;
    const gb = new GoogleBooksClient({ baseUrl: 'http://stub/books/v1', apiKey: 'k', fetchImpl });

    const res = await gb.resolveVolume({ isbn: '9788497593069', title: 'Azazel', author: 'Isaac Asimov', language: 'en' });

    expect(res).toMatchObject({ volumeId: 'en-azazel', language: 'en', title: 'Azazel', authors: ['Isaac Asimov'] });
    // One leg: no `isbn:` leg (an ISBN names the Spanish edition), and no `/volumes/{id}` comic-confirm GET.
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('langRestrict=en');
    expect(calls[0]).toContain('intitle:Azazel inauthor:Isaac Asimov');
    expect(calls[0]).not.toContain('isbn:');
  });

  it('falls back to the plain words when the structured query finds nothing (Azazel: intitle/inauthor lists no hit)', async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      const q = decoded(url);
      calls.push(q);
      // Google Books answers the structured query for this work with nothing, and the plain words with the book.
      if (q.includes('intitle:')) return volResponse([]);
      return volResponse([
        { id: 'es', volumeInfo: { title: 'Azazel', authors: ['Isaac Asimov'], language: 'es' } },
        { id: 'unrelated', volumeInfo: { title: 'Isaac Asimov', subtitle: 'The Foundations of Science Fiction', authors: ['James Gunn'], language: 'en' } },
        { id: 'en-azazel', volumeInfo: { title: 'Azazel', authors: ['Isaac Asimov'], language: 'en' } },
      ]);
    }) as unknown as typeof fetch;
    const gb = new GoogleBooksClient({ baseUrl: 'http://stub/books/v1', apiKey: 'k', fetchImpl });
    const res = await gb.resolveVolume({ title: 'Azazel', author: 'Isaac Asimov', language: 'en' });
    expect(res?.volumeId).toBe('en-azazel');
    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain('q=Azazel Isaac Asimov');
    expect(calls[1]).toContain('langRestrict=en');
  });

  it('the plain-words fallback is for the language-restricted lookup only, and cannot admit another work', async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      calls.push(decoded(url));
      return volResponse([{ id: 'other', volumeInfo: { title: 'Foundation', authors: ['Isaac Asimov'], language: 'en' } }]);
    }) as unknown as typeof fetch;
    const gb = new GoogleBooksClient({ baseUrl: 'http://stub/books/v1', apiKey: 'k', fetchImpl });
    expect(await gb.resolveVolume({ title: 'Azazel', author: 'Isaac Asimov', language: 'en' })).toBeNull();
    expect(calls).toHaveLength(2); // structured, then plain words; both refused by the title guard
    calls.length = 0;
    expect(await gb.resolveVolume({ title: 'Azazel', author: 'Isaac Asimov' })).toBeNull();
    expect(calls).toHaveLength(1); // a plain resolve is unchanged: one structured leg
  });

  it('a volume that reports no language, or another language, is never the English edition', async () => {
    const fetchImpl = vi.fn(async () =>
      volResponse([
        { id: 'no-lang', volumeInfo: { title: 'Azazel', authors: ['Isaac Asimov'] } },
        { id: 'fr', volumeInfo: { title: 'Azazel', authors: ['Isaac Asimov'], language: 'fr' } },
      ]),
    ) as unknown as typeof fetch;
    const gb = new GoogleBooksClient({ baseUrl: 'http://stub/books/v1', apiKey: 'k', fetchImpl });
    expect(await gb.resolveVolume({ title: 'Azazel', author: 'Isaac Asimov', language: 'en' })).toBeNull();
  });

  it('keeps the volume guard: another volume of the series is not the English edition (the pre-colon fallback too)', async () => {
    const fetchImpl = vi.fn(async () =>
      volResponse([
        { id: 'en-1', volumeInfo: { title: 'A Court of Thorns and Roses', authors: ['Sarah J. Maas'], language: 'en' } },
      ]),
    ) as unknown as typeof fetch;
    const gb = new GoogleBooksClient({ baseUrl: 'http://stub/books/v1', apiKey: 'k', fetchImpl });
    expect(await gb.resolveVolume({ title: 'Court of Thorns and Roses bk 2', author: 'Sarah J. Maas', language: 'en' })).toBeNull();
    expect(await gb.resolveVolume({ title: 'Court of Thorns and Roses: Book 2', author: 'Sarah J. Maas', language: 'en' })).toBeNull();
  });

  it('a plain resolve is unchanged: no langRestrict, the ISBN leg first, only the top hit', async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      calls.push(decoded(url));
      return volResponse([
        { id: 'top-es', volumeInfo: { title: 'Azazel', authors: ['Isaac Asimov'], language: 'es' } },
        { id: 'second-en', volumeInfo: { title: 'Azazel', authors: ['Isaac Asimov'], language: 'en' } },
      ]);
    }) as unknown as typeof fetch;
    const gb = new GoogleBooksClient({ baseUrl: 'http://stub/books/v1', apiKey: 'k', fetchImpl });
    const res = await gb.resolveVolume({ title: 'Azazel', author: 'Isaac Asimov' });
    expect(res?.volumeId).toBe('top-es');
    expect(calls[0]).not.toContain('langRestrict');
  });
});
