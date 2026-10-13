'use client';

// ADR-109 C-02, C-03 / ADR-110 C-04 / DESIGN-055 D-01, D-04, D-05 (PLAN-077 P4) — the Episode Re-map step of the Repair
// Guide: "this file is really another episode" (a single move) or "they're all off by one" (a season shift). It asks one
// question, previews every move in the order it will run with what each file's own name says, names the episodes left
// empty, and moves the existing files only after the person confirms (`fix.remap` with the plan's digest). Afterwards
// each episode left empty is offered Force Search (the same `fix.forceSearch` the title page uses, so the hourly budget
// and the Import Check apply), and a release group that filed several of the moved files is offered the Mislabel Block.
//
// Owner rulings (2026-10-12): a re-map never deletes a file, so nothing here is "gone afterwards" and nothing is ticked;
// a slot that holds a file the plan does not move refuses the plan. Anyone who can use Fix may use it.
//
// Rendered inside the guide's Modal (hard rule 8). Hard rule 9: the dialog keeps its fixed height and the steps replace
// each other in place; a button that turns into its answer (Force Search, the Mislabel offer) shares one reserved cell
// with that answer, so nothing beside or below it moves. Copy lives in lib/remap-guide.ts.
import Link from 'next/link';
import { useState } from 'react';
import { MediaAction, ReservedActionSlot } from '@hnet/ui';
import { trpc } from '@/lib/trpc-client';
import { appCodeOf, describeMutationError } from '@/lib/app-error';
import {
  REMAP_FIX_REASON,
  REMAP_NOTHING_LOST,
  REMAP_WATCHED_NOTE,
  mislabelButtonLabel,
  mislabelNotSavedText,
  mislabelOfferTitle,
  mislabelOfferWhy,
  mislabelSavedText,
  moveLine,
  nameEvidenceLine,
  remapConfirmLabel,
  remapConfirmable,
  resultLead,
  resultNotes,
  shiftClaim,
  shiftDefaults,
  shiftFromOptions,
  shiftThroughOptions,
  suggestedTarget,
  targetOptions,
  vacatedNote,
  vacatedResultNote,
  type RemapClaim,
  type RemapEpisodeRef,
  type RemapKind,
  type RemapResult,
  type ShiftChoice,
} from '@/lib/remap-guide';
import { ActionLiveChip, useActionProgress, type SearchProgressInput } from '@/components/action-progress';

export interface EpisodeRemapProps {
  item: { id: string; title: string };
  kind: RemapKind;
  /** The season (a shift), or the episode's season when known (a single move from a Title Check flag). */
  seasonNumber: number | null;
  /** A single move: the episode the file is on now, and its label. */
  fromEpisodeId?: number;
  /** "S01E24 · Some Title" or "Season 1": what the guide is fixing. */
  targetLabel: string;
  /** A Title Check flag (D-05): the episode the file's name points at; the guide opens straight at the preview. */
  initialToEpisodeId?: number | null;
  /** Back to the guide's previous question. */
  onBack: () => void;
  onClose: () => void;
  /** The title changed (files moved, a search started): refresh what the page shows. */
  onChanged: () => void;
  /** The guide's banner line (null clears it). */
  setError: (message: string | null) => void;
}

type Step = 'ask' | 'preview' | 'done';

const PLAN_CHANGED = 'The season changed since you looked. Here is what it looks like now.';

export function EpisodeRemap({
  item,
  kind,
  seasonNumber: knownSeason,
  fromEpisodeId,
  targetLabel,
  initialToEpisodeId = null,
  onBack,
  onClose,
  onChanged,
  setError,
}: EpisodeRemapProps) {
  const startAtPreview = kind === 'single' && initialToEpisodeId !== null && knownSeason !== null;
  const [step, setStep] = useState<Step>(startAtPreview ? 'preview' : 'ask');
  const [toChoice, setToChoice] = useState<number | null>(initialToEpisodeId);
  const [shift, setShift] = useState<Partial<ShiftChoice>>({});
  const [claim, setClaim] = useState<RemapClaim | null>(
    startAtPreview && fromEpisodeId !== undefined && initialToEpisodeId !== null
      ? { kind: 'single', fromEpisodeId, toEpisodeId: initialToEpisodeId }
      : null,
  );
  const [result, setResult] = useState<RemapResult | null>(null);

  // A single move from the episode list knows only the episode: its season comes from the title's episode list.
  const children = trpc.ledger.children.useQuery(
    { mediaItemId: item.id },
    { enabled: knownSeason === null && fromEpisodeId !== undefined, staleTime: 60_000 },
  );
  const seasonNumber =
    knownSeason ?? children.data?.find((c) => c.arrChildId === fromEpisodeId)?.seasonNumber ?? null;

  const season = trpc.fix.remapSeason.useQuery(
    { mediaItemId: item.id, seasonNumber: seasonNumber ?? 0 },
    { enabled: seasonNumber !== null && step === 'ask', staleTime: 60_000, retry: false, refetchOnWindowFocus: false },
  );
  const plan = trpc.fix.remapPlan.useQuery(
    { mediaItemId: item.id, seasonNumber: seasonNumber ?? 0, claim: claim ?? { kind: 'single', fromEpisodeId: 1, toEpisodeId: 1 } },
    {
      enabled: seasonNumber !== null && claim !== null && step === 'preview',
      staleTime: Infinity,
      gcTime: 0,
      retry: false,
      refetchOnWindowFocus: false,
    },
  );

  const remap = trpc.fix.remap.useMutation({
    onError: (err) => {
      if (appCodeOf(err) === 'FIX_PLAN_CHANGED') {
        setError(PLAN_CHANGED);
        void plan.refetch();
        return;
      }
      setError(describeMutationError(err));
    },
    onSuccess: (r) => {
      setError(null);
      setResult(r);
      setStep('done');
      onChanged();
    },
  });

  const targetLine = (
    <p className="fix-target">
      Fixing <strong>{targetLabel}</strong>
    </p>
  );

  function toPreview(next: RemapClaim) {
    setError(null);
    setClaim(next);
    setStep('preview');
  }

  function backToAsk() {
    setError(null);
    setStep('ask');
  }

  // ---------------------------------------------------------------- the question
  if (step === 'ask') {
    const data = season.data;
    const loading = seasonNumber === null ? children.isLoading : season.isLoading;
    const failure = seasonNumber === null ? (children.error ?? null) : (season.error ?? null);
    const backButton = (
      <button type="button" className="btn" onClick={onBack}>
        Back
      </button>
    );
    if (loading || (!data && !failure && seasonNumber !== null)) {
      return (
        <div className="repair-guide__step">
          {targetLine}
          <p className="muted" role="status">
            Loading the season…
          </p>
        </div>
      );
    }
    if (failure || !data) {
      return (
        <div className="repair-guide__step">
          {targetLine}
          <p className="alert">
            Couldn&rsquo;t load the season{failure ? `: ${failure.message}` : '.'}
          </p>
          <p className="muted">Nothing was changed.</p>
          <div className="form-actions">
            {backButton}
            {seasonNumber !== null ? (
              <button type="button" className="btn" onClick={() => void season.refetch()}>
                Try again
              </button>
            ) : null}
          </div>
        </div>
      );
    }

    if (kind === 'single' && fromEpisodeId !== undefined) {
      const suggested = suggestedTarget(data, fromEpisodeId);
      const chosen = toChoice ?? suggested?.id ?? null;
      const options = targetOptions(data.episodes, fromEpisodeId);
      return (
        <form
          className="admin-form fix-form repair-guide__step"
          onSubmit={(e) => {
            e.preventDefault();
            if (chosen !== null) toPreview({ kind: 'single', fromEpisodeId, toEpisodeId: chosen });
          }}
        >
          {targetLine}
          <label className="field">
            <span className="repair-guide__question">Which episode is this really?</span>
            <select
              value={chosen ?? ''}
              onChange={(e) => setToChoice(e.target.value === '' ? null : Number(e.target.value))}
            >
              <option value="">Choose the episode it plays…</option>
              {options.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <p className="muted">
            {suggested
              ? `Its file name says ${suggested.label}, so that one is picked. Change it if the name is wrong.`
              : 'Pick the episode this file actually plays. Nothing moves until you confirm.'}
          </p>
          <div className="form-actions">
            {backButton}
            <button type="submit" className="btn primary" disabled={chosen === null}>
              Next
            </button>
          </div>
        </form>
      );
    }

    // A shift.
    const defaults = shiftDefaults(data);
    if (!defaults) {
      return (
        <div className="repair-guide__step">
          {targetLine}
          <p>No episode of this season has a file, so there is nothing to move.</p>
          <div className="form-actions">
            {backButton}
            <button type="button" className="btn primary" onClick={onClose}>
              Done
            </button>
          </div>
        </div>
      );
    }
    const choice: ShiftChoice = {
      fromEpisodeNumber: shift.fromEpisodeNumber ?? defaults.fromEpisodeNumber,
      throughEpisodeNumber: shift.throughEpisodeNumber !== undefined ? shift.throughEpisodeNumber : defaults.throughEpisodeNumber,
      by: shift.by ?? defaults.by,
    };
    const throughOptions = shiftThroughOptions(data.episodes, choice.fromEpisodeNumber);
    const through =
      choice.throughEpisodeNumber !== null && throughOptions.some((e) => e.episodeNumber === choice.throughEpisodeNumber)
        ? choice.throughEpisodeNumber
        : null;
    return (
      <form
        className="admin-form fix-form repair-guide__step"
        onSubmit={(e) => {
          e.preventDefault();
          toPreview(shiftClaim({ ...choice, throughEpisodeNumber: through }));
        }}
      >
        {targetLine}
        <h3 className="repair-guide__question">Which files are off by one?</h3>
        <label className="field">
          <span>The first episode that plays the wrong one</span>
          <select
            value={choice.fromEpisodeNumber}
            onChange={(e) => setShift({ ...shift, fromEpisodeNumber: Number(e.target.value) })}
          >
            {shiftFromOptions(data.episodes).map((ep) => (
              <option key={ep.id} value={ep.episodeNumber}>
                {ep.label}
              </option>
            ))}
          </select>
        </label>
        <fieldset className="field">
          <legend>What each of those files really is</legend>
          <ul className="check-list">
            <li>
              <label className="check-row">
                <input
                  type="radio"
                  name="remap-by"
                  checked={choice.by === 1}
                  onChange={() => setShift({ ...shift, by: 1 })}
                />
                <span>The next episode (the file on E11 is really E12)</span>
              </label>
            </li>
            <li>
              <label className="check-row">
                <input
                  type="radio"
                  name="remap-by"
                  checked={choice.by === -1}
                  onChange={() => setShift({ ...shift, by: -1 })}
                />
                <span>The episode before (the file on E12 is really E11)</span>
              </label>
            </li>
          </ul>
        </fieldset>
        <label className="field">
          <span>Up to which episode</span>
          <select
            value={through ?? ''}
            onChange={(e) => setShift({ ...shift, throughEpisodeNumber: e.target.value === '' ? null : Number(e.target.value) })}
          >
            <option value="">To the end of the season</option>
            {throughOptions.map((ep) => (
              <option key={ep.id} value={ep.episodeNumber}>
                {ep.label}
              </option>
            ))}
          </select>
        </label>
        <p className="muted">
          {data.suggestion.claim?.kind === 'shift'
            ? 'The files’ own names point to this, so it is filled in. Nothing moves until you confirm.'
            : 'Nothing moves until you confirm. The next step shows every file and where it goes.'}
        </p>
        <div className="form-actions">
          {backButton}
          <button type="submit" className="btn primary">
            Next
          </button>
        </div>
      </form>
    );
  }

  // ---------------------------------------------------------------- the preview
  if (step === 'preview') {
    const p = plan.data;
    const busy = plan.isLoading || plan.isFetching || (seasonNumber === null && children.isLoading);
    return (
      <div className="repair-guide__step">
        {targetLine}
        {busy ? (
          <p className="muted" role="status">
            Working out what moves where…
          </p>
        ) : plan.error || !p ? (
          <>
            <p className="alert">Couldn&rsquo;t work out the moves{plan.error ? `: ${plan.error.message}` : '.'}</p>
            <p className="muted">Nothing was changed.</p>
            <div className="form-actions">
              <button type="button" className="btn" onClick={backToAsk}>
                Back
              </button>
              <button type="button" className="btn" onClick={() => void plan.refetch()}>
                Try again
              </button>
            </div>
          </>
        ) : !remapConfirmable(p) ? (
          <>
            <h3 className="repair-guide__question">This can&rsquo;t be moved as it is.</h3>
            <p>{p.remapOn ? (p.refusalText ?? 'There is nothing to move.') : 'Moving episode files is switched off right now.'}</p>
            <p className="muted">
              Nothing was changed. If it still needs attention, open a <Link href="/bulletin">ticket</Link> and staff
              will take a look.
            </p>
            <div className="form-actions">
              <button type="button" className="btn" onClick={backToAsk}>
                Back
              </button>
              <button type="button" className="btn primary" onClick={onClose}>
                Done
              </button>
            </div>
          </>
        ) : (
          <div className="repair-guide__plan">
            <h3 className="repair-guide__question">Here&rsquo;s what will happen</h3>
            <p>
              {p.moves.length === 1 ? 'This file moves to the right episode.' : 'These files move to the right episodes, in this order.'}{' '}
              {REMAP_NOTHING_LOST}
            </p>
            <ol className="repair-guide__facts remap-guide__moves" aria-label="The moves, in the order they run">
              {p.moves.map((m) => {
                const evidence = nameEvidenceLine(m);
                return (
                  <li key={m.fileId}>
                    <span>{moveLine(m)}</span>
                    {evidence ? (
                      <span className={`remap-guide__name remap-guide__name--${evidence.tone}`}>{evidence.text}</span>
                    ) : null}
                  </li>
                );
              })}
            </ol>
            {p.vacated.length > 0 ? (
              <section className="repair-guide__group">
                <h4>Left empty</h4>
                <ul className="repair-guide__facts">
                  {p.vacated.map((e) => (
                    <li key={e.id}>{e.label}</li>
                  ))}
                </ul>
                <p className="muted remap-guide__note">{vacatedNote(p.vacated.length)}</p>
              </section>
            ) : null}
            <p className="muted remap-guide__quiet">{REMAP_WATCHED_NOTE}</p>
            <div className="form-actions">
              <button type="button" className="btn" disabled={remap.isPending} onClick={backToAsk}>
                Back
              </button>
              <button
                type="button"
                className="btn primary"
                disabled={remap.isPending}
                onClick={() => {
                  if (seasonNumber === null || claim === null) return;
                  setError(null);
                  remap.mutate({
                    mediaItemId: item.id,
                    seasonNumber,
                    claim,
                    planDigest: p.digest,
                    reason: REMAP_FIX_REASON,
                  });
                }}
              >
                {remapConfirmLabel(p.moves.length)}
              </button>
            </div>
            <p className="muted remap-guide__status" role="status">
              {remap.isPending ? 'Moving the files one at a time. This can take a minute.' : ''}
            </p>
          </div>
        )}
      </div>
    );
  }

  // ---------------------------------------------------------------- the result
  if (!result) return null;
  const notes = resultNotes(result);
  return (
    <div className="fix-done repair-guide__step">
      {targetLine}
      <p className="fix-done__lead" role="status">
        {resultLead(result)}
      </p>
      {notes.map((n) => (
        <p key={n} className="muted">
          {n}
        </p>
      ))}
      {result.vacated.length > 0 && seasonNumber !== null ? (
        <section className="repair-guide__group">
          <h4>Left empty</h4>
          <p className="muted remap-guide__note">{vacatedResultNote(result.vacated.length)}</p>
          <ul className="remap-guide__vacated">
            {result.vacated.map((e) => (
              <VacatedEpisode key={e.id} itemId={item.id} episode={e} onSearched={onChanged} />
            ))}
          </ul>
        </section>
      ) : null}
      {result.mislabelGroups.length > 0 ? (
        <section className="repair-guide__group">
          {result.mislabelGroups.map((g) => (
            <MislabelOffer
              key={g.releaseGroup}
              repairRequestId={result.repairRequestId}
              releaseGroup={g.releaseGroup}
              fileCount={g.fileCount}
            />
          ))}
        </section>
      ) : null}
      <p className="muted">The episode list on the title shows where each file is now.</p>
      <div className="form-actions">
        <button type="button" className="btn primary" onClick={onClose}>
          Done
        </button>
      </div>
    </div>
  );
}

/**
 * One episode the re-map left empty, with Force Search (D-04 rule 9). The same `fix.forceSearch` as the title page: one
 * unit of the hourly budget, and with the Import Check on it reads the queue first. Once pressed, the button's cell shows
 * the live search instead (hard rule 9: the slot keeps its width).
 */
function VacatedEpisode({
  itemId,
  episode,
  onSearched,
}: {
  itemId: string;
  episode: RemapEpisodeRef;
  onSearched: () => void;
}) {
  const [input, setInput] = useState<SearchProgressInput | null>(null);
  const [note, setNote] = useState<string>('');
  const search = trpc.fix.forceSearch.useMutation({
    onError: (err) => setNote(describeMutationError(err)),
    onSuccess: (r, variables) => {
      if (r.outcome === 'searched' || r.outcome === 'removed_and_searched') {
        setNote('');
        setInput({ mediaItemId: variables.mediaItemId, scope: variables.scope, targetChildId: variables.targetChildId });
      } else {
        setNote(r.outcome === 'on_its_way' ? 'Already on its way.' : 'Found a finished download and added it.');
      }
      onSearched();
    },
  });
  const live = useActionProgress(input !== null ? { kind: 'search', input } : null);
  return (
    <li className="remap-guide__vacated-row">
      <span className="remap-guide__vacated-label">{episode.label}</span>
      <ReservedActionSlot live={input !== null ? <ActionLiveChip {...live} /> : null}>
        <MediaAction
          action="forceSearch"
          size="sm"
          disabled={search.isPending || note !== ''}
          onFire={() => search.mutate({ mediaItemId: itemId, scope: 'episode', targetChildId: episode.id })}
        />
      </ReservedActionSlot>
      <span className="muted remap-guide__vacated-note" role="status">
        {note}
      </span>
    </li>
  );
}

/**
 * D-04 rule 10 / D-05 — "Stop <group> from filing this show again": one Mislabel Block term on confirm. Saved or not
 * saved shows in the button's own cell, which keeps the size of the larger of the two (hard rule 9).
 */
function MislabelOffer({
  repairRequestId,
  releaseGroup,
  fileCount,
}: {
  repairRequestId: string;
  releaseGroup: string;
  fileCount: number;
}) {
  const [answer, setAnswer] = useState<{ saved: boolean; text: string } | null>(null);
  const block = trpc.fix.mislabelBlock.useMutation({
    onError: (err) => setAnswer({ saved: false, text: mislabelNotSavedText(describeMutationError(err)) }),
    onSuccess: (r) =>
      setAnswer(
        r.saved
          ? { saved: true, text: mislabelSavedText(releaseGroup, r.alreadyActive) }
          : { saved: false, text: mislabelNotSavedText(r.message) },
      ),
  });
  return (
    <div className="repair-guide__card remap-guide__offer">
      <strong className="remap-guide__offer-title">{mislabelOfferTitle(releaseGroup)}</strong>
      <span>{mislabelOfferWhy(releaseGroup, fileCount)}</span>
      <div className="remap-guide__offer-cell">
        <button
          type="button"
          className={`btn${answer ? ' remap-guide__ghost' : ''}`}
          aria-hidden={answer ? true : undefined}
          tabIndex={answer ? -1 : undefined}
          disabled={block.isPending || answer !== null}
          onClick={() => block.mutate({ repairRequestId, releaseGroup })}
        >
          {mislabelButtonLabel(releaseGroup)}
        </button>
        <span
          className={`remap-guide__offer-answer${answer ? (answer.saved ? ' remap-guide__offer-answer--saved' : ' remap-guide__offer-answer--failed') : ' remap-guide__ghost'}`}
          role="status"
        >
          {answer?.text ?? mislabelSavedText(releaseGroup)}
        </span>
      </div>
    </div>
  );
}
