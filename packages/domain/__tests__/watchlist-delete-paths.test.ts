// ADR-093 / DESIGN-052 D-06 (D-24e) — a static guard, like the import guards: every DELETE path evaluates the pending
// set against a `delete` snapshot from the Registry Gate. `shapePendingItems` / `listTrashPending` are shared by eight
// callers, and the natural default ("no snapshot") would read every item as not listed and evaluable, i.e. deletable.
// TypeScript already requires the parameter; this pins WHICH snapshot each delete path passes, so a refactor cannot
// quietly hand a delete path a `display` snapshot or `null`.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const read = (file: string) => readFileSync(join(SRC, file), 'utf8');

/** The source of one top-level function (from its declaration to the next column-0 closing brace). */
function functionBody(source: string, name: string): string {
  const start = source.search(new RegExp(`\\n(?:export )?(?:async )?function ${name}\\b`));
  expect(start, `function ${name} exists`).toBeGreaterThan(-1);
  const end = source.indexOf('\n}\n', start);
  expect(end, `function ${name} ends`).toBeGreaterThan(start);
  return source.slice(start, end + 2);
}

/** Every `callee({ … })` argument object in `body` (brace-matched). */
function callArgs(body: string, callee: string): string[] {
  const out: string[] = [];
  let from = 0;
  for (;;) {
    const at = body.indexOf(`${callee}({`, from);
    if (at === -1) return out;
    let depth = 0;
    let i = at + callee.length + 1;
    for (; i < body.length; i += 1) {
      if (body[i] === '{') depth += 1;
      else if (body[i] === '}') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    out.push(body.slice(at + callee.length + 1, i + 1));
    from = i;
  }
}

const DELETE_PATHS: Array<{ file: string; fn: string }> = [
  { file: 'trash-batches.ts', fn: 'expireOneBatch' },
  { file: 'trash-flow.ts', fn: 'expediteDeletion' },
  { file: 'trash-flow.ts', fn: 'resolvePendingTarget' },
  { file: 'trash-flow.ts', fn: 'guardRecentlyWatched' },
];

describe('delete paths take a `delete` snapshot from the Registry Gate (DESIGN-052 D-06)', () => {
  for (const { file, fn } of DELETE_PATHS) {
    it(`${fn} passes a delete snapshot to every pending read`, () => {
      const body = functionBody(read(file), fn);
      const reads = [...callArgs(body, 'listTrashPending'), ...callArgs(body, 'shapePendingItems')];
      expect(reads.length, `${fn} reads the pending set`).toBeGreaterThan(0);
      // Where the snapshot comes from: this function takes the gate itself, or declares a DeleteWatchlistSnapshot input.
      const takesGate = /evaluateRegistryGate\(\{[^}]*purpose: 'delete'/.test(body);
      const declaresDelete = /watchlist: DeleteWatchlistSnapshot;/.test(body);
      expect(takesGate || declaresDelete, `${fn} obtains a delete snapshot`).toBe(true);
      for (const args of reads) {
        const m =
          /\bwatchlist(?::\s*([\w.]+))?\s*,/.exec(args) ??
          /\bwatchlist(?::\s*([\w.]+))?\s*\n/.exec(args);
        expect(m, `${fn}: a pending read without a watchlist`).not.toBeNull();
        const value = m![1] ?? 'watchlist';
        expect(['watchlist', 'input.watchlist'], `${fn}: watchlist value ${value}`).toContain(
          value,
        );
      }
      expect(body).not.toMatch(/watchlist:\s*(null|undefined|await readDisplayWatchlistSnapshot)/);
    });
  }

  it('the sweep takes the gate (purpose delete) before any batch is expired, and hands that snapshot on', () => {
    const body = functionBody(read('trash-batches.ts'), 'sweepExpiredBatches');
    const gate = body.search(/evaluateRegistryGate\(\{[^}]*purpose: 'delete'/);
    const expire = body.indexOf('expireOneBatch(');
    expect(gate).toBeGreaterThan(-1);
    expect(expire).toBeGreaterThan(gate);
    const [args] = callArgs(body, 'expireOneBatch');
    expect(args).toMatch(/\bwatchlist,/);
  });

  it('Expedite takes the gate before its first pending read', () => {
    const body = functionBody(read('trash-flow.ts'), 'expediteDeletion');
    const gate = body.search(/evaluateRegistryGate\(\{[^}]*purpose: 'delete'/);
    expect(gate).toBeGreaterThan(-1);
    expect(body.indexOf('resolvePendingTarget(')).toBeGreaterThan(gate);
    expect(body.indexOf('listTrashPending(')).toBeGreaterThan(gate);
  });
});
