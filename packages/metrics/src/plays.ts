// ADR-068 / DESIGN-040 — the estate play scoreboard read model: lifetime Tautulli
// get_libraries_table totals from all three estate instances, summed by section type,
// behind a single-flight in-process TTL memo (the "semi-live" contract, D-03). Read-only,
// no persistence — a memo, not a store (ADR-041 C-04 spirit). Every instance degrades
// independently (allSettled + a short deadline, D-02); an all-failed aggregate is honest
// (`unavailable`) and the dashboard renders NOTHING for it (D-07).

/** DESIGN-040 D-03 — the "semi-live" freshness window. */
export const SCOREBOARD_TTL_MS = 10 * 60_000;
/** DESIGN-040 D-02 — per-instance read deadline; a slower Tautulli is marked failed. */
export const SCOREBOARD_DEADLINE_MS = 3_000;

/**
 * Structural subset of `@hnet/arr`'s TautulliLibrariesTableRow — kept structural so this
 * package needs no @hnet/arr dependency (the same seam as PrometheusReader). Numerics
 * tolerate Tautulli's string looseness; non-finite coerces to 0.
 */
export interface ScoreboardLibraryRow {
  section_type?: string | null;
  plays?: number | string | null;
  duration?: number | string | null;
}

/** One estate Tautulli — `@hnet/arr` TautulliClient satisfies this structurally. */
export interface ScoreboardReader {
  slug: string;
  getLibrariesTable(): Promise<ScoreboardLibraryRow[]>;
}

export interface ScoreboardInstanceStatus {
  slug: string;
  /** False when the read failed or blew the deadline — that instance contributed nothing. */
  ok: boolean;
}

/** DESIGN-040 D-01 — the aggregate. Totals only: no user, no title, no per-server counts. */
export interface EstatePlayTotals {
  moviePlays: number;
  episodePlays: number;
  trackPlays: number;
  /** Σ duration (seconds) across the three counted kinds, rounded to whole hours. */
  hoursWatched: number;
  /** Server-side diagnostics (D-09) — the UI never renders this. */
  instances: ScoreboardInstanceStatus[];
  /** True iff NO instance contributed (none configured, or every read failed) ⇒ render nothing. */
  unavailable: boolean;
}

/** Coerce Tautulli's number-or-string numerics; non-finite/negative ⇒ 0 (D-01). */
function toCount(value: number | string | null | undefined): number {
  const n = typeof value === 'number' ? value : Number(value ?? Number.NaN);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** section_type → aggregate bucket; photo and unknown types are EXCLUDED entirely (D-01). */
const KIND_BUCKET: Record<string, 'moviePlays' | 'episodePlays' | 'trackPlays'> = {
  movie: 'moviePlays',
  show: 'episodePlays',
  artist: 'trackPlays',
};

/** Race a read against the deadline; the loser rejects and is folded into `ok: false`. */
function withDeadline<T>(promise: Promise<T>, deadlineMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`scoreboard read exceeded ${deadlineMs}ms`)),
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
 * DESIGN-040 D-01/D-02 — read every instance in parallel (allSettled — a failure NEVER
 * blocks the render) and sum plays + duration by section type. Never rejects.
 */
export async function aggregatePlayTotals(
  readers: ScoreboardReader[],
  opts: { deadlineMs?: number } = {},
): Promise<EstatePlayTotals> {
  const deadlineMs = opts.deadlineMs ?? SCOREBOARD_DEADLINE_MS;
  const settled = await Promise.allSettled(
    readers.map((reader) => withDeadline(reader.getLibrariesTable(), deadlineMs)),
  );

  const totals: EstatePlayTotals = {
    moviePlays: 0,
    episodePlays: 0,
    trackPlays: 0,
    hoursWatched: 0,
    instances: [],
    unavailable: true,
  };
  let durationSeconds = 0;
  settled.forEach((result, i) => {
    const slug = readers[i]!.slug;
    if (result.status === 'rejected') {
      totals.instances.push({ slug, ok: false });
      return;
    }
    totals.instances.push({ slug, ok: true });
    for (const row of result.value) {
      const bucket = KIND_BUCKET[row.section_type ?? ''];
      if (!bucket) continue; // photo + unknown kinds: excluded from plays AND duration
      totals[bucket] += toCount(row.plays);
      durationSeconds += toCount(row.duration);
    }
  });
  totals.hoursWatched = Math.round(durationSeconds / 3600);
  totals.unavailable = !totals.instances.some((inst) => inst.ok);
  return totals;
}

export interface PlayScoreboardSource {
  get(): Promise<EstatePlayTotals>;
}

export interface CreatePlayScoreboardOptions {
  readers: ScoreboardReader[];
  ttlMs?: number;
  deadlineMs?: number;
  /** Injectable clock (tests). */
  now?: () => number;
}

/**
 * DESIGN-040 D-03 — the single-flight TTL memo. A fresh memo is served as-is; a stale or
 * absent one triggers ONE shared aggregation (concurrent SSRs coalesce). An `unavailable`
 * result is served but NOT memoized, so recovery is next-request rather than next-window.
 */
export function createPlayScoreboard(opts: CreatePlayScoreboardOptions): PlayScoreboardSource {
  const now = opts.now ?? Date.now;
  const ttlMs = opts.ttlMs ?? SCOREBOARD_TTL_MS;
  let memo: { at: number; value: EstatePlayTotals } | undefined;
  let inFlight: Promise<EstatePlayTotals> | undefined;
  return {
    async get() {
      if (memo && now() - memo.at < ttlMs) return memo.value;
      inFlight ??= aggregatePlayTotals(opts.readers, { deadlineMs: opts.deadlineMs })
        .then((value) => {
          if (!value.unavailable) memo = { at: now(), value };
          return value;
        })
        .finally(() => {
          inFlight = undefined;
        });
      return inFlight;
    },
  };
}
