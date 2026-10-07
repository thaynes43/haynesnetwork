// DESIGN-039 amendment 2026-10-07 (OC-014) — the GB Call Pacer (glossary T-293). The daily CALL BUDGET
// (gb-call-budget.ts) keeps the estate's consumers inside Google Books' per-DAY quota; nothing kept them inside
// its per-MINUTE one. The format-pairing mint walked its candidates with only a 250ms pause between ATTEMPTS, and
// one attempt is one to four GB requests (plus their retries), so a run with many lookups to make fired about two
// requests a second and Google answered `gb_quota_trip kind=minute` about a minute in: 2026-10-05 10:33Z and
// 11:32Z, 10-06 07:33Z, 09:33Z and 11:32Z, 10-07 07:33Z and 09:33Z. The goodreads job did the same at 07:41Z on
// each of those days. A trip ends the run's lookups (the breaker opens for two minutes and the run skips the rest),
// and LazyLibrarian's adds, on the same key, are refused while it lasts.
//
// The pacer holds ONE process to at most `perMinute` physical requests in any 60-second window: each request
// awaits `beforeCall()` (the `@hnet/goodreads` http wrapper calls it before every attempt, retries included), which
// returns at once while the window has room and otherwise sleeps until the oldest request in it is a minute old.
// In memory only: each GB-using CronJob is its own process and they run at different minutes (:32, :41), so no
// shared state is needed; the shared breaker remains the backstop for a burst from another consumer of the key.
// Kept dependency-free (no DB) so it can be wired into the dumb GB client like the call meter.

/**
 * The per-process ceiling on Google Books requests per minute (env-tunable; `0` turns pacing off). The trips above
 * came at roughly 100 to 130 requests in the first minute of a run, and LazyLibrarian draws on the same key, so the
 * default leaves room under a limit of about 100. A run of 100 attempts at two requests each then takes a little over
 * three minutes, well inside the hourly schedule.
 */
export const GB_CALLS_PER_MINUTE = Number(process.env.GB_CALLS_PER_MINUTE ?? 60);

/** The window the per-minute ceiling counts over. */
export const GB_CALL_PACER_WINDOW_MS = 60_000;

export interface GbCallPacer {
  /** Await before each physical GB request: resolves at once while the window has room, else when it has. */
  beforeCall(): Promise<void>;
  /** The ceiling this pacer holds (0 = off). */
  perMinute(): number;
  /** How many requests had to wait for room. */
  waits(): number;
  /** The total time requests spent waiting, in ms. */
  waitedMs(): number;
}

export function createGbCallPacer(
  options: {
    perMinute?: number;
    windowMs?: number;
    /** Clock (ms). Injected by tests; defaults to `Date.now`. */
    now?: () => number;
    /** Sleep. Injected by tests; defaults to `setTimeout`. */
    sleep?: (ms: number) => Promise<void>;
  } = {},
): GbCallPacer {
  const raw = options.perMinute ?? GB_CALLS_PER_MINUTE;
  const limit = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
  const windowMs = options.windowMs ?? GB_CALL_PACER_WINDOW_MS;
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  /** Start times of the requests inside the window, oldest first. */
  const stamps: number[] = [];
  let waits = 0;
  let waitedMs = 0;
  // Callers take their turn one at a time, so two concurrent requests can never both see the last free slot.
  let queue: Promise<void> = Promise.resolve();

  const take = async (): Promise<void> => {
    let waited = false;
    for (;;) {
      const t = now();
      while (stamps.length > 0 && stamps[0]! <= t - windowMs) stamps.shift();
      if (stamps.length < limit) {
        stamps.push(t);
        return;
      }
      const ms = Math.max(1, stamps[0]! + windowMs - t);
      if (!waited) waits += 1;
      waited = true;
      waitedMs += ms;
      await sleep(ms);
    }
  };

  return {
    beforeCall: () => {
      if (limit === 0) return Promise.resolve();
      const turn = queue.then(take);
      queue = turn.catch(() => undefined);
      return turn;
    },
    perMinute: () => limit,
    waits: () => waits,
    waitedMs: () => waitedMs,
  };
}
