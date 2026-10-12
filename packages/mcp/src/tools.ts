// ADR-087 / DESIGN-049 D-02 / D-05 — the watch tools: EXACTLY the D-05 names, descriptions and parameters,
// one scope each, and the server's `instructions`; ADR-092 / DESIGN-051 D-01 adds `watchlist` and
// `set_watchlist`; ADR-107 / DESIGN-054 adds the two bounded personal-evidence reads. Schema rules
// (Home Assistant converts every schema; OpenAI strips top-level combinators): strict objects,
// primitive properties except check_titles' bounded object array, property-level enums only, no defaults, no
// nullable, no unions, integers bounded with `.int().min().max()`. Built ONCE at module scope.
import { z } from 'zod';
import type { WatchScope } from './auth';

export const SERVER_NAME = 'Watch history';

/** D-02 — only Claude Code and Codex read these (Home Assistant drops them); ≤ 600 characters. */
export const INSTRUCTIONS =
  'Use viewing_context for personal evidence; plays do not prove liking. Discover broadly, then check_titles and rank for the request using dated research. Released titles beyond theatrical-only are eligible; upcoming/theatrical-only need explicit request. Streaming/rental listings are optional convenience, never a default filter or ranking boost. Plex/watchlist restrict only explicit requests. recommend is a limited cache. No recorded viewing is not proof of never watched; viewingBasis explains recorded status. Reads never acquire titles; set_watchlist may download, mark_watched writes Plex.';

const showOrMovie = z.enum(['show', 'movie']);
const anyKind = z.enum(['show', 'movie', 'any']);
const int = (min: number, max: number) => z.number().int().min(min).max(max);
const title = z.string().min(1).max(200);

export const unfinishedInput = z
  .object({ kind: anyKind.optional(), limit: int(1, 10).optional(), kids: z.boolean().optional() })
  .strict();
export const recommendInput = z
  .object({
    kind: anyKind.optional(),
    genre: z.string().min(1).max(40).optional(),
    limit: int(1, 10).optional(),
    offset: int(0, 100).optional(),
    kids: z.boolean().optional(),
    scope: z.enum(['catalog', 'plex', 'watchlist']).optional(),
  })
  .strict();
export const watchStatusInput = z.object({ title, kind: showOrMovie.optional() }).strict();
export const recentHistoryInput = z
  .object({ days: int(1, 365).optional(), limit: int(1, 20).optional() })
  .strict();
export const markWatchedInput = z
  .object({
    title,
    kind: showOrMovie.optional(),
    season: int(1, 100).optional(),
    episode: int(1, 9999).optional(),
    through: z.boolean().optional(),
  })
  .strict();
export const dismissInput = z
  .object({ title, reason: z.enum(['not_interested', 'not_mine']).optional() })
  .strict();
export const undoInput = z.object({}).strict();
/** DESIGN-051 D-01 — `offset` reaches the provider's 2,000-title read cap. */
export const watchlistInput = z
  .object({
    kind: anyKind.optional(),
    limit: int(1, 10).optional(),
    offset: int(0, 2000).optional(),
  })
  .strict();
export const setWatchlistInput = z
  .object({ title, action: z.enum(['add', 'remove']), kind: showOrMovie.optional() })
  .strict();

/** DESIGN-054 D-02: identity validation is local; a contradictory identity never falls back to a name. */
const checkTitleInput = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    year: int(1800, 2200).optional(),
    kind: showOrMovie.optional(),
    tmdbId: int(1, 2_147_483_647).optional(),
    tvdbId: int(1, 2_147_483_647).optional(),
    imdbId: z
      .string()
      .trim()
      .min(1)
      .max(40)
      .regex(/^[tT][tT]\d+$/)
      .optional(),
    plexGuid: z
      .string()
      .trim()
      .min(1)
      .max(500)
      .regex(/^plex:\/\/(movie|show)\/[^\s/]+$/)
      .optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    const issue = (message: string) => ctx.addIssue({ code: 'custom', message });
    if (![v.title, v.tmdbId, v.tvdbId, v.imdbId, v.plexGuid].some((x) => x !== undefined))
      issue('Provide a title or a canonical identifier');
    if (v.tmdbId !== undefined && v.kind === undefined) issue('Provide kind for a TMDB identifier');
    if (v.tvdbId !== undefined && v.kind === 'movie') issue('A TVDB identifier describes a show');
    const guidKind = v.plexGuid?.split('/')[2];
    if (v.kind !== undefined && guidKind !== undefined && guidKind !== v.kind)
      issue('Plex identifier kind conflicts with kind');
    if (v.tvdbId !== undefined && guidKind === 'movie')
      issue('A TVDB identifier conflicts with a movie Plex identifier');
  });

export const checkTitlesInput = z
  .object({ titles: z.array(checkTitleInput).min(1).max(10) })
  .strict();

export const viewingContextInput = z
  .object({
    kind: anyKind.optional(),
    section: z.enum(['viewing', 'feedback']).optional(),
    limit: int(1, 20).optional(),
    offset: int(0, 2000).optional(),
  })
  .strict();

/**
 * The JSON Schema served in `tools/list` — HAND-WRITTEN (D-05): the SDK's generated list adds a `$schema`
 * URL and `execution: {taskSupport}` to every tool and came to 3,475 bytes, over the 3,072-byte Voice
 * Budget of the time (ADR-107 raises the eleven-tool cap to 6,144 bytes).
 * These carry the same parameters, types, enums and integer bounds as the zod schema (a test pins them to each
 * other); string lengths are checked by zod in the call path only.
 */
export interface ToolJsonSchema {
  [key: string]: unknown;
  type: 'object';
  properties: Record<string, Record<string, unknown>>;
  required?: string[];
  additionalProperties: false;
}

export interface WatchToolDef {
  name: string;
  scope: WatchScope;
  description: string;
  input: z.ZodObject;
  jsonSchema: ToolJsonSchema;
  annotations: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean };
}

const S = { type: 'string' } as const;
const B = { type: 'boolean' } as const;
const I = (minimum: number, maximum: number) => ({ type: 'integer', minimum, maximum }) as const;
const E = (...values: string[]) => ({ type: 'string', enum: values }) as const;
const schema = (properties: ToolJsonSchema['properties'], required?: string[]): ToolJsonSchema => ({
  type: 'object',
  properties,
  ...(required ? { required } : {}),
  additionalProperties: false,
});

const READ = { readOnlyHint: true } as const;

/** D-05 (+ DESIGN-051 D-01 / DESIGN-054 D-04): reads, then writes, undo last. */
export const WATCH_TOOLS = [
  {
    name: 'unfinished',
    scope: 'watch:read',
    description:
      "Shows (or movies) the user started but hasn't finished, most recent first, with the next episode.",
    input: unfinishedInput,
    jsonSchema: schema({ kind: E('show', 'movie', 'any'), limit: I(1, 10), kids: B }),
    annotations: READ,
  },
  {
    name: 'recommend',
    scope: 'watch:read',
    description:
      'Limited cached ledger/watchlist/TMDB candidates; scope plex or watchlist only when requested. For general choices use viewing_context, broad research and check_titles.',
    input: recommendInput,
    jsonSchema: schema({
      kind: E('show', 'movie', 'any'),
      genre: S,
      limit: I(1, 10),
      offset: I(0, 100),
      kids: B,
      scope: E('catalog', 'plex', 'watchlist'),
    }),
    annotations: READ,
  },
  {
    name: 'watch_status',
    scope: 'watch:read',
    description:
      'Recorded viewing, progress and Plex/watchlist membership for one title; unknowns are stated.',
    input: watchStatusInput,
    jsonSchema: schema({ title: S, kind: E('show', 'movie') }, ['title']),
    annotations: READ,
  },
  {
    name: 'recent_history',
    scope: 'watch:read',
    description: 'Recent recorded plays; a play alone does not establish completion or liking.',
    input: recentHistoryInput,
    jsonSchema: schema({ days: I(1, 365), limit: I(1, 20) }),
    annotations: READ,
  },
  {
    name: 'watchlist',
    scope: 'watch:read',
    description:
      "The user's Plex watchlist, newest first, each title with whether it is on Plex; pass offset for more.",
    input: watchlistInput,
    jsonSchema: schema({ kind: E('show', 'movie', 'any'), limit: I(1, 10), offset: I(0, 2000) }),
    annotations: READ,
  },
  {
    name: 'check_titles',
    scope: 'watch:read',
    description:
      'Check up to 10 researched titles against personal records, in input order. Returns identity, viewing, feedback, memberships and unknowns; no acquisitions. Supply kind with tmdbId.',
    input: checkTitlesInput,
    jsonSchema: schema(
      {
        titles: {
          type: 'array',
          minItems: 1,
          maxItems: 10,
          items: schema({
            title: S,
            year: I(1800, 2200),
            kind: E('show', 'movie'),
            tmdbId: I(1, 2_147_483_647),
            tvdbId: I(1, 2_147_483_647),
            imdbId: { ...S, pattern: '^[tT][tT]\\d+$' },
            plexGuid: { ...S, pattern: '^plex:\\/\\/(movie|show)\\/[^\\s/]+$' },
          }),
        },
      },
      ['titles'],
    ),
    annotations: READ,
  },
  {
    name: 'viewing_context',
    scope: 'watch:read',
    description:
      'Personal viewing evidence and explicit feedback, paginated. Plays do not prove completion or liking; personal ratings are unavailable.',
    input: viewingContextInput,
    jsonSchema: schema({
      kind: E('show', 'movie', 'any'),
      section: E('viewing', 'feedback'),
      limit: I(1, 20),
      offset: I(0, 2000),
    }),
    annotations: READ,
  },
  {
    name: 'mark_watched',
    scope: 'watch:write',
    description:
      'Record that the user already watched a title and mark it watched in Plex: the whole show unless a season or episode is given; through=true marks everything up to that episode.',
    input: markWatchedInput,
    jsonSchema: schema(
      { title: S, kind: E('show', 'movie'), season: I(1, 100), episode: I(1, 9999), through: B },
      ['title'],
    ),
    annotations: { destructiveHint: false, idempotentHint: true },
  },
  {
    name: 'dismiss',
    scope: 'watch:write',
    description:
      'Stop suggesting a title: reason not_interested (default) or not_mine (someone else watched it on this account). Never changes Plex.',
    input: dismissInput,
    jsonSchema: schema({ title: S, reason: E('not_interested', 'not_mine') }, ['title']),
    annotations: { destructiveHint: false },
  },
  {
    name: 'set_watchlist',
    scope: 'watch:write',
    description:
      "Add a title to the user's Plex watchlist or remove it; says back the title it found. Adding a title not on Plex makes Seerr download it.",
    input: setWatchlistInput,
    jsonSchema: schema({ title: S, action: E('add', 'remove'), kind: E('show', 'movie') }, [
      'title',
      'action',
    ]),
    annotations: { destructiveHint: false, idempotentHint: true },
  },
  {
    name: 'undo_last_change',
    scope: 'watch:write',
    description: "Undo the user's last mark_watched, dismiss or set_watchlist from the past day.",
    input: undoInput,
    jsonSchema: schema({}),
    annotations: { destructiveHint: false },
  },
] as const satisfies readonly WatchToolDef[];

export type WatchToolName = (typeof WATCH_TOOLS)[number]['name'];
