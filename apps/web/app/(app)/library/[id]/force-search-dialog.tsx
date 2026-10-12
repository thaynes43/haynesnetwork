'use client';

// DESIGN-005 D-17 — Force Search dialog: the search-only action for MISSING content
// (not broken, just missing). No reason taxonomy, no blocklist, no delete — a single
// confirm → fix.forceSearch → then the ADR-028 / D-20 LIVE progress view: the dialog
// polls fix.searchProgress (anchored on the search_requested event) and walks
// searching → found-something → downloading% → completed, or lands the honest
// nothing_found terminal with a "Search again" retry. Season/artist scopes expand a
// per-child roll-up (D-21).
//
// ADR-109 C-05 / DESIGN-055 D-01, D-07 (PLAN-077 P2) — with the `import_check` remedy on, Force Search on one episode or
// on a movie becomes the Force Search step of the Repair Guide: it reads the download queue first (`fix.searchPlan`,
// read-only and free) and shows one step for what it found. Nothing queued: today's search. A download on its way: its
// progress, and nothing is sent. A finished download that passes the Import Check: what it found (each fact with its
// source) and "Import it". A download whose name says it is another episode: "Import onto…" the episode it names or the
// one searched for. A failed or broken download: remove it and block the release (a "gone afterwards" line the person
// ticks, never pre-ticked), then search once. Anything else: why, and a prefilled Helpdesk ticket for staff. The press
// sends the plan's digest back; a plan that changed is re-read and shown again. Other targets, and the remedy off, keep
// today's dialog unchanged.
//
// Hard rule 8: a Modal (an explanatory confirm). Hard rule 9: the guide's dialog has a fixed height (`modal--guide`) and
// only its body scrolls, so a step that replaces another never moves anything outside it; an interaction recolors or
// enables, and the "Import onto…" confirm reserves the width of its longest label. Copy follows the owner's rules.
import Link from 'next/link';
import { Fragment, useState } from 'react';
import { MediaAction, ProgressMeter } from '@hnet/ui';
import { trpc } from '@/lib/trpc-client';
import { appCodeOf, describeMutationError } from '@/lib/app-error';
import { targetToInput, type ActionTarget, type ArrKindName } from '@/lib/media';
import {
  arrMessages,
  arrName,
  confirmText,
  defectText,
  downloadStatusText,
  fileFacts,
  importTargetLabels,
  joinLabels,
  outcomeSearched,
  outcomeText,
  progressDetail,
  progressPercent,
  readsQueueFirst,
  removalGoneLine,
  staffText,
  staffTicketText,
  stepHeading,
  titleEvidenceText,
  type ForceSearchOutcome,
  type GuideArrKind,
  type SearchPlan,
} from '@/lib/force-search-guide';
import { ticketComposeHref } from '@/lib/ticket-compose-link';
import { Modal } from '@/components/modal';
import {
  ActionProgressBlock,
  useActionProgress,
  type SearchProgressInput,
} from '@/components/action-progress';

export interface ForceSearchDialogProps {
  open: boolean;
  onClose: () => void;
  item: { id: string; arrKind: string; title: string };
  /**
   * The scoped target: a single episode/album, a whole season, or the whole show /
   * artist. null ⇒ the movie / legacy whole-series search.
   */
  target?: ActionTarget | null;
  /**
   * Invalidate/refresh hooks after a successful submit. Receives the submitted grain
   * so the item view can lock that slot behind the live chip (D-21).
   */
  onSubmitted: (search: { input: SearchProgressInput; label: string }) => void;
  /**
   * DESIGN-055 D-07 — called when a press changed the title without starting a search (an import), so a caller that
   * shows the title somewhere the item queries do not cover can refresh it.
   */
  onChanged?: () => void;
}

/**
 * Force Search opens the queue-aware guide step when the `import_check` remedy is on and the target is one episode or
 * the movie; otherwise today's dialog. The guide mounts only while open, so each press reads the queue afresh.
 */
export function ForceSearchDialog(props: ForceSearchDialogProps) {
  const guide = trpc.fix.guideConfig.useQuery(undefined, { staleTime: 60_000 });
  const target = props.target ?? null;
  const kind = props.item.arrKind;
  const eligible = readsQueueFirst({ arrKind: kind, target, importCheckOn: true });
  if (eligible && (kind === 'sonarr' || kind === 'radarr') && (guide.isLoading || guide.data?.importCheckOn)) {
    return props.open ? (
      <QueueAwareForceSearch {...props} kind={kind} target={target} configLoading={guide.isLoading} />
    ) : null;
  }
  return <ClassicForceSearchDialog {...props} />;
}

const PLAN_CHANGED = 'What Force Search found has changed. Here is what it sees now.';

interface DoneState {
  outcome: ForceSearchOutcome;
  removeWhy: 'failed' | 'defect' | null;
  targetLabel: string;
  input: SearchProgressInput;
}

function QueueAwareForceSearch({
  onClose,
  item,
  target,
  kind,
  configLoading,
  onSubmitted,
  onChanged,
}: ForceSearchDialogProps & { kind: GuideArrKind; target: ActionTarget | null; configLoading: boolean }) {
  const scopeInput = targetToInput(target);
  const utils = trpc.useUtils();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<DoneState | null>(null);
  const [acked, setAcked] = useState(false);
  const [onto, setOnto] = useState<number | null>(null);

  // Read-only and free. `gcTime: 0` drops the plan when the dialog closes, so the next open reads the queue again.
  const plan = trpc.fix.searchPlan.useQuery(
    { mediaItemId: item.id, ...scopeInput },
    { enabled: !configLoading && done === null, staleTime: Infinity, gcTime: 0, retry: false, refetchOnWindowFocus: false },
  );
  const data: SearchPlan | undefined = plan.data;
  const label = data?.targetLabel ?? target?.label ?? item.title;
  const app = arrName(kind);

  // The other episodes a multi-episode file lands on are named from the title's episode list.
  const fileTargets = data?.check?.file?.targetIds ?? [];
  const children = trpc.ledger.children.useQuery(
    { mediaItemId: item.id },
    { enabled: kind === 'sonarr' && data?.state === 'import' && fileTargets.length > 1, staleTime: 60_000 },
  );

  const refreshItem = () => {
    void utils.ledger.detail.invalidate({ id: item.id });
    void utils.ledger.children.invalidate({ mediaItemId: item.id });
    void utils.ledger.events.invalidate();
    onChanged?.();
  };

  const search = trpc.fix.forceSearch.useMutation({
    onError: (err) => {
      if (appCodeOf(err) === 'FIX_PLAN_CHANGED') {
        setError(PLAN_CHANGED);
        setAcked(false);
        setOnto(null);
        void plan.refetch();
        return;
      }
      setError(describeMutationError(err));
    },
    onSuccess: (result, variables) => {
      setError(null);
      const input: SearchProgressInput = {
        mediaItemId: variables.mediaItemId,
        scope: variables.scope,
        targetChildId: variables.targetChildId,
        seasonNumber: variables.seasonNumber,
      };
      setDone({ outcome: result.outcome, removeWhy: data?.removeWhy ?? null, targetLabel: label, input });
      if (outcomeSearched(result.outcome)) {
        // A retry lands while the previous poll is STOPPED on its terminal — invalidate so the fresh anchor is fetched.
        void utils.fix.searchProgress.invalidate();
        onSubmitted({ input, label });
      } else {
        refreshItem();
      }
    },
  });

  const live = useActionProgress(
    done !== null && outcomeSearched(done.outcome) ? { kind: 'search', input: done.input } : null,
  );

  // "Import onto…": the episode the file name names is preselected, else the first offered.
  const suggested = data?.ontoChoices.find((c) => c.suggested) ?? null;
  const chosenOnto = onto ?? suggested?.episodeId ?? data?.ontoChoices[0]?.episodeId ?? null;

  function submit(p: SearchPlan) {
    setError(null);
    search.mutate({
      mediaItemId: item.id,
      ...scopeInput,
      ...(p.queueAware ? { planDigest: p.digest } : {}),
      ...(p.state === 'import_onto' && chosenOnto !== null ? { ontoEpisodeId: chosenOnto } : {}),
    });
  }

  const targetLine = (
    <p className="fix-target">
      Force Search for <strong>{label}</strong>
    </p>
  );
  const doneButton = (
    <div className="form-actions">
      <button type="button" className="btn primary" onClick={onClose}>
        Done
      </button>
    </div>
  );

  /** What the queue holds, each fact with its source: the download, the file the Import Check judged, the *arr's words. */
  const evidence = (p: SearchPlan) => {
    const facts = fileFacts(p.check?.file ?? null);
    const titleLine = p.check ? titleEvidenceText(p.check, kind) : null;
    const messages = arrMessages(p.download, p.check);
    return (
      <div className="repair-guide__cards">
        {facts.length > 0 ? (
          <div className="repair-guide__card">
            <span className="repair-guide__card-label">What {app} sees in the finished download</span>
            <dl className="fs-guide__facts">
              {facts.map((f) => (
                <Fragment key={f.label}>
                  <dt>{f.label}</dt>
                  <dd>{f.value}</dd>
                </Fragment>
              ))}
            </dl>
            {titleLine ? <span className="fs-guide__evidence">{titleLine}</span> : null}
          </div>
        ) : p.download?.title ? (
          <div className="repair-guide__card">
            <span className="repair-guide__card-label">In the download queue</span>
            <span className="repair-guide__release">{p.download.title}</span>
          </div>
        ) : null}
        {messages.length > 0 ? (
          <div className="repair-guide__card">
            <span className="repair-guide__card-label">What {app} says about it</span>
            <ul className="repair-guide__facts">
              {messages.map((m) => (
                <li key={m} className="repair-guide__release">
                  {m}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    );
  };

  const ticketHref = (p: SearchPlan, reasonLine: string) => {
    const text = staffTicketText({ plan: p, targetLabel: label, kind, reasonLine });
    return ticketComposeHref({
      mediaItemId: item.id,
      episodeId: kind === 'sonarr' ? (target?.childId ?? null) : null,
      subject: text.subject,
      note: text.note,
      category: 'missing',
    });
  };

  const body = (() => {
    if (done) {
      const searched = outcomeSearched(done.outcome);
      return (
        <div className="fix-done repair-guide__step">
          {targetLine}
          <p className="fix-done__lead" role="status">
            {outcomeText({ outcome: done.outcome, removeWhy: done.removeWhy, targetLabel: done.targetLabel })}
          </p>
          {done.outcome === 'searched' ? (
            <p className="muted">Nothing was blocked or deleted. This was a search only.</p>
          ) : done.outcome === 'on_its_way' ? (
            <p className="muted">Nothing was searched, so nothing is lost.</p>
          ) : null}
          {searched ? (
            <>
              <ActionProgressBlock
                progress={live.progress}
                pending={live.pending}
                checkFailed={live.checkFailed}
                kind={item.arrKind as ArrKindName}
                onRetry={() => search.mutate({ ...done.input })}
                retryLabel="Search again"
                retryPending={search.isPending}
              />
              <p className="muted">You can close this. The live status stays on the title until it finishes.</p>
            </>
          ) : null}
          {doneButton}
        </div>
      );
    }

    if (configLoading || plan.isLoading || plan.isFetching) {
      return (
        <div className="repair-guide__step">
          {targetLine}
          <p className="muted" role="status">
            Checking the download queue…
          </p>
        </div>
      );
    }
    if (plan.error || !data) {
      return (
        <div className="repair-guide__step">
          {targetLine}
          <p className="alert">Couldn&rsquo;t read the download queue: {plan.error?.message ?? 'no answer'}</p>
          <p className="muted">Nothing was changed.</p>
          <div className="form-actions">
            <button type="button" className="btn" onClick={() => void plan.refetch()}>
              Try again
            </button>
          </div>
        </div>
      );
    }

    const heading = stepHeading(data, label, suggested?.label ?? null);
    switch (data.state) {
      case 'search':
        return (
          <div className="repair-guide__step">
            {data.queueAware ? <p className="muted">{heading}</p> : null}
            <p className="fix-done__lead">
              Force a fresh search for <strong>{label}</strong>?
            </p>
            <p className="muted">A search blocks no release and removes no file.</p>
            <div className="form-actions">
              <button type="button" className="btn primary" disabled={search.isPending} onClick={() => submit(data)}>
                {confirmText('search', null)}
              </button>
              <button type="button" className="btn" disabled={search.isPending} onClick={onClose}>
                Cancel
              </button>
            </div>
          </div>
        );

      case 'on_its_way': {
        const d = data.download;
        const pct = progressPercent(d?.progress);
        return (
          <div className="repair-guide__step">
            {targetLine}
            <h3 className="repair-guide__question">{heading}</h3>
            {d ? (
              <div className="repair-guide__card">
                <span className="repair-guide__card-label">In the download queue</span>
                <span className="repair-guide__release">{d.title ?? label}</span>
                <span>{downloadStatusText(d)}</span>
                <ProgressMeter
                  pct={pct ?? undefined}
                  tone="progress"
                  detail={progressDetail(d)}
                  label={`How far along the download for ${label} is`}
                />
              </div>
            ) : null}
            <p>Nothing was searched, so nothing is lost.</p>
            {doneButton}
          </div>
        );
      }

      case 'import': {
        const targets = importTargetLabels(
          fileTargets,
          { id: target?.childId ?? null, label },
          (id) => children.data?.find((c) => c.arrChildId === id)?.label ?? null,
        );
        return (
          <div className="repair-guide__step">
            {targetLine}
            <h3 className="repair-guide__question">{heading}</h3>
            {evidence(data)}
            <section className="repair-guide__group">
              <h4>What it will do</h4>
              <ul className="repair-guide__facts">
                <li>Add this file to {joinLabels(targets)}.</li>
                <li>Nothing is deleted or blocked.</li>
              </ul>
            </section>
            <div className="form-actions">
              <MediaAction action="importDownload" disabled={search.isPending} onFire={() => submit(data)} />
            </div>
          </div>
        );
      }

      case 'import_onto': {
        const staffLine = staffText({ check: data.check, targetLabel: label, kind });
        return (
          <div className="repair-guide__step">
            {targetLine}
            <h3 className="repair-guide__question">{heading}</h3>
            <p>
              {app} grabbed it for {label}, but the file&rsquo;s own name says otherwise, so it was not added on its
              own. Choose where it goes.
            </p>
            {evidence(data)}
            <fieldset className="field">
              <legend className="repair-guide__question">Import it onto</legend>
              <ul className="check-list">
                {data.ontoChoices.map((c) => (
                  <li key={c.episodeId}>
                    <label className="check-row">
                      <input
                        type="radio"
                        name="force-search-onto"
                        checked={chosenOnto === c.episodeId}
                        onChange={() => setOnto(c.episodeId)}
                      />
                      <span>
                        {c.label}
                        {c.suggested ? <span className="muted"> (what the file name says)</span> : null}
                        {c.grabTarget ? <span className="muted"> (the episode you searched for)</span> : null}
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            </fieldset>
            <p className="muted">
              Nothing is deleted or blocked. None of these?{' '}
              <Link href={ticketHref(data, staffLine)}>Open a ticket</Link> and staff will sort it out.
            </p>
            <div className="form-actions">
              <button
                type="button"
                className="btn primary fs-guide__sized"
                disabled={search.isPending || chosenOnto === null}
                onClick={() => submit(data)}
              >
                {/* Every choice's label sits in the same cell; only the chosen one shows, so the button keeps the
                    width of the longest and a new choice never moves anything (hard rule 9). */}
                {data.ontoChoices.map((c) => (
                  <span
                    key={c.episodeId}
                    className={c.episodeId === chosenOnto ? undefined : 'fs-guide__ghost'}
                    aria-hidden={c.episodeId === chosenOnto ? undefined : true}
                  >
                    {confirmText('import_onto', c.label)}
                  </span>
                ))}
              </button>
            </div>
          </div>
        );
      }

      case 'remove_and_search': {
        const defect = data.removeWhy === 'defect' ? defectText(data.check?.detail, kind) : null;
        return (
          <div className="repair-guide__step">
            {targetLine}
            <h3 className="repair-guide__question">{heading}</h3>
            {defect ? <p>{defect}</p> : null}
            {evidence(data)}
            <section className="repair-guide__group">
              <h4>What it will do</h4>
              <ul className="repair-guide__facts">
                <li>Remove the download and block that release.</li>
                <li>Search once for another release of {label}.</li>
              </ul>
            </section>
            <fieldset className="field repair-guide__gone">
              <legend>Gone afterwards (tick to confirm)</legend>
              <label className="check-row">
                <input type="checkbox" checked={acked} onChange={(e) => setAcked(e.target.checked)} />
                <span>{removalGoneLine(data.download)}</span>
              </label>
            </fieldset>
            <div className="form-actions">
              <button
                type="button"
                className="btn primary"
                disabled={!acked || search.isPending}
                onClick={() => submit(data)}
              >
                {confirmText('remove_and_search', null)}
              </button>
            </div>
          </div>
        );
      }

      case 'staff': {
        const why = staffText({ check: data.check, targetLabel: label, kind });
        return (
          <div className="repair-guide__step">
            {targetLine}
            <h3 className="repair-guide__question">{heading}</h3>
            <p>{why}</p>
            {evidence(data)}
            <p>
              Staff can add it by hand. <Link href={ticketHref(data, why)}>Open a ticket</Link> with the details filled
              in and it goes straight to them. Nothing was changed.
            </p>
            {doneButton}
          </div>
        );
      }
    }
  })();

  return (
    <Modal
      open
      title={`Force search ${item.title}`}
      onClose={onClose}
      className="modal--guide"
      banner={error ? <p className="alert">{error}</p> : null}
    >
      <div className="repair-guide">{body}</div>
    </Modal>
  );
}

function ClassicForceSearchDialog({
  open,
  onClose,
  item,
  target,
  onSubmitted,
}: ForceSearchDialogProps) {
  const preselected = target ?? null;
  const what = preselected !== null ? preselected.label : item.title;

  const utils = trpc.useUtils();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ input: SearchProgressInput } | null>(null);

  const search = trpc.fix.forceSearch.useMutation({
    onError: (err) => setError(describeMutationError(err)),
    onSuccess: (_result, variables) => {
      setError(null);
      const input: SearchProgressInput = {
        mediaItemId: variables.mediaItemId,
        scope: variables.scope,
        targetChildId: variables.targetChildId,
        seasonNumber: variables.seasonNumber,
      };
      setDone({ input });
      // A retry lands while the previous poll is STOPPED on its terminal — invalidate
      // so the fresh anchor is fetched and the non-terminal phase re-arms the interval.
      void utils.fix.searchProgress.invalidate();
      onSubmitted({ input, label: what });
    },
  });

  // A retry re-issues the SAME grain: the latest search_requested event becomes the
  // fresh anchor, so the ongoing poll simply picks the new window up — no source swap.
  const live = useActionProgress(open && done !== null ? { kind: 'search', input: done.input } : null);

  function reset() {
    setError(null);
    setDone(null);
  }

  function close() {
    reset();
    onClose();
  }

  function submit() {
    setError(null);
    search.mutate({ mediaItemId: item.id, ...targetToInput(preselected) });
  }

  return (
    <Modal open={open} title={`Force search ${item.title}`} onClose={close}>
      {done ? (
        <div className="fix-done">
          <p className="fix-done__lead">
            A fresh search is running, and the manager will grab {what} as soon as a release is
            found.
          </p>
          <p className="muted">Nothing was blocklisted or deleted. This was a search only.</p>
          <ActionProgressBlock
            progress={live.progress}
            pending={live.pending}
            checkFailed={live.checkFailed}
            kind={item.arrKind as ArrKindName}
            onRetry={() => search.mutate({ ...done.input })}
            retryLabel="Search again"
            retryPending={search.isPending}
          />
          <p className="muted">
            You can close this. The live status stays on the item until it finishes.
          </p>
          <div className="form-actions">
            <button type="button" className="btn primary" onClick={close}>
              Done
            </button>
          </div>
        </div>
      ) : (
        <div className="fix-done">
          {error ? (
            <p className="alert" role="alert">
              {error}
            </p>
          ) : null}
          <p className="fix-done__lead">
            Force a fresh search for <strong>{what}</strong>?
          </p>
          <p className="muted">
            This is for content that is simply missing. No release is blocklisted and no file
            is removed.
          </p>
          <div className="form-actions">
            <button
              type="button"
              className="btn primary"
              disabled={search.isPending}
              onClick={submit}
            >
              {search.isPending ? 'Searching…' : 'Force search'}
            </button>
            <button type="button" className="btn" disabled={search.isPending} onClick={close}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}
