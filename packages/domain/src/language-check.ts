// ADR-109 C-03 / DESIGN-055 D-08 rules 1-3 (PLAN-077 P1) — Wrong language reads the file's audio before anything is
// blocklisted or deleted. READ-ONLY. The one wrong_language Fix in the 90 days before 2026-10-12 took the delete path;
// in Case A the wanted English track was in every file, only behind a Portuguese default.
//
// The source is the *arr's own read of the file (`mediaInfo.audioLanguages`, ISO 639-2 codes). Plex's per-server
// stream list and the preferred-audio write come with PLAN-077 P6 (DESIGN-055 Q-03 ruling); until then a file that has
// the wanted language gets guidance only, and the Fix refuses to destroy it.
import { mediaItems, type DbClient } from '@hnet/db';
import { eq } from 'drizzle-orm';
import { LedgerItemTombstonedError, NotFoundError } from './errors';
import { resolveDb } from './db-client';
import type { ArrClientBundle } from './arr-clients';
import { guardArrCall, listMediaChildren } from './media-children';
import { resolveFixTarget, type SearchScope } from './action-scope';
import { audioLanguageName, fileHasLanguage, parseAudioLanguages } from './fix-guards';

export interface FileAudioLanguages {
  /** What the guide calls the file: the episode label, or null for the movie. */
  label: string | null;
  /** The distinct audio languages, as canonical ISO 639-2 codes, in track order. */
  codes: string[];
}

export interface FileAudio {
  /** One entry per on-disk file in scope (a movie: one; an episode: one; a season: every on-disk episode). */
  files: FileAudioLanguages[];
  /** Every language found across the files, for the "Which language did you want?" list. */
  languages: Array<{ code: string; name: string }>;
}

/** Read the audio languages of the file(s) a Fix would touch. Sonarr and Radarr only. */
export async function readFileAudio(input: {
  db?: DbClient;
  arr: Pick<ArrClientBundle, 'read'>;
  mediaItemId: string;
  scope?: SearchScope;
  targetChildId?: number;
  seasonNumber?: number;
}): Promise<FileAudio> {
  const db = resolveDb(input.db);
  const [item] = await db
    .select({ id: mediaItems.id, arrKind: mediaItems.arrKind, arrItemId: mediaItems.arrItemId, deletedFromArrAt: mediaItems.deletedFromArrAt })
    .from(mediaItems)
    .where(eq(mediaItems.id, input.mediaItemId));
  if (!item) throw new NotFoundError(`Media item ${input.mediaItemId} not found`);
  if (item.deletedFromArrAt !== null) {
    throw new LedgerItemTombstonedError(`Media item ${input.mediaItemId} is tombstoned — nothing to fix in the *arr`);
  }
  const files: FileAudioLanguages[] = [];
  if (item.arrKind === 'radarr') {
    const movieFiles = await guardArrCall(`radarr GET /moviefile?movieId=${item.arrItemId}`, () =>
      input.arr.read.radarr.listMovieFiles(item.arrItemId),
    );
    for (const f of movieFiles) files.push({ label: null, codes: parseAudioLanguages(f.mediaInfo?.audioLanguages) });
  } else if (item.arrKind === 'sonarr') {
    const resolved = resolveFixTarget('sonarr', {
      scope: input.scope,
      targetChildId: input.targetChildId,
      seasonNumber: input.seasonNumber,
    });
    const children = await listMediaChildren({ db: input.db, arr: input.arr, mediaItemId: item.id });
    const inScope = children.filter((c) =>
      resolved.scope === 'season'
        ? c.seasonNumber === resolved.seasonNumber && c.hasFile
        : c.arrChildId === resolved.targetChildId,
    );
    const fileIds = new Set(inScope.map((c) => c.episodeFileId).filter((id): id is number => id !== null && id > 0));
    if (fileIds.size > 0) {
      const episodeFiles = await guardArrCall(`sonarr GET /episodefile?seriesId=${item.arrItemId}`, () =>
        input.arr.read.sonarr.listEpisodeFileReleases(item.arrItemId),
      );
      for (const child of inScope) {
        const f = episodeFiles.find((e) => e.id === child.episodeFileId);
        if (f) files.push({ label: child.label, codes: parseAudioLanguages(f.mediaInfo?.audioLanguages) });
      }
    }
  }
  const all: string[] = [];
  for (const f of files) for (const c of f.codes) if (!all.includes(c)) all.push(c);
  return { files, languages: all.map((code) => ({ code, name: audioLanguageName(code) })) };
}

export type LanguageVerdict = 'present' | 'missing' | 'unknown';

/**
 * D-08 rule 3: `present` when EVERY file in scope carries the wanted language (nothing to blocklist or delete),
 * `missing` when a file with readable audio lacks it (the Fix runs as before), `unknown` when no file's audio could be
 * read (the Fix runs as before; the guide says it could not tell).
 */
export function languageVerdict(audio: FileAudio, wanted: string): LanguageVerdict {
  const readable = audio.files.filter((f) => f.codes.length > 0);
  if (readable.length === 0) return 'unknown';
  if (readable.length < audio.files.length) {
    return readable.some((f) => !fileHasLanguage(f.codes, wanted)) ? 'missing' : 'unknown';
  }
  return readable.every((f) => fileHasLanguage(f.codes, wanted)) ? 'present' : 'missing';
}
