// ADR-109 C-02, C-07 / DESIGN-055 D-08 rule 3 (PLAN-077 P6) — the Audio Preference: when a Wrong language report finds
// the wanted audio already in the file, and that language is the title's original language, the app sets the show's
// preferred audio language in Plex, for everyone, on every server that carries the show, and reads it back (owner ruling
// Q-03, 2026-10-12). Otherwise it changes nothing and the guide explains how to pick the track.
//
// Case A (Regular Show: The Lost Tapes): BiOMA's DUAL files mark Portuguese as the default track and one HMAX file
// Bulgarian, with English beside them. Butterbean's Cafe: 38 files with 16 audio tracks each, Bulgarian the default. Both
// were fixed by hand on 2026-10-12 with exactly this write (show-level `audioLanguage` = en-US on HaynesTower and
// HaynesOps). Plex offers the preference on a show only: a movie's settings carry no audio language (DESIGN-055 Q-08,
// read live 2026-10-13), so a movie always gets the guidance.
//
// The Plex write goes through @hnet/plex/write only from here (ADR-017 C-10 confinement, hard rule 4), after its Repair
// Request (kind `audio_preference`) and `repair_requested` ledger event commit (hard rule 6), and every written server is
// read back before the request completes.
import { createHash } from 'node:crypto';
import { mediaItems, mediaPlexMatches, plexLibraries, plexServers, type DbClient, type FixActionEntry } from '@hnet/db';
import type { PlexAudioLanguagePreference, PlexAudioTrack, PlexServerName } from '@hnet/plex';
import { PLEX_SERVERS } from '@hnet/plex';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { resolveDb } from './db-client';
import type { ArrClientBundle } from './arr-clients';
import type { PlexClientBundle } from './plex-clients';
import { FixPlanChangedError, FixRefusedError, LedgerItemTombstonedError, NotFoundError } from './errors';
import { guardArrCall, listMediaChildren } from './media-children';
import { resolveFixTarget, type SearchScope } from './action-scope';
import { languageVerdict, readFileAudio, type LanguageVerdict } from './language-check';
import {
  audioLanguageName,
  canonicalLanguageCode,
  languageCodeFromArrName,
  languageOfPlexLocale,
  parseAudioLanguages,
  plexLocaleFor,
} from './fix-guards';
import { createRepairRequest, recordRepairTransition } from './repair-requests';
import { getRepairGuideRemedies } from './repair-guide-settings';

/** What the guide does with a Wrong language report whose language is in the file. */
export type AudioPreferenceAction =
  /** Set the show's preferred audio language on the servers listed in `toWrite`. */
  | 'set'
  /** Every server already prefers the wanted language for this show: nothing to write. */
  | 'already_set'
  /** Change nothing; the guide explains how to pick the track (`reason` says why). */
  | 'guidance';

export type AudioGuidanceReason =
  /** The file does not carry the wanted language in every file in scope (the Fix's replace path, not this one). */
  | 'not_present'
  /** The wanted language is not the title's original language (Q-03 ruling: a person's own preference). */
  | 'not_original'
  /** The *arr names no original language for the title. */
  | 'unknown_original'
  /** A movie: Plex offers no movie-level audio language (Q-08). */
  | 'movie'
  /** No Plex server carries the title (no ADR-047 match), or none could be read. */
  | 'no_plex'
  /** Plex's own list of languages has no value for the wanted one. */
  | 'no_plex_value';

/** One Plex server that carries the title, as read for the decision. */
export interface AudioPreferenceServer {
  slug: PlexServerName;
  /** The server's display name (`HaynesTower`). */
  name: string;
  ratingKey: string;
  /** The read failed: the server is left out of the write and named in the result. */
  unreachable: boolean;
  /** Plex offers the setting on this item (a show). */
  offered: boolean;
  /** The stored value (`en-US`; `''` is "Account default"). */
  current: string;
  /** The language the stored value names, or null for "Account default". */
  currentLanguage: string | null;
  /** The value to write for the wanted language (Plex's first locale for it), or null when Plex has none. */
  target: string | null;
}

/** The file's audio tracks as one Plex server lists them, for the guidance ("choose English (EAC3 5.1)"). */
export interface AudioTrackHint {
  server: string;
  tracks: PlexAudioTrack[];
}

export interface AudioPreferencePreview {
  action: AudioPreferenceAction;
  reason: AudioGuidanceReason | null;
  wanted: { code: string; name: string };
  original: { code: string; name: string } | null;
  isShow: boolean;
  /** The language check's verdict on the files in scope (D-08 rule 3). */
  verdict: LanguageVerdict;
  servers: AudioPreferenceServer[];
  /** The servers a `set` writes (those whose value is not the wanted language yet). */
  toWrite: PlexServerName[];
  /** The scope's own file on one server, when one episode or the movie is in scope and Plex could be read. */
  tracks: AudioTrackHint | null;
  /** The `audio_preference` remedy is on: the guide may offer the write (off: guidance only, as in P1). */
  remedyOn: boolean;
  /** What `set` would do, hashed: a different decision at confirm time is refused, not run. */
  digest: string;
}

export interface AudioPreferenceInput {
  db?: DbClient;
  arr: Pick<ArrClientBundle, 'read'>;
  plex: Pick<PlexClientBundle, 'read'>;
  mediaItemId: string;
  scope?: SearchScope;
  targetChildId?: number;
  seasonNumber?: number;
  /** The audio language the person wanted (ISO 639-2, e.g. `eng`). */
  wantedLanguage: string;
  /**
   * Which languages may be set. `original` (the default): a person's Wrong language report, the show's original language
   * only (Q-03 ruling). `household`: staff's sweep under the owner's ruling on #955 (2026-10-13), English when the show's
   * files carry it, else the original language; staff only (requester null).
   */
  rule?: AudioPreferenceRule;
}

/** DESIGN-055 P6 decision 14 — the Q-03 rule for a person's report, or the owner's household default for staff (#955). */
export type AudioPreferenceRule = 'original' | 'household';

const SERVER_NAMES: Record<PlexServerName, string> = {
  haynestower: 'HaynesTower',
  haynesops: 'HaynesOps',
  hayneskube: 'HaynesKube',
};

const isServerSlug = (slug: string): slug is PlexServerName => (PLEX_SERVERS as readonly string[]).includes(slug);

/**
 * The title's Plex items (ADR-047 match), one per server. A title can match in two libraries of one server, a show in
 * its TV library and a same-named movie in a movie library (12 Sonarr titles live, 2026-10-13: Love, Death & Robots on
 * HaynesOps matched movie 11764 before show 55811). The item in a library of the title's own kind wins (`show` for
 * Sonarr, `movie` for Radarr), then the lowest rating key.
 */
async function plexItemsFor(db: DbClient | undefined, mediaItemId: string, kind: 'show' | 'movie') {
  const rows = await resolveDb(db)
    .select({
      slug: plexServers.slug,
      name: plexServers.name,
      ratingKey: mediaPlexMatches.ratingKey,
      mediaType: plexLibraries.mediaType,
    })
    .from(mediaPlexMatches)
    .innerJoin(plexLibraries, eq(plexLibraries.id, mediaPlexMatches.plexLibraryId))
    .innerJoin(plexServers, eq(plexServers.id, plexLibraries.serverId))
    .where(eq(mediaPlexMatches.mediaItemId, mediaItemId))
    .orderBy(asc(plexServers.slug), asc(mediaPlexMatches.ratingKey));
  const ordered = [...rows.filter((r) => r.mediaType === kind), ...rows.filter((r) => r.mediaType !== kind)];
  const out: Array<{ slug: PlexServerName; name: string; ratingKey: string }> = [];
  for (const row of ordered) {
    if (!isServerSlug(row.slug) || out.some((o) => o.slug === row.slug)) continue;
    out.push({ slug: row.slug, name: row.name || SERVER_NAMES[row.slug], ratingKey: row.ratingKey });
  }
  return out.sort((a, b) => a.slug.localeCompare(b.slug));
}

/** One server's read, never throwing: an unreachable server is recorded as such and left out of the write. */
function serverFromRead(
  base: { slug: PlexServerName; name: string; ratingKey: string },
  pref: PlexAudioLanguagePreference | null,
  wanted: string,
): AudioPreferenceServer {
  if (!pref) {
    return { ...base, unreachable: true, offered: false, current: '', currentLanguage: null, target: null };
  }
  return {
    ...base,
    unreachable: false,
    offered: pref.offered,
    current: pref.value,
    currentLanguage: languageOfPlexLocale(pref.value),
    target: pref.offered ? plexLocaleFor(wanted, pref.options) : null,
  };
}

/**
 * D-08 rule 3 and the Q-03 ruling, pure: `set` only for a show, when the file has the wanted language, that language is
 * the title's original language, and Plex has a value for it; `already_set` when every server already prefers it; else
 * `guidance` with the reason.
 */
export function decideAudioPreference(input: {
  isShow: boolean;
  verdict: LanguageVerdict;
  wanted: string;
  original: string | null;
  servers: readonly AudioPreferenceServer[];
  /** `household` (staff, #955): English is allowed beside the original language. */
  rule?: AudioPreferenceRule;
}): { action: AudioPreferenceAction; reason: AudioGuidanceReason | null; toWrite: PlexServerName[] } {
  const guidance = (reason: AudioGuidanceReason) => ({ action: 'guidance' as const, reason, toWrite: [] });
  const wanted = canonicalLanguageCode(input.wanted);
  if (input.verdict !== 'present') return guidance('not_present');
  if (!input.isShow) return guidance('movie');
  if (input.original === null) return guidance('unknown_original');
  const allowed = canonicalLanguageCode(input.original) === wanted || (input.rule === 'household' && wanted === 'eng');
  if (!allowed) return guidance('not_original');
  const readable = input.servers.filter((s) => !s.unreachable && s.offered);
  if (readable.length === 0) return guidance('no_plex');
  const toWrite = readable.filter((s) => s.currentLanguage !== wanted);
  if (toWrite.length === 0) return { action: 'already_set', reason: null, toWrite: [] };
  if (toWrite.some((s) => s.target === null)) return guidance('no_plex_value');
  return { action: 'set', reason: null, toWrite: toWrite.map((s) => s.slug) };
}

/** A stable digest of what `set` would write. */
function previewDigest(p: Pick<AudioPreferencePreview, 'action' | 'servers' | 'toWrite' | 'wanted'>): string {
  const writes = p.toWrite.map((slug) => {
    const s = p.servers.find((x) => x.slug === slug)!;
    return [slug, s.ratingKey, s.current, s.target];
  });
  return createHash('sha256')
    .update(JSON.stringify({ action: p.action, wanted: p.wanted.code, writes }))
    .digest('hex')
    .slice(0, 24);
}

/** The scope's single file in Plex (an episode or the movie), for the guidance's track names. Best effort. */
async function readTrackHint(input: {
  plex: Pick<PlexClientBundle, 'read'>;
  servers: readonly AudioPreferenceServer[];
  isShow: boolean;
  episode: { seasonNumber: number; episodeNumber: number } | null;
}): Promise<AudioTrackHint | null> {
  const server = input.servers.find((s) => !s.unreachable);
  if (!server) return null;
  const client = input.plex.read[server.slug];
  try {
    let ratingKey: string | null = server.ratingKey;
    if (input.isShow) {
      if (!input.episode) return null;
      const seasons = await client.listMetadataChildren(server.ratingKey);
      const season = seasons.items.find((i) => i.index === input.episode!.seasonNumber);
      if (!season) return null;
      const episodes = await client.listMetadataChildren(season.ratingKey);
      ratingKey = episodes.items.find((i) => i.index === input.episode!.episodeNumber)?.ratingKey ?? null;
    }
    if (!ratingKey) return null;
    const tracks = await client.getAudioTracks(ratingKey);
    return tracks && tracks.length > 0 ? { server: server.name, tracks } : null;
  } catch {
    return null;
  }
}

/**
 * D-08 rules 1 and 3, read-only and free: the file's audio (the *arr's `mediaInfo`), the title's original language (the
 * *arr), each Plex server's stored preference, the decision, and the scope's own tracks in Plex for the guidance.
 */
export async function previewAudioPreference(input: AudioPreferenceInput): Promise<AudioPreferencePreview> {
  const db = resolveDb(input.db);
  const [item] = await db
    .select({ id: mediaItems.id, arrKind: mediaItems.arrKind, arrItemId: mediaItems.arrItemId, deletedFromArrAt: mediaItems.deletedFromArrAt })
    .from(mediaItems)
    .where(eq(mediaItems.id, input.mediaItemId));
  if (!item) throw new NotFoundError(`Media item ${input.mediaItemId} not found`);
  if (item.deletedFromArrAt !== null) {
    throw new LedgerItemTombstonedError(`Media item ${input.mediaItemId} is tombstoned — nothing to fix in the *arr`);
  }
  if (item.arrKind !== 'sonarr' && item.arrKind !== 'radarr') {
    throw new FixRefusedError('audio_preference_refused', 'Audio languages are checked for shows and movies only.');
  }
  const wanted = canonicalLanguageCode(input.wantedLanguage);
  const isShow = item.arrKind === 'sonarr';
  const resolved = resolveFixTarget(item.arrKind, {
    scope: input.scope,
    targetChildId: input.targetChildId,
    seasonNumber: input.seasonNumber,
  });

  const [audio, originalName] = await Promise.all([
    readFileAudio({
      db: input.db,
      arr: input.arr,
      mediaItemId: item.id,
      scope: input.scope,
      targetChildId: input.targetChildId,
      seasonNumber: input.seasonNumber,
    }),
    isShow
      ? guardArrCall(`sonarr GET /series/${item.arrItemId}`, () => input.arr.read.sonarr.getSeriesById(item.arrItemId)).then(
          (s) => s.originalLanguage?.name ?? null,
        )
      : guardArrCall(`radarr GET /movie/${item.arrItemId}`, () => input.arr.read.radarr.getMovieById(item.arrItemId)).then(
          (m) => m.originalLanguage?.name ?? null,
        ),
  ]);
  const verdict = languageVerdict(audio, wanted);
  const originalCode = languageCodeFromArrName(originalName);

  const matches = await plexItemsFor(input.db, item.id, isShow ? 'show' : 'movie');
  const servers = await Promise.all(
    matches.map(async (m) => {
      const pref = await input.plex.read[m.slug].getAudioLanguagePreference(m.ratingKey).catch(() => null);
      return serverFromRead(m, pref, wanted);
    }),
  );

  let episode: { seasonNumber: number; episodeNumber: number } | null = null;
  if (isShow && resolved.scope === 'episode' && resolved.targetChildId !== null) {
    const children = await listMediaChildren({ db: input.db, arr: input.arr, mediaItemId: item.id });
    const child = children.find((c) => c.arrChildId === resolved.targetChildId);
    if (child && child.seasonNumber !== null && child.episodeNumber !== null) {
      episode = { seasonNumber: child.seasonNumber, episodeNumber: child.episodeNumber };
    }
  }
  const tracks = await readTrackHint({ plex: input.plex, servers, isShow, episode });

  const decision = decideAudioPreference({ isShow, verdict, wanted, original: originalCode, servers, rule: input.rule });
  const remedies = await getRepairGuideRemedies(input.db);
  const preview = {
    remedyOn: remedies.audio_preference,
    action: decision.action,
    reason: decision.reason,
    wanted: { code: wanted, name: audioLanguageName(wanted) },
    original: originalCode ? { code: originalCode, name: audioLanguageName(originalCode) } : null,
    isShow,
    verdict,
    servers,
    toWrite: decision.toWrite,
    tracks,
  };
  return { ...preview, digest: previewDigest(preview) };
}

export interface SetAudioPreferenceInput extends AudioPreferenceInput {
  /** PLAN-077 P7 — the Seerr issue the guide was opened from (kept only when it is open and on this title). */
  seerrIssueId?: number | null;
  plex: PlexClientBundle;
  /** The person who confirmed; null is staff working from the in-cluster tool (no budget, "actor null"). */
  requesterId: string | null;
  requesterIsAdmin?: boolean;
  /** The digest of the preview the person confirmed; a different decision now is refused. */
  digest?: string;
}

export interface SetAudioPreferenceResult {
  outcome: 'set' | 'already_set';
  repairRequestId: string | null;
  language: { code: string; name: string };
  /** The servers that now prefer the language (written and read back, or already set). */
  servers: string[];
  /** Servers that carry the title but could not be read or written. */
  unreachable: string[];
}

const stepAt = () => new Date().toISOString();

/**
 * The single writer for the Audio Preference (ADR-109 C-07). Re-reads the decision; anything but `set` writes nothing
 * (`already_set` returns without a row; `guidance` refuses). Then the Repair Request (`audio_preference`, one budget
 * unit, its `repair_requested` event in the same transaction), then each server's `PUT .../prefs?audioLanguage=` and a
 * read-back. The request completes only when every written server reads back the wanted language; otherwise it fails,
 * with each server's step in its trail.
 */
export async function setAudioPreference(input: SetAudioPreferenceInput): Promise<SetAudioPreferenceResult> {
  if (input.rule === 'household' && input.requesterId !== null) {
    throw new FixRefusedError('audio_preference_refused', "The household default is staff's to set.");
  }
  const preview = await previewAudioPreference(input);
  if (input.digest !== undefined && input.digest !== preview.digest) {
    throw new FixPlanChangedError('Something changed since you looked, so nothing was done. Check again before you confirm.');
  }
  const settled = preview.servers.filter((s) => !s.unreachable && s.offered && s.currentLanguage === preview.wanted.code);
  const unreachable = preview.servers.filter((s) => s.unreachable).map((s) => s.name);
  if (preview.action === 'already_set') {
    return {
      outcome: 'already_set',
      repairRequestId: null,
      language: preview.wanted,
      servers: settled.map((s) => s.name),
      unreachable,
    };
  }
  if (preview.action !== 'set') {
    throw new FixRefusedError('audio_preference_refused', refusalText(preview));
  }
  if (!preview.remedyOn) {
    throw new FixRefusedError('audio_preference_refused', 'Setting the audio language for a show is turned off right now.');
  }

  const db = resolveDb(input.db);
  const [item] = await db.select({ arrKind: mediaItems.arrKind }).from(mediaItems).where(eq(mediaItems.id, input.mediaItemId));
  const resolved = resolveFixTarget(item!.arrKind, {
    scope: input.scope,
    targetChildId: input.targetChildId,
    seasonNumber: input.seasonNumber,
  });
  let seasonNumber = resolved.seasonNumber;
  let targetLabel: string | null = null;
  if (resolved.scope === 'episode' && resolved.targetChildId !== null) {
    const children = await listMediaChildren({ db: input.db, arr: input.arr, mediaItemId: input.mediaItemId });
    const child = children.find((c) => c.arrChildId === resolved.targetChildId);
    if (!child) throw new NotFoundError(`sonarr episode ${resolved.targetChildId} not found`);
    seasonNumber = child.seasonNumber;
    targetLabel = child.label;
  } else if (resolved.scope === 'season') {
    targetLabel = `Season ${resolved.seasonNumber}`;
  }

  const { repairRequestId } = await createRepairRequest({
    db: input.db,
    seerrIssueId: input.seerrIssueId ?? null,
    requesterId: input.requesterId,
    requesterIsAdmin: input.requesterIsAdmin,
    mediaItemId: input.mediaItemId,
    kind: 'audio_preference',
    scope: resolved.scope === 'season' ? 'season' : 'episode',
    seasonNumber,
    targetChildIds: resolved.targetChildId !== null ? [resolved.targetChildId] : [],
    targetLabel,
    reason: 'wrong_language',
    preview: {
      action: preview.action,
      rule: input.rule ?? 'original',
      wanted: preview.wanted.code,
      original: preview.original?.code ?? null,
      digest: preview.digest,
      servers: preview.servers.map((s) => ({
        server: s.slug,
        ratingKey: s.ratingKey,
        current: s.current,
        target: s.target,
        unreachable: s.unreachable,
      })),
      toWrite: preview.toWrite,
    },
  });

  const actions: FixActionEntry[] = [];
  const done: string[] = settled.map((s) => s.name);
  let failed = false;
  for (const slug of preview.toWrite) {
    const server = preview.servers.find((s) => s.slug === slug)!;
    const endpoint = `PUT ${slug} /library/metadata/${server.ratingKey}/prefs?audioLanguage=${server.target}`;
    try {
      await input.plex.write[slug].setAudioLanguagePreference(server.ratingKey, server.target!);
      actions.push({ step: 'plex_audio_preference', endpoint, ok: true, at: stepAt(), server: slug, from: server.current, to: server.target });
    } catch (err) {
      failed = true;
      actions.push({ step: 'plex_audio_preference', endpoint, ok: false, at: stepAt(), server: slug, error: errText(err) });
      continue;
    }
    const readEndpoint = `GET ${slug} /library/metadata/${server.ratingKey}?includePreferences=1`;
    try {
      const back = await input.plex.read[slug].getAudioLanguagePreference(server.ratingKey);
      const landed = back !== null && languageOfPlexLocale(back.value) === preview.wanted.code;
      actions.push({ step: 'plex_audio_readback', endpoint: readEndpoint, ok: landed, at: stepAt(), server: slug, value: back?.value ?? null });
      if (landed) done.push(server.name);
      else failed = true;
    } catch (err) {
      failed = true;
      actions.push({ step: 'plex_audio_readback', endpoint: readEndpoint, ok: false, at: stepAt(), server: slug, error: errText(err) });
    }
  }
  await recordRepairTransition({ db: input.db, repairRequestId, transition: failed ? 'failed' : 'completed', actions });
  if (failed) {
    const missed = preview.toWrite
      .map((slug) => preview.servers.find((s) => s.slug === slug)!.name)
      .filter((name) => !done.includes(name));
    throw new FixRefusedError(
      'audio_preference_refused',
      `Plex did not take the change on ${missed.join(' and ')}. Nothing else was changed. Try again in a little while.`,
    );
  }
  return { outcome: 'set', repairRequestId, language: preview.wanted, servers: done, unreachable };
}

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Why the preference is not set, in the guide's words. */
function refusalText(p: AudioPreferencePreview): string {
  switch (p.reason) {
    case 'not_original':
      return `${p.wanted.name} is not this title's original language, so Plex is left as it is. Pick the ${p.wanted.name} track in the player.`;
    case 'movie':
      return 'Plex keeps no audio language for a single movie, so pick the track in the player.';
    case 'not_present':
      return `Not every file here has ${p.wanted.name} audio, so Plex is left as it is.`;
    case 'unknown_original':
      return "This title's original language is not known, so Plex is left as it is.";
    case 'no_plex':
      return 'This title is not on a Plex server that could be reached, so nothing was changed.';
    case 'no_plex_value':
      return `Plex has no setting for ${p.wanted.name}, so pick the track in the player.`;
    default:
      return 'Nothing was changed.';
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// DESIGN-055 P6 decision 10 — the staff scan: every show whose files put another language ahead of the original one
// ---------------------------------------------------------------------------------------------------------------------

export interface AudioScanFinding {
  tvdbId: number;
  seriesId: number;
  mediaItemId: string | null;
  title: string;
  /** The series' original language (ISO 639-2). */
  original: string;
  /** Files carrying the original language at all. */
  filesWithOriginal: number;
  /** Of those, files whose first audio track is another language. */
  filesFirstOther: number;
  /** The languages those files lead with. */
  leadingLanguages: string[];
  /** One such file: its episode (the scope a fix uses) and name. */
  sample: { episodeId: number; label: string; fileName: string | null } | null;
  /**
   * The language Plex actually starts that file in (the track the file flags as default, else its first track), read on
   * the first server that answers; null when Plex could not be read. A finding is a real one when this is not `original`.
   */
  plexDefault: string | null;
  plex: Array<{ server: string; current: string; unreachable: boolean }>;
  /** Every readable Plex server already prefers the original language for this show. */
  preferenceSet: boolean;
  /**
   * DESIGN-055 P6 decision 14 (#955) — English in the show's files, for the household default: how many files carry an
   * English track, how many of those start in another language, and one file to use as the scope (one that starts in
   * another language when there is one).
   */
  english: { files: number; leadOther: number; sample: { episodeId: number; label: string } | null };
}

export interface AudioScanReport {
  seriesScanned: number;
  filesRead: number;
  findings: AudioScanFinding[];
}

/** The language a play starts in: the track the file flags as its default, else the first audio track. */
export function effectiveDefaultLanguage(tracks: readonly PlexAudioTrack[]): string | null {
  const track = tracks.find((t) => t.isDefault) ?? tracks[0];
  return track?.languageCode ? canonicalLanguageCode(track.languageCode) : null;
}

/**
 * DESIGN-055 P6 decision 10 — read-only: for every Sonarr series with files, the files whose audio carries the series'
 * original language behind another one (the *arr's `mediaInfo.audioLanguages`, in track order), confirmed on one such
 * file in Plex (the track a play starts in), and each Plex server's stored show preference. Sequential, one episode-file
 * read per series, so it stays gentle on Sonarr. Staff fix a finding with the same writer a person's Wrong language
 * report uses (`setAudioPreference`, requester null).
 */
export async function scanAudioDefaults(input: {
  db?: DbClient;
  arr: Pick<ArrClientBundle, 'read'>;
  plex: Pick<PlexClientBundle, 'read'>;
  /** Only these series (tests, a re-check). */
  onlySeriesIds?: readonly number[];
}): Promise<AudioScanReport> {
  const db = resolveDb(input.db);
  const sonarr = input.arr.read.sonarr;
  const series = await guardArrCall('sonarr GET /series', () => sonarr.listSeries());
  const findings: AudioScanFinding[] = [];
  let seriesScanned = 0;
  let filesRead = 0;
  for (const s of series.sort((a, b) => a.sortTitle.localeCompare(b.sortTitle))) {
    if (input.onlySeriesIds && !input.onlySeriesIds.includes(s.id)) continue;
    if (s.statistics.episodeFileCount === 0) continue;
    const original = languageCodeFromArrName(s.originalLanguage?.name);
    if (!original) continue;
    seriesScanned += 1;
    const files = await guardArrCall(`sonarr GET /episodefile?seriesId=${s.id}`, () => sonarr.listEpisodeFileReleases(s.id));
    filesRead += files.length;
    let withOriginal = 0;
    let firstOther = 0;
    const leading = new Set<string>();
    let sampleFile: (typeof files)[number] | null = null;
    let withEnglish = 0;
    let englishLeadOther = 0;
    let englishFile: (typeof files)[number] | null = null;
    for (const f of files) {
      const codes = parseAudioLanguages(f.mediaInfo?.audioLanguages);
      if (codes.includes('eng')) {
        withEnglish += 1;
        if (codes[0] !== 'eng') {
          englishLeadOther += 1;
          if (englishFile === null || parseAudioLanguages(englishFile.mediaInfo?.audioLanguages)[0] === 'eng') englishFile = f;
        } else {
          englishFile ??= f;
        }
      }
      if (!codes.includes(original)) continue;
      withOriginal += 1;
      if (codes[0] !== original) {
        firstOther += 1;
        leading.add(codes[0]!);
        sampleFile ??= f;
      }
    }
    if (firstOther === 0) continue;
    const [item] = await db
      .select({ id: mediaItems.id })
      .from(mediaItems)
      .where(and(eq(mediaItems.arrKind, 'sonarr'), eq(mediaItems.arrItemId, s.id), isNull(mediaItems.deletedFromArrAt)));
    let sample: AudioScanFinding['sample'] = null;
    let englishSample: AudioScanFinding['english']['sample'] = null;
    if (sampleFile || englishFile) {
      const episodes = await guardArrCall(`sonarr GET /episode?seriesId=${s.id}`, () => sonarr.listEpisodes(s.id));
      const label = (e: { seasonNumber: number; episodeNumber: number }) =>
        `S${String(e.seasonNumber).padStart(2, '0')}E${String(e.episodeNumber).padStart(2, '0')}`;
      const ep = sampleFile ? episodes.find((e) => e.episodeFileId === sampleFile!.id) : undefined;
      if (ep && sampleFile) {
        sample = {
          episodeId: ep.id,
          label: label(ep),
          fileName: (sampleFile.relativePath ?? '').split(/[\\/]/).pop() || null,
        };
      }
      const enEp = englishFile ? episodes.find((e) => e.episodeFileId === englishFile!.id) : undefined;
      if (enEp) englishSample = { episodeId: enEp.id, label: label(enEp) };
    }
    const plex: AudioScanFinding['plex'] = [];
    const servers: AudioPreferenceServer[] = [];
    if (item) {
      for (const m of await plexItemsFor(input.db, item.id, 'show')) {
        const pref = await input.plex.read[m.slug].getAudioLanguagePreference(m.ratingKey).catch(() => null);
        plex.push({ server: m.name, current: pref?.value ?? '', unreachable: pref === null });
        servers.push(serverFromRead(m, pref, original));
      }
    }
    let plexDefault: string | null = null;
    if (sample) {
      const m = /^S(\d+)E(\d+)$/.exec(sample.label)!;
      const hint = await readTrackHint({
        plex: input.plex,
        servers,
        isShow: true,
        episode: { seasonNumber: Number(m[1]), episodeNumber: Number(m[2]) },
      });
      plexDefault = hint ? effectiveDefaultLanguage(hint.tracks) : null;
    }
    const readable = plex.filter((p) => !p.unreachable);
    findings.push({
      tvdbId: s.tvdbId,
      seriesId: s.id,
      mediaItemId: item?.id ?? null,
      title: s.title,
      original,
      filesWithOriginal: withOriginal,
      filesFirstOther: firstOther,
      leadingLanguages: [...leading],
      sample,
      plexDefault,
      plex,
      preferenceSet: readable.length > 0 && readable.every((p) => languageOfPlexLocale(p.current) === original),
      english: { files: withEnglish, leadOther: englishLeadOther, sample: englishSample },
    });
  }
  findings.sort((a, b) => Number(a.preferenceSet) - Number(b.preferenceSet) || b.filesFirstOther - a.filesFirstOther);
  return { seriesScanned, filesRead, findings };
}

/**
 * ADR-115 / DESIGN-055 P6 decision 14 — the owner's household default (#955, 2026-10-13) for one scan finding: English
 * when the show's files carry an English track, else the original language. `noop` when every file that carries that
 * language already starts in it (Boruto: all 291 files start in English) AND no server stores another language (a show
 * set to `ja-JP` by an earlier report still plays Japanese, so it is not a no-op; PR #958 review), so nothing is written.
 */
export function householdTarget(f: AudioScanFinding): {
  language: string;
  scope: { episodeId: number; label: string } | null;
  noop: boolean;
} {
  const storedOther = (language: string) =>
    f.plex.some((p) => !p.unreachable && p.current !== '' && languageOfPlexLocale(p.current) !== language);
  if (f.english.files > 0) {
    return { language: 'eng', scope: f.english.sample, noop: f.english.leadOther === 0 && !storedOther('eng') };
  }
  return {
    language: f.original,
    scope: f.sample ? { episodeId: f.sample.episodeId, label: f.sample.label } : null,
    noop: (f.filesFirstOther === 0 || f.plexDefault === f.original) && !storedOther(f.original),
  };
}
