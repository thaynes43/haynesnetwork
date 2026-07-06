// ADR-016 / DESIGN-005 D-19 — the per-kind Fix Reason offer rule. The R-45 taxonomy
// (FIX_REASONS) is unchanged (all six values still valid in the enum); this is an OFFER
// filter, not an enum edit. `missing_subtitles` routes to Bazarr, which covers the
// Radarr/Sonarr estate only — so Music (lidarr) is not offered that reason.
import { FIX_REASONS, type ArrKind, type FixReason } from '@hnet/db';

/** The Fix reasons offered for a kind: sonarr/radarr get all six; lidarr excludes missing_subtitles. */
export function fixReasonsForKind(kind: ArrKind): readonly FixReason[] {
  if (kind === 'lidarr') {
    return FIX_REASONS.filter((r) => r !== 'missing_subtitles');
  }
  return FIX_REASONS;
}
