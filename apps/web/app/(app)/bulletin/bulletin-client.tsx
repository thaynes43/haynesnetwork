'use client';

// ADR-050 / DESIGN-012 D-12 (PLAN-034 Helpdesk) — the /bulletin section UI. Two sub-tabs, the
// HELPDESK FIRST (owner requirement 1):
//
// - HELPDESK — the household media-issue ticket system (it replaced the Messages board). A
//   POSTER WALL in the Library/Trash grammar (owner requirement 8): tickets with a linked title
//   render its poster, non-media tickets render their intake-category icon in the same 2:3 tile,
//   and every tile bakes the STATE on as a colored corner puck (the Trash `bwall-overlay` idiom)
//   plus a status badge in the caption. MULTI-SELECT state filter chips (HP-01 — each toggles a
//   state in/out of the one wall; default {Open, In progress}, Complete/Rejected opt-in) replace
//   the old All/Visible/Hidden/Deleted (requirement 7). Compose NEVER stacks above the list
//   (requirement 2): the "New
//   ticket" button opens a Modal (multi-field — ADR-014), mobile-first. A tile click drills into
//   /bulletin/ticket/[id] (requirement 6).
// - FEED — the aggregated third-party notification browse (unchanged, ADR-026 D-05).
//
// Navigation implements the DESIGN-004 D-19 history contract: tab switches and ticket drill-ins
// PUSH history entries; the state chips and the Feed's ?src/?media segs REPLACE in place.
// ADR-015 (hard rule 9): interactions recolor, never reflow — list refetches dim in place
// (placeholderData), compose overlays (Modal), pickers overlay (popover).
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useRef, useState, type FormEvent } from 'react';
import { trpc } from '@/lib/trpc-client';
import { Modal } from '@/components/modal';
import { TicketCard, TicketWall, TicketWallSkeleton } from '@/components/cards';
import { TicketCategoryIcon } from '@/components/ticket-glyphs';
import { describeMutationError } from '@/lib/app-error';
import { ARR_KIND_LABELS, formatWhen, type ArrKindName } from '@/lib/media';
import {
  FEED_SOURCE_LABELS,
  FEED_SOURCE_NAMES,
  HELPDESK_NAME,
  TICKET_CATEGORY_HINTS,
  TICKET_CATEGORY_LABELS,
  TICKET_CATEGORY_NAMES,
  TICKET_STATUS_LABELS,
  TICKET_STATUS_NAMES,
  type BulletinViewName,
  type FeedSourceName,
  type MessageActionName,
  type TicketCategoryName,
  type TicketStatusName,
} from '@/lib/bulletin';

export interface BulletinAccess {
  level: 'edit' | 'read_only';
  actions: MessageActionName[];
  // ADR-049 C-02 (PLAN-027) — the granted Bulletin SUB-VIEWS; the client renders ONLY these
  // sub-tabs (the `messages` view carries the Helpdesk since PLAN-034; the endpoints FORBID
  // ungranted views server-side regardless).
  views: BulletinViewName[];
}

// The Helpdesk rides the stored `messages` view grant (ADR-050 option H — renames never migrate
// grant rows); the tab key + label are display-only.
const BULLETIN_TABS = [
  { key: 'helpdesk', view: 'messages', label: HELPDESK_NAME },
  { key: 'feed', view: 'feed', label: 'Feed' },
] as const;
type TabKey = (typeof BULLETIN_TABS)[number]['key'];

/** Resolve the active tab against the sub-views the role may see: honour ?tab when it's granted
 *  (the retired `?tab=messages` deep-links alias to the Helpdesk), else fall back to the FIRST
 *  granted tab in display order — so the Helpdesk leads whenever it's granted (requirement 1). */
function resolveTab(raw: string | null, available: readonly TabKey[]): TabKey {
  const wanted = raw === 'messages' ? 'helpdesk' : raw;
  if (wanted !== null && (available as readonly string[]).includes(wanted)) return wanted as TabKey;
  return available[0] ?? 'helpdesk';
}

function kindLabel(arrKind: string | null): string | null {
  return arrKind !== null && arrKind in ARR_KIND_LABELS
    ? ARR_KIND_LABELS[arrKind as ArrKindName]
    : null;
}

/** Tile-compact activity time ("Jul 11"; the year appears only once it differs) — the full
 *  timestamps live on the detail page. Bad ISO → as-is. */
function tileWhen(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
}

// ── Feed ─────────────────────────────────────────────────────────────────────────────────

/** The media link cell: a Library link when the event resolved to a ledger item, else an em dash. */
function MediaLink({
  mediaItemId,
  mediaTitle,
}: {
  mediaItemId: string | null;
  mediaTitle: string | null;
}) {
  if (mediaItemId === null) return <span className="muted">—</span>;
  return (
    <Link className="row-link" href={`/library/${mediaItemId}?from=bulletin-feed`}>
      {mediaTitle ?? 'Media item'}
    </Link>
  );
}

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
    // Refinements REPLACE (DESIGN-004 D-19) — no history entry per chip.
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
          <table
            className="admin-table bulletin-feed"
            aria-busy={refreshing}
            data-testid="bulletin-feed"
          >
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

// ── Helpdesk: the compose Modal ──────────────────────────────────────────────────────────

interface MediaPick {
  id: string;
  title: string;
  arrKind: string;
}

/** Small library search-select for the optional linked title (ledger.search is available to
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
        aria-label="Link the affected title (search the library)"
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

/** ADR-014 — the multi-field "New ticket" Modal (requirement 2: compose NEVER stacks above the
 *  wall; a Modal overlays it — the strongest mobile shape). On success the router PUSHES the new
 *  ticket's detail page (a screen change — D-19), which doubles as the "it's filed" confirmation. */
function ComposeModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const router = useRouter();
  const utils = trpc.useUtils();
  const [title, setTitle] = useState('');
  const [category, setCategory] = useState<TicketCategoryName>('playback');
  const [body, setBody] = useState('');
  const [media, setMedia] = useState<MediaPick | null>(null);
  const [error, setError] = useState<string | null>(null);

  const create = trpc.communication.tickets.create.useMutation({
    onError: (err: unknown) => setError(describeMutationError(err)),
    onSuccess: (created) => {
      setError(null);
      setTitle('');
      setBody('');
      setMedia(null);
      setCategory('playback');
      void utils.communication.tickets.invalidate();
      router.push(`/bulletin/ticket/${created.id}`);
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (title.trim() === '' || body.trim() === '') return;
    create.mutate({
      title: title.trim(),
      body: body.trim(),
      category,
      ...(media !== null ? { mediaItemId: media.id } : {}),
    });
  };

  return (
    <Modal
      open={open}
      title="New ticket"
      onClose={() => {
        if (!create.isPending) onClose();
      }}
      banner={
        error !== null ? (
          <p className="alert" role="alert">
            {error}
          </p>
        ) : null
      }
    >
      <form className="admin-form" data-testid="ticket-compose" onSubmit={submit}>
        <p className="muted tcompose-note">
          Report an issue with media or playback. Found a bug with the <strong>site itself</strong>?
          That goes to GitHub instead (linked from the Home banner).
        </p>
        <label className="field">
          <span>
            What’s wrong?{' '}
            <span className="req" aria-hidden="true">
              *
            </span>
          </span>
          <input
            required
            maxLength={200}
            placeholder="e.g. No sound from minute 3"
            data-testid="ticket-title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </label>
        <fieldset className="field tcat-field">
          <legend>Category</legend>
          <div className="tcat-grid" role="radiogroup" aria-label="Ticket category">
            {TICKET_CATEGORY_NAMES.map((c) => (
              <button
                key={c}
                type="button"
                role="radio"
                aria-checked={category === c}
                className={`tcat-opt${category === c ? ' is-active' : ''}`}
                data-testid={`ticket-category-${c}`}
                onClick={() => setCategory(c)}
              >
                <TicketCategoryIcon category={c} className="tcat-opt__icon" />
                <span className="tcat-opt__label">{TICKET_CATEGORY_LABELS[c]}</span>
                <span className="tcat-opt__hint muted">{TICKET_CATEGORY_HINTS[c]}</span>
              </button>
            ))}
          </div>
        </fieldset>
        <div className="field">
          <span>Which title? (optional) — its poster becomes the ticket’s tile</span>
          <MediaPicker selected={media} onSelect={setMedia} />
        </div>
        <label className="field">
          <span>
            Details{' '}
            <span className="req" aria-hidden="true">
              *
            </span>
          </span>
          <textarea
            required
            rows={4}
            maxLength={8000}
            placeholder="What happened, on which device/app, and when…"
            data-testid="ticket-body"
            value={body}
            onChange={(e) => setBody(e.target.value)}
          />
        </label>
        <div className="form-actions">
          <button
            type="submit"
            className="btn primary"
            data-testid="ticket-create"
            disabled={create.isPending || title.trim() === '' || body.trim() === ''}
          >
            {create.isPending ? 'Filing…' : 'File ticket'}
          </button>
          <button type="button" className="btn" disabled={create.isPending} onClick={onClose}>
            Cancel
          </button>
        </div>
      </form>
    </Modal>
  );
}

// ── Helpdesk: the ticket wall ────────────────────────────────────────────────────────────

interface TicketListItem {
  id: string;
  title: string;
  category: TicketCategoryName;
  status: TicketStatusName;
  authorUserId: string;
  authorName: string | null;
  mediaItemId: string | null;
  mediaTitle: string | null;
  mediaArrKind: string | null;
  mediaYear: number | null;
  mediaPosterUrl: string | null;
  replyCount: number;
  createdAt: string;
  lastActivityAt: string;
}

/** One wall tile: the linked title's poster (or the category icon tile), the state baked on as a
 *  colored corner puck (the Trash idiom) + a status badge in the caption, the reply count, and the
 *  last-activity time. The WHOLE tile is the drill-in link (requirement 6 — a history push).
 *  PLAN-047 / ADR-058: rendered by the shared card family (TicketCard) — never bespoke markup. */
function TicketTile({ ticket }: { ticket: TicketListItem }) {
  return (
    <TicketCard
      href={`/bulletin/ticket/${ticket.id}`}
      title={ticket.title}
      status={ticket.status}
      category={ticket.category}
      media={
        ticket.mediaItemId !== null
          ? {
              posterUrl: ticket.mediaPosterUrl,
              kind: ticket.mediaArrKind ?? 'radarr',
              title: ticket.mediaTitle,
              year: ticket.mediaYear,
            }
          : null
      }
      replyCount={ticket.replyCount}
      whenLabel={tileWhen(ticket.lastActivityAt)}
    />
  );
}

// HP-01 — the wall's DEFAULT visible states: actionable work only. Complete/Rejected are historical
// (opt-in). A fresh visit (no ?state param) always resolves to this set — no per-user persistence.
const DEFAULT_STATES: readonly TicketStatusName[] = ['open', 'in_progress'];
// Sentinel for a DELIBERATELY empty selection (every chip toggled off) — distinct from "untouched"
// (no param ⇒ the default), so the URL stays shareable and a share of "show nothing" round-trips.
const EMPTY_STATE_TOKEN = 'none';

/** Resolve the wall's visible state SET from the URL's repeated ?state= params (HP-01, a D-09
 *  refinement). No param ⇒ the default {open, in_progress}; one or more ⇒ exactly the valid states
 *  named (the `none` sentinel — or any unknown value — yields an empty set → the empty state). */
function selectionFromParams(raw: readonly string[]): Set<TicketStatusName> {
  if (raw.length === 0) return new Set(DEFAULT_STATES);
  return new Set(
    raw.filter((v): v is TicketStatusName => (TICKET_STATUS_NAMES as readonly string[]).includes(v)),
  );
}

function HelpdeskTab({ access }: { access: BulletinAccess }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const canCreate = access.actions.includes('post');

  // The state selection rides the URL as repeated ?state= params (HP-01 multi-select) —
  // deep-linkable/shareable; chip toggles REPLACE, never push (D-19).
  const selected = selectionFromParams(searchParams.getAll('state'));
  const allActive = TICKET_STATUS_NAMES.every((s) => selected.has(s));

  const writeSelection = (next: Set<TicketStatusName>) => {
    const params = new URLSearchParams(window.location.search);
    params.delete('state');
    const nextList = TICKET_STATUS_NAMES.filter((s) => next.has(s)); // canonical order
    const isDefault =
      nextList.length === DEFAULT_STATES.length && DEFAULT_STATES.every((s) => next.has(s));
    if (isDefault) {
      // Canonical default ⇒ NO param (a toggled-to-default URL matches a fresh visit — cleanest).
    } else if (nextList.length === 0) {
      params.set('state', EMPTY_STATE_TOKEN);
    } else {
      for (const s of nextList) params.append('state', s);
    }
    const qs = params.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  };
  const toggleState = (s: TicketStatusName) => {
    const next = new Set(selected);
    if (next.has(s)) next.delete(s);
    else next.add(s);
    writeSelection(next);
  };
  const selectAll = () => writeSelection(new Set(TICKET_STATUS_NAMES));

  const statuses = TICKET_STATUS_NAMES.filter((s) => selected.has(s));
  const counts = trpc.communication.tickets.counts.useQuery();
  const list = trpc.communication.tickets.list.useInfiniteQuery(
    { statuses, limit: 60 },
    { getNextPageParam: (last) => last.nextCursor ?? undefined, placeholderData: (prev) => prev },
  );
  const rows = (list.data?.pages.flatMap((p) => p.items) ?? []) as TicketListItem[];
  const refreshing = list.isPlaceholderData && list.isFetching;
  const total =
    counts.data !== undefined
      ? counts.data.open + counts.data.in_progress + counts.data.complete + counts.data.rejected
      : undefined;

  const [composing, setComposing] = useState(false);

  return (
    <>
      <div className="library-filters admin-filterbar twall-bar">
        <div className="seg" role="group" aria-label="Filter the wall by ticket state">
          {/* Multi-select toggles (HP-01, the Library filter-chip idiom): each state chip adds/
              removes that state from the ONE wall; "All" selects every state. Toggling recolors in
              place — the row never reflows (ADR-015). Live per-chip counts are always shown. */}
          <button
            type="button"
            className={allActive ? 'is-active' : undefined}
            aria-pressed={allActive}
            data-testid="ticket-filter-all"
            onClick={selectAll}
          >
            All{total !== undefined ? ` · ${total}` : ''}
          </button>
          {TICKET_STATUS_NAMES.map((value) => {
            const on = selected.has(value);
            return (
              <button
                key={value}
                type="button"
                className={on ? 'is-active' : undefined}
                aria-pressed={on}
                data-testid={`ticket-filter-${value}`}
                onClick={() => toggleState(value)}
              >
                {TICKET_STATUS_LABELS[value]}
                {counts.data !== undefined ? ` · ${counts.data[value]}` : ''}
              </button>
            );
          })}
        </div>
        {canCreate ? (
          <button
            type="button"
            className="btn primary twall-new"
            data-testid="ticket-new"
            onClick={() => setComposing(true)}
          >
            New ticket
          </button>
        ) : (
          <p className="muted twall-new-note" data-testid="composer-absent">
            You can read and reply. Filing tickets needs the post permission — ask an admin.
          </p>
        )}
      </div>

      {list.error ? (
        <p className="alert" role="alert">
          Couldn’t load the {HELPDESK_NAME.toLowerCase()}: {list.error.message}
        </p>
      ) : null}

      {list.isLoading ? (
        <TicketWallSkeleton />
      ) : !list.error && rows.length === 0 ? (
        <section className="card empty-state" data-testid="tickets-empty">
          <p>
            {selected.size === 0
              ? 'No states selected — pick a state chip above to see tickets.'
              : allActive
                ? 'No tickets yet — when playback misbehaves or something’s missing, file it here.'
                : `No tickets in the selected ${selected.size === 1 ? 'state' : 'states'}.`}
          </p>
          <p className="muted">
            Media or playback problems belong here; bugs with the site itself go to GitHub (linked
            from the Home banner).
          </p>
        </section>
      ) : (
        <TicketWall refreshing={refreshing} testId="ticket-wall">
          {rows.map((tk) => (
            <TicketTile key={tk.id} ticket={tk} />
          ))}
        </TicketWall>
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

      {canCreate ? <ComposeModal open={composing} onClose={() => setComposing(false)} /> : null}
    </>
  );
}

// ── the section shell ────────────────────────────────────────────────────────────────────

function BulletinContent({ access }: { access: BulletinAccess }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  // ADR-049 C-02 (PLAN-027) — only the granted sub-views render as tabs; a role narrowed to
  // messages-only (the Default shape) sees ONLY the Helpdesk (and the feed endpoint FORBIDs it
  // server-side regardless).
  const availableTabs = BULLETIN_TABS.filter((t) => access.views.includes(t.view));
  const tabKeys = availableTabs.map((t) => t.key);
  const active = resolveTab(searchParams.get('tab'), tabKeys);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const selectTab = (key: TabKey) => {
    // Same contract as /library, /ledger, /trash: switching keeps ONLY ?tab, and a
    // screen-level tab switch PUSHES a history entry (DESIGN-004 D-19) so Back returns to
    // the prior tab; the Helpdesk's ?state and the Feed's ?src/?media refinements stay
    // router.replace. scroll:false preserves the existing tab-switch scroll behaviour.
    const params = new URLSearchParams();
    params.set('tab', key);
    router.push(`${pathname}?${params.toString()}`, { scroll: false });
  };

  const onTabKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    const count = availableTabs.length;
    let next = index;
    if (e.key === 'ArrowRight') next = (index + 1) % count;
    else if (e.key === 'ArrowLeft') next = (index - 1 + count) % count;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = count - 1;
    else return;
    e.preventDefault();
    const target = availableTabs[next];
    if (!target) return;
    selectTab(target.key);
    tabRefs.current[next]?.focus();
  };

  return (
    <>
      {/* DESIGN-004 D-22 — the section reads under its ratified name (HELPDESK_NAME = "Tickets");
          the route/section id / testids stay `bulletin`. */}
      <h1 className="page-title">{HELPDESK_NAME}</h1>

      <div className="library-tabs" role="tablist" aria-label={`${HELPDESK_NAME} sections`}>
        {availableTabs.map((tab, index) => (
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
        {active === 'feed' ? <FeedTab /> : <HelpdeskTab access={access} />}
      </div>
    </>
  );
}

export function BulletinClient({ access }: { access: BulletinAccess }) {
  return (
    <Suspense fallback={<p className="muted">Loading…</p>}>
      <BulletinContent access={access} />
    </Suspense>
  );
}
