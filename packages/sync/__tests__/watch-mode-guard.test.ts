// ADR-088 / DESIGN-049 D-09 (PLAN-068 S2) — 'watch' is in SYNC_RUN_KINDS (the CLI parser accepts it and the
// sync_runs.run_kind CHECK admits it) before the mode itself exists (PLAN-068 S6). runSync must refuse it
// outright rather than fall through to the per-source loop, which would run an incremental *arr sync
// labelled 'watch'. The client stubs throw on ANY use, and the db is a poison object, so this test fails
// loudly if the guard ever moves below a network or database touch.
import { describe, expect, it } from 'vitest';
import { SYNC_RUN_KINDS } from '@hnet/db';
import { runSync, type RunSyncOptions } from '../src/orchestrator';

const poison = new Proxy(
  {},
  {
    get(_target, prop) {
      throw new Error(`the 'watch' guard let runSync touch ${String(prop)}`);
    },
  },
);

describe("runSync — mode 'watch' before PLAN-068 S6", () => {
  it('is a known mode (SYNC_RUN_KINDS) but is refused before any client or database use', async () => {
    expect(SYNC_RUN_KINDS).toContain('watch');
    await expect(
      runSync({
        mode: 'watch',
        clients: poison as RunSyncOptions['clients'],
        db: poison as RunSyncOptions['db'],
      }),
    ).rejects.toThrow("sync mode 'watch' is not implemented yet (PLAN-068 S6)");
  });
});
