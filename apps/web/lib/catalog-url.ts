// DESIGN-004 D-11 / DESIGN-003 D-04 — client-side mirror of the R-14 catalog URL
// rule for live form feedback. The server (zod edge schema + domain assert + DB
// CHECK) stays authoritative; this only saves a round-trip on the obvious cases.
// Rule: https://<sub>.haynesnetwork.com[/path?query] — no other host (never
// *.haynesops.com — CLAUDE.md hard rule 3), no http:, no bare apex, no ports, no
// credentials, no IP literals.

const HOSTNAME_RE = /^([a-z0-9-]+\.)+haynesnetwork\.com$/i; // ≥1 subdomain label, end-anchored

/** Human-readable violation for live form validation; null = looks valid. */
export function catalogUrlError(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === '') return 'Enter a URL.';
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return 'Enter a full URL, e.g. https://app.haynesnetwork.com';
  }
  if (url.protocol !== 'https:') return 'Catalog URLs must use https://';
  if (!HOSTNAME_RE.test(url.hostname)) {
    return 'Host must be a *.haynesnetwork.com subdomain (never *.haynesops.com).';
  }
  if (url.port !== '') return 'Catalog URLs must not carry a port.';
  if (url.username !== '' || url.password !== '') {
    return 'Catalog URLs must not carry credentials.';
  }
  return null;
}
