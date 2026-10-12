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
      return 'partial viewing recorded';
    case 'watched':
      if (kind === 'movie') return 'recorded as watched';
      if (
        evidence.statements.some(
          (statement) => statement.action === 'watched' && statement.scope === 'show',
        )
      ) {
        return 'explicitly marked watched';
      }
      return 'recorded viewing; see episode progress';
  }
}

function briefEvidence(identity: WatchResolvedIdentity, evidence: WatchPersonalEvidence): string {
  const feedback = evidence.dismissal === 'not_interested' ? '; marked not interested' : '';
  return `${label(identity)}: ${viewingFact(evidence, identity.kind)}${feedback}.`;
}

function unresolvedFact(check: WatchCandidateCheck): string {
  const name = inputLabel(check);
  if (check.reason === 'conflicting_ids')
    return `${name}: identifiers disagree; no viewing conclusion assigned.`;
  if (check.resolution === 'ambiguous')
    return `${name}: identity ambiguous; no viewing conclusion assigned.`;
  if (check.resolution === 'unavailable')
    return `${name}: identity lookup unavailable; viewing status unknown.`;
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
    return capSpokenList({ lead: unresolvedFact(check), items: options });
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
