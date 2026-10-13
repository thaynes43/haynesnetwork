'use client';

// DESIGN-005 D-15 / R-43..R-45 — the Fix dialog: episode/album target picker (live
// children via ledger.children, D-06), the mandatory reason taxonomy (free text only
// on Other), submit → fix.create → then the ADR-028 / D-20 LIVE progress view: the
// dialog polls fix.progress and walks the user through
// searching → queued → downloading% → importing → completed (or an honest
// nothing_found / stalled / failed terminal with a retry) instead of a static
// "a search is running" line. Closing the dialog is safe — the same state lives on
// the item's action slot (D-21).
import { useState, type ReactNode } from 'react';
import { trpc } from '@/lib/trpc-client';
import { describeMutationError } from '@/lib/app-error';
import {
  FIX_REASON_LABELS,
  fixReasonsForKind,
  targetToInput,
  type ActionTarget,
  type ArrKindName,
  type FixReasonName,
} from '@/lib/media';
import { Modal } from '@/components/modal';
import {
  ActionProgressBlock,
  useActionProgress,
  type ProgressSource,
  type SearchProgressInput,
} from '@/components/action-progress';
import { RepairGuide, type GuidePlayTarget, type GuideRemapStart } from './repair-guide';
import { useSeerrIssueLink } from '@/lib/seerr-issue-link-context';

export interface FixDialogProps {
  open: boolean;
  onClose: () => void;
  item: { id: string; arrKind: string; title: string };
  /**
   * The scoped target already chosen (per-episode / per-album / whole-season Fix from
   * the detail list). When present the picker is skipped and the scope is carried into
   * fix.create. null ⇒ the radarr movie (item scope).
   */
  target?: ActionTarget | null;
  /** Invalidate/refresh hooks after a successful submit. */
  onSubmitted: () => void;
  /** ADR-109 / DESIGN-055 D-09 — the title's "Watch on Plex" links, for the Repair Guide's Won't play triage. */
  play?: readonly GuidePlayTarget[];
  /**
   * DESIGN-055 D-10 / D-11 (PLAN-077 P3) — opened from a Seerr report: the reason the report's type points at
   * (Audio is Wrong language, Subtitles is Missing subtitles), preselected on "What's wrong?". The person still confirms.
   */
  initialReason?: FixReasonName | null;
  /** D-11 — a short note above the first question ("You reported this in Seerr. Here's what you can try first."). */
  intro?: ReactNode;
  /**
   * DESIGN-055 D-05 (PLAN-077 P4) — opened from a Title Check flag: the guide starts at the Episode Re-map preview with
   * this move (the file on one episode belongs on the one its name says). Ignored while the remedy is off.
   */
  initialRemap?: GuideRemapStart | null;
  /**
   * DESIGN-055 D-06 (PLAN-077 P5): open Force Search for one episode in place of the guide (the Release Pick sends a
   * download that needs a hand to Force Search, whose Import Check adds it).
   */
  onForceSearch?: (target: ActionTarget) => void;
}

/**
 * ADR-109 / DESIGN-055 D-01 (PLAN-077 P1) — Fix opens the Repair Guide for a movie or a TV episode or season once any
 * of its remedies is on (`repair_guide_remedies`, read through `fix.guideConfig`); otherwise, and always for Music,
 * today's dialog. The guide mounts only while open, so each Fix starts from its first question.
 */
export function FixDialog(props: FixDialogProps) {
  const guide = trpc.fix.guideConfig.useQuery(undefined, { staleTime: 60_000 });
  const kind = props.item.arrKind;
  if (guide.data?.guideOn && (kind === 'sonarr' || kind === 'radarr')) {
    return props.open ? (
      <RepairGuide
        open
        onClose={props.onClose}
        item={{ id: props.item.id, arrKind: kind, title: props.item.title }}
        target={props.target ?? null}
        play={props.play ?? []}
        remedies={guide.data.remedies}
        knownIssueServers={guide.data.knownIssueServers}
        onSubmitted={props.onSubmitted}
        initialReason={props.initialReason ?? null}
        intro={props.intro}
        remapOn={guide.data.remapOn}
        initialRemap={props.initialRemap ?? null}
        releasePickOn={guide.data.releasePickOn}
        onForceSearch={props.onForceSearch}
      />
    ) : null;
  }
  return <ClassicFixDialog {...props} />;
}

interface DoneState {
  fixRequestId: string;
  pathTaken: string;
  targetLabel: string | null;
  /** The grain submitted — the "Search again" retry re-issues a search on it. */
  searchInput: SearchProgressInput;
}

function ClassicFixDialog({ open, onClose, item, target, onSubmitted, initialReason, intro }: FixDialogProps) {
  const seerrLink = useSeerrIssueLink();
  const needsTarget = item.arrKind === 'sonarr' || item.arrKind === 'lidarr';
  const targetNoun = item.arrKind === 'sonarr' ? 'episode' : 'album';
  const preselected = target ?? null;
  // ADR-016 / D-19: the reason set is fixed by kind at dialog-open (Music excludes
  // 'missing_subtitles' — Bazarr covers movies/TV only). It never changes on interaction,
  // so no reflow-on-interaction (ADR-015 / hard rule 9).
  const reasons = fixReasonsForKind(item.arrKind as ArrKindName);

  const [targetChildId, setTargetChildId] = useState<number | ''>('');
  // DESIGN-055 D-10 — this dialog stays mounted and resets on close, so the reason is the person's pick, else the one a
  // Seerr report points at, else Won't play (derived, so a report's reason applies on every open).
  const [pickedReason, setReason] = useState<FixReasonName | null>(null);
  const reason: FixReasonName =
    pickedReason ?? (initialReason && reasons.includes(initialReason) ? initialReason : 'wont_play_corrupt');
  const [reasonText, setReasonText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<DoneState | null>(null);
  // After a retry the live anchor is the NEW search event, not the old fix row
  // (whose found-nothing window already elapsed) — so the poll source swaps.
  const [retried, setRetried] = useState(false);

  // Only fetch the live picker when we need a target AND one wasn't handed in.
  const children = trpc.ledger.children.useQuery(
    { mediaItemId: item.id },
    { enabled: open && needsTarget && preselected === null },
  );
  const create = trpc.fix.create.useMutation({
    onError: (err) => setError(describeMutationError(err)),
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
      onSubmitted();
    },
  });
  const utils = trpc.useUtils();
  const retrySearch = trpc.fix.forceSearch.useMutation({
    onError: (err) => setError(describeMutationError(err)),
    onSuccess: () => {
      setError(null);
      setRetried(true);
      // The retry may reuse a search query that already stopped on a terminal —
      // invalidate so the fresh anchor is fetched and polling re-arms.
      void utils.fix.searchProgress.invalidate();
      onSubmitted();
    },
  });

  // Bazarr subtitle fixes have no *arr queue/import to watch — they keep the
  // static fire-and-forget copy (mirrors the completeFixRequests exclusion).
  const isSubtitlePath = done?.pathTaken === 'bazarr_subtitle';
  const source: ProgressSource | null =
    open && done !== null && !isSubtitlePath
      ? retried
        ? { kind: 'search', input: done.searchInput }
        : { kind: 'fix', fixRequestId: done.fixRequestId }
      : null;
  const live = useActionProgress(source, { onTerminal: () => onSubmitted() });

  function reset() {
    setTargetChildId('');
    setReason(null);
    setReasonText('');
    setError(null);
    setDone(null);
    setRetried(false);
  }

  function close() {
    reset();
    onClose();
  }

  function submit() {
    setError(null);
    // The preselected scope (episode/album/season/item) drives the mutation; the picker
    // is the fallback for a bare sonarr/lidarr Fix and always resolves to a single child.
    let scopeInput: ReturnType<typeof targetToInput>;
    if (preselected !== null) {
      scopeInput = targetToInput(preselected);
    } else if (needsTarget) {
      if (targetChildId === '') {
        setError(`Pick the ${targetNoun} that needs fixing first.`);
        return;
      }
      scopeInput = {
        scope: item.arrKind === 'sonarr' ? 'episode' : 'album',
        targetChildId,
      };
    } else {
      scopeInput = {}; // radarr movie (item scope)
    }
    if (reason === 'other' && reasonText.trim() === '') {
      setError('Tell us what is wrong — the Other reason needs a few words.');
      return;
    }
    create.mutate({
      mediaItemId: item.id,
      ...scopeInput,
      reason,
      ...(reason === 'other' ? { reasonText: reasonText.trim() } : {}),
      ...seerrLink,
    });
  }

  return (
    <Modal
      open={open}
      title={`Fix ${item.title}`}
      onClose={close}
      // Errors ride a pinned aria-live slot above the scrolling body so the alert never
      // squeezes the reason list into a cut-off scrollbox (owner UX nitpick).
      banner={error ? <p className="alert">{error}</p> : null}
    >
      {intro && !done ? intro : null}
      {done ? (
        <div className="fix-done">
          <p className="fix-done__lead">
            {done.pathTaken === 'bazarr_subtitle'
              ? 'Bazarr is searching for and downloading subtitles — the media file itself is untouched.'
              : done.pathTaken === 'blocklist_search'
                ? 'The bad release was blocklisted and a search for a replacement is running.'
                : 'The file was removed and a search for a replacement is running.'}
          </p>
          {done.targetLabel ? <p className="muted">Target: {done.targetLabel}</p> : null}
          {isSubtitlePath ? (
            <p className="muted">
              Subtitle downloads finish on their own — nothing else to watch here.
            </p>
          ) : (
            <>
              <ActionProgressBlock
                progress={live.progress}
                pending={live.pending}
                checkFailed={live.checkFailed}
                kind={item.arrKind as ArrKindName}
                onRetry={() => retrySearch.mutate({ ...done.searchInput })}
                retryLabel="Search again"
                retryPending={retrySearch.isPending}
              />
              <p className="muted">
                You can close this — the live status stays on the item and under Library → My
                Fixes.
              </p>
            </>
          )}
          <div className="form-actions">
            <button type="button" className="btn primary" onClick={close}>
              Done
            </button>
          </div>
        </div>
      ) : (
        <form
          className="admin-form fix-form"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          {needsTarget && preselected !== null ? (
            <p className="fix-target">
              Fixing <strong>{preselected.label}</strong>
            </p>
          ) : null}

          {needsTarget && preselected === null ? (
            <label className="field">
              <span>Which {targetNoun}?</span>
              {children.isLoading ? (
                <span className="muted">Loading {targetNoun}s…</span>
              ) : children.error ? (
                <span className="field-error">
                  Could not load the {targetNoun} list: {children.error.message}
                </span>
              ) : (
                <select
                  required
                  value={targetChildId}
                  onChange={(e) =>
                    setTargetChildId(e.target.value === '' ? '' : Number(e.target.value))
                  }
                >
                  <option value="">Select a {targetNoun}…</option>
                  {(children.data ?? []).map((child) => (
                    <option key={child.arrChildId} value={child.arrChildId}>
                      {child.label}
                      {child.hasFile ? '' : ' (not on disk)'}
                    </option>
                  ))}
                </select>
              )}
            </label>
          ) : null}

          <fieldset className="field">
            <legend>What is wrong? (required)</legend>
            <ul className="check-list">
              {reasons.map((value) => (
                <li key={value}>
                  <label className="check-row">
                    <input
                      type="radio"
                      name="fix-reason"
                      value={value}
                      checked={reason === value}
                      onChange={() => setReason(value)}
                    />
                    <span>{FIX_REASON_LABELS[value]}</span>
                  </label>
                </li>
              ))}
            </ul>
          </fieldset>

          {reason === 'other' ? (
            <label className="field">
              <span>Tell us more</span>
              <textarea
                required
                maxLength={500}
                rows={3}
                value={reasonText}
                onChange={(e) => setReasonText(e.target.value)}
                placeholder="What exactly is broken?"
              />
            </label>
          ) : null}

          <div className="form-actions">
            <button type="submit" className="btn primary" disabled={create.isPending}>
              {create.isPending ? 'Submitting…' : 'Submit fix'}
            </button>
            <button type="button" className="btn" disabled={create.isPending} onClick={close}>
              Cancel
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}
