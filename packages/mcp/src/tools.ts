// ADR-087 / DESIGN-049 D-02 / D-05 — the watch tools: EXACTLY the D-05 names, descriptions and parameters,
// one scope each, and the server's `instructions`; ADR-092 / DESIGN-051 D-01 adds `watchlist` and
// `set_watchlist` (nine tools) and rewords `watch_status` and `undo_last_change`. Schema rules (Home Assistant converts every
// schema and fails the whole entry on one it cannot; OpenAI strips top-level combinators): flat `.strict()`
// objects, primitive properties, property-level enums only, no defaults (applied in the handler), no
// nullable, no unions, integers bounded with `.int().min().max()`. Built ONCE at module scope.
import { z } from 'zod';
import type { WatchScope } from './auth';

export const SERVER_NAME = 'Watch history';

/** D-02 — only Claude Code and Codex read these (Home Assistant drops them); ≤ 600 characters. */
export const INSTRUCTIONS =
  "Watch history for the owner's Plex account across HaynesOps, HaynesKube and HaynesTower. Every result is short plain text meant to be read aloud. unfinished: shows started and not finished. recommend: never-watched picks with reasons (pass offset for more). watch_status: one title. recent_history: recent plays. watchlist: the Plex watchlist. set_watchlist adds or removes; adding a title not on Plex makes Seerr download it. mark_watched writes to Plex; dismiss never does; undo_last_change reverses the last change.";

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
  .object({ kind: anyKind.optional(), limit: int(1, 10).optional(), offset: int(0, 2000).optional() })
  .strict();
export const setWatchlistInput = z
  .object({ title, action: z.enum(['add', 'remove']), kind: showOrMovie.optional() })
  .strict();

/**
 * The JSON Schema served in `tools/list` — HAND-WRITTEN (D-05): the SDK's generated list adds a `$schema`
 * URL and `execution: {taskSupport}` to every tool and came to 3,475 bytes, over the 3,072-byte Voice
 * Budget of the time (the cap is 4,096 since ADR-092 C-09; the nine hand-written tools serve 3,633 bytes).
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
const schema = (
  properties: ToolJsonSchema['properties'],
  required?: string[],
): ToolJsonSchema => ({
  type: 'object',
  properties,
  ...(required ? { required } : {}),
  additionalProperties: false,
});

const READ = { readOnlyHint: true } as const;

/** D-05 (+ DESIGN-051 D-01), in the served order: the reads, then the writes, undo last. */
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
      'Titles the user has never watched, best first, each with a short reason; titles on Plex first.',
    input: recommendInput,
    jsonSchema: schema({
      kind: E('show', 'movie', 'any'),
      genre: S,
      limit: I(1, 10),
      offset: I(0, 100),
      kids: B,
    }),
    annotations: READ,
  },
  {
    name: 'watch_status',
    scope: 'watch:read',
    description:
      'Whether the user has seen a title, how far along he is, and whether it is on Plex and on his watchlist.',
    input: watchStatusInput,
    jsonSchema: schema({ title: S, kind: E('show', 'movie') }, ['title']),
    annotations: READ,
  },
  {
    name: 'recent_history',
    scope: 'watch:read',
    description: 'What the user watched recently.',
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
    jsonSchema: schema({ title: S, action: E('add', 'remove'), kind: E('show', 'movie') }, ['title', 'action']),
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
