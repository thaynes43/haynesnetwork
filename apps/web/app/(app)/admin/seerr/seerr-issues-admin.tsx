'use client';

// ADR-111 C-02 / ADR-112 C-02, C-03 / DESIGN-055 D-10, D-12 (PLAN-077 P3) — the admin Seerr issues list: each report
// with its title and episode, the reporter (admins only), the fix-it-yourself link, the repairs the app's own records
// link to it (which tool, by whom, how it ended), and the staff note. "Mark fixed by hand" asks for a note naming the
// missing capability (D-12 working practice). Nothing is scored (ADR-112 C-01); Seerr is never written (P7 does that).
//
// Hard rule 8: the note is a multi-field form, so it opens in a Modal; clearing a mark is the ConfirmButton two-step.
// Hard rule 9: nothing moves on interaction; the copy-link status reserves its width. Token colours only.
import Link from 'next/link';
import { useState } from 'react';
import { ConfirmButton } from '@hnet/ui';
import { trpc } from '@/lib/trpc-client';
import { describeMutationError } from '@/lib/app-error';
import { Modal } from '@/components/modal';
import { ARR_KIND_LABELS, formatWhen, type ArrKindName } from '@/lib/media';
import { issueKicker, seerrIssueUrl, seerrLinkPath, SEERR_URL } from '@/lib/seerr-issues';
import type { RouterOutputs } from '@/lib/trpc-client';

type AdminIssue = RouterOutputs['seerrIssues']['adminList']['items'][number];
type Filter = 'open' | 'all';

const REPAIR_STATUS_WORDS: Record<string, string> = {
  pending: 'Pending',
  actioned: 'Running',
  search_triggered: 'Searching',
  searched: 'Searched',
  completed: 'Completed',
  refused: 'Refused',
  failed: 'Failed',
  timed_out: 'Timed out',
  closed_manually: 'Closed by staff',
};

function repairTone(status: string): string {
  if (status === 'completed') return 'ok';
  if (status === 'failed' || status === 'timed_out' || status === 'refused') return 'danger';
  if (status === 'closed_manually') return 'muted';
  return 'info';
}

function CopyLink({ url }: { url: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  return (
    <span className="seerr-admin__link">
      <code className="seerr-admin__url">{url}</code>
      <button
        type="button"
        className="btn sm"
        onClick={() => {
          void navigator.clipboard?.writeText(url).then(
            () => setState('copied'),
            () => setState('failed'),
          );
        }}
      >
        Copy link
      </button>
      <span className="seerr-admin__copied muted" aria-live="polite">
        {state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed' : ''}
      </span>
    </span>
  );
}

function NoteDialog({
  issue,
  onClose,
  onSaved,
}: {
  issue: AdminIssue;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [note, setNote] = useState(issue.staff.note ?? '');
  const [error, setError] = useState<string | null>(null);
  const save = trpc.seerrIssues.setStaffNote.useMutation({
    onError: (err) => setError(describeMutationError(err)),
    onSuccess: () => {
      onSaved();
      onClose();
    },
  });
  const empty = note.trim().length === 0;
  return (
    <Modal
      open
      title={issue.staff.fixedByHand ? 'Edit the staff note' : 'Mark fixed by hand'}
      onClose={onClose}
      banner={error ? <p className="alert">{error}</p> : null}
    >
      <form
        className="admin-form seerr-admin__form"
        onSubmit={(e) => {
          e.preventDefault();
          if (empty) return;
          setError(null);
          save.mutate({ seerrIssueId: issue.seerrIssueId, note: note.trim(), fixedByHand: true });
        }}
      >
        <p className="muted">
          Report {issue.seerrIssueId}
          {issue.item ? ` on ${issue.item.title}` : ''} ({issueKicker(issue)}).
        </p>
        <label className="field">
          <span>
            What was done by hand, and what was missing <span className="req">*</span>
          </span>
          <textarea
            value={note}
            maxLength={2000}
            rows={5}
            onChange={(e) => setNote(e.target.value)}
            placeholder="For example: imported the stuck download by hand. Missing: Force Search could not import a file named as an episode range."
          />
          <span className="field-hint">
            Name the capability the self-service tools lacked, so it can be added to the plan.
          </span>
        </label>
        <div className="form-actions">
          <button type="submit" className="btn primary" disabled={empty || save.isPending}>
            {issue.staff.fixedByHand ? 'Save note' : 'Mark fixed by hand'}
          </button>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
        </div>
      </form>
    </Modal>
  );
}

function IssueCard({
  issue,
  linkOrigin,
  onEdit,
  onCleared,
}: {
  issue: AdminIssue;
  linkOrigin: string;
  onEdit: () => void;
  onCleared: () => void;
}) {
  const clear = trpc.seerrIssues.setStaffNote.useMutation({ onSuccess: onCleared });
  return (
    <li className="card seerr-admin__issue" data-testid="seerr-admin-issue" data-issue={issue.seerrIssueId}>
      <div className="seerr-admin__head">
        <span className="seerr-admin__id">#{issue.seerrIssueId}</span>
        <span className="seerr-report__kicker">{issueKicker(issue)}</span>
        {issue.removed ? (
          <span className="badge badge--muted">Removed in Seerr</span>
        ) : (
          <span className={`badge badge--${issue.status === 'open' ? 'warn' : 'ok'}`}>
            {issue.status === 'open' ? 'Open' : 'Resolved'}
          </span>
        )}
        {issue.staff.fixedByHand ? <span className="badge badge--info">Fixed by hand</span> : null}
      </div>
      <p className="seerr-admin__title">
        {issue.item ? (
          <>
            <Link className="row-link" href={`/library/${issue.item.id}`}>
              {issue.item.title}
            </Link>{' '}
            <span className="badge badge--muted">{ARR_KIND_LABELS[issue.item.arrKind as ArrKindName] ?? issue.item.arrKind}</span>
          </>
        ) : (
          <span className="muted">Not in the Library</span>
        )}
      </p>
      {issue.message ? <blockquote className="seerr-report__message">{issue.message}</blockquote> : null}
      <p className="seerr-admin__meta muted">
        Reported by {issue.reporterName ?? 'an unknown Seerr user'}
        {issue.reporterAccount ? ` (account: ${issue.reporterAccount.displayName})` : ' (no haynesnetwork account yet)'} on{' '}
        {formatWhen(issue.reportedAt)}. {issue.commentCount} {issue.commentCount === 1 ? 'comment' : 'comments'}.{' '}
        <a href={seerrIssueUrl(issue.seerrIssueId)} target="_blank" rel="noreferrer">
          Open in Seerr
        </a>
      </p>
      <div className="seerr-admin__row">
        <span className="seerr-admin__label">Fix-it-yourself link</span>
        <CopyLink url={`${linkOrigin}${seerrLinkPath(issue.seerrIssueId)}`} />
      </div>
      <div className="seerr-admin__row">
        <span className="seerr-admin__label">Repairs on this title since the report</span>
        {issue.linkedRepairs.length === 0 ? (
          <span className="muted">None yet.</span>
        ) : (
          <ul className="seerr-admin__repairs">
            {issue.linkedRepairs.map((r) => (
              <li key={`${r.kind}:${r.id}`} className="seerr-admin__repair">
                <span className="seerr-admin__repair-what">{r.what}</span>
                {r.targetLabel ? <span className="muted">{r.targetLabel}</span> : null}
                <span className={`badge badge--${repairTone(r.status)}`}>{REPAIR_STATUS_WORDS[r.status] ?? r.status}</span>
                <span className="muted">
                  {r.requesterName ?? 'a removed account'}
                  {r.requesterIsAdmin ? ' (staff)' : ''}, {formatWhen(r.at)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="seerr-admin__row">
        <span className="seerr-admin__label">Staff note</span>
        {issue.staff.note ? (
          <div className="seerr-admin__note">
            <p>{issue.staff.note}</p>
            {issue.staff.fixedByHand ? (
              <p className="muted">
                Marked fixed by hand{issue.staff.byName ? ` by ${issue.staff.byName}` : ''}
                {issue.staff.at ? ` on ${formatWhen(issue.staff.at)}` : ''}.
              </p>
            ) : null}
          </div>
        ) : (
          <span className="muted">None.</span>
        )}
        <div className="form-actions">
          <button type="button" className="btn sm" onClick={onEdit}>
            {issue.staff.fixedByHand ? 'Edit note' : 'Mark fixed by hand'}
          </button>
          {issue.staff.fixedByHand ? (
            <ConfirmButton
              className="btn btn--sm"
              label="Clear the mark"
              data-testid="seerr-admin-clear"
              restingAriaLabel={`Clear the fixed-by-hand mark on report ${issue.seerrIssueId} — click twice to confirm`}
              confirmAriaLabel={`Confirm clearing the fixed-by-hand mark on report ${issue.seerrIssueId}`}
              disabled={clear.isPending}
              onConfirm={() => clear.mutate({ seerrIssueId: issue.seerrIssueId, note: null, fixedByHand: false })}
            />
          ) : null}
        </div>
      </div>
    </li>
  );
}

export function SeerrIssuesAdmin({ linkOrigin }: { linkOrigin: string }) {
  const [filter, setFilter] = useState<Filter>('open');
  const [editing, setEditing] = useState<AdminIssue | null>(null);
  const utils = trpc.useUtils();
  const list = trpc.seerrIssues.adminList.useInfiniteQuery(
    { filter, limit: 25 },
    { getNextPageParam: (last) => last.nextCursor ?? undefined, placeholderData: (prev) => prev },
  );
  const rows = list.data?.pages.flatMap((p) => p.items) ?? [];
  const refresh = () => void utils.seerrIssues.adminList.invalidate();

  return (
    <>
      <h1>Seerr issues</h1>
      <p className="seerr-admin__lead muted">
        Every problem reported in <a href={SEERR_URL}>Seerr</a>, with the repairs made on haynesnetwork since. Work each
        new report through the Library&apos;s own tools first, the way a member would. When none of them can fix it,
        fix it by hand and note what was missing. Reports sync from Seerr every ten minutes.
      </p>
      <div className="library-filters admin-filterbar">
        <div className="seg" role="group" aria-label="Which reports">
          {(['open', 'all'] as const).map((value) => (
            <button
              key={value}
              type="button"
              className={filter === value ? 'is-active' : undefined}
              onClick={() => setFilter(value)}
            >
              {value === 'open' ? 'Open' : 'All'}
            </button>
          ))}
        </div>
      </div>

      {list.isLoading ? <p className="muted">Loading reports…</p> : null}
      {list.error ? (
        <p className="alert" role="alert">
          Failed to load the reports: {list.error.message}
        </p>
      ) : null}
      {!list.isLoading && !list.error && rows.length === 0 ? (
        <p className="muted">{filter === 'open' ? 'No open reports.' : 'No reports yet.'}</p>
      ) : null}

      {rows.length > 0 ? (
        <ul className="seerr-admin__list">
          {rows.map((issue) => (
            <IssueCard
              key={issue.seerrIssueId}
              issue={issue}
              linkOrigin={linkOrigin}
              onEdit={() => setEditing(issue)}
              onCleared={refresh}
            />
          ))}
        </ul>
      ) : null}

      {list.hasNextPage ? (
        <div className="load-more">
          <button
            type="button"
            className="btn"
            disabled={list.isFetchingNextPage}
            onClick={() => void list.fetchNextPage()}
          >
            {list.isFetchingNextPage ? 'Loading…' : 'Load more'}
          </button>
        </div>
      ) : null}

      {editing ? <NoteDialog issue={editing} onClose={() => setEditing(null)} onSaved={refresh} /> : null}
    </>
  );
}
