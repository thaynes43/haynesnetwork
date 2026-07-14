// ADR-056 (PLAN-046) — the READ surface for Kapowarr (@hnet/kapowarr/read). ComicVine-backed volume search
// (the match step), the added-volume list / detail (the reconcile step: monitored + downloaded counts), and
// the root-folder list (needed to add). Import-unrestricted (reads are safe everywhere); the mutating surface
// lives in ./write and is import-confined to packages/domain (ADR-056, the @hnet/arr / @hnet/lazylibrarian
// precedent). All acquisition stays Kapowarr's own (GetComics DDL) — this client NEVER touches MAM/qB/Prowlarr.
import { KapowarrHttp, type KapowarrHttpOptions } from './http';
import {
  kapowarrHistoryListSchema,
  kapowarrQueueListSchema,
  kapowarrRootFolderListSchema,
  kapowarrSearchResponseSchema,
  kapowarrTaskListSchema,
  kapowarrVolumeListSchema,
  kapowarrVolumeSchema,
} from './schemas';

/** Options shared by the read + write clients (mirrors LazyLibrarianClientOptions). */
export type KapowarrClientOptions = KapowarrHttpOptions;

/** A normalized ComicVine search candidate (the fields the domain resolver scores on). */
export interface KapowarrSearchCandidate {
  comicvineId: number;
  title: string;
  year: number | null;
  volumeNumber: number | null;
  publisher: string | null;
  issueCount: number | null;
  /** True when this is a translated (non-original-language) edition — the resolver deprioritizes it. */
  translated: boolean;
  /** The local volume id when this ComicVine volume is ALREADY added (null otherwise). */
  alreadyAdded: number | null;
}

/** A normalized added-volume snapshot (the fields the domain reconcile maps to a per-format status). */
export interface KapowarrVolume {
  id: number;
  comicvineId: number | null;
  title: string | null;
  monitored: boolean;
  issueCount: number;
  issuesDownloaded: number;
}

/** A Kapowarr root folder (id + path). */
export interface KapowarrRootFolder {
  id: number;
  folder: string | null;
}

/**
 * ADR-059 / DESIGN-030 D-08 (PLAN-048) — a normalized live download-queue entry (the Activity adapter's
 * downloading/importing/failed signal). `status` is the raw Kapowarr `DownloadState`; `progress` 0..100.
 */
export interface KapowarrQueueEntry {
  id: number | null;
  volumeId: number | null;
  issueId: number | null;
  status: string;
  progress: number | null;
  title: string | null;
  source: string | null;
}

/** A normalized completed-download history row (the Activity adapter's `completed`-recent signal). */
export interface KapowarrHistoryEntry {
  volumeId: number | null;
  issueId: number | null;
  title: string | null;
  /** Epoch MILLISECONDS (converted from Kapowarr's `downloaded_at` seconds), or null. */
  downloadedAtMs: number | null;
  success: boolean;
}

/** A normalized planned/running background task (the Activity adapter's `searching` signal). */
export interface KapowarrTask {
  action: string | null;
  volumeId: number | null;
  displayTitle: string | null;
}

export class KapowarrReadClient {
  private readonly http: KapowarrHttp;

  constructor(options: KapowarrClientOptions) {
    this.http = new KapowarrHttp(options);
  }

  /**
   * `GET /api/volumes/search?query=` — ComicVine-backed volume search. Returns the candidates RAW-normalized;
   * the domain resolver (pickBestVolume) scores them (original edition, title match). Empty ⇒ no ComicVine
   * match (or ComicVine key absent upstream — the volume stays honestly un-routable, never a fabricated add).
   */
  async searchVolumes(query: string): Promise<KapowarrSearchCandidate[]> {
    const rows = await this.http.json('GET', '/volumes/search', kapowarrSearchResponseSchema, { query });
    return rows.map((r) => ({
      comicvineId: r.comicvine_id,
      title: r.title,
      year: r.year ?? null,
      volumeNumber: r.volume_number ?? null,
      publisher: r.publisher ?? null,
      issueCount: r.issue_count ?? null,
      translated: r.translated ?? false,
      alreadyAdded: r.already_added ?? null,
    }));
  }

  /** `GET /api/volumes` — the added volumes (for a bulk reconcile / dedupe by ComicVine id). */
  async listVolumes(): Promise<KapowarrVolume[]> {
    const rows = await this.http.json('GET', '/volumes', kapowarrVolumeListSchema);
    return rows.map(toVolume);
  }

  /** `GET /api/volumes/{id}` — one volume's live state (monitored + downloaded counts) for reconcile. */
  async getVolume(id: number): Promise<KapowarrVolume | null> {
    try {
      const row = await this.http.json('GET', `/volumes/${id}`, kapowarrVolumeSchema);
      return toVolume(row);
    } catch {
      // A 404 (volume removed upstream) or a transient failure ⇒ nothing to reconcile this run.
      return null;
    }
  }

  /** `GET /api/rootfolder` — the configured comics root folders; the add needs one's id. */
  async getRootFolders(): Promise<KapowarrRootFolder[]> {
    const rows = await this.http.json('GET', '/rootfolder', kapowarrRootFolderListSchema);
    return rows.map((r) => ({ id: r.id, folder: r.folder ?? null }));
  }

  /**
   * `GET /api/activity/queue` — the live download queue (ADR-059 / DESIGN-030 D-08, the Activity adapter's
   * downloading/importing/failed signal). READ-ONLY. Kapowarr downloads from its OWN GetComics DDL sources.
   */
  async getQueue(): Promise<KapowarrQueueEntry[]> {
    const rows = await this.http.json('GET', '/activity/queue', kapowarrQueueListSchema);
    return rows.map((r) => ({
      id: r.id ?? null,
      volumeId: r.volume_id ?? null,
      issueId: r.issue_id ?? null,
      status: (r.status ?? '').toLowerCase(),
      progress: r.progress ?? null,
      title: r.web_title ?? r.title ?? null,
      source: r.source ?? null,
    }));
  }

  /**
   * `GET /api/activity/history` — the completed-download log (the Activity adapter's `completed`-recent
   * signal). READ-ONLY. `downloaded_at` (epoch seconds) is normalized to ms; `success` defaults true.
   */
  async getDownloadHistory(): Promise<KapowarrHistoryEntry[]> {
    const rows = await this.http.json('GET', '/activity/history', kapowarrHistoryListSchema);
    return rows.map((r) => ({
      volumeId: r.volume_id ?? null,
      issueId: r.issue_id ?? null,
      title: r.web_title ?? r.file_title ?? r.title ?? null,
      downloadedAtMs: r.downloaded_at != null ? r.downloaded_at * 1000 : null,
      success: r.success ?? true,
    }));
  }

  /**
   * `GET /api/system/tasks` — the planned/running background tasks (the Activity adapter's `searching`
   * signal: a search-shaped task's `volume_id`, or a monitored/mass search with `volume_id: null`).
   * READ-ONLY — the task SUBMIT (auto_search) lives on the confined write surface.
   */
  async getTasks(): Promise<KapowarrTask[]> {
    const rows = await this.http.json('GET', '/system/tasks', kapowarrTaskListSchema);
    return rows.map((r) => ({
      action: r.action ?? null,
      volumeId: r.volume_id ?? null,
      displayTitle: r.display_title ?? null,
    }));
  }
}

function toVolume(r: {
  id: number;
  comicvine_id?: number | null;
  title?: string | null;
  monitored?: boolean | null;
  issue_count?: number | null;
  issues_downloaded?: number | null;
}): KapowarrVolume {
  return {
    id: r.id,
    comicvineId: r.comicvine_id ?? null,
    title: r.title ?? null,
    monitored: r.monitored ?? false,
    issueCount: r.issue_count ?? 0,
    issuesDownloaded: r.issues_downloaded ?? 0,
  };
}

export function kapowarrReadClient(options: KapowarrClientOptions): KapowarrReadClient {
  return new KapowarrReadClient(options);
}
