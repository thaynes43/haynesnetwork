// ADR-046 / DESIGN-024 (PLAN-023) — env contract for the two book servers.
// URLs are non-secret config with in-cluster service-DNS defaults (verified live 2026-07-10);
// usernames default to the bootstrap admin accounts; passwords are secrets (ExternalSecret
// in-cluster from the `kavita`/`audiobookshelf` 1Password items, .env.local in dev — hard rule 7)
// and are REQUIRED: there is no password default and values never appear in errors.
import { BooksConfigError } from './errors';

export const BOOK_SERVERS = ['kavita', 'audiobookshelf'] as const;
export type BookServerName = (typeof BOOK_SERVERS)[number];

/** In-cluster service DNS defaults (verified live 2026-07-10 from the frontend namespace). */
export const KAVITA_CLUSTER_URL_DEFAULT = 'http://kavita.media.svc.cluster.local:5000';
export const AUDIOBOOKSHELF_CLUSTER_URL_DEFAULT =
  'http://audiobookshelf.media.svc.cluster.local:13378';

/** The bootstrap admin usernames the app authenticates as (OIDC does not replace this READ path). */
export const KAVITA_DEFAULT_USERNAME = 'hnetadmin';
export const AUDIOBOOKSHELF_DEFAULT_USERNAME = 'root';

/**
 * PUBLIC user-facing base URLs used to build deep links stored on each ledger row (opens in a new tab —
 * the Phase-3 OIDC train makes these live). Distinct from the in-cluster `*_URL` the sync/cover proxy
 * FETCH from: users never see the `*.svc.cluster.local` address (hard rule 3). Overridable for staging.
 */
export const KAVITA_PUBLIC_URL_DEFAULT = 'https://kavita.haynesnetwork.com';
export const AUDIOBOOKSHELF_PUBLIC_URL_DEFAULT = 'https://audiobookshelf.haynesnetwork.com';

export interface KavitaConfig {
  baseUrl: string;
  username: string;
  password: string;
  publicUrl: string;
}

export interface AudiobookshelfConfig {
  baseUrl: string;
  username: string;
  password: string;
  publicUrl: string;
}

export interface BooksEnvConfig {
  kavita: KavitaConfig;
  audiobookshelf: AudiobookshelfConfig;
}

/**
 * Read `KAVITA_URL`/`KAVITA_USERNAME`/`KAVITA_PASSWORD` (+ AUDIOBOOKSHELF_*) from `env`.
 * URLs + usernames default; missing passwords throw a single BooksConfigError naming every
 * absent variable (values are never echoed). Used by the books-sync mode AND the web cover proxy.
 */
export function assertBooksEnv(
  env: Record<string, string | undefined> = process.env,
): BooksEnvConfig {
  const missing: string[] = [];

  const kavitaPassword = env.KAVITA_PASSWORD?.trim() ?? '';
  if (!kavitaPassword) missing.push('KAVITA_PASSWORD');
  const absPassword = env.AUDIOBOOKSHELF_PASSWORD?.trim() ?? '';
  if (!absPassword) missing.push('AUDIOBOOKSHELF_PASSWORD');

  if (missing.length > 0) throw new BooksConfigError(missing);

  return {
    kavita: {
      baseUrl: env.KAVITA_URL?.trim() || KAVITA_CLUSTER_URL_DEFAULT,
      username: env.KAVITA_USERNAME?.trim() || KAVITA_DEFAULT_USERNAME,
      password: kavitaPassword,
      publicUrl: (env.KAVITA_PUBLIC_URL?.trim() || KAVITA_PUBLIC_URL_DEFAULT).replace(/\/+$/, ''),
    },
    audiobookshelf: {
      baseUrl: env.AUDIOBOOKSHELF_URL?.trim() || AUDIOBOOKSHELF_CLUSTER_URL_DEFAULT,
      username: env.AUDIOBOOKSHELF_USERNAME?.trim() || AUDIOBOOKSHELF_DEFAULT_USERNAME,
      password: absPassword,
      publicUrl: (
        env.AUDIOBOOKSHELF_PUBLIC_URL?.trim() || AUDIOBOOKSHELF_PUBLIC_URL_DEFAULT
      ).replace(/\/+$/, ''),
    },
  };
}
