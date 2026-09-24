// ADR-091 / DESIGN-050 D-09 — `/login?next=`: where the sign-in lands afterwards. Only a RELATIVE path is ever
// honoured — it must start with `/` and not `//` (a protocol-relative URL is another origin), carry no backslash
// (browsers read `/\evil.example` as `//evil.example`) and no control or whitespace character, and be at most
// 2,048 characters; anything else falls back to `/`. It must ALSO fit Better Auth's relative-callback grammar
// (better-auth 1.6.23 `matchesOriginPattern` with `allowRelativePaths`), because the login button hands it over
// as `callbackURL` and Better Auth refuses the sign-in (403 INVALID_CALLBACK_URL) on anything else — a value that
// would only fail there falls back to `/` here instead. The OAuth authorize and consent paths always fit: they are
// built percent-encoded (`lib/oauth/authorize.ts`).

export const NEXT_MAX_LENGTH = 2048;

/** better-auth 1.6.23 auth/trusted-origins.mjs — the relative-path form it accepts for a callbackURL. */
const BETTER_AUTH_RELATIVE = /^\/(?!\/|\\|%2f|%5c)[\w\-.+/@]*(?:\?[\w\-.+/=&%@]*)?$/;

/** A safe post-sign-in destination (D-09), or `/`. */
export function safeNext(value: unknown): string {
  if (typeof value !== 'string') return '/';
  if (value.length === 0 || value.length > NEXT_MAX_LENGTH) return '/';
  if (!value.startsWith('/') || value.startsWith('//')) return '/';
  if (value.includes('\\') || /[\u0000- \u007f]/.test(value)) return '/';
  if (!BETTER_AUTH_RELATIVE.test(value)) return '/';
  // Belt and braces: resolved against any origin it must stay on that origin.
  try {
    if (new URL(value, 'https://origin.invalid').origin !== 'https://origin.invalid') return '/';
  } catch {
    return '/';
  }
  return value;
}

/** The first value of a Next `searchParams` entry. */
export function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** `/login?next=…` for a relative destination (the destination is percent-encoded once). */
export function loginPath(next: string): string {
  const safe = safeNext(next);
  return safe === '/' ? '/login' : `/login?next=${encodeURIComponent(safe)}`;
}
