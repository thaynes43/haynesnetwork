'use client';

// ADR-109 C-06 / DESIGN-055 D-01, D-06 (PLAN-077 P5): the Release Pick step of the Repair Guide. "See every release"
// lists every release the sites have for one missing episode or movie (`fix.releaseList`, one hourly media action), with
// the *arr's reasons in plain words: the best choice first and why, the other releases the person can pick, and the ones
// nobody can pick under a closed "Releases you can't pick" with an "Ask staff" ticket each. "Pick this one" leads to the
// confirm (what it found, what it will do, nothing deleted or blocked), and "Grab this release" sends the pick
// (`fix.releaseGrab`). Afterwards the live chip follows the download (`fix.repairProgress`); a failed download offers
// another pick, a download that needs a hand to be added offers Force Search, whose Import Check adds it.
//
// Rendered inside a guide Modal's body (hard rule 8: the explanatory confirm). Hard rule 9: the dialog keeps its fixed
// height (`modal--guide`) and the steps replace each other in place; the list stays in memory when the confirm goes Back.
// An interaction recolors or enables, never reflows: a row's action shares one reserved cell for "Pick this one" and
// "Try another site", and the grab's status line keeps its height. Copy lives in lib/release-pick-guide.ts.
import Link from 'next/link';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { MediaAction, ProgressMeter } from '@hnet/ui';
import { trpc } from '@/lib/trpc-client';
import { appCodeOf, describeMutationError } from '@/lib/app-error';
import { progressPercent } from '@/lib/force-search-guide';
import {
  ASK_STAFF_LABEL,
  ASK_STAFF_TAIL,
  BEST_CHOICE_LABEL,
  BLOCKED_NOTE,
  CONFIRM_HEADING,
  EVERY_SITE_REFUSED_TEXT,
  GRABBING_TEXT,
  NOTHING_TO_PICK_NOTE,
  OTHERS_HEADING,
  PICK_AGAIN_LABEL,
  PICK_LABEL,
  SEARCHING_NOTE,
  SEARCH_AGAIN_LABEL,
  SITE_REFUSED_TEXT,
  STALE_NOTE,
  TRY_ANOTHER_SITE_LABEL,
  TRY_ANOTHER_SITE_NOTE,
  arrWords,
  arrWordsLabel,
  askStaffTicket,
  bestChoiceWhy,
  blockedSummary,
  budgetAfter,
  budgetText,
  confirmPlan,
  displayReasons,
  evidenceText,
  grabOutcomeText,
  listLead,
  listSections,
  nextKey,
  reasonTone,
  resultFollowUp,
  rowFacts,
  rowStateTag,
  searchingText,
  statusStepText,
  type PickArrKind,
  type ReleaseGrab,
  type ReleaseList,
  type ReleaseRow,
} from '@/lib/release-pick-guide';
import { ticketComposeHref } from '@/lib/ticket-compose-link';
import { ActionProgressBlock, useActionProgress } from '@/components/action-progress';

export interface ReleasePickProps {
  item: { id: string; title: string };
  kind: PickArrKind;
  /** The episode (Sonarr); null for the movie. */
  episodeId: number | null;
  /** "S01E11 · Spice It Up", or the movie's title: what the step names until the list does. */
  targetLabel: string;
  /** Back to the step that opened it (Force Search, or a re-map's result). Offered until something is grabbed. */
  onBack?: () => void;
  onClose: () => void;
  /** Opens Force Search for this target: its Import Check adds a download that needs a hand. */
  onForceSearch?: () => void;
  /** Something changed on the title (a grab started). */
  onChanged?: () => void;
  /** The guide's banner line (null clears it). */
  setError: (message: string | null) => void;
}

type View = 'list' | 'confirm' | 'grabbed' | 'stale' | 'refused';

/** A budget refusal carries the role's own limit in its message; the shared copy for the code does not. */
function errorText(err: unknown): string {
  if (appCodeOf(err) === 'FIX_RATE_LIMIT_EXCEEDED') {
    const message = (err as { message?: unknown }).message;
    if (typeof message === 'string' && message !== '') return message;
  }
  if (appCodeOf(err) === 'FIX_ALREADY_OPEN') {
    return 'Another repair for this is still open. Give it a little while to finish, then try again.';
  }
  return describeMutationError(err);
}

export function ReleasePick({
  item,
  kind,
  episodeId,
  targetLabel: initialLabel,
  onBack,
  onClose,
  onForceSearch,
  onChanged,
  setError,
}: ReleasePickProps) {
  // Each bump opens a fresh list (the first open, "Search again", "Pick another release").
  const [request, setRequest] = useState(0);
  const [list, setList] = useState<ReleaseList | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [view, setView] = useState<View>('list');
  const [chosenKey, setChosenKey] = useState<string | null>(null);
  // Per row: the sources a site refused (a 409), so "Try another site" grabs the next one.
  const [refused, setRefused] = useState<Record<string, string[]>>({});
  const [picksMade, setPicksMade] = useState(0);
  const [budgetOut, setBudgetOut] = useState(false);
  const [grab, setGrab] = useState<ReleaseGrab | null>(null);

  const label = list?.targetLabel ?? initialLabel;

  const open = trpc.fix.releaseList.useMutation({
    onError: (err) => setListError(errorText(err)),
    onSuccess: (data) => {
      setListError(null);
      setList(data);
      setView('list');
      setChosenKey(null);
      setRefused({});
      setPicksMade(0);
      setBudgetOut(false);
      setGrab(null);
    },
  });

  // The list is a live search of every site and a unit of the hourly budget: send it once per request, never twice
  // for one press (React's development double-run of effects keeps the ref).
  const sent = useRef(-1);
  const openMutate = open.mutate;
  useEffect(() => {
    if (sent.current === request) return;
    sent.current = request;
    openMutate({
      mediaItemId: item.id,
      ...(kind === 'sonarr' && episodeId !== null ? { scope: 'episode' as const, targetChildId: episodeId } : {}),
    });
  }, [request, openMutate, item.id, kind, episodeId]);

  function freshList() {
    setError(null);
    setList(null);
    setListError(null);
    setView('list');
    setRequest((n) => n + 1);
  }

  const rowOf = (key: string): ReleaseRow | null => list?.rows.find((r) => r.keys.includes(key)) ?? null;

  const take = trpc.fix.releaseGrab.useMutation({
    onError: (err) => {
      if (appCodeOf(err) === 'FIX_RATE_LIMIT_EXCEEDED') setBudgetOut(true);
      setError(errorText(err));
    },
    onSuccess: (result, variables) => {
      setError(null);
      // A grab that reached the *arr opened a Repair Request, one unit of the hourly budget, even when a site refused it.
      if (result.repairRequestId !== null) setPicksMade((n) => n + 1);
      setGrab(result);
      switch (result.outcome) {
        case 'grabbed':
          setView('grabbed');
          onChanged?.();
          return;
        case 'grab_failed': {
          const row = rowOf(variables.key);
          if (row) setRefused((prev) => ({ ...prev, [row.key]: [...(prev[row.key] ?? []), variables.key] }));
          setView('list');
          return;
        }
        case 'list_stale':
          setView('stale');
          return;
        default:
          setView('refused');
      }
    },
  });

  const live = useActionProgress(
    view === 'grabbed' && grab?.repairRequestId ? { kind: 'repair', repairRequestId: grab.repairRequestId } : null,
  );

  const targetLine = (
    <p className="fix-target">
      Every release for <strong>{label}</strong>
    </p>
  );
  const doneButton = (
    <button type="button" className="btn primary" onClick={onClose}>
      Done
    </button>
  );
  const backButton = onBack ? (
    <button type="button" className="btn" disabled={take.isPending} onClick={onBack}>
      Back
    </button>
  ) : null;

  const ticketHref = (row: ReleaseRow | null) => {
    const text = askStaffTicket({ row, targetLabel: label, kind });
    return ticketComposeHref({
      mediaItemId: item.id,
      episodeId: kind === 'sonarr' ? episodeId : null,
      subject: text.subject,
      note: text.note,
      category: 'missing',
    });
  };

  const forceSearchControl = onForceSearch ? (
    <div className="form-actions">
      <MediaAction action="forceSearch" onFire={onForceSearch} />
    </div>
  ) : null;

  // ---------------------------------------------------------------- searching, or the list could not be read
  if (list === null) {
    if (listError !== null && !open.isPending) {
      return (
        <div className="repair-guide__step">
          {targetLine}
          <p className="alert">{listError}</p>
          <p className="muted">Nothing was grabbed.</p>
          <div className="form-actions">
            {backButton}
            <button type="button" className="btn" onClick={freshList}>
              Try again
            </button>
          </div>
        </div>
      );
    }
    return (
      <div className="repair-guide__step">
        {targetLine}
        <p className="fix-done__lead" role="status">
          {searchingText(label)}
        </p>
        <ProgressMeter label={`Looking for releases of ${label}`} tone="progress" detail="" />
        <p className="muted">{SEARCHING_NOTE}</p>
      </div>
    );
  }

  // ---------------------------------------------------------------- nothing to list (free)
  if (list.status !== 'list') {
    const text = statusStepText(list.status, label, list.download !== null);
    const d = list.download;
    const pct = progressPercent(d?.progress);
    return (
      <div className="repair-guide__step">
        {targetLine}
        <h3 className="repair-guide__question">{text.heading}</h3>
        {d && list.status !== 'has_file' ? (
          <div className="repair-guide__card">
            <span className="repair-guide__card-label">In the download queue</span>
            <span className="repair-guide__release">{d.title ?? label}</span>
            {list.status === 'on_its_way' ? (
              <ProgressMeter
                pct={pct ?? undefined}
                tone="progress"
                detail={pct !== null ? `${pct}%` : ''}
                label={`How far along the download for ${label} is`}
              />
            ) : null}
          </div>
        ) : null}
        <p>{text.body}</p>
        {list.status === 'queue_stuck' ? forceSearchControl : null}
        <div className="form-actions">
          {backButton}
          {doneButton}
        </div>
      </div>
    );
  }

  const budget = budgetAfter(list.budget, picksMade);
  const canPick = list.canPick && budget.canPick && !budgetOut;
  const sections = listSections(list);
  const chosen = chosenKey !== null ? (list.rows.find((r) => r.key === chosenKey) ?? null) : null;

  function send(key: string) {
    if (!list?.listId) return;
    setError(null);
    take.mutate({ listId: list.listId, key });
  }

  // ---------------------------------------------------------------- the confirm (D-01 preview contract)
  if (view === 'confirm' && chosen) {
    const lines = confirmPlan(chosen, { kind, targetLabel: label, limited: list.budget.limit !== null });
    const key = nextKey(chosen, refused[chosen.key] ?? []);
    return (
      <div className="repair-guide__step">
        {targetLine}
        <h3 className="repair-guide__question">{CONFIRM_HEADING}</h3>
        <section className="repair-guide__group">
          <h4>What it found</h4>
          <ReleaseCard row={chosen} kind={kind} />
        </section>
        <section className="repair-guide__group">
          <h4>What it will do</h4>
          <ul className="repair-guide__facts">
            {lines.map((l) => (
              <li key={l.text}>
                {l.text}
                {l.sub.length > 0 ? (
                  <ul className="release-pick__sub">
                    {l.sub.map((s) => (
                      <li key={s}>{s}</li>
                    ))}
                  </ul>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
        {!canPick ? <p className="alert">{budgetText(budget, false)}</p> : null}
        <div className="form-actions">
          <button
            type="button"
            className="btn"
            disabled={take.isPending}
            onClick={() => {
              setError(null);
              setView('list');
            }}
          >
            Back
          </button>
          <MediaAction
            action="grabRelease"
            disabled={take.isPending || !canPick || key === null}
            onFire={() => {
              if (key !== null) send(key);
            }}
          />
        </div>
        <p className="muted release-pick__status" role="status">
          {take.isPending ? GRABBING_TEXT : ''}
        </p>
      </div>
    );
  }

  // ---------------------------------------------------------------- grabbed: the live progress
  if (view === 'grabbed' && grab) {
    const follow = resultFollowUp(live.progress?.phase ?? null, { kind, targetLabel: grab.targetLabel });
    const row = chosen;
    return (
      <div className="fix-done repair-guide__step">
        {targetLine}
        <p className="fix-done__lead" role="status">
          {grabOutcomeText({ outcome: 'grabbed', targetLabel: grab.targetLabel, override: grab.override })}
        </p>
        {row ? <p className="repair-guide__release release-pick__grabbed-title">{row.title}</p> : null}
        <p className="muted">Nothing was deleted or blocked.</p>
        <ActionProgressBlock
          progress={live.progress}
          pending={live.pending}
          checkFailed={live.checkFailed}
          kind={kind}
        />
        <div className={`release-pick__next release-pick__next--${follow.tone}`}>
          <p>{follow.text}</p>
          {follow.next === 'pick_again' ? (
            <div className="form-actions">
              <button type="button" className="btn" disabled={open.isPending} onClick={freshList}>
                {PICK_AGAIN_LABEL}
              </button>
            </div>
          ) : follow.next === 'force_search' ? (
            forceSearchControl
          ) : null}
        </div>
        <div className="form-actions">{doneButton}</div>
      </div>
    );
  }

  // ---------------------------------------------------------------- the list was too old to grab from
  if (view === 'stale') {
    return (
      <div className="repair-guide__step">
        {targetLine}
        <h3 className="repair-guide__question">
          {grabOutcomeText({ outcome: 'list_stale', targetLabel: label, override: false })}
        </h3>
        <p>{STALE_NOTE}</p>
        <div className="form-actions">
          {backButton}
          <button type="button" className="btn primary" disabled={!canPick} onClick={freshList}>
            {SEARCH_AGAIN_LABEL}
          </button>
        </div>
        {!canPick ? <p className="alert">{budgetText(budget, false)}</p> : null}
      </div>
    );
  }

  // ---------------------------------------------------------------- nothing was grabbed (has a file, on its way, refused)
  if (view === 'refused' && grab) {
    return (
      <div className="repair-guide__step">
        {targetLine}
        <p className="fix-done__lead" role="status">
          {grabOutcomeText({ outcome: grab.outcome, targetLabel: label, override: false })}
        </p>
        {grab.outcome === 'not_allowed' ? (
          <p className="muted">
            <Link href={ticketHref(chosen)}>{ASK_STAFF_LABEL}</Link> {ASK_STAFF_TAIL}
          </p>
        ) : null}
        <div className="form-actions">
          {grab.outcome === 'not_allowed' ? (
            <button type="button" className="btn" onClick={() => setView('list')}>
              Back to the list
            </button>
          ) : null}
          {doneButton}
        </div>
      </div>
    );
  }

  // ---------------------------------------------------------------- the list
  const pickable = (sections.best ? 1 : 0) + sections.others.length;
  const budgetLine = budgetText(budget, canPick);
  const rowAction = (row: ReleaseRow, primary: boolean) => {
    const tried = refused[row.key] ?? [];
    const next = nextKey(row, tried);
    const wasRefused = tried.length > 0;
    return (
      <div className="release-pick__act">
        {wasRefused ? (
          <p className="release-pick__refused" role="status">
            {SITE_REFUSED_TEXT}
          </p>
        ) : null}
        {/* A release found on one site has nowhere else to try. One found on several keeps its button (disabled once
            every site refused), so a refusal from the list never removes it and nothing moves (hard rule 9). */}
        {wasRefused && row.keys.length === 1 ? null : (
          <button
            type="button"
            className={`btn sm release-pick__sized${primary && !wasRefused ? ' primary' : ''}`}
            disabled={!canPick || take.isPending || (wasRefused && next === null)}
            onClick={() => {
              setError(null);
              setChosenKey(row.key);
              if (wasRefused) {
                if (next !== null) send(next);
                return;
              }
              setView('confirm');
            }}
          >
            {/* Both labels share one cell; only one shows, so the button keeps its width (hard rule 9). */}
            <span className={wasRefused ? 'release-pick__ghost' : undefined} aria-hidden={wasRefused ? true : undefined}>
              {PICK_LABEL}
            </span>
            <span className={wasRefused ? undefined : 'release-pick__ghost'} aria-hidden={wasRefused ? undefined : true}>
              {TRY_ANOTHER_SITE_LABEL}
            </span>
          </button>
        )}
        {wasRefused && row.keys.length > 1 ? (
          <span className="muted release-pick__note" role="status">
            {take.isPending && take.variables !== undefined && row.keys.includes(take.variables.key)
              ? GRABBING_TEXT
              : next !== null
                ? TRY_ANOTHER_SITE_NOTE
                : EVERY_SITE_REFUSED_TEXT}
          </span>
        ) : null}
      </div>
    );
  };

  return (
    <div className="repair-guide__step release-pick">
      {targetLine}
      <p className="fix-done__lead">{listLead(sections, label)}</p>
      {budgetLine ? <p className={canPick ? 'muted' : 'alert'}>{budgetLine}</p> : null}
      {sections.best ? (
        <section className="repair-guide__group" aria-label={BEST_CHOICE_LABEL}>
          <ul className="release-pick__rows">
            <li>
              <ReleaseCard
                row={sections.best}
                kind={kind}
                best={bestChoiceWhy(sections.best, kind)}
                action={rowAction(sections.best, true)}
              />
            </li>
          </ul>
        </section>
      ) : null}
      {sections.others.length > 0 ? (
        <section className="repair-guide__group">
          <h4>{OTHERS_HEADING}</h4>
          <ul className="release-pick__rows">
            {sections.others.map((row) => (
              <li key={row.key}>
                <ReleaseCard row={row} kind={kind} action={rowAction(row, false)} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {sections.blocked.length > 0 ? (
        <details className="release-pick__blocked">
          <summary>{blockedSummary(sections.blocked.length)}</summary>
          <p className="muted release-pick__note">{BLOCKED_NOTE}</p>
          <ul className="release-pick__rows">
            {sections.blocked.map((row) => (
              <li key={row.key}>
                <ReleaseCard
                  row={row}
                  kind={kind}
                  action={
                    <div className="release-pick__act">
                      <Link className="release-pick__ask" href={ticketHref(row)}>
                        {ASK_STAFF_LABEL}
                      </Link>
                    </div>
                  }
                />
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      {pickable === 0 ? (
        <p className="muted">
          {NOTHING_TO_PICK_NOTE} <Link href={ticketHref(null)}>{ASK_STAFF_LABEL}</Link> {ASK_STAFF_TAIL}
        </p>
      ) : null}
      <div className="form-actions">
        {backButton}
        {pickable === 0 ? doneButton : null}
      </div>
    </div>
  );
}

/**
 * One release: its title (wrapping anywhere on a phone), its plain facts, what its name says, its reasons (a hard one in
 * the alert tone, one the person may go past in a neutral one), and the *arr's own words under a small disclosure.
 */
function ReleaseCard({
  row,
  kind,
  best,
  action,
}: {
  row: ReleaseRow;
  kind: PickArrKind;
  /** The recommended row: why it is the best choice. */
  best?: string;
  action?: ReactNode;
}) {
  const evidence = evidenceText(row, kind);
  const reasons = displayReasons(row);
  const words = arrWords(row);
  return (
    <div className={`release-pick__row release-pick__row--${row.state}${best ? ' release-pick__row--best' : ''}`}>
      <div className="release-pick__tags">
        {best ? <span className="release-pick__tag release-pick__tag--best">{BEST_CHOICE_LABEL}</span> : null}
        <span className={`release-pick__tag release-pick__tag--${row.state}`}>{rowStateTag(row)}</span>
      </div>
      <span className="release-pick__title">{row.title}</span>
      {best ? <span className="release-pick__why">{best}</span> : null}
      <span className="release-pick__facts">{rowFacts(row).join(' · ')}</span>
      {evidence ? (
        <span className={`release-pick__evidence release-pick__evidence--${evidence.tone}`}>{evidence.text}</span>
      ) : null}
      {reasons.length > 0 ? (
        <ul className="release-pick__reasons">
          {reasons.map((r) => (
            <li key={`${r.code}:${r.text}`} className={`release-pick__reason release-pick__reason--${reasonTone(r)}`}>
              {r.text}
            </li>
          ))}
        </ul>
      ) : null}
      {words.length > 0 ? (
        <details className="release-pick__arr">
          <summary>{arrWordsLabel(kind)}</summary>
          <ul>
            {words.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </details>
      ) : null}
      {action ?? null}
    </div>
  );
}
