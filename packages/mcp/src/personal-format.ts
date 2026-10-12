// ADR-107 / DESIGN-054: concise factual speech alongside the full structured evidence.
import {
  capSpokenList,
  spokenTitle,
  type WatchBatchCheck,
  type WatchCandidateCheck,
  type WatchPersonalEvidence,
  type WatchResolvedIdentity,
  type WatchViewingContext,
} from '@hnet/watch';

function label(identity: WatchResolvedIdentity): string {
  return `${spokenTitle(identity.title)}${identity.year === null ? '' : `, ${identity.year}`}`;
}

function inputLabel(check: WatchCandidateCheck): string {
  if (check.identity) return label(check.identity);
  if (check.input.title) return spokenTitle(check.input.title);
  return 'The supplied title identity';
}

function viewingFact(evidence: WatchPersonalEvidence, kind: 'show' | 'movie'): string {
  switch (evidence.viewing) {
    case 'unknown':
      return 'viewing status unknown; recorded plays cannot be assigned to this identity';
    case 'not_mine':
      return 'marked not mine; other household viewing';
    case 'no_recorded_viewing':
      return 'no recorded viewing in available records';
    case 'played':
      return 'played; completion unconfirmed';
    case 'partial':
      return evidence.viewingBasis.includes('plex_resume')
        ? 'partial viewing; Plex resume evidence'
        : 'partial viewing in playback records';
    case 'watched':
      return `${kind === 'movie' ? 'recorded as watched' : 'recorded watched evidence; see statement scope and episode progress'} (${evidence.viewingBasis
        .map((basis) => {
          switch (basis) {
            case 'explicit_watched':
              return 'explicit watched statement';
            case 'plex_watched_state':
              return 'Plex watched flag';
            case 'plex_episode_state':
              return 'Plex episode state';
            case 'completed_playback':
              return 'playback watched verdict';
            case 'historical_completion':
              return 'retained playback watched summary';
            default:
              return '';
          }
        })
        .filter(Boolean)
        .join(', ')})`;
  }
}

function briefEvidence(identity: WatchResolvedIdentity, evidence: WatchPersonalEvidence): string {
  const feedback = evidence.dismissal === 'not_interested' ? '; marked not interested' : '';
  return `${label(identity)}: ${viewingFact(evidence, identity.kind)}${feedback}.`;
}

function unresolvedFact(check: WatchCandidateCheck, includeOptions = true): string {
  const name = inputLabel(check);
  if (check.reason === 'conflicting_ids')
    return `${name}: identifiers disagree; no viewing conclusion assigned.`;
  if (check.resolution === 'ambiguous')
    return `${name}: identity ambiguous; no viewing conclusion assigned.`;
  if (check.resolution === 'unavailable')
    return `${name}: identity lookup unavailable; viewing status unknown.`;
  if (check.reason === 'year_mismatch') {
    if (!check.options.length)
      return `${name}: release year differs; identity unresolved and viewing unknown.`;
    const options = check.options.slice(0, 2).map(label).join(' or ');
    return `${name}: release year differs; confirm ${includeOptions ? options : 'a canonical option'}${includeOptions && check.options.length > 2 ? ' or another listed option' : ''} before checking viewing.`;
  }
  return `${name}: identity unresolved; viewing status unknown.`;
}

export function formatCandidateChecks(batch: WatchBatchCheck): string {
  return capSpokenList({
    lead: `Checked ${batch.results.length} candidates against available personal records.`,
    items: batch.results.map((check) =>
      check.resolution === 'resolved' && check.identity && check.evidence
        ? briefEvidence(check.identity, check.evidence)
        : unresolvedFact(check),
    ),
  });
}

export function formatViewingContext(context: WatchViewingContext): string {
  return capSpokenList({
    lead: 'Personal viewing and feedback. Plays alone do not prove completion or liking.',
    items: context.items.map(({ identity, evidence }) => {
      const genres = evidence.genres.slice(0, 2).map(spokenTitle);
      return `${briefEvidence(identity, evidence)}${genres.length ? ` Genres: ${genres.join(', ')}.` : ''}`;
    }),
    more: Math.max(0, context.page.total - context.page.offset - context.items.length),
  });
}

export function formatSingleWatchCheck(check: WatchCandidateCheck): string {
  if (check.resolution !== 'resolved' || !check.identity || !check.evidence) {
    const options = check.options.map(label);
    return capSpokenList({ lead: unresolvedFact(check, false), items: options });
  }
  const { identity, evidence } = check;
  const details: string[] = [];
  const progress = evidence.progress;
  if (identity.kind === 'show' && progress.episodesWatched !== null) {
    details.push(
      `${progress.episodesWatched}${progress.episodesTotal === null ? '' : ` of ${progress.episodesTotal}`} episodes currently watched.`,
    );
  }
  if (identity.kind === 'movie' && progress.resumePercent !== null && progress.resumePercent > 0) {
    details.push(`Current resume point: ${Math.round(progress.resumePercent)} percent.`);
  }
  if (progress.state !== 'unknown')
    details.push(`Current Plex progress: ${progress.state.replaceAll('_', ' ')}.`);
  details.push(
    evidence.onPlex === true
      ? 'On Plex.'
      : evidence.onPlex === false
        ? 'Not on Plex.'
        : 'Plex membership unknown.',
  );
  details.push(
    evidence.onWatchlist === true
      ? 'On your watchlist.'
      : evidence.onWatchlist === false
        ? 'Not on your watchlist.'
        : 'Watchlist membership unknown.',
  );
  return capSpokenList({ lead: briefEvidence(identity, evidence), items: details });
}
