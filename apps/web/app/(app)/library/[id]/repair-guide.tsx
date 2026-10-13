'use client';

// ADR-109 / DESIGN-055 D-01, D-08, D-09 (PLAN-077 P1) — the Repair Guide behind Fix, with the P1 remedies:
//   • Won't play triage: did the person's play reach our servers (Playback Evidence, T-309)?
//   • Wrong language: is the wanted audio already in the file? Then nothing is removed.
//   • The season guard: pick the episodes that are wrong; a pack that also holds fine episodes is left alone.
//   • The Replacement Preview: before a delete, the release that would replace the file; the Same Release, or nothing
//     at all, is refused.
// It asks one question at a time, shows what it found and what it will do, and acts only after the person confirms,
// ticking every line that would be gone afterwards (never pre-ticked). Each remedy follows its kill switch
// (`repair_guide_remedies`): a remedy that is off is skipped, and with every remedy off the classic Fix dialog opens.
//
// ADR-109 C-02 / DESIGN-055 D-04 (PLAN-077 P4) — with the `episode_remap` remedy on, "What's wrong?" on an episode gains
// "It's a different episode of this show" and a season gains "They're all off by one"; both open the Episode Re-map
// (episode-remap.tsx), which moves the existing files onto the right episodes. A Title Check flag on the title page opens
// the guide straight at that step with the move chosen.
//
// Hard rule 8: the guide is a Modal (an explanatory multi-step confirm). Hard rule 9: the dialog has a fixed height
// (`modal--guide`) and only its body scrolls, so a step that replaces another never moves anything else. Copy follows
// the owner's rules: plain, friendly, no em-dashes, no names, links where there is somewhere to go.
import Link from 'next/link';
import { Fragment, useMemo, useState, type ReactNode } from 'react';
import { ConsumeLink } from '@hnet/ui';
import { trpc } from '@/lib/trpc-client';
import { appCodeOf, describeMutationError } from '@/lib/app-error';
import {
  FIX_REASON_LABELS,
  fixReasonsForKind,
  targetToInput,
  type ActionTarget,
  type FixReasonName,
} from '@/lib/media';
import {
  GUIDE_REASON_LABELS,
  OTHER_AUDIO_LANGUAGES,
  confirmFieldsFor,
  confirmLabelFor,
  describeRelease,
  firstGuideStep,
  goneLinesFor,
  joinServerNames,
  orderPlayTargets,
  refusalFor,
  remapChoiceOn,
  stepAfterChoice,
  stepAfterTriage,
  wantedLanguageInFile,
  type GuidePlan,
  type GuideRemedies,
  type GuideStep,
} from '@/lib/repair-guide';
import { REMAP_CHOICE_LABELS, remapKindFor } from '@/lib/remap-guide';
import { Modal } from '@/components/modal';
import {
  ActionProgressBlock,
  useActionProgress,
  type ProgressSource,
  type SearchProgressInput,
} from '@/components/action-progress';
import { EpisodeRemap } from './episode-remap';

export type { GuideRemedies };

/** DESIGN-055 D-05 — a Title Check flag: the file on `fromEpisodeId` belongs on `toEpisodeId` (its name says so). */
export interface GuideRemapStart {
  seasonNumber: number;
  fromEpisodeId: number;
  toEpisodeId: number;
}

export interface GuidePlayTarget {
  label: string;
  url: string;
  serverSlug: string;
  serverName: string;
}

export interface RepairGuideProps {
  open: boolean;
  onClose: () => void;
  item: { id: string; arrKind: 'sonarr' | 'radarr'; title: string };
  /** The chosen episode or season (null: the movie, or a bare TV Fix that picks an episode first). */
  target: ActionTarget | null;
  /** The person's "Watch on Plex" links for this title (ADR-047), for Won't play triage. */
  play: readonly GuidePlayTarget[];
  remedies: GuideRemedies;
  knownIssueServers: readonly string[];
  onSubmitted: () => void;
  /** DESIGN-055 D-10 (PLAN-077 P3) — opened from a Seerr report: the reason its type points at, preselected. */
  initialReason?: FixReasonName | null;
  /** D-11 — a short note above the guide's steps when it opened from a Seerr report. */
  intro?: ReactNode;
  /** DESIGN-055 D-04 (PLAN-077 P4) — the `episode_remap` remedy: the guide offers moving files onto the right episodes. */
  remapOn?: boolean;
  /** D-05 — opened from a Title Check flag: start at the re-map preview with this move. */
  initialRemap?: GuideRemapStart | null;
  /** DESIGN-055 D-06 (PLAN-077 P5): the `release_pick` remedy, offered on each episode a re-map leaves empty. */
  releasePickOn?: boolean;
  /** Closes the guide and opens Force Search for one episode (the Release Pick's way to add a download). */
  onForceSearch?: (target: ActionTarget) => void;
}

interface DoneState {
  fixRequestId: string;
  pathTaken: string;
  targetLabel: string | null;
  searchInput: SearchProgressInput;
}

export function RepairGuide({
  open,
  onClose,
  item,
  target,
  play,
  remedies,
  knownIssueServers,
  onSubmitted,
  initialReason = null,
  intro,
  remapOn = false,
  initialRemap = null,
  releasePickOn = false,
  onForceSearch,
}: RepairGuideProps) {
  const isTv = item.arrKind === 'sonarr';
  const planning = remedies.replacement_preview || remedies.season_guard;
  const remapStart = remapOn && initialRemap !== null && target?.scope === 'episode';
  const firstStep = firstGuideStep({
    isTv,
    hasTarget: target !== null,
    isSeason: target?.scope === 'season',
    remedies,
    remapStart,
  });

  const [step, setStep] = useState<GuideStep>(firstStep);
  const [pickedChild, setPickedChild] = useState<number | ''>('');
  const [chosen, setChosen] = useState<ReadonlySet<number>>(() => new Set());
  const [reason, setReason] = useState<FixReasonName>(
    initialReason && fixReasonsForKind(item.arrKind).includes(initialReason) ? initialReason : 'wont_play_corrupt',
  );
  const [reasonText, setReasonText] = useState('');
  const [wanted, setWanted] = useState<string>('eng');
  const [packChoice, setPackChoice] = useState<'replace' | 'block'>('replace');
  const [acks, setAcks] = useState<ReadonlySet<string>>(() => new Set());
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<DoneState | null>(null);
  const [retried, setRetried] = useState(false);
  // DESIGN-055 D-04 — the re-map chosen on "What's wrong?", and the question its Back returns to.
  const [remapPicked, setRemapPicked] = useState(false);
  const [remapBack, setRemapBack] = useState<GuideStep>(firstStep);

  const children = trpc.ledger.children.useQuery(
    { mediaItemId: item.id },
    { enabled: open && step === 'pick' },
  );
  const pickedLabel = (children.data ?? []).find((c) => c.arrChildId === pickedChild)?.label ?? '';
  const effectiveTarget: ActionTarget | null =
    target ??
    (isTv && pickedChild !== '' ? { scope: 'episode', childId: pickedChild, label: pickedLabel } : null);
  const scopeInput = targetToInput(effectiveTarget);
  const isSeason = effectiveTarget?.scope === 'season';
  const remapKind = remapKindFor({ remapOn, arrKind: item.arrKind, target: effectiveTarget });
  const episodeIds = isSeason && remedies.season_guard && chosen.size > 0 ? [...chosen].sort((a, b) => a - b) : undefined;

  const seasonChoices = trpc.fix.seasonChoices.useQuery(
    { mediaItemId: item.id, seasonNumber: effectiveTarget?.seasonNumber ?? 0 },
    { enabled: open && step === 'episodes' && isSeason, staleTime: 60_000, retry: false },
  );
  const evidence = trpc.fix.playbackEvidence.useQuery(
    { mediaItemId: item.id },
    { enabled: open && step === 'playback', staleTime: 30_000, retry: false, refetchOnWindowFocus: false },
  );
  const audio = trpc.fix.audioLanguages.useQuery(
    { mediaItemId: item.id, ...scopeInput },
    {
      enabled: open && (step === 'language' || step === 'language-present'),
      staleTime: 60_000,
      retry: false,
      refetchOnWindowFocus: false,
    },
  );
  const previewInput = {
    mediaItemId: item.id,
    ...scopeInput,
    ...(episodeIds ? { episodeIds } : {}),
    ...(packChoice === 'replace' && !isSeason ? { replaceFile: true } : {}),
  };
  const preview = trpc.fix.preview.useQuery(previewInput, {
    enabled: open && step === 'preview' && planning,
    staleTime: Infinity,
    retry: false,
    refetchOnWindowFocus: false,
  });

  const utils = trpc.useUtils();
  const create = trpc.fix.create.useMutation({
    onError: (err) => {
      setError(describeMutationError(err));
      if (appCodeOf(err) === 'FIX_PLAN_CHANGED') {
        setAcks(new Set());
        void utils.fix.preview.invalidate();
      }
    },
    onSuccess: (result, variables) => {
      setError(null);
      setDone({
        fixRequestId: result.id,
        pathTaken: result.pathTaken,
        targetLabel: result.targetLabel,
        searchInput: {
          mediaItemId: variables.mediaItemId,
          scope: variables.scope,
          targetChildId: variables.targetChildId,
          seasonNumber: variables.seasonNumber,
        },
      });
      setStep('done');
      onSubmitted();
    },
  });
  const retrySearch = trpc.fix.forceSearch.useMutation({
    onError: (err) => setError(describeMutationError(err)),
    onSuccess: () => {
      setError(null);
      setRetried(true);
      void utils.fix.searchProgress.invalidate();
      onSubmitted();
    },
  });
  const isSubtitlePath = done?.pathTaken === 'bazarr_subtitle';
  const source: ProgressSource | null =
    open && done !== null && !isSubtitlePath
      ? retried
        ? { kind: 'search', input: done.searchInput }
        : { kind: 'fix', fixRequestId: done.fixRequestId }
      : null;
  const live = useActionProgress(source, { onTerminal: () => onSubmitted() });

  function close() {
    setStep(firstStep);
    setPickedChild('');
    setChosen(new Set());
    setReason('wont_play_corrupt');
    setReasonText('');
    setWanted('eng');
    setPackChoice('replace');
    setAcks(new Set());
    setError(null);
    setDone(null);
    setRetried(false);
    setRemapPicked(false);
    setRemapBack(firstStep);
    onClose();
  }

  function go(next: GuideStep) {
    setError(null);
    setAcks(new Set());
    setStep(next);
  }

  /** After the triage steps: the preview when a planning remedy is on, else today's confirm. */
  function afterTriage() {
    go(stepAfterTriage(reason, remedies));
  }

  function afterReason() {
    if (remapPicked && remapKind !== null) {
      setRemapBack('reason');
      go(stepAfterChoice('remap', remedies));
      return;
    }
    if (reason === 'other' && reasonText.trim() === '') {
      setError('Tell us what is wrong. A few words are enough.');
      return;
    }
    go(stepAfterChoice(reason, remedies));
  }

  function submit(extra: Record<string, unknown> = {}) {
    setError(null);
    create.mutate({
      mediaItemId: item.id,
      ...scopeInput,
      reason,
      ...(reason === 'other' ? { reasonText: reasonText.trim() } : {}),
      ...(reason === 'wrong_language' && remedies.language_check ? { wantedLanguage: wanted } : {}),
      ...extra,
    });
  }

  const plan: GuidePlan | null = preview.data?.plan ?? null;
  const goneLines = useMemo(() => goneLinesFor(plan), [plan]);
  const refusal = refusalFor(plan, remedies);
  const allAcked = goneLines.every((l) => acks.has(l.key));
  const confirmLabel = confirmLabelFor(plan);

  const reasons = fixReasonsForKind(item.arrKind);
  const targetLine = effectiveTarget ? (
    <p className="fix-target">
      Fixing <strong>{effectiveTarget.label}</strong>
    </p>
  ) : null;

  const sortedPlay = orderPlayTargets(play, knownIssueServers);
  const watchLinks =
    sortedPlay.length > 0 ? (
      <div className="repair-guide__links">
        {sortedPlay.map((t) => (
          <ConsumeLink key={t.url} label={`Watch on ${t.serverName}`} url={t.url} variant="outline" />
        ))}
      </div>
    ) : (
      <p className="muted">This title isn&rsquo;t on a Plex library you can open.</p>
    );

  const ev = evidence.data;
  const reachedNames = ev ? joinServerNames(ev.servers, ev.serverNames) : '';

  const body = (() => {
    switch (step) {
      case 'pick':
        return (
          <div className="repair-guide__step">
            <h3 className="repair-guide__question">Which episode needs fixing?</h3>
            {children.isLoading ? (
              <p className="muted">Loading episodes…</p>
            ) : children.error ? (
              <p className="alert">Could not load the episode list: {children.error.message}</p>
            ) : (
              <label className="field">
                <span className="sr-only">Episode</span>
                <select
                  value={pickedChild}
                  onChange={(e) => setPickedChild(e.target.value === '' ? '' : Number(e.target.value))}
                >
                  <option value="">Select an episode…</option>
                  {(children.data ?? [])
                    .filter((c) => c.hasFile)
                    .map((c) => (
                      <option key={c.arrChildId} value={c.arrChildId}>
                        {c.label}
                      </option>
                    ))}
                </select>
              </label>
            )}
            <div className="form-actions">
              <button
                type="button"
                className="btn primary"
                disabled={pickedChild === ''}
                onClick={() => go('reason')}
              >
                Next
              </button>
            </div>
          </div>
        );

      case 'episodes':
        return (
          <div className="repair-guide__step">
            {targetLine}
            <h3 className="repair-guide__question">Which episodes are wrong?</h3>
            <p className="muted">Pick only the ones that are wrong. The rest stay as they are.</p>
            {seasonChoices.isLoading ? (
              <p className="muted">Loading the season…</p>
            ) : seasonChoices.error ? (
              <p className="alert">Could not load the season: {seasonChoices.error.message}</p>
            ) : (seasonChoices.data ?? []).length === 0 ? (
              <p className="muted">No episode of this season is on disk, so there is nothing to fix.</p>
            ) : (
              <ul className="check-list repair-guide__episodes">
                {(seasonChoices.data ?? []).map((ep) => (
                  <li key={ep.episodeId}>
                    <label className="check-row repair-guide__episode">
                      <input
                        type="checkbox"
                        checked={chosen.has(ep.episodeId)}
                        onChange={(e) => {
                          const next = new Set(chosen);
                          if (e.target.checked) next.add(ep.episodeId);
                          else next.delete(ep.episodeId);
                          setChosen(next);
                        }}
                      />
                      <span className="repair-guide__episode-text">
                        <span>{ep.label}</span>
                        <span className="muted repair-guide__release">
                          {ep.releaseName ?? 'No download record'}
                        </span>
                      </span>
                      {ep.downloadEpisodes > 1 ? (
                        <span className="badge badge--muted">Pack of {ep.downloadEpisodes}</span>
                      ) : null}
                    </label>
                  </li>
                ))}
              </ul>
            )}
            {remapChoiceOn('episodes', remapKind, remedies) ? (
              <section className="repair-guide__group">
                <h4>Or are they all off by one?</h4>
                <p className="muted remap-guide__note">
                  When each file plays the episode next to it, nothing needs downloading: the files can be moved onto the
                  right episodes.
                </p>
              </section>
            ) : null}
            <div className="form-actions">
              {remapChoiceOn('episodes', remapKind, remedies) ? (
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    setRemapBack('episodes');
                    go('remap');
                  }}
                >
                  They&rsquo;re all off by one
                </button>
              ) : null}
              <button type="button" className="btn primary" disabled={chosen.size === 0} onClick={() => go('reason')}>
                Next
              </button>
            </div>
          </div>
        );

      case 'reason':
        return (
          <form
            className="admin-form fix-form repair-guide__step"
            onSubmit={(e) => {
              e.preventDefault();
              afterReason();
            }}
          >
            {targetLine}
            <fieldset className="field">
              <legend className="repair-guide__question">What&rsquo;s wrong?</legend>
              <ul className="check-list">
                {reasons.map((value) => (
                  <Fragment key={value}>
                    {/* DESIGN-055 D-04: the re-map choice sits just before "It's a different show or movie". */}
                    {value === 'wrong_content' && remapKind !== null && remapChoiceOn('reason', remapKind, remedies) ? (
                      <li>
                        <label className="check-row">
                          <input
                            type="radio"
                            name="guide-reason"
                            value="remap"
                            checked={remapPicked}
                            onChange={() => setRemapPicked(true)}
                          />
                          <span>{REMAP_CHOICE_LABELS[remapKind]}</span>
                        </label>
                      </li>
                    ) : null}
                    <li>
                      <label className="check-row">
                        <input
                          type="radio"
                          name="guide-reason"
                          value={value}
                          checked={!remapPicked && reason === value}
                          onChange={() => {
                            setRemapPicked(false);
                            setReason(value);
                          }}
                        />
                        <span>{GUIDE_REASON_LABELS[value] ?? FIX_REASON_LABELS[value]}</span>
                      </label>
                    </li>
                  </Fragment>
                ))}
              </ul>
            </fieldset>
            {reason === 'other' && !remapPicked ? (
              <label className="field">
                <span>Tell us more</span>
                <textarea
                  maxLength={500}
                  rows={3}
                  value={reasonText}
                  onChange={(e) => setReasonText(e.target.value)}
                  placeholder="What exactly is wrong?"
                />
              </label>
            ) : null}
            <div className="form-actions">
              <button type="submit" className="btn primary">
                Next
              </button>
            </div>
          </form>
        );

      case 'playback':
        return (
          <div className="repair-guide__step">
            {targetLine}
            {evidence.isLoading ? (
              <p className="muted" role="status">
                Checking whether your play reached our servers…
              </p>
            ) : evidence.error ? (
              <>
                <p className="status-note status-note--warn">
                  We couldn&rsquo;t check your plays, so we&rsquo;ll go straight to the fix.
                </p>
                <div className="form-actions">
                  <button type="button" className="btn primary" onClick={afterTriage}>
                    Continue
                  </button>
                </div>
              </>
            ) : evidence.data?.verdict === 'no_play' ? (
              <>
                <h3 className="repair-guide__question">Your play didn&rsquo;t reach our servers.</h3>
                <p>
                  Plex also lists its own free copies of some titles, and those don&rsquo;t come from us. Open our
                  copy from one of these links, then try again:
                </p>
                {watchLinks}
                <p className="muted">The copy to pick is the one that names our server.</p>
                <div className="form-actions">
                  <button type="button" className="btn" onClick={afterTriage}>
                    I played our copy and it still won&rsquo;t play
                  </button>
                  <button type="button" className="btn primary" onClick={close}>
                    Done
                  </button>
                </div>
              </>
            ) : evidence.data?.verdict === 'known_issue_server' ? (
              <>
                <h3 className="repair-guide__question">Try another server first.</h3>
                <p>
                  Your play reached {reachedNames}, which {ev && ev.servers.length > 1 ? 'have' : 'has'} a known
                  problem converting some videos for playback. The file itself is usually fine. Try it from
                  another server:
                </p>
                {watchLinks}
                <div className="form-actions">
                  <button type="button" className="btn" onClick={afterTriage}>
                    It still won&rsquo;t play
                  </button>
                  <button type="button" className="btn primary" onClick={close}>
                    Done
                  </button>
                </div>
              </>
            ) : (
              <>
                <h3 className="repair-guide__question">We can see your play.</h3>
                <p>
                  Your play reached {reachedNames !== '' ? reachedNames : 'our servers'}, so the next step is to
                  look at the file.
                </p>
                <div className="form-actions">
                  <button type="button" className="btn primary" onClick={afterTriage}>
                    Continue
                  </button>
                </div>
              </>
            )}
          </div>
        );

      case 'language': {
        const found = audio.data?.languages ?? [];
        const options = [
          { code: 'eng', name: 'English' },
          ...found.filter((l) => l.code !== 'eng'),
        ];
        const others = OTHER_AUDIO_LANGUAGES.filter((l) => !options.some((o) => o.code === l.code));
        return (
          <div className="repair-guide__step">
            {targetLine}
            {audio.isLoading ? (
              <p className="muted" role="status">
                Reading the file&rsquo;s audio tracks…
              </p>
            ) : (
              <form
                className="admin-form fix-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (wantedLanguageInFile(audio.data?.files ?? [], wanted)) go('language-present');
                  else afterTriage();
                }}
              >
                <fieldset className="field">
                  <legend className="repair-guide__question">Which language did you want?</legend>
                  <ul className="check-list">
                    {options.map((l) => (
                      <li key={l.code}>
                        <label className="check-row">
                          <input
                            type="radio"
                            name="guide-language"
                            checked={wanted === l.code}
                            onChange={() => setWanted(l.code)}
                          />
                          <span>
                            {l.name}
                            {found.some((f) => f.code === l.code) ? (
                              <span className="muted"> (in this file)</span>
                            ) : null}
                          </span>
                        </label>
                      </li>
                    ))}
                  </ul>
                </fieldset>
                <label className="field">
                  <span>Another language</span>
                  <select
                    value={options.some((o) => o.code === wanted) ? '' : wanted}
                    onChange={(e) => setWanted(e.target.value === '' ? 'eng' : e.target.value)}
                  >
                    <option value="">Choose…</option>
                    {others.map((l) => (
                      <option key={l.code} value={l.code}>
                        {l.name}
                      </option>
                    ))}
                  </select>
                </label>
                {audio.error ? (
                  <p className="muted">We couldn&rsquo;t read this file&rsquo;s audio tracks, so we can&rsquo;t check it first.</p>
                ) : null}
                <div className="form-actions">
                  <button type="submit" className="btn primary">
                    Next
                  </button>
                </div>
              </form>
            )}
          </div>
        );
      }

      case 'language-present': {
        const name =
          audio.data?.languages.find((l) => l.code === wanted)?.name ??
          [{ code: 'eng', name: 'English' }, ...OTHER_AUDIO_LANGUAGES].find((l) => l.code === wanted)?.name ??
          wanted.toUpperCase();
        return (
          <div className="repair-guide__step">
            {targetLine}
            <h3 className="repair-guide__question">This file already has {name} audio.</h3>
            <p>Nothing needs replacing. Another track is just playing first.</p>
            <ol className="repair-guide__how">
              <li>Start playing it in Plex.</li>
              <li>Open the audio menu and choose {name}.</li>
              <li>
                To have Plex pick {name} by itself, set your preferred audio language in your{' '}
                <a href="https://app.plex.tv/desktop/#!/settings/account" target="_blank" rel="noopener noreferrer">
                  Plex account settings
                </a>
                .
              </li>
            </ol>
            <div className="form-actions">
              <button type="button" className="btn" onClick={() => go('reason')}>
                Something else is wrong
              </button>
              <button type="button" className="btn primary" onClick={close}>
                Done
              </button>
            </div>
          </div>
        );
      }

      case 'preview':
        return (
          <div className="repair-guide__step">
            {targetLine}
            {preview.isLoading || preview.isFetching ? (
              <p className="muted" role="status">
                Checking what this would do. Looking for a replacement can take up to a minute…
              </p>
            ) : preview.error ? (
              <>
                <p className="alert">Couldn&rsquo;t check what this would do: {preview.error.message}</p>
                <p className="muted">Nothing was changed.</p>
                <div className="form-actions">
                  <button type="button" className="btn" onClick={() => void preview.refetch()}>
                    Try again
                  </button>
                </div>
              </>
            ) : plan ? (
              <PlanView
                plan={plan}
                remedies={remedies}
                refusal={refusal}
                packChoice={packChoice}
                onPackChoice={(c) => {
                  setAcks(new Set());
                  setPackChoice(c);
                }}
                reason={reason}
              />
            ) : (
              <p className="muted">Nothing to preview.</p>
            )}
            {plan && !refusal && !preview.isFetching ? (
              <>
                {goneLines.length > 0 ? (
                  <fieldset className="field repair-guide__gone">
                    <legend>Gone afterwards (tick each to confirm)</legend>
                    <ul className="check-list">
                      {goneLines.map((l) => (
                        <li key={l.key}>
                          <label className="check-row">
                            <input
                              type="checkbox"
                              checked={acks.has(l.key)}
                              onChange={(e) => {
                                const next = new Set(acks);
                                if (e.target.checked) next.add(l.key);
                                else next.delete(l.key);
                                setAcks(next);
                              }}
                            />
                            <span>{l.text}</span>
                          </label>
                        </li>
                      ))}
                    </ul>
                  </fieldset>
                ) : null}
                <div className="form-actions">
                  <button
                    type="button"
                    className="btn primary"
                    disabled={!allAcked || create.isPending}
                    onClick={() => submit(confirmFieldsFor(plan, episodeIds))}
                  >
                    {create.isPending ? 'Working…' : confirmLabel}
                  </button>
                </div>
              </>
            ) : null}
            {refusal ? (
              <div className="form-actions">
                <button type="button" className="btn primary" onClick={close}>
                  Done
                </button>
              </div>
            ) : null}
          </div>
        );

      case 'confirm':
        return (
          <div className="repair-guide__step">
            {targetLine}
            <p>
              {reason === 'missing_subtitles'
                ? 'This searches for the missing subtitles. The video file is not touched.'
                : 'This marks the current download as failed (or removes the file when there is no download record) and searches for a replacement.'}
            </p>
            <div className="form-actions">
              <button type="button" className="btn primary" disabled={create.isPending} onClick={() => submit()}>
                {create.isPending ? 'Submitting…' : 'Submit fix'}
              </button>
            </div>
          </div>
        );

      case 'remap':
        return remapKind !== null && effectiveTarget !== null ? (
          <EpisodeRemap
            item={{ id: item.id, title: item.title }}
            kind={remapKind}
            seasonNumber={remapKind === 'shift' ? (effectiveTarget.seasonNumber ?? null) : (initialRemap?.seasonNumber ?? null)}
            fromEpisodeId={remapKind === 'single' ? effectiveTarget.childId : undefined}
            targetLabel={effectiveTarget.label}
            initialToEpisodeId={remapStart && remapBack === firstStep ? (initialRemap?.toEpisodeId ?? null) : null}
            onBack={() => go(remapStart && remapBack === 'remap' ? 'reason' : remapBack)}
            onClose={close}
            onChanged={onSubmitted}
            setError={setError}
            releasePickOn={releasePickOn}
            onForceSearch={onForceSearch}
          />
        ) : null;

      case 'done':
        return done ? (
          <div className="fix-done repair-guide__step">
            <p className="fix-done__lead">
              {done.pathTaken === 'bazarr_subtitle'
                ? 'Bazarr is searching for subtitles. The video file is untouched.'
                : done.pathTaken === 'blocklist_search'
                  ? 'The bad release is blocked and a search for a replacement is running.'
                  : 'The file was removed and a search for a replacement is running.'}
            </p>
            {done.targetLabel ? <p className="muted">Target: {done.targetLabel}</p> : null}
            {isSubtitlePath ? (
              <p className="muted">Subtitle downloads finish on their own.</p>
            ) : (
              <>
                <ActionProgressBlock
                  progress={live.progress}
                  pending={live.pending}
                  checkFailed={live.checkFailed}
                  kind={item.arrKind}
                  onRetry={() => retrySearch.mutate({ ...done.searchInput })}
                  retryLabel="Search again"
                  retryPending={retrySearch.isPending}
                />
                <p className="muted">
                  You can close this. The live status stays on the title and under{' '}
                  <Link href="/my-fixes">My Fixes</Link>.
                </p>
              </>
            )}
            <div className="form-actions">
              <button type="button" className="btn primary" onClick={close}>
                Done
              </button>
            </div>
          </div>
        ) : null;
    }
  })();

  return (
    <Modal
      open={open}
      title={`Fix ${item.title}`}
      onClose={close}
      className="modal--guide"
      banner={error ? <p className="alert">{error}</p> : null}
    >
      <div className="repair-guide">
        {intro && done === null ? intro : null}
        {body}
      </div>
    </Modal>
  );
}


function PlanView({
  plan,
  remedies,
  refusal,
  packChoice,
  onPackChoice,
  reason,
}: {
  plan: GuidePlan;
  remedies: GuideRemedies;
  refusal: 'same_release' | 'no_replacement' | 'nothing_safe' | null;
  packChoice: 'replace' | 'block';
  onPackChoice: (choice: 'replace' | 'block') => void;
  reason: FixReasonName;
}) {
  const packChooser = (others: ReadonlyArray<{ label: string }>) => (
    <div className="repair-guide__callout">
      <p>
        <strong>This download is a pack.</strong> It also holds{' '}
        {others.length === 1 ? 'another episode' : `${others.length} other episodes`}:{' '}
        {others.map((e) => e.label).join(', ')}. Blocking it would block their copy too.
      </p>
      <fieldset className="field">
        <legend className="sr-only">What to do with the pack</legend>
        <ul className="check-list">
          <li>
            <label className="check-row">
              <input
                type="radio"
                name="guide-pack"
                checked={packChoice === 'replace'}
                onChange={() => onPackChoice('replace')}
              />
              <span>Replace just this episode (recommended)</span>
            </label>
          </li>
          <li>
            <label className="check-row">
              <input
                type="radio"
                name="guide-pack"
                checked={packChoice === 'block'}
                onChange={() => onPackChoice('block')}
              />
              <span>Block the whole pack</span>
            </label>
          </li>
        </ul>
      </fieldset>
    </div>
  );

  if (plan.kind === 'blocklist') {
    return (
      <div className="repair-guide__plan">
        {plan.packCost.length > 0 && remedies.season_guard ? packChooser(plan.packCost) : null}
        <h3 className="repair-guide__question">Here&rsquo;s what will happen</h3>
        <ul className="repair-guide__facts">
          <li>
            The download it came from is marked as failed:{' '}
            <span className="repair-guide__release">{plan.grab.sourceTitle ?? 'the last download'}</span>
          </li>
          <li>A search for a replacement starts right after.</li>
        </ul>
      </div>
    );
  }

  if (plan.kind === 'delete') {
    const fileLine = plan.file ? (
      <div className="repair-guide__card">
        <span className="repair-guide__card-label">In the library</span>
        <span className="repair-guide__release">{plan.file.name ?? 'The current file'}</span>
        <span className="muted">{describeRelease(plan.file)}</span>
      </div>
    ) : null;
    const candidate = plan.replacement.candidate;
    const candidateLine = candidate ? (
      <div className="repair-guide__card">
        <span className="repair-guide__card-label">Would replace it</span>
        <span className="repair-guide__release">{candidate.title}</span>
        <span className="muted">{describeRelease(candidate)}</span>
      </div>
    ) : null;
    return (
      <div className="repair-guide__plan">
        {plan.packCost.length > 0 && remedies.season_guard ? packChooser(plan.packCost) : null}
        {refusal === 'same_release' ? (
          <>
            <h3 className="repair-guide__question">That would download the same release again.</h3>
            <div className="repair-guide__cards">
              {fileLine}
              {candidateLine}
            </div>
            <p>
              The release that would replace this file is the same one you have, so deleting it would not change
              anything. Nothing was removed.
            </p>
            {reason === 'wont_play_corrupt' ? (
              <p>
                When the file is fine, the problem is usually the player or the server. Try playing it on another
                device or from another server, or open a <Link href="/bulletin">ticket</Link> and staff will take a
                look.
              </p>
            ) : (
              <p>
                If something is still wrong with it, open a <Link href="/bulletin">ticket</Link> and staff will take a
                look.
              </p>
            )}
          </>
        ) : refusal === 'no_replacement' ? (
          <>
            <h3 className="repair-guide__question">Deleting would leave nothing to replace it.</h3>
            <div className="repair-guide__cards">{fileLine}</div>
            <p>
              No release the library would accept is available, so the file stays. Nothing was removed. If it needs
              attention anyway, open a <Link href="/bulletin">ticket</Link>.
            </p>
          </>
        ) : (
          <>
            <h3 className="repair-guide__question">Here&rsquo;s what will happen</h3>
            {plan.file ? (
              <div className="repair-guide__cards">
                {fileLine}
                {candidateLine}
              </div>
            ) : (
              <p>Nothing is on disk for this one, so this only searches for it.</p>
            )}
            {plan.file ? (
              <p className="muted">
                {plan.insteadOfPack
                  ? 'Only this episode’s file is removed and searched again. The pack stays.'
                  : 'There is no download record to block, so the file is removed and searched again.'}
              </p>
            ) : null}
          </>
        )}
      </div>
    );
  }

  // season
  const list = (eps: ReadonlyArray<{ label: string }>) => eps.map((e) => e.label).join(', ');
  return (
    <div className="repair-guide__plan">
      {refusal === 'nothing_safe' ? (
        <h3 className="repair-guide__question">Nothing here can be fixed safely as a season.</h3>
      ) : (
        <h3 className="repair-guide__question">Here&rsquo;s what will happen</h3>
      )}
      {plan.marks.length > 0 ? (
        <section className="repair-guide__group">
          <h4>Blocked and searched again</h4>
          <ul className="repair-guide__facts">
            {plan.marks.map((m) => (
              <li key={m.grabId}>
                <span className="repair-guide__release">{m.sourceTitle ?? 'A download'}</span>
                <span className="muted"> ({list(m.episodes)})</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {plan.deletes.length > 0 ? (
        <section className="repair-guide__group">
          <h4>Deleted and searched again</h4>
          <ul className="repair-guide__facts">
            {plan.deletes.map((d) => (
              <li key={d.file.fileId}>
                {d.episode.label}
                {d.replacement.candidate ? (
                  <span className="muted"> · next: {describeRelease(d.replacement.candidate)}</span>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {plan.heldBack.length > 0 ? (
        <section className="repair-guide__group">
          <h4>Left alone: part of a pack</h4>
          <ul className="repair-guide__facts">
            {plan.heldBack.map((h, i) => (
              <li key={i}>
                {list(h.chosen)} came in a pack that also holds {list(h.others)}, which you marked fine. Blocking it
                would cost those too, so fix {h.chosen.length === 1 ? 'that episode' : 'those episodes'} on its own
                from the episode list.
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {plan.noRecord.length > 0 ? (
        <section className="repair-guide__group">
          <h4>Left alone: no download record</h4>
          <p>
            {list(plan.noRecord)} {plan.noRecord.length === 1 ? 'has' : 'have'} no download to block. Fix{' '}
            {plan.noRecord.length === 1 ? 'it' : 'each one'} on its own to see what would replace it.
          </p>
        </section>
      ) : null}
      {plan.refused.length > 0 ? (
        <section className="repair-guide__group">
          <h4>Left alone: nothing better to replace it</h4>
          <ul className="repair-guide__facts">
            {plan.refused.map((d) => (
              <li key={d.file.fileId}>
                {d.episode.label}:{' '}
                {d.replacement.verdict === 'same_release'
                  ? 'the replacement would be the same release'
                  : 'no release the library would accept is available'}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
