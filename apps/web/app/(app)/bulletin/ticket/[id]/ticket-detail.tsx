'use client';

// ADR-050 / DESIGN-012 D-12 (PLAN-034) — the ticket drill-in (owner requirement 6: "like clicking
// a movie"). The /library/[id] detail grammar reused wholesale:
//
//   1. BackLink → the Helpdesk wall.
//   2. `.detail-head` hero — the linked title's poster (or the category icon tile), the ticket
//      title, the state + category badges, the repair cue, the filed-by meta, an "Open in
//      Library" deep link, and — for STAFF (the `moderate` grant) — the transition buttons the
//      CURRENT state allows (the TICKET_TRANSITIONS matrix; nothing the server would refuse).
//      Every transition opens a multi-field Modal carrying the optional household-visible reason
//      (requirement 5) — ADR-014 (explanatory confirms are Modals, never window.confirm).
//   3. The report body.
//   4. History — the append-only event timeline (`.timeline`, the item-detail idiom): Filed +
//      every transition with actor, when, and note.
//   5. The reply thread + composer (ANY member with the messages view may reply — Q-02). The
//      composer sits BELOW the thread (a fixed block — nothing stacks above a list, ADR-015).
import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { trpc } from '@/lib/trpc-client';
import { Modal } from '@/components/modal';
import { BackLink } from '@/components/back-link';
import { MediaPoster, PosterBox, TicketCategoryTile } from '@/components/cards';
import { TicketCategoryIcon } from '@/components/ticket-glyphs';
import { describeMutationError } from '@/lib/app-error';
import { formatWhen } from '@/lib/media';
import {
  TICKET_CATEGORY_LABELS,
  TICKET_STATUS_LABELS,
  TICKET_TRANSITIONS_CLIENT,
  ticketStatusTone,
  transitionLabel,
  type MessageActionName,
  type TicketStatusName,
} from '@/lib/bulletin';

/** The static repair cue for the linked title (sourced server-side off fix_requests). An OPEN fix
 *  wins; else a count of recorded repairs; else nothing. A HINT — the item page owns the live
 *  phases (ADR-028). */
function RepairHint({ openFix, fixCount }: { openFix: boolean; fixCount: number }) {
  if (openFix) {
    return (
      <span className="repair-hint repair-hint--open" data-testid="repair-hint">
        <span className="repair-hint__dot" aria-hidden="true" />
        Fix in progress
      </span>
    );
  }
  if (fixCount > 0) {
    return (
      <span className="repair-hint repair-hint--past" data-testid="repair-hint">
        {fixCount} {fixCount === 1 ? 'repair' : 'repairs'} recorded
      </span>
    );
  }
  return null;
}

export function TicketDetail({
  ticketId,
  actions,
}: {
  ticketId: string;
  actions: MessageActionName[];
}) {
  const utils = trpc.useUtils();
  const canTransition = actions.includes('moderate');
  const detail = trpc.communication.tickets.detail.useQuery({ ticketId });

  // ── the staff transition Modal (state fixed per button; the optional note rides along) ──
  const [transitionTo, setTransitionTo] = useState<TicketStatusName | null>(null);
  const [note, setNote] = useState('');
  const [transitionError, setTransitionError] = useState<string | null>(null);
  const transition = trpc.communication.tickets.transition.useMutation({
    onError: (err: unknown) => setTransitionError(describeMutationError(err)),
    onSuccess: () => {
      setTransitionTo(null);
      setNote('');
      setTransitionError(null);
      void utils.communication.tickets.invalidate();
    },
  });
  const openTransition = (to: TicketStatusName) => {
    setNote('');
    setTransitionError(null);
    setTransitionTo(to);
  };

  // ── the reply composer (any member with the messages view — Q-02) ──
  const [reply, setReply] = useState('');
  const [replyError, setReplyError] = useState<string | null>(null);
  const postReply = trpc.communication.tickets.reply.useMutation({
    onError: (err: unknown) => setReplyError(describeMutationError(err)),
    onSuccess: () => {
      setReply('');
      setReplyError(null);
      void utils.communication.tickets.detail.invalidate({ ticketId });
      void utils.communication.tickets.list.invalidate();
    },
  });
  const submitReply = (e: FormEvent) => {
    e.preventDefault();
    if (reply.trim() === '') return;
    postReply.mutate({ ticketId, body: reply.trim() });
  };

  if (detail.isLoading) {
    return (
      <>
        <BackLink from="helpdesk" />
        <section className="card detail-head" aria-busy="true">
          <span className="detail-head__poster">
            <PosterBox />
          </span>
          <div className="detail-head__body">
            <span className="skeleton-line" />
            <span className="skeleton-line skeleton-line--short" />
          </div>
        </section>
      </>
    );
  }
  if (detail.error || detail.data === undefined) {
    return (
      <>
        <BackLink from="helpdesk" />
        <p className="alert" role="alert">
          Couldn’t load the ticket{detail.error ? `: ${detail.error.message}` : '.'}
        </p>
      </>
    );
  }
  if (!detail.data.found) {
    return (
      <>
        <BackLink from="helpdesk" />
        <section className="card empty-state" data-testid="ticket-not-found">
          <h1 className="page-title">Ticket not found</h1>
          <p className="muted">It may have been removed, or the link is stale.</p>
        </section>
      </>
    );
  }

  const { ticket, events, replies } = detail.data;
  const tone = ticketStatusTone(ticket.status);
  const allowedMoves = TICKET_TRANSITIONS_CLIENT[ticket.status];
  const modalTone = transitionTo === 'rejected' ? 'danger' : 'primary';

  return (
    <>
      <BackLink from="helpdesk" />

      <section className="card detail-head" data-testid="ticket-detail">
        <span className="detail-head__poster">
          {ticket.mediaItemId !== null ? (
            <MediaPoster
              posterUrl={ticket.mediaPosterUrl}
              kind={ticket.mediaArrKind ?? 'radarr'}
              alt=""
            />
          ) : (
            <TicketCategoryTile category={ticket.category} />
          )}
        </span>
        <div className="detail-head__body">
          <h1 className="detail-head__title" data-testid="ticket-detail-title">
            {ticket.title}
          </h1>
          <div className="media-card__badges">
            <span className={`badge badge--${tone}`} data-testid="ticket-detail-status">
              {TICKET_STATUS_LABELS[ticket.status]}
            </span>
            <span className="badge badge--muted tdetail-cat">
              <TicketCategoryIcon category={ticket.category} className="tdetail-cat__icon" />
              {TICKET_CATEGORY_LABELS[ticket.category]}
            </span>
            <RepairHint openFix={ticket.openFix} fixCount={ticket.fixCount} />
          </div>
          <p className="detail-head__meta muted">
            Filed by {ticket.authorName ?? '(deleted user)'} · {formatWhen(ticket.createdAt)}
            {ticket.lastActivityAt !== ticket.createdAt
              ? ` · updated ${formatWhen(ticket.lastActivityAt)}`
              : ''}
          </p>
          {ticket.mediaItemId !== null ? (
            <p className="detail-head__play">
              <Link className="btn sm" href={`/library/${ticket.mediaItemId}?from=bulletin`}>
                {ticket.mediaTitle ?? 'Open in Library'}
                {ticket.mediaYear !== null ? ` (${ticket.mediaYear})` : ''} — history & repairs
              </Link>
            </p>
          ) : null}
          {canTransition && allowedMoves.length > 0 ? (
            <div className="detail-head__actions" data-testid="ticket-transitions">
              {allowedMoves.map((to) => (
                <button
                  key={to}
                  type="button"
                  className={`btn sm${to === 'complete' ? ' primary' : ''}${to === 'rejected' ? ' danger' : ''}`}
                  data-testid={`ticket-move-${to}`}
                  disabled={transition.isPending}
                  onClick={() => openTransition(to)}
                >
                  {transitionLabel(ticket.status, to)}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      </section>

      <section className="card admin-section">
        <h2>Report</h2>
        <p className="tdetail-body" data-testid="ticket-detail-body">
          {ticket.body}
        </p>
      </section>

      <section className="card admin-section">
        <h2>History</h2>
        <ol className="timeline" data-testid="ticket-timeline">
          {events.map((ev) => (
            <li key={ev.id}>
              <span className="timeline__type">
                {ev.fromStatus === null
                  ? 'Filed'
                  : `${TICKET_STATUS_LABELS[ev.fromStatus as TicketStatusName]} → ${TICKET_STATUS_LABELS[ev.toStatus as TicketStatusName]}`}
              </span>
              <span className="timeline__detail">
                {ev.fromStatus === null ? 'by ' : 'by '}
                {ev.actorName ?? '(deleted user)'}
                {ev.note !== null && ev.note !== '' ? <> — “{ev.note}”</> : null}
              </span>
              <span className="muted timeline__when">{formatWhen(ev.createdAt)}</span>
            </li>
          ))}
        </ol>
      </section>

      <section className="card admin-section">
        <h2>
          Replies{replies.length > 0 ? <span className="muted"> · {replies.length}</span> : null}
        </h2>
        {replies.length === 0 ? (
          <p className="muted" data-testid="replies-empty">
            No replies yet — anyone in the household can chime in below.
          </p>
        ) : (
          <ol className="treply-list" data-testid="ticket-replies">
            {replies.map((r) => (
              <li key={r.id} className="treply" data-testid="ticket-reply">
                <span className="treply__meta">
                  <strong>{r.authorName ?? '(deleted user)'}</strong>
                  <span className="muted"> · {formatWhen(r.createdAt)}</span>
                </span>
                <p className="treply__body">{r.body}</p>
              </li>
            ))}
          </ol>
        )}
        <form className="treply-composer" data-testid="reply-composer" onSubmit={submitReply}>
          <label className="field">
            <span>Reply</span>
            <textarea
              rows={2}
              maxLength={8000}
              placeholder="Add what you know — device, time, what you saw…"
              data-testid="reply-body"
              value={reply}
              onChange={(e) => setReply(e.target.value)}
            />
          </label>
          {replyError !== null ? (
            <p className="alert" role="alert">
              {replyError}
            </p>
          ) : null}
          <div className="form-actions">
            <button
              type="submit"
              className="btn"
              data-testid="reply-send"
              disabled={postReply.isPending || reply.trim() === ''}
            >
              {postReply.isPending ? 'Sending…' : 'Reply'}
            </button>
          </div>
        </form>
      </section>

      {/* ADR-014 — the staff transition Modal: the target state is fixed by the button that
          opened it; the optional household-visible reason rides the same audited event. */}
      <Modal
        open={transitionTo !== null}
        title={
          transitionTo !== null ? `${transitionLabel(ticket.status, transitionTo)}?` : 'Transition'
        }
        onClose={() => {
          if (!transition.isPending) setTransitionTo(null);
        }}
        banner={
          transitionError !== null ? (
            <p className="alert" role="alert">
              {transitionError}
            </p>
          ) : null
        }
      >
        <form
          className="admin-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (transitionTo === null) return;
            transition.mutate({
              ticketId,
              toStatus: transitionTo,
              ...(note.trim() !== '' ? { note: note.trim() } : {}),
            });
          }}
        >
          <p className="muted">
            {transitionTo !== null
              ? `${TICKET_STATUS_LABELS[ticket.status]} → ${TICKET_STATUS_LABELS[transitionTo]}. `
              : ''}
            The move lands in the ticket’s history; the reason (optional) is visible to the whole
            household.
          </p>
          <label className="field">
            <span>Reason / comment (optional)</span>
            <textarea
              rows={2}
              maxLength={1000}
              placeholder={
                transitionTo === 'rejected'
                  ? 'e.g. Site bug — filed on GitHub instead'
                  : transitionTo === 'complete'
                    ? 'e.g. Regrabbed a clean copy — try it now'
                    : 'Optional'
              }
              data-testid="transition-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </label>
          <div className="form-actions">
            <button
              type="submit"
              className={`btn ${modalTone}`}
              data-testid="transition-apply"
              disabled={transition.isPending}
            >
              {transition.isPending
                ? 'Applying…'
                : transitionTo !== null
                  ? transitionLabel(ticket.status, transitionTo)
                  : 'Apply'}
            </button>
            <button
              type="button"
              className="btn"
              disabled={transition.isPending}
              onClick={() => setTransitionTo(null)}
            >
              Cancel
            </button>
          </div>
        </form>
      </Modal>
    </>
  );
}
