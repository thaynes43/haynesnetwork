// @hnet/downloads — env contract for the MAM-governor clients (ADR-054 / DESIGN-027, PLAN-039).
// URLs are non-secret config with in-cluster service-DNS defaults (verified live 2026-07-11 from the
// `frontend` namespace: both Services answer cross-namespace). qBittorrent's WebAPI answers WITHOUT auth
// (verified: GET /api/v2/app/version → v5.2.1, HTTP 200 from the cluster pod network), so the governor's
// COUNT path needs NO credential. The GATE seam is Prowlarr's indexer `enable` toggle (see read.ts/write.ts
// for why the LazyLibrarian-side toggle was REJECTED — Prowlarr's fullSync app clobbers LL provider edits),
// which DOES require Prowlarr's API key (`/api/v1/health` → 401 without it), so PROWLARR_API_KEY is REQUIRED
// and never echoed in an error (CLAUDE.md hard rule 7).
import { DownloadsConfigError } from './errors';

/** qBittorrent WebAPI base — the primary `qbittorrent` Service in the `downloads` namespace (port 8080). */
export const QBITTORRENT_CLUSTER_URL_DEFAULT =
  'http://qbittorrent.downloads.svc.cluster.local:8080';
/** The category PLAN-031 files every MAM torrent under (qB save path .../torrents/books/books-mam). */
export const QBITTORRENT_MAM_CATEGORY_DEFAULT = 'books-mam';
/** Prowlarr API base — the primary `prowlarr` Service in the `downloads` namespace (port 9696). */
export const PROWLARR_CLUSTER_URL_DEFAULT = 'http://prowlarr.downloads.svc.cluster.local:9696';
/** The Prowlarr indexer id for MyAnonaMouse (verified live: `GET /api/v1/indexer/17` → name "MyAnonaMouse"). */
export const PROWLARR_MAM_INDEXER_ID_DEFAULT = 17;

export interface QbittorrentConfig {
  baseUrl: string;
  /** The qB category the governor counts unsatisfied torrents in. */
  category: string;
}

export interface ProwlarrConfig {
  baseUrl: string;
  /** Prowlarr's API key (media-stack 1Password item) — required; auth header `X-Api-Key`; never echoed. */
  apiKey: string;
  /** The Prowlarr indexer id the governor toggles `enable` on (default 17 = MyAnonaMouse). */
  indexerId: number;
}

export interface GovernorClientsConfig {
  qbittorrent: QbittorrentConfig;
  prowlarr: ProwlarrConfig;
}

/**
 * Read the governor's client env: `QBITTORRENT_URL` / `QBITTORRENT_MAM_CATEGORY` (URL + category, both
 * defaulted), `PROWLARR_URL` / `PROWLARR_MAM_INDEXER_ID` (defaulted), and the REQUIRED `PROWLARR_API_KEY`.
 * A missing key throws a single DownloadsConfigError naming it (never its value). The qBittorrent side
 * needs no secret.
 */
export function assertGovernorClientsEnv(
  env: Record<string, string | undefined> = process.env,
): GovernorClientsConfig {
  const missing: string[] = [];
  const qbBaseUrl = env.QBITTORRENT_URL?.trim() || QBITTORRENT_CLUSTER_URL_DEFAULT;
  const category = env.QBITTORRENT_MAM_CATEGORY?.trim() || QBITTORRENT_MAM_CATEGORY_DEFAULT;
  const prowlarrBaseUrl = env.PROWLARR_URL?.trim() || PROWLARR_CLUSTER_URL_DEFAULT;
  const rawIndexerId = env.PROWLARR_MAM_INDEXER_ID?.trim();
  const parsedIndexerId = rawIndexerId ? Number.parseInt(rawIndexerId, 10) : NaN;
  const indexerId = Number.isFinite(parsedIndexerId)
    ? parsedIndexerId
    : PROWLARR_MAM_INDEXER_ID_DEFAULT;
  const apiKey = env.PROWLARR_API_KEY?.trim() ?? '';
  if (!apiKey) missing.push('PROWLARR_API_KEY');
  if (missing.length > 0) throw new DownloadsConfigError(missing);
  return {
    qbittorrent: { baseUrl: qbBaseUrl, category },
    prowlarr: { baseUrl: prowlarrBaseUrl, apiKey, indexerId },
  };
}
