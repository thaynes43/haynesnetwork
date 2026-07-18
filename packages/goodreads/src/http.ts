// ADR-055 / DESIGN-028 (PLAN-044) — shared GET primitive for the Goodreads RSS + Google Books clients.
// Per-attempt AbortController timeout + MANDATORY backoff retry on 5xx/429/network/timeout (hard
// constraint: "GB retry/backoff on every call" — Google Books `backendFailed` bursts are transient 503s).
// Returns the raw response text. `fetchImpl`/`sleepImpl` are injectable so unit tests + the hermetic e2e
// stub run offline (ADR-010).
import { GoodreadsHttpError, GoodreadsNetworkError, GoodreadsTimeoutError } from './errors';

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_RETRIES = 3;
const DEFAULT_BACKOFF_MS = 500;
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

/** A DAILY-quota 429 body ("Queries per day" / legacy "Daily Limit Exceeded") — mirrors the
 * domain breaker's GB_DAILY_BODY so the two agree on what "cannot succeed before the reset" means. */
const GB_DAILY_QUOTA_BODY = /per day|daily limit|dailyLimitExceeded/i;

/** Ceiling for an honored `Retry-After` (seconds→ms): a large window can't wedge a whole run —
 * the domain-side per-minute breaker takes over once retries are exhausted and the 429 throws. */
const RETRY_AFTER_CAP_MS = 5_000;

/**
 * The delay before the next retry. Honors a numeric `Retry-After` (seconds) when the server sends
 * one, capped at RETRY_AFTER_CAP_MS; otherwise a JITTERED linear backoff (`backoffMs * attempt`,
 * ±25%) so the three GB consumers (web Fix / goodreads-sync / format-pairing) don't retry in
 * lockstep after a shared per-minute burst. Google Books sends no Retry-After on quota 429s (a
 * 2026-07-18 live capture had none), so the jittered branch is the norm; the header branch is
 * defensive for other hosts / future behavior.
 */
export function nextBackoffMs(backoffMs: number, attempt: number, retryAfter?: string | null): number {
  if (retryAfter != null && retryAfter !== '') {
    const secs = Number(retryAfter);
    if (Number.isFinite(secs) && secs > 0) return Math.min(secs * 1_000, RETRY_AFTER_CAP_MS);
  }
  const base = backoffMs * attempt;
  return Math.round(base * (0.75 + Math.random() * 0.5));
}

export interface GetOptions {
  timeoutMs?: number;
  retries?: number;
  backoffMs?: number;
  accept?: string;
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Redact a `key=` query param so a Google Books key never lands in an error/log. */
export function redactKey(url: string): string {
  return url.replace(/([?&])key=[^&]*/i, '$1key=REDACTED');
}

export async function getText(url: string, options: GetOptions = {}): Promise<string> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retries = options.retries ?? DEFAULT_RETRIES;
  const backoffMs = options.backoffMs ?? DEFAULT_BACKOFF_MS;
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleepImpl = options.sleepImpl ?? defaultSleep;
  const redacted = redactKey(url);

  let attempt = 0;
  for (;;) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: 'GET',
        headers: { Accept: options.accept ?? 'application/json, application/rss+xml, text/xml, */*' },
        signal: controller.signal,
      });
    } catch (error) {
      clearTimeout(timer);
      const aborted = controller.signal.aborted;
      if (attempt < retries) {
        attempt += 1;
        await sleepImpl(nextBackoffMs(backoffMs, attempt));
        continue;
      }
      if (aborted) throw new GoodreadsTimeoutError(redacted, timeoutMs);
      throw new GoodreadsNetworkError(redacted, { cause: error });
    }
    clearTimeout(timer);

    if (!response.ok) {
      const snippet = (await response.text().catch(() => '')).slice(0, 300);
      // ADR-067 (PLAN-055): a 429 whose body names the DAILY quota ("Queries per day" / legacy
      // "Daily Limit Exceeded") cannot succeed before the 07:00 UTC reset — retrying it is pointless
      // by definition, so it throws immediately (the domain-side quota breaker arms the day trip from
      // the body snippet). Every other retryable status (incl. a per-MINUTE burst 429) keeps the
      // mandatory backoff loop, now jittered + Retry-After-aware.
      const dailyQuota429 = response.status === 429 && GB_DAILY_QUOTA_BODY.test(snippet);
      if (RETRYABLE_STATUS.has(response.status) && !dailyQuota429 && attempt < retries) {
        attempt += 1;
        await sleepImpl(nextBackoffMs(backoffMs, attempt, response.headers.get('retry-after')));
        continue;
      }
      throw new GoodreadsHttpError(response.status, redacted, snippet || undefined);
    }
    return response.text();
  }
}
