// ADR-103 — the HARNESS FLAG, guarded. The e2e stack serves a production build (`next build` + `next start`), and
// sets HNET_E2E_HARNESS=1 on it so the suite keeps the non-production behaviour it was written against at the places
// the app branches on NODE_ENV: the /e2e harness pages render, the ADR-081 boot tasks stay off, Better Auth does not
// rate limit, and Trash candidates refresh inline (ADR-035).
//
// The flag is honoured ONLY when BETTER_AUTH_URL's host is `localhost` or `127.0.0.1`, which is true of the e2e
// stack (and `pnpm dev:local`) and never of a deployed pod. Set anywhere else, it is ignored, production behaviour
// stays on, and the process warns once. No other module reads HNET_E2E_HARNESS.
//
// A subpath export (`@hnet/domain/e2e-harness`) with no imports, so a page can ask without pulling in the domain
// barrel.

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1']);

let warned = false;

function hostOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

/**
 * True when this process runs under the e2e harness: HNET_E2E_HARNESS is `1` AND BETTER_AUTH_URL points at
 * localhost or 127.0.0.1. A flag set with any other BETTER_AUTH_URL (or none) is ignored, with one warning per
 * process.
 */
export function e2eHarnessActive(
  env: Readonly<Record<string, string | undefined>> = process.env,
  warn: (message: string) => void = console.warn,
): boolean {
  if (env.HNET_E2E_HARNESS !== '1') return false;
  const host = hostOf(env.BETTER_AUTH_URL);
  if (host !== undefined && LOCAL_HOSTS.has(host)) return true;
  if (!warned) {
    warned = true;
    warn(
      `[e2e-harness] HNET_E2E_HARNESS=1 is ignored: BETTER_AUTH_URL's host (${host ?? 'unset'}) is not localhost or ` +
        '127.0.0.1, so production behaviour stays on (ADR-103).',
    );
  }
  return false;
}

/** Test seam: let the next ignored flag warn again. */
export function __resetE2eHarnessWarningForTests(): void {
  warned = false;
}
