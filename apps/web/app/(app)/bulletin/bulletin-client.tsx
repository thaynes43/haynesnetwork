'use client';

// ADR-026 / DESIGN-012 D-08 — the /bulletin section UI over the communication.* wire
// contracts (D-05/D-06). Two sub-tabs:
//
// - FEED — the aggregated third-party notification browse (Seerr / Tautulli / Maintainerr),
//   newest-first keyset pages with simple param filters (source, media link — Q-05: no full
//   filter-engine port; the segs swap the result set in place, ADR-015).
// - MESSAGES — the durable board: a composer (the `post` grant; subject optional, body
//   required, optional Media Item link via a small library search) above the newest-first
//   list. The author edits their OWN visible message through a Modal (multi-field, ADR-014);
//   moderators (the `moderate` grant) hide/delete via inline two-step ConfirmButtons
//   (destructive, ADR-014 — never window.confirm), restore via a plain button (protective),
//   and attach a status+note through the multi-field Triage Modal. Non-moderators never see
//   hidden/deleted rows or the moderation trail (server-enforced; the UI simply has nothing
//   to render).
//
// ADR-015 (hard rule 9): interactions recolor, never reflow — the ConfirmButton reserves its
// armed width, list refetches dim in place (placeholderData), the composer/media-picker
// results render in an overlay popover, and modals overlay rather than reorient the page.
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useRef, useState, type FormEvent } from 'react';
import { ConfirmButton } from '@hnet/ui';
import { trpc } from '@/lib/trpc-client';
import { Modal } from '@/components/modal';
import { KindIcon } from '@/components/kind-icon';
import { describeMutationError } from '@/lib/app-error';
import { ARR_KIND_LABELS, formatWhen, type ArrKindName } from '@/lib/media';
import {
  FEED_SOURCE_LABELS,
  FEED_SOURCE_NAMES,
  MESSAGE_STATUS_LABELS,
  messageStatusTone,
  type FeedSourceName,
  type MessageActionName,
  type MessageStatusName,
} from '@/lib/bulletin';

export interface BulletinAccess {
  level: 'edit' | 'read_only';
  actions: MessageActionName[];
}

const BULLETIN_TABS = [
  { key: 'feed', label: 'Feed' },
  { key: 'messages', label: 'Messages' },
] as const;
type TabKey = (typeof BULLETIN_TABS)[number]['key'];

function resolveTab(raw: string | null): TabKey {
  return BULLETIN_TABS.some((t) => t.key === raw) ? (raw as TabKey) : 'feed';
}

function kindLabel(arrKind: string | null): string | null {
  return arrKind !== null && arrKind in ARR_KIND_LABELS
    ? ARR_KIND_LABELS[arrKind as ArrKindName]
    : null;
}

/** The media link cell/chip both tabs share: a Library link when the event/message resolved
 *  to a ledger item, else an em dash. */
function MediaLink({
  mediaItemId,
  mediaTitle,
}: {
  mediaItemId: string | null;
  mediaTitle: string | null;
}) {
  if (mediaItemId === null) return <span className="muted">—</span>;
  return (
    <Link className="row-link" href={`/library/${mediaItemId}`}>
      {mediaTitle ?? 'Media item'}
    </Link>
  );
}

/** The static repair-status cue shown on a linked message's media chip — sourced server-side
 *  (messages.list) from fix_requests for the page's linked ids. An OPEN fix wins; else a count
 *  of recorded repairs; else nothing. This is a HINT, not a live view — the item page owns the
 *  live phases (ADR-028). */
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

/** DESIGN-012 addendum — the prominent, clearly-clickable media chip on a message card. It deep-
 *  links to the item page (/library/[id] — where History + Fix live) so a reader can jump straight
 *  to a referenced title's repair history. Poster thumb when the item has one (authed proxy), else
 *  the kind icon; the thumb box RESERVES its space so a late/failed image never reflows (ADR-015).
 *  The repair cue rides along, static. */
function MessageMediaChip({
  mediaItemId,
  mediaTitle,
  mediaArrKind,
  mediaYear,
  mediaPosterUrl,
  openFix,
  fixCount,
}: {
  mediaItemId: string;
  mediaTitle: string | null;
  mediaArrKind: string | null;
  mediaYear: number | null;
  mediaPosterUrl: string | null;
  openFix: boolean;
  fixCount: number;
}) {
  const [imgFailed, setImgFailed] = useState(false);
  const kind = mediaArrKind ?? 'radarr';
  const label = kindLabel(mediaArrKind);
  const showImage = mediaPosterUrl !== null && !imgFailed;
  return (
    <Link
      className="media-chip"
      href={`/library/${mediaItemId}`}
      data-testid="message-media-chip"
      aria-label={`Open ${mediaTitle ?? 'the media item'} — view its history and repairs`}
    >
      <span className="media-chip__thumb" aria-hidden="true">
        {showImage ? (
          // eslint-disable-next-line @next/next/no-img-element -- authed proxy route, not a static asset
          <img
            src={mediaPosterUrl}
            alt=""
            loading="lazy"
            decoding="async"
            onError={() => setImgFailed(true)}
          />
        ) : (
          <KindIcon kind={kind} className="media-chip__icon" />
        )}
      </span>
      <span className="media-chip__text">
        <span className="media-chip__title">
          {mediaTitle ?? 'Media item'}
          {mediaYear !== null ? <span className="media-chip__year"> ({mediaYear})</span> : null}
        </span>
        <span className="media-chip__meta">
          {label !== null ? <span className="media-chip__kind">{label}</span> : null}
          <RepairHint openFix={openFix} fixCount={fixCount} />
        </span>
      </span>
    </Link>
  );
}

// ── Feed ─────────────────────────────────────────────────────────────────────────────────

const MEDIA_FILTERS = [
  { key: 'any', label: 'All events' },
  { key: 'linked', label: 'Linked to media' },
  { key: 'none', label: 'Unlinked' },
] as const;
type MediaFilter = (typeof MEDIA_FILTERS)[number]['key'];

function FeedTab() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // URL-carried filters (?src / ?media) — deep-linkable, same convention as /trash.
  const srcParam = searchParams.get('src');
  const source = (FEED_SOURCE_NAMES as readonly string[]).includes(srcParam ?? '')
    ? (srcParam as FeedSourceName)
    : undefined;
  const mediaParam = searchParams.get('media');
  const mediaFilter: MediaFilter =
    mediaParam === 'linked' || mediaParam === 'none' ? mediaParam : 'any';

  const patchParams = (patch: Record<string, string | null>) => {
    const params = new URLSearchParams(window.location.search);
    for (const [k, v] of Object.entries(patch)) {
      params.delete(k);
      if (v !== null && v !== '') params.set(k, v);
    }
    const qs = params.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  };

  const feed = trpc.communication.feed.useInfiniteQuery(
    {
      ...(source !== undefined ? { source } : {}),
      ...(mediaFilter === 'linked' ? { hasMedia: true } : {}),
      ...(mediaFilter === 'none' ? { hasMedia: false } : {}),
      limit: 50,
    },
    {
      getNextPageParam: (last) => last.nextCursor ?? undefined,
      // Filter swaps keep the previous rows rendered (dimmed) while the refetch resolves —
      // results replace in place, the layout never jumps (ADR-015).
      placeholderData: (prev) => prev,
    },
  );
  const rows = feed.data?.pages.flatMap((p) => p.items) ?? [];
  const refreshing = feed.isPlaceholderData && feed.isFetching;

  return (
    <>
      <div className="library-filters admin-filterbar">
        <div className="seg" role="group" aria-label="Source">
          <button
            type="button"
            className={source === undefined ? 'is-active' : undefined}
            onClick={() => patchParams({ src: null })}
          >
            All sources
          </button>
          {FEED_SOURCE_NAMES.map((s) => (
            <button
              key={s}
              type="button"
              className={source === s ? 'is-active' : undefined}
              onClick={() => patchParams({ src: s })}
            >
              {FEED_SOURCE_LABELS[s]}
            </button>
          ))}
        </div>
        <div className="seg" role="group" aria-label="Media link">
          {MEDIA_FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              className={mediaFilter === f.key ? 'is-active' : undefined}
              onClick={() => patchParams({ media: f.key === 'any' ? null : f.key })}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {feed.isLoading ? <p className="muted">Loading the feed…</p> : null}
      {feed.error ? (
        <p className="alert" role="alert">
          Couldn’t load the feed: {feed.error.message}
        </p>
      ) : null}

      {!feed.isLoading && !feed.error && rows.length === 0 ? (
        <p className="muted" data-testid="feed-empty">
          No events yet — Seerr requests, Tautulli playback, and Maintainerr cleanup land here as
          the services report them.
        </p>
      ) : rows.length > 0 ? (
        <div className={`bulletin-feedwrap${refreshing ? ' is-refreshing' : ''}`}>
          <table className="admin-table bulletin-feed" aria-busy={refreshing} data-testid="bulletin-feed">
            <thead>
              <tr>
                <th>When</th>
                <th>Source</th>
                <th>Event</th>
                <th className="col-what">What</th>
                <th>Media</th>
                <th>Who</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((n) => (
                <tr key={n.id} data-testid="feed-row">
                  <td data-label="When" className="bulletin-when">
                    {formatWhen(n.occurredAt)}
                  </td>
                  <td data-label="Source">
                    <span className="badge badge--muted">
                      {FEED_SOURCE_LABELS[n.source as FeedSourceName] ?? n.source}
                    </span>
                  </td>
                  <td data-label="Event" className="bulletin-event">
                    {n.eventType}
                  </td>
                  <td data-label="What" className="col-what">
                    <span className="bulletin-what">
                      <strong>{n.title}</strong>
                      {n.body !== '' ? <span className="muted"> — {n.body}</span> : null}
                    </span>
                  </td>
                  <td data-label="Media">
                    <MediaLink mediaItemId={n.mediaItemId} mediaTitle={n.mediaTitle} />
                    {n.mediaArrKind !== null && kindLabel(n.mediaArrKind) !== null ? (
                      <span className="muted"> · {kindLabel(n.mediaArrKind)}</span>
                    ) : null}
                  </td>
                  <td data-label="Who">
                    {n.attributedUserName ?? <span className="muted">unattributed</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {feed.hasNextPage ? (
        <div className="load-more">
          <button
            type="button"
            className="btn"
            disabled={feed.isFetchingNextPage}
            onClick={() => void feed.fetchNextPage()}
          >
            {feed.isFetchingNextPage ? 'Loading…' : 'Load more'}
          </button>
        </div>
      ) : null}
    </>
  );
}

// ── Messages: the composer ───────────────────────────────────────────────────────────────

interface MediaPick {
  id: string;
  title: string;
  arrKind: string;
}

/** Small library search-select for the optional Media Item link (ledger.search is available to
 *  every signed-in user). Results render in an overlay popover — nothing below reflows. */
function MediaPicker({
  selected,
  onSelect,
}: {
  selected: MediaPick | null;
  onSelect: (pick: MediaPick | null) => void;
}) {
  const [query, setQuery] = useState('');
  const trimmed = query.trim();
  const search = trpc.ledger.search.useQuery(
    { query: trimmed, limit: 8 },
    { enabled: trimmed.length >= 2 },
  );

  if (selected !== null) {
    return (
      <span className="chips" data-testid="composer-media-picked">
        <span className="chip">
          {selected.title}
          {kindLabel(selected.arrKind) !== null ? (
            <span className="muted"> · {kindLabel(selected.arrKind)}</span>
          ) : null}
          <button
            type="button"
            className="chip__remove"
            aria-label={`Remove the link to ${selected.title}`}
            onClick={() => onSelect(null)}
          >
            ×
          </button>
        </span>
      </span>
    );
  }

  const results = trimmed.length >= 2 ? (search.data?.items ?? []) : [];
  return (
    <span className="bulletin-mediapick">
      <input
        type="search"
        placeholder="Search the library…"
        aria-label="Link a media item (search the library)"
        data-testid="composer-media-search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {trimmed.length >= 2 ? (
        <div className="bulletin-mediapick__pop" role="listbox" aria-label="Library matches">
          {search.isLoading ? (
            <span className="muted bulletin-mediapick__note">Searching…</span>
          ) : results.length === 0 ? (
            <span className="muted bulletin-mediapick__note">No matches.</span>
          ) : (
            results.map((item) => (
              <button
                key={item.id}
                type="button"
                role="option"
                aria-selected="false"
                className="bulletin-mediapick__opt"
                onClick={() => {
                  onSelect({ id: item.id, title: item.title, arrKind: item.arrKind });
                  setQuery('');
                }}
              >
                {item.title}
                {item.year !== null ? <span className="muted"> ({item.year})</span> : null}
                {kindLabel(item.arrKind) !== null ? (
                  <span className="muted"> · {kindLabel(item.arrKind)}</span>
                ) : null}
              </button>
            ))
          )}
        </div>
      ) : null}
    </span>
  );
}

function Composer({ onPosted }: { onPosted: () => void }) {
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [media, setMedia] = useState<MediaPick | null>(null);
  const [error, setError] = useState<string | null>(null);

  const post = trpc.communication.messages.post.useMutation({
    onError: (err: unknown) => setError(describeMutationError(err)),
    onSuccess: () => {
      setError(null);
      setSubject('');
      setBody('');
      setMedia(null);
      onPosted();
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (body.trim() === '') return;
    post.mutate({
      ...(subject.trim() !== '' ? { subject: subject.trim() } : {}),
      body: body.trim(),
      ...(media !== null ? { mediaItemId: media.id } : {}),
    });
  };

  return (
    <form className="card bulletin-composer" data-testid="message-composer" onSubmit={submit}>
      <label className="field">
        <span>Subject</span>
        <input
          maxLength={200}
          placeholder="Optional"
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
        />
      </label>
      <label className="field">
        <span>
          Message{' '}
          <span className="req" aria-hidden="true">
            *
          </span>
        </span>
        <textarea
          required
          rows={3}
          maxLength={8000}
          placeholder="Broken media, a request, or anything for the household…"
          value={body}
          onChange={(e) => setBody(e.target.value)}
        />
      </label>
      <div className="field">
        <span>Link the title (optional) — helps others check its history and repairs</span>
        <MediaPicker selected={media} onSelect={setMedia} />
      </div>
      {error !== null ? (
        <p className="alert" role="alert">
          {error}
        </p>
      ) : null}
      <div className="form-actions">
        <button
          type="submit"
          className="btn primary"
          data-testid="message-post"
          disabled={post.isPending || body.trim() === ''}
        >
          {post.isPending ? 'Posting…' : 'Post message'}
        </button>
      </div>
    </form>
  );
}

// ── Messages: the board ──────────────────────────────────────────────────────────────────

interface MessageItem {
  id: string;
  authorUserId: string;
  authorName: string | null;
  subject: string | null;
  body: string;
  mediaItemId: string | null;
  mediaTitle: string | null;
  mediaArrKind: string | null;
  mediaYear: number | null;
  mediaPosterUrl: string | null;
  openFix: boolean;
  fixCount: number;
  status: MessageStatusName;
  createdAt: string;
  editedAt: string | null;
  moderatedBy: string | null;
  moderatedAt: string | null;
  moderationNote: string | null;
}

const STATUS_FILTERS = [undefined, 'visible', 'hidden', 'deleted'] as const;
type StatusFilter = (typeof STATUS_FILTERS)[number];

function MessagesTab({ access, viewerId }: { access: BulletinAccess; viewerId: string }) {
  const utils = trpc.useUtils();
  const canPost = access.actions.includes('post');
  const canModerate = access.actions.includes('moderate');

  // Moderator-only status filter (non-moderators only ever receive visible rows — D-06).
  const [status, setStatus] = useState<StatusFilter>(undefined);
  const list = trpc.communication.messages.list.useInfiniteQuery(
    { ...(canModerate && status !== undefined ? { status } : {}), limit: 50 },
    { getNextPageParam: (last) => last.nextCursor ?? undefined, placeholderData: (prev) => prev },
  );
  const rows = (list.data?.pages.flatMap((p) => p.items) ?? []) as MessageItem[];
  const refreshing = list.isPlaceholderData && list.isFetching;

  const invalidate = () => void utils.communication.messages.list.invalidate();

  const [rowError, setRowError] = useState<string | null>(null);
  const moderate = trpc.communication.messages.moderate.useMutation({
    onError: (err: unknown) => setRowError(describeMutationError(err)),
    onSuccess: () => {
      setRowError(null);
      invalidate();
    },
  });

  // ── Edit (author-only, Modal — multi-field, ADR-014) ──
  const [editing, setEditing] = useState<MessageItem | null>(null);
  const [editSubject, setEditSubject] = useState('');
  const [editBody, setEditBody] = useState('');
  const [editError, setEditError] = useState<string | null>(null);
  const edit = trpc.communication.messages.edit.useMutation({
    onError: (err: unknown) => setEditError(describeMutationError(err)),
    onSuccess: () => {
      setEditing(null);
      setEditError(null);
      invalidate();
    },
  });
  const openEdit = (m: MessageItem) => {
    setEditSubject(m.subject ?? '');
    setEditBody(m.body);
    setEditError(null);
    setEditing(m);
  };

  // ── Triage (moderators, Modal — the multi-field status + note transition) ──
  const [triaging, setTriaging] = useState<MessageItem | null>(null);
  const [triageStatus, setTriageStatus] = useState<MessageStatusName>('hidden');
  const [triageNote, setTriageNote] = useState('');
  const [triageError, setTriageError] = useState<string | null>(null);
  const triage = trpc.communication.messages.moderate.useMutation({
    onError: (err: unknown) => setTriageError(describeMutationError(err)),
    onSuccess: () => {
      setTriaging(null);
      setTriageError(null);
      invalidate();
    },
  });
  const openTriage = (m: MessageItem) => {
    setTriageStatus(m.status === 'visible' ? 'hidden' : m.status);
    setTriageNote(m.moderationNote ?? '');
    setTriageError(null);
    setTriaging(m);
  };

  const busy = moderate.isPending || triage.isPending;

  return (
    <>
      {canPost ? (
        <Composer onPosted={invalidate} />
      ) : (
        <p className="muted" data-testid="composer-absent">
          You can read the board. Posting needs the post permission — ask an admin if you need it.
        </p>
      )}

      {canModerate ? (
        <div className="library-filters admin-filterbar">
          <div className="seg" role="group" aria-label="Status">
            {STATUS_FILTERS.map((value) => (
              <button
                key={value ?? 'all'}
                type="button"
                className={status === value ? 'is-active' : undefined}
                onClick={() => setStatus(value)}
              >
                {value === undefined ? 'All' : MESSAGE_STATUS_LABELS[value]}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {rowError !== null ? (
        <p className="alert" role="alert">
          {rowError}
        </p>
      ) : null}
      {list.isLoading ? <p className="muted">Loading messages…</p> : null}
      {list.error ? (
        <p className="alert" role="alert">
          Couldn’t load the board: {list.error.message}
        </p>
      ) : null}

      {!list.isLoading && !list.error && rows.length === 0 ? (
        <p className="muted" data-testid="messages-empty">
          No messages yet{canPost ? ' — start the board with the form above.' : '.'}
        </p>
      ) : (
        <ol
          className={`bulletin-board${refreshing ? ' is-refreshing' : ''}`}
          aria-busy={refreshing}
          data-testid="bulletin-messages"
        >
          {rows.map((m) => {
            const mine = m.authorUserId === viewerId;
            return (
              <li key={m.id}>
                <article className="card bulletin-msg" data-status={m.status} data-testid="message-card">
                  <header className="bulletin-msg__head">
                    <span className="bulletin-msg__meta">
                      <strong>{m.authorName ?? '(deleted user)'}</strong>
                      <span className="muted"> · {formatWhen(m.createdAt)}</span>
                      {m.editedAt !== null ? <span className="muted"> · edited</span> : null}
                      {m.status !== 'visible' ? (
                        <span className={`badge badge--${messageStatusTone(m.status)}`}>
                          {MESSAGE_STATUS_LABELS[m.status]}
                        </span>
                      ) : null}
                    </span>
                    <span className="row-actions bulletin-msg__actions">
                      {mine && canPost && m.status === 'visible' ? (
                        <button
                          type="button"
                          className="btn sm"
                          data-testid="message-edit"
                          disabled={busy}
                          onClick={() => openEdit(m)}
                        >
                          Edit
                        </button>
                      ) : null}
                      {canModerate ? (
                        <>
                          {m.status === 'visible' ? (
                            <ConfirmButton
                              className="btn sm"
                              data-testid="message-hide"
                              label="Hide"
                              disabled={busy}
                              restingAriaLabel={`Hide this message from the board — content is preserved — click twice to confirm`}
                              confirmAriaLabel="Confirm hide this message"
                              onConfirm={() => moderate.mutate({ messageId: m.id, status: 'hidden' })}
                            />
                          ) : (
                            <button
                              type="button"
                              className="btn sm"
                              data-testid="message-restore"
                              disabled={busy}
                              onClick={() => moderate.mutate({ messageId: m.id, status: 'visible' })}
                            >
                              Restore
                            </button>
                          )}
                          {m.status !== 'deleted' ? (
                            <ConfirmButton
                              className="btn sm danger"
                              data-testid="message-delete"
                              label="Delete"
                              disabled={busy}
                              restingAriaLabel={`Delete this message — soft delete, content preserved for audit — click twice to confirm`}
                              confirmAriaLabel="Confirm delete this message"
                              onConfirm={() => moderate.mutate({ messageId: m.id, status: 'deleted' })}
                            />
                          ) : null}
                          <button
                            type="button"
                            className="btn sm"
                            data-testid="message-triage"
                            disabled={busy}
                            onClick={() => openTriage(m)}
                          >
                            Triage…
                          </button>
                        </>
                      ) : null}
                    </span>
                  </header>
                  {m.subject !== null && m.subject !== '' ? (
                    <p className="bulletin-msg__subject">{m.subject}</p>
                  ) : null}
                  <p className="bulletin-msg__body">{m.body}</p>
                  {m.mediaItemId !== null ? (
                    <div className="bulletin-msg__media">
                      <MessageMediaChip
                        mediaItemId={m.mediaItemId}
                        mediaTitle={m.mediaTitle}
                        mediaArrKind={m.mediaArrKind}
                        mediaYear={m.mediaYear}
                        mediaPosterUrl={m.mediaPosterUrl}
                        openFix={m.openFix}
                        fixCount={m.fixCount}
                      />
                    </div>
                  ) : null}
                  {canModerate && m.moderatedAt !== null ? (
                    <p className="muted bulletin-msg__trail" data-testid="message-trail">
                      Moderated {formatWhen(m.moderatedAt)}
                      {m.moderationNote !== null && m.moderationNote !== ''
                        ? ` — “${m.moderationNote}”`
                        : ''}
                    </p>
                  ) : null}
                </article>
              </li>
            );
          })}
        </ol>
      )}

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

      {/* ADR-014 — the author's Edit Modal (multi-field: subject + body). A message a
          moderator hid meanwhile edits to a CONFLICT — surfaced on the banner, never silent. */}
      <Modal
        open={editing !== null}
        title="Edit message"
        onClose={() => {
          if (!edit.isPending) setEditing(null);
        }}
        banner={
          editError !== null ? (
            <p className="alert" role="alert">
              {editError}
            </p>
          ) : null
        }
      >
        <form
          className="admin-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (editing === null || editBody.trim() === '') return;
            edit.mutate({
              messageId: editing.id,
              ...(editSubject.trim() !== '' ? { subject: editSubject.trim() } : {}),
              body: editBody.trim(),
            });
          }}
        >
          <label className="field">
            <span>Subject</span>
            <input
              maxLength={200}
              value={editSubject}
              onChange={(e) => setEditSubject(e.target.value)}
            />
          </label>
          <label className="field">
            <span>
              Message{' '}
              <span className="req" aria-hidden="true">
                *
              </span>
            </span>
            <textarea
              required
              rows={4}
              maxLength={8000}
              value={editBody}
              onChange={(e) => setEditBody(e.target.value)}
            />
          </label>
          <div className="form-actions">
            <button
              type="submit"
              className="btn primary"
              data-testid="message-edit-save"
              disabled={edit.isPending || editBody.trim() === ''}
            >
              {edit.isPending ? 'Saving…' : 'Save changes'}
            </button>
            <button
              type="button"
              className="btn"
              disabled={edit.isPending}
              onClick={() => setEditing(null)}
            >
              Cancel
            </button>
          </div>
        </form>
      </Modal>

      {/* ADR-014 — the moderator's multi-field Triage Modal (status + note in one audited
          transition; the quick Hide/Delete ConfirmButtons above skip the note). */}
      <Modal
        open={triaging !== null}
        title="Triage message"
        onClose={() => {
          if (!triage.isPending) setTriaging(null);
        }}
        banner={
          triageError !== null ? (
            <p className="alert" role="alert">
              {triageError}
            </p>
          ) : null
        }
      >
        <form
          className="admin-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (triaging === null) return;
            triage.mutate({
              messageId: triaging.id,
              status: triageStatus,
              ...(triageNote.trim() !== '' ? { note: triageNote.trim() } : {}),
            });
          }}
        >
          <p className="muted">
            Transitions are soft — the message content is always preserved as the audit record.
          </p>
          <label className="field">
            <span>Status</span>
            <select
              className="section-select"
              value={triageStatus}
              onChange={(e) => setTriageStatus(e.target.value as MessageStatusName)}
            >
              <option value="visible">Visible (restore)</option>
              <option value="hidden">Hidden</option>
              <option value="deleted">Deleted</option>
            </select>
          </label>
          <label className="field">
            <span>Moderation note</span>
            <textarea
              rows={2}
              maxLength={500}
              placeholder="Optional — visible to moderators only"
              value={triageNote}
              onChange={(e) => setTriageNote(e.target.value)}
            />
          </label>
          <div className="form-actions">
            <button
              type="submit"
              className={`btn ${triageStatus === 'visible' ? 'primary' : 'danger'}`}
              data-testid="message-triage-apply"
              disabled={triage.isPending}
            >
              {triage.isPending
                ? 'Applying…'
                : triageStatus === 'visible'
                  ? 'Restore message'
                  : `Mark ${MESSAGE_STATUS_LABELS[triageStatus].toLowerCase()}`}
            </button>
            <button
              type="button"
              className="btn"
              disabled={triage.isPending}
              onClick={() => setTriaging(null)}
            >
              Cancel
            </button>
          </div>
        </form>
      </Modal>
    </>
  );
}

// ── the section shell ────────────────────────────────────────────────────────────────────

function BulletinContent({ access, viewerId }: { access: BulletinAccess; viewerId: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const active = resolveTab(searchParams.get('tab'));
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const selectTab = (key: TabKey) => {
    // Same contract as /library, /ledger, /trash: switching keeps ONLY ?tab.
    const params = new URLSearchParams();
    params.set('tab', key);
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  };

  const onTabKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    let next = index;
    if (e.key === 'ArrowRight') next = (index + 1) % BULLETIN_TABS.length;
    else if (e.key === 'ArrowLeft') next = (index - 1 + BULLETIN_TABS.length) % BULLETIN_TABS.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = BULLETIN_TABS.length - 1;
    else return;
    e.preventDefault();
    const target = BULLETIN_TABS[next];
    if (!target) return;
    selectTab(target.key);
    tabRefs.current[next]?.focus();
  };

  return (
    <>
      <h1 className="page-title">Bulletin</h1>

      <div className="library-tabs" role="tablist" aria-label="Bulletin sections">
        {BULLETIN_TABS.map((tab, index) => (
          <button
            key={tab.key}
            ref={(el) => {
              tabRefs.current[index] = el;
            }}
            type="button"
            role="tab"
            id={`bulletintab-${tab.key}`}
            aria-selected={active === tab.key}
            aria-controls="bulletin-panel"
            tabIndex={active === tab.key ? 0 : -1}
            onClick={() => selectTab(tab.key)}
            onKeyDown={(e) => onTabKeyDown(e, index)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div id="bulletin-panel" role="tabpanel" aria-labelledby={`bulletintab-${active}`}>
        {active === 'feed' ? <FeedTab /> : <MessagesTab access={access} viewerId={viewerId} />}
      </div>
    </>
  );
}

export function BulletinClient({ access, viewerId }: { access: BulletinAccess; viewerId: string }) {
  return (
    <Suspense fallback={<p className="muted">Loading…</p>}>
      <BulletinContent access={access} viewerId={viewerId} />
    </Suspense>
  );
}
