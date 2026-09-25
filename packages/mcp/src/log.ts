// ADR-087 / DESIGN-049 D-06 — one log line per tool call: `[mcp] tool_called {"tool","consumer","ms","ok",
// "chars"}` (+ `"code"` on failure); `[mcp] slow_call` with the slowest phase over 2 s;
// `[mcp] revalidate_timeout` when D-11 ran out of budget; `[mcp] watchlist_changed` per `set_watchlist` call
// (DESIGN-051 D-10). Arguments and results are NEVER logged — they are the owner's viewing history.
import type { WatchlistChangeResult, WatchPhases } from '@hnet/domain';

export const SLOW_CALL_MS = 2_000;

export interface ToolCallLog {
  tool: string;
  consumer: string;
  ms: number;
  ok: boolean;
  chars: number;
  code?: string;
}

export function toolCalledLine(entry: ToolCallLog): string {
  return `[mcp] tool_called ${JSON.stringify(entry)}`;
}

/** The phase that took longest, or `other` when none was measured. */
export function slowestPhase(phases: WatchPhases): string {
  const entries = Object.entries(phases).filter(([, ms]) => typeof ms === 'number') as Array<[string, number]>;
  return entries.sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'other';
}

export function slowCallLine(entry: { tool: string; consumer: string; ms: number; phase: string }): string {
  return `[mcp] slow_call ${JSON.stringify(entry)}`;
}

export function revalidateTimeoutLine(entry: { tool: string; consumer: string }): string {
  return `[mcp] revalidate_timeout ${JSON.stringify(entry)}`;
}

/** A short, credential-free code for a failure (typed client errors carry one). */
export function errorCode(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error && typeof (error as { code: unknown }).code === 'string') {
    return (error as { code: string }).code;
  }
  return error instanceof Error ? error.name : 'unknown';
}

/**
 * ADR-092 / DESIGN-051 D-10 (PLAN-071 ruling 9) — one line per `set_watchlist` call: exactly the consumer, the
 * action, the kind, the result and whether the title is on Plex. Never a title, a query or a token (DESIGN-049
 * D-06: arguments and results are the owner's viewing history).
 */
export interface WatchlistChangedLog {
  consumer: string;
  action: 'add' | 'remove';
  kind: 'show' | 'movie' | null;
  result: WatchlistChangeResult;
  onPlex: boolean | null;
}

export function watchlistChangedLine(entry: WatchlistChangedLog): string {
  const { consumer, action, kind, result, onPlex } = entry;
  return `[mcp] watchlist_changed ${JSON.stringify({ consumer, action, kind, result, onPlex })}`;
}
