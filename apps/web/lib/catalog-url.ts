// Client-side mirror of the catalog URL normalizer for live form feedback. The
// catalog accepts ARBITRARY http(s) URLs (BRANCH-A: no host allow/deny rules) —
// bare hosts default to https://. The server (zod edge schema + domain assert + DB
// scheme backstop) stays authoritative; this only saves a round-trip on obvious cases.
// The authoritative copy lives in @hnet/domain src/url-assert.ts — keep them byte-identical.

export function normalizeCatalogUrl(
  raw: string,
): { ok: true; url: string } | { ok: false; error: string } {
  const trimmed = raw.trim();
  if (trimmed === '') return { ok: false, error: 'Enter a URL.' };
  // A real URL has no interior whitespace. Reject it up front so behavior is deterministic:
  // some URL engines throw on `https://a b`, others silently percent-encode it into a
  // surprising "valid" URL.
  if (/\s/.test(trimmed)) return { ok: false, error: 'A URL cannot contain spaces.' };
  const tryParse = (s: string): URL | null => {
    try {
      return new URL(s);
    } catch {
      return null;
    }
  };
  // Trust the string as typed only when it already names an http(s):// URL or a real scheme
  // (javascript:/mailto:); otherwise default to https:// so a bare host or host:port
  // (google.com, plex.example.com:32400) parses instead of the dotted host being read as a
  // scheme. The regex treats `scheme:` followed by a digit as a port, not a scheme.
  const hasScheme = /^[a-z][a-z0-9+.-]*:(\/\/|(?!\d))/i.test(trimmed);
  const url = tryParse(hasScheme ? trimmed : `https://${trimmed}`);
  if (!url) return { ok: false, error: 'That does not look like a URL. Try example.com.' };
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, error: 'Only http:// and https:// links are allowed.' };
  }
  if (url.username !== '' || url.password !== '') {
    return { ok: false, error: 'Remove the username and password from the URL.' };
  }
  const host = url.hostname;
  if (host === '') return { ok: false, error: 'That does not look like a URL. Try example.com.' };
  // Require a real domain (a dot), an IP, or localhost — rejects typos like "eeeee".
  if (!host.includes('.') && host !== 'localhost' && !host.startsWith('[')) {
    return { ok: false, error: 'Add a top-level domain, e.g. example.com.' };
  }
  // Canonical form: URL.href minus the lone trailing slash a bare host picks up.
  let out = url.toString();
  if (url.pathname === '/' && url.search === '' && url.hash === '') out = out.slice(0, -1);
  return { ok: true, url: out };
}

/** Human-readable violation for live form validation; null = looks valid. */
export function catalogUrlError(raw: string): string | null {
  const res = normalizeCatalogUrl(raw);
  return res.ok ? null : res.error;
}
