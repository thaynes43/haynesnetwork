// ADR-056 (PLAN-046) — the READ surface for Kapowarr (@hnet/kapowarr/read). ComicVine-backed volume search
// (the match step), the added-volume list / detail (the reconcile step: monitored + downloaded counts), and
// the root-folder list (needed to add). Import-unrestricted (reads are safe everywhere); the mutating surface
// lives in ./write and is import-confined to packages/domain (ADR-056, the @hnet/arr / @hnet/lazylibrarian
// precedent). All acquisition stays Kapowarr's own (GetComics DDL) — this client NEVER touches MAM/qB/Prowlarr.
import { KapowarrHttp, type KapowarrHttpOptions } from './http';
import {
  kapowarrRootFolderListSchema,
  kapowarrSearchResponseSchema,
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
