// @hnet/kapowarr/write — the WRITE surface (ADR-056, read/write split). The ONLY sanctioned Kapowarr
// write-backs are the PLAN-046 comic-acquisition actions: add a volume by its resolved ComicVine id
// (monitored), toggle its monitored flag, and trigger a force-search (the `auto_search` task — the *arr
// Force-Search analog: search + grab). This entrypoint may be imported ONLY by the packages/domain comic
// orchestrator and by packages/kapowarr itself — enforced by the arr-write-import-guard test (extended for
// @hnet/kapowarr/write). Kapowarr acquires from ITS OWN sources (GetComics DDL) — this surface is NEVER
// wired to MAM/qBittorrent/Prowlarr/the compliance governor (PLAN-046 hard constraint).
import { KapowarrHttp } from './http';
import type { KapowarrClientOptions } from './read';
import { kapowarrVolumeSchema } from './schemas';
import { z } from 'zod';

/** Options for adding a volume: the ComicVine id + the root folder to file it under. */
export interface AddVolumeInput {
  comicvineId: number;
  rootFolderId: number;
  /** Monitor the volume (default true — a monitored volume is the *arr "Wanted"). */
  monitor?: boolean;
  /** Kick Kapowarr's search immediately on add (default true — reaches Wanted-and-searching in one call). */
  autoSearch?: boolean;
}

export class KapowarrWriteClient {
  private readonly http: KapowarrHttp;

  constructor(options: KapowarrClientOptions) {
    this.http = new KapowarrHttp(options);
  }

  /**
   * `POST /api/volumes` — add a volume by its resolved ComicVine id under `rootFolderId`, monitored, with an
   * immediate auto-search (the default). Returns the new local volume id (the reconcile + force-search key).
   * `monitoring_scheme: 'all'` + `monitor_new_issues: true` mirror Kapowarr's own add defaults.
   */
  async addVolume(input: AddVolumeInput): Promise<number> {
    const created = await this.http.json('POST', '/volumes', kapowarrVolumeSchema, {}, {
      comicvine_id: input.comicvineId,
      root_folder_id: input.rootFolderId,
      monitor: input.monitor ?? true,
      monitoring_scheme: 'all',
      monitor_new_issues: true,
      auto_search: input.autoSearch ?? true,
    });
    return created.id;
  }

  /**
   * `PUT /api/volumes/{id}` — flip a volume's monitored flag (monitored ⇒ the *arr "Wanted", eligible for
   * search/grab). Returns nothing (Kapowarr's edit responds `result: null`).
   */
  async setMonitored(id: number, monitored: boolean): Promise<void> {
    await this.http.json('PUT', `/volumes/${id}`, z.null(), {}, { monitored });
  }

  /**
   * `POST /api/system/tasks` `{ cmd: 'auto_search', volume_id }` — queue Kapowarr's auto-search-and-grab task
   * for the volume (the *arr Force-Search idiom: search its GetComics DDL sources and grab the best result).
   * This is the write the Library "Force Search" button (PLAN-045) fires for a comic. Kapowarr answers
   * 201 `{ error: null, result: { id: <task id> } }` (live-verified v1.3.1, 2026-07-17 — the first
   * real fire; the old `z.null()` schema was written blind and rejected the SUCCESS response). The
   * payload is not consumed, so tolerate any result the error-checked envelope carries.
   */
  async searchVolume(id: number): Promise<void> {
    await this.http.json('POST', '/system/tasks', z.unknown(), {}, { cmd: 'auto_search', volume_id: id });
  }
}

export function kapowarrWriteClient(options: KapowarrClientOptions): KapowarrWriteClient {
  return new KapowarrWriteClient(options);
}
