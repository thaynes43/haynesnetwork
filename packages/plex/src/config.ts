// ADR-017 / DESIGN-007 D-03 — env contract for the three Plex servers of record (OPS-002).
// Per-server base URLs are non-secret config with in-cluster service-DNS defaults; the owner
// TOKENS are secrets (ExternalSecret in-cluster, .env.local in dev — CLAUDE.md rule 7) and
// are REQUIRED: there is no token default and token values NEVER appear in errors (copy of
// the @hnet/arr assertArrEnv discipline). Env var names use the canonical SLUGS, not the
// ingress subdomains (plexops/k8plex) — the token_ref stored on plex_servers matches these.
import { PlexConfigError } from './errors';

export const PLEX_SERVERS = ['haynestower', 'haynesops', 'hayneskube'] as const;
export type PlexServerName = (typeof PLEX_SERVERS)[number];

/**
 * The plex.tv host the v1 sharing API lives on (friend/share model). Fixed, non-secret;
 * separate from a server's own base URL because sharing is a plex.tv-account operation keyed
 * on the server's machineIdentifier, not a call to the PMS itself.
 */
export const PLEX_TV_BASE_URL = 'https://plex.tv';

/**
 * In-cluster service DNS defaults (OPS-002 topology; the app runs in the `frontend` ns and
 * reaches the `media` ns by FQDN). Local dev / staging override with the public ingresses
 * (`https://plex.haynesnetwork.com` etc.) via PLEX_<SLUG>_URL. These URLs are backend config
 * only and must never be shown to users (hard rule 3) — but they ARE exempt from the catalog
 * http(s) rule (server-side, ADR-013 note). Only used for the direct-PMS reads
 * (`/library/sections`, `/identity`); sharing writes go to PLEX_TV_BASE_URL.
 */
export const PLEX_CLUSTER_URL_DEFAULTS: Record<PlexServerName, string> = {
  haynestower: 'http://haynestower.media.svc.cluster.local:32400',
  haynesops: 'http://plexops.media.svc.cluster.local:32400',
  hayneskube: 'http://plex.media.svc.cluster.local:32400',
};

/**
 * The Plex server GUIDs (machineIdentifier) the plex.tv sharing API keys on. Verified live
 * 2026-07-06 and seeded into `plex_servers.machine_identifier` (migration 0010) — the DB row
 * is the live truth (the registry refresh re-reads `/identity`), but the env-built client
 * bundle needs them at construction, so they are pinned here as defaults (overridable via
 * `PLEX_<SLUG>_MACHINE_ID` if a server is ever reclaimed). These MUST match the 0010 seed.
 */
export const PLEX_MACHINE_IDENTIFIERS: Record<PlexServerName, string> = {
  haynestower: 'a5ec8cb29c425667637eabdb6a0615d6ccf68cc3',
  haynesops: '80b33acb1d207508990637ec151fe9abad8d3d7a',
  hayneskube: 'c1b23d688afea4a39ec2c214776832c16be6504d',
};

export interface PlexInstanceConfig {
  /** Direct PMS base URL (registry reads). */
  baseUrl: string;
  /** The server's owner X-Plex-Token (secret). */
  token: string;
  /** The Plex server GUID (for the plex.tv sharing API). */
  machineIdentifier: string;
  /** plex.tv host for the sharing API (overridable via PLEX_TV_URL — e2e points it at the stub). */
  plexTvBaseUrl: string;
}

export type PlexEnvConfig = Record<PlexServerName, PlexInstanceConfig>;

/**
 * Read `PLEX_HAYNESTOWER_URL`/`PLEX_HAYNESTOWER_TOKEN` (+ HAYNESOPS_/HAYNESKUBE_) from `env`.
 * URLs default to the cluster service DNS; a missing token throws a single PlexConfigError
 * naming every absent variable (token values are never echoed).
 */
export function assertPlexEnv(env: Record<string, string | undefined> = process.env): PlexEnvConfig {
  const missing: string[] = [];
  const config = {} as PlexEnvConfig;
  const plexTvBaseUrl = env.PLEX_TV_URL?.trim() || PLEX_TV_BASE_URL;
  for (const server of PLEX_SERVERS) {
    const prefix = `PLEX_${server.toUpperCase()}`;
    const baseUrl = env[`${prefix}_URL`]?.trim() || PLEX_CLUSTER_URL_DEFAULTS[server];
    const token = env[`${prefix}_TOKEN`]?.trim() ?? '';
    const machineIdentifier =
      env[`${prefix}_MACHINE_ID`]?.trim() || PLEX_MACHINE_IDENTIFIERS[server];
    if (!token) missing.push(`${prefix}_TOKEN`);
    config[server] = { baseUrl, token, machineIdentifier, plexTvBaseUrl };
  }
  if (missing.length > 0) throw new PlexConfigError(missing);
  return config;
}
