// ADR-087 / DESIGN-049 D-06 — one log line per tool call: `[mcp] tool_called {"tool","consumer","ms","ok",
// "chars"}` (+ `"code"` on failure); `[mcp] slow_call` with the slowest phase over 2 s;
// `[mcp] revalidate_timeout` when D-11 ran out of budget. Arguments and results are NEVER logged — they are
// the owner's viewing history.
import type { WatchPhases } from '@hnet/domain';

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
