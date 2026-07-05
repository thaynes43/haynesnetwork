import { InvalidCatalogUrlError } from './errors';

/**
 * ADR-013 / BRANCH-A — the catalog accepts ARBITRARY URLs entered as a plain string,
 * normalized from common forms. NO host allow/deny rules: the only floor is a
 * well-formed http(s) URL with no embedded credentials.
 *
 * The web client keeps an identical mirror of `normalizeCatalogUrl` in
 * apps/web/lib/catalog-url.ts (live UX only) — the two copies must stay byte-identical.
 */
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

/**
 * Domain single-writer floor (ADR-013): normalize + validate an arbitrary catalog URL.
 * Returns the canonical URL string on success; throws InvalidCatalogUrlError otherwise.
 * The zod edge schema stays lenient — the domain is authoritative.
 */
export function assertCatalogUrl(raw: string): string {
  const res = normalizeCatalogUrl(raw);
  if (!res.ok) {
    throw new InvalidCatalogUrlError(res.error);
  }
  return res.url;
}
