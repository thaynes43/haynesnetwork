import { ForbiddenHostError } from './errors';

/**
 * R-14 / CLAUDE.md hard rule 3 — user-facing catalog URLs must be
 * `https://<sub>.haynesnetwork.com[/path]` and nothing else. Never `*.haynesops.com`.
 *
 * Mirror of the DB CHECK `app_catalog_url_haynesnetwork_only` (DESIGN-001 D-05):
 * end-anchored with `(/.*)?$` so the hostname must END in `.haynesnetwork.com` —
 * a prefix-only regex would accept `https://evil.haynesnetwork.com.attacker.io`.
 */
const DB_CHECK_MIRROR = /^https:\/\/[a-z0-9.-]+\.haynesnetwork\.com(\/.*)?$/;

/** Structural hostname rule (DESIGN-003 D-04): at least one subdomain label. */
const USER_FACING_HOSTNAME = /^([a-z0-9-]+\.)+haynesnetwork\.com$/;

export function isUserFacingUrl(raw: string): boolean {
  if (!DB_CHECK_MIRROR.test(raw)) return false;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  return (
    url.protocol === 'https:' &&
    USER_FACING_HOSTNAME.test(url.hostname) &&
    url.port === '' &&
    url.username === '' &&
    url.password === ''
  );
}

/**
 * Defense-in-depth layer 2 (DESIGN-003 D-04): re-asserts the R-14 predicate inside the
 * catalog domain helpers so no code path — tRPC or not — can write a forbidden host.
 * Layer 1 is the zod schema at the API edge; layer 3 is the DB CHECK constraint.
 */
export function assertUserFacingUrl(raw: string): void {
  if (!isUserFacingUrl(raw)) {
    throw new ForbiddenHostError(
      `Catalog URLs must be https://<sub>.haynesnetwork.com[/path] — got ${JSON.stringify(
        raw,
      )} (no ports, no credentials, and never *.haynesops.com — R-14)`,
    );
  }
}
