// ADR-079 / DESIGN-004 D-25 (PLAN-064) — the front-page uptime badge read model: the
// current status + 24h/7d/30d uptime ratios of the Gatus apex check, behind a single-flight
// in-process TTL memo (the plays.ts "semi-live" idiom, ADR-068). Read-only, no persistence —
// a memo, not a store. NEVER rejects: an unreachable/degraded Gatus yields the honest
// `measured: false` snapshot (never fake numbers, never a Home-breaking throw — ADR-079 C-02),
// and an unmeasured result is NOT memoized so recovery is next-request rather than next-window.

/** ADR-079 C-03 — the badge's freshness window (per-replica skew accepted, ADR-068 C-05). */
export const UPTIME_TTL_MS = 60_000;
/** ADR-079 C-03 — per-read deadline; a slower Gatus loses the race and the badge degrades. */
export const UPTIME_DEADLINE_MS = 3_000;

/** The windows the badge carries (headline = 30d; 24h/7d ride the tooltip). */
export type UptimeWindow = '24h' | '7d' | '30d';

/**
 * Structural subset of `@hnet/arr`'s GatusClient — kept structural so this package needs
 * no @hnet/arr dependency (the ScoreboardReader seam, DESIGN-040 precedent).
 */
export interface UptimeReader {
  /** Current status of the measured endpoint (`results[last].success`). */
  isUp(): Promise<boolean>;
  /** Uptime ratio 0..1 for a window (Gatus's plain-text float, already validated). */
  getUptime(window: UptimeWindow): Promise<number>;
}

/** The tRPC payload (ADR-079). All-null + `measured: false` = the honest unmeasured state. */
export interface UptimeSnapshot {
  /** True only when BOTH the current status and the 30d ratio were read successfully. */
  measured: boolean;
  up: boolean | null;
  uptime24h: number | null;
  uptime7d: number | null;
  uptime30d: number | null;
}

export const UNMEASURED_SNAPSHOT: UptimeSnapshot = {
  measured: false,
  up: null,
  uptime24h: null,
  uptime7d: null,
  uptime30d: null,
};

/** Race a read against the deadline; the loser rejects and degrades that field. */
function withDeadline<T>(promise: Promise<T>, deadlineMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`uptime read exceeded ${deadlineMs}ms`)),
      deadlineMs,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

/**
 * Read all four values in parallel (allSettled — never rejects). `measured` requires the
 * status AND the 30d ratio (the two things the badge headline renders — ADR-079 C-02);
 * a failed 24h/7d read degrades that window to null alone (tooltip-only loss). When
 * unmeasured, every field is null — no half-honest partial headline.
 */
export async function readUptimeSnapshot(
  reader: UptimeReader,
  opts: { deadlineMs?: number } = {},
): Promise<UptimeSnapshot> {
  const deadlineMs = opts.deadlineMs ?? UPTIME_DEADLINE_MS;
  const [up, d24h, d7d, d30d] = await Promise.allSettled([
    withDeadline(reader.isUp(), deadlineMs),
    withDeadline(reader.getUptime('24h'), deadlineMs),
    withDeadline(reader.getUptime('7d'), deadlineMs),
    withDeadline(reader.getUptime('30d'), deadlineMs),
  ]);
  if (up.status === 'rejected' || d30d.status === 'rejected') return UNMEASURED_SNAPSHOT;
  return {
    measured: true,
    up: up.value,
    uptime24h: d24h.status === 'fulfilled' ? d24h.value : null,
    uptime7d: d7d.status === 'fulfilled' ? d7d.value : null,
    uptime30d: d30d.value,
  };
}

export interface UptimeSource {
  get(): Promise<UptimeSnapshot>;
}

export interface CreateUptimeSourceOptions {
  reader: UptimeReader;
  ttlMs?: number;
  deadlineMs?: number;
  /** Injectable clock (tests). */
  now?: () => number;
}

/**
 * The single-flight TTL memo (the createPlayScoreboard contract): a fresh memo is served
 * as-is; a stale or absent one triggers ONE shared read (concurrent SSRs coalesce). An
 * unmeasured result is served but NOT memoized, so recovery is next-request.
 */
export function createUptimeSource(opts: CreateUptimeSourceOptions): UptimeSource {
  const now = opts.now ?? Date.now;
  const ttlMs = opts.ttlMs ?? UPTIME_TTL_MS;
  let memo: { at: number; value: UptimeSnapshot } | undefined;
  let inFlight: Promise<UptimeSnapshot> | undefined;
  return {
    async get() {
      if (memo && now() - memo.at < ttlMs) return memo.value;
      inFlight ??= readUptimeSnapshot(opts.reader, { deadlineMs: opts.deadlineMs })
        .then((value) => {
          if (value.measured) memo = { at: now(), value };
          return value;
        })
        .finally(() => {
          inFlight = undefined;
        });
      return inFlight;
    },
  };
}
