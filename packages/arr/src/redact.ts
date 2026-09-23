// DESIGN-049 D-01 (PLAN-068 S3) — credential redaction for everything an @hnet/arr error exposes.
//
// Most *arr-family services take their key in a header, but two clients here cannot: Tautulli
// authenticates ONLY by an `apikey` QUERY parameter, and TMDB v3 (the `TMDB_API_KEY` fallback) by an
// `api_key` query parameter. The shared ArrHttp builds the full request URL and every ArrError used to
// embed it verbatim — so a Tautulli 5xx/timeout or a TMDB 401 put a live key into the error message, and
// from there into the sync logs and `sync_runs.error`. The error constructors now pass every URL through
// `redactUrl` and every message/body snippet through `redactSecrets`; the key never survives.
//
// The redacted names (compared case-insensitively): `apikey` (Tautulli, LazyLibrarian, SABnzbd), `api_key`
// (TMDB v3, Kapowarr), `token` (the webhook receivers' `?token=`) and `X-Plex-Token` (Plex accepts its token
// as a query parameter too; this app sends it only as a header, but a URL carrying it is redacted anyway).

/** Query-parameter names whose VALUES are credentials — lower-case; matched case-insensitively. */
export const SECRET_QUERY_PARAMS: readonly string[] = ['apikey', 'api_key', 'token', 'x-plex-token'];

/** What a redacted value is replaced with. */
export const REDACTED = 'REDACTED';

const SECRET_NAMES = new Set(SECRET_QUERY_PARAMS);

function decodeName(raw: string): string {
  try {
    return decodeURIComponent(raw.replace(/\+/g, ' ')).trim().toLowerCase();
  } catch {
    return raw.trim().toLowerCase(); // malformed %-escape — compare the raw name
  }
}

/**
 * Redact the value of every credential query parameter in a URL string. Structure-preserving: nothing
 * else in the URL is decoded, re-encoded or reordered (so the result still reads as the request that was
 * made). A parameter NAME is compared after percent-decoding, so `X%2DPlex%2DToken=…` is caught too. The
 * whole URL then gets the free-text pass as well, which catches what a `&`-split cannot see (a `;`-joined
 * pair, a key pasted into the path). Strings that are not URLs get the free-text pass alone.
 */
export function redactUrl(url: string): string {
  const q = url.indexOf('?');
  if (q < 0) return redactSecrets(url);
  const hash = url.indexOf('#', q);
  const end = hash < 0 ? url.length : hash;
  const query = url
    .slice(q + 1, end)
    .split('&')
    .map((pair) => {
      const eq = pair.indexOf('=');
      const rawName = eq < 0 ? pair : pair.slice(0, eq);
      return SECRET_NAMES.has(decodeName(rawName)) ? `${rawName}=${REDACTED}` : pair;
    })
    .join('&');
  return redactSecrets(url.slice(0, q + 1) + query + url.slice(end));
}

const NAMES = 'apikey|api_key|token|x-plex-token';
// `"name": "value"` — a JSON body (an error payload) that echoes a credential field. The closing quote is
// optional so a value CUT OFF by a body-snippet limit is still redacted to its end.
const JSON_PATTERN = new RegExp(`("(?:${NAMES})"\\s*:\\s*")((?:[^"\\\\]|\\\\.)*)("|$)`, 'gi');
// `name=value`, `name: value`, `'name': 'value'` anywhere in free text — a query pair, an echoed request
// URL or header, a Python/YAML dump. The left boundary refuses word characters and '-', so `csrf_token=` or
// the `token` inside `x-plex-token` are never taken as the name; a value ends at the first URL/text
// delimiter (or the end of the text, when a snippet limit cut it).
const PAIR_PATTERN = new RegExp(
  `(^|[^A-Za-z0-9_-])(${NAMES})(['"]?\\s*[=:]\\s*['"]?)([^&\\s#"'<>,;}]*)`,
  'gi',
);

/** Redact credential `"name":"value"` JSON fields and `name=value` / `name: value` pairs in free text. */
export function redactSecrets(text: string): string {
  return text
    .replace(JSON_PATTERN, (_m, open: string, _value: string, close: string) => `${open}${REDACTED}${close}`)
    .replace(PAIR_PATTERN, (_m, lead: string, name: string, sep: string) => `${lead}${name}${sep}${REDACTED}`);
}
