// ADR-103 (issue #812) — measurement hooks for the e2e stack (NO Playwright imports, like harness.ts).
//
// Off unless HNET_E2E_TIMINGS_DIR is set (CI sets it): then the harness records when each boot phase ends
// (stack-timings.json) and copies the app server's output, one timestamped line at a time, to server.log, while
// still echoing it to this process's stdout/stderr as before. e2e/support/timings-report.mjs reads both, plus
// Playwright's JSON report, and writes the per-spec and first-hit-versus-repeat-hit summary.
import { createWriteStream, mkdirSync, writeFileSync, type WriteStream } from 'node:fs';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';

export const TIMINGS_DIR = process.env.HNET_E2E_TIMINGS_DIR || undefined;

export interface StackTimings {
  /** Record that a boot phase ended now (wall clock, ms since the epoch). */
  mark: (phase: string) => void;
  /** Write stack-timings.json (no-op when timings are off). */
  flush: (extra?: Record<string, unknown>) => void;
  /** The server.log sink, or undefined when timings are off. */
  serverLog: WriteStream | undefined;
}

export function createStackTimings(): StackTimings {
  const t0 = Date.now();
  const marks: Array<{ phase: string; at: number; sinceStartMs: number }> = [];
  if (!TIMINGS_DIR) {
    return { mark: () => undefined, flush: () => undefined, serverLog: undefined };
  }
  mkdirSync(TIMINGS_DIR, { recursive: true });
  const serverLog = createWriteStream(join(TIMINGS_DIR, 'server.log'), { flags: 'a' });
  return {
    mark: (phase) => {
      const at = Date.now();
      marks.push({ phase, at, sinceStartMs: at - t0 });
      console.log(`[stack] timing: ${phase} at +${at - t0}ms`);
    },
    flush: (extra = {}) => {
      writeFileSync(
        join(TIMINGS_DIR, 'stack-timings.json'),
        JSON.stringify({ startedAt: t0, marks, ...extra }, null, 2),
      );
    },
    serverLog,
  };
}

/**
 * Echo a child's stdout/stderr to ours and append each complete line to `sink` as `<epoch ms> <line>`, so the
 * report can tell boot-time requests from test-time ones. Only for children spawned with piped stdio.
 */
export function teeChildOutput(child: ChildProcess, sink: WriteStream, label: string): void {
  const pipe = (stream: NodeJS.ReadableStream | null, out: NodeJS.WriteStream): void => {
    if (!stream) return;
    let partial = '';
    stream.on('data', (chunk: Buffer) => {
      out.write(chunk);
      const text = partial + chunk.toString('utf8');
      const lines = text.split('\n');
      partial = lines.pop() ?? '';
      const now = Date.now();
      for (const line of lines) sink.write(`${now} [${label}] ${line}\n`);
    });
    stream.on('end', () => {
      if (partial) sink.write(`${Date.now()} [${label}] ${partial}\n`);
      partial = '';
    });
  };
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);
}
