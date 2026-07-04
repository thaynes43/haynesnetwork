// DESIGN-005 D-15/D-17 (media-hierarchy actions) — the SCOPE a Fix or Force Search
// targets, and the per-kind rules that make a (kind, scope, child, season) tuple legal.
// Kept as one pure module so the Fix writer, the Force Search writer, and their two
// orchestrators validate identically (a mismatch would let the audit row and the *arr
// command disagree).
//
//   Force Search scopes (search-only, wider — whole show/artist allowed):
//     radarr: 'item' (the movie)
//     sonarr: 'show' | 'season' | 'episode'
//     lidarr: 'artist' | 'album'
//   Fix scopes (destructive, narrower — whole show/artist are Force-Search-ONLY, D-15):
//     radarr: 'item'   sonarr: 'season' | 'episode'   lidarr: 'album'
import type { ArrKind } from '@hnet/db';
import { FixTargetRequiredError } from './errors';

export type SearchScope = 'item' | 'show' | 'season' | 'episode' | 'artist' | 'album';
export type FixScope = 'item' | 'season' | 'episode' | 'album';

export interface ScopeInput {
  /** Explicit scope; when omitted the legacy per-kind default is derived (back-compat). */
  scope?: SearchScope;
  /** Episode id (sonarr) / album id (lidarr) — for 'episode'/'album' scopes. */
  targetChildId?: number | null;
  /** Sonarr season number — for 'season' scope. */
  seasonNumber?: number | null;
}

export interface ResolvedScope<S extends string> {
  scope: S;
  targetChildId: number | null;
  seasonNumber: number | null;
}

/** Whether a scope needs a single child id (episode/album) vs a season vs neither. */
function childRequired(scope: SearchScope): boolean {
  return scope === 'episode' || scope === 'album';
}
function seasonRequired(scope: SearchScope): boolean {
  return scope === 'season';
}

/**
 * Force Search: resolve + validate the target for a kind. Missing scope derives the
 * legacy default (radarr → item; sonarr → episode when a child was given, else the
 * whole-show search; lidarr → album), so old single-target callers are unchanged.
 */
export function resolveSearchTarget(kind: ArrKind, input: ScopeInput): ResolvedScope<SearchScope> {
  const childId = input.targetChildId ?? null;
  const season = input.seasonNumber ?? null;
  const scope: SearchScope =
    input.scope ??
    (kind === 'radarr' ? 'item' : kind === 'sonarr' ? (childId !== null ? 'episode' : 'show') : 'album');

  const allowed: Record<ArrKind, SearchScope[]> = {
    radarr: ['item'],
    sonarr: ['show', 'season', 'episode'],
    lidarr: ['artist', 'album'],
  };
  assertScope(kind, scope, allowed[kind], childId, season);
  return { scope, targetChildId: childRequired(scope) ? childId : null, seasonNumber: seasonRequired(scope) ? season : null };
}

/**
 * Fix: resolve + validate the target for a kind. Whole-show/whole-artist are NOT fix
 * scopes (Force-Search-only, D-15). Missing scope derives the legacy default (radarr →
 * item; sonarr → episode; lidarr → album), so old single-target callers are unchanged.
 */
export function resolveFixTarget(kind: ArrKind, input: ScopeInput): ResolvedScope<FixScope> {
  const childId = input.targetChildId ?? null;
  const season = input.seasonNumber ?? null;
  const scope: SearchScope =
    input.scope ?? (kind === 'radarr' ? 'item' : kind === 'sonarr' ? 'episode' : 'album');

  const allowed: Record<ArrKind, SearchScope[]> = {
    radarr: ['item'],
    sonarr: ['season', 'episode'],
    lidarr: ['album'],
  };
  assertScope(kind, scope, allowed[kind], childId, season);
  // Narrowed to FixScope by the allow-list above (show/artist rejected).
  return {
    scope: scope as FixScope,
    targetChildId: childRequired(scope) ? childId : null,
    seasonNumber: seasonRequired(scope) ? season : null,
  };
}

function assertScope(
  kind: ArrKind,
  scope: SearchScope,
  allowed: SearchScope[],
  childId: number | null,
  season: number | null,
): void {
  if (!allowed.includes(scope)) {
    throw new FixTargetRequiredError(`${kind} does not support the '${scope}' scope`);
  }
  if (childRequired(scope) && childId === null) {
    throw new FixTargetRequiredError(
      `${kind} '${scope}' scope requires a ${scope === 'album' ? 'album' : 'episode'} target`,
    );
  }
  if (!childRequired(scope) && childId !== null) {
    throw new FixTargetRequiredError(`the '${scope}' scope takes no child target`);
  }
  if (seasonRequired(scope) && season === null) {
    throw new FixTargetRequiredError(`the 'season' scope requires a season number`);
  }
  if (!seasonRequired(scope) && season !== null) {
    throw new FixTargetRequiredError(`the '${scope}' scope takes no season number`);
  }
}
