'use client';

// Issue #792 (DESIGN-028 amendment 2026-10-07; owner ruling: admins only) — one want's Request Event history
// (ADR-101), newest first. The shared History idiom: the `.timeline` list the movie and book detail pages already use,
// the "Older" load-more of the movie History, the event's reason as the row's type, what changed as a field list
// (an update's fields before and after; a mint's fields as set; a delete's fields as the want held them), the
// writer's context, then when and who. Rendered only for an admin (the page decides); the API refuses everyone
// else, so a non-admin never receives a row. Read-only: nothing here writes.
import Link from 'next/link';
import { Fragment } from 'react';
import { trpc, type RouterOutputs } from '@/lib/trpc-client';
import { formatWhen } from '@/lib/media';
import {
  recordedFromLabel,
  requestEventActorLabel,
  requestEventChanges,
  requestEventDetail,
  requestEventReasonLabel,
  requestEventSiteLabel,
  type EventValue,
  type RequestEventRefsLike,
  type RequestEventWantLike,
} from '@/lib/request-events';

type EventsPage = RouterOutputs['books']['requestEvents'];
type EventEntry = EventsPage['events'][number];

/** Events per page. The first live day held at most 6 per want (p95 3), so one page covers nearly every want. */
export const REQUEST_EVENTS_PAGE_SIZE = 20;

function Value({ value }: { value: EventValue }) {
  const className = [value.mono ? 'request-event__id' : null, value.none ? 'muted' : null]
    .filter(Boolean)
    .join(' ');
  if (value.href) {
    return (
      <Link href={value.href} className={className || undefined} title={value.title}>
        {value.text}
      </Link>
    );
  }
  return (
    <span className={className || undefined} title={value.title}>
      {value.text}
    </span>
  );
}

function EventRow({
  event,
  refs,
  want,
}: {
  event: EventEntry;
  refs: RequestEventRefsLike;
  want: RequestEventWantLike | null;
}) {
  const changes = requestEventChanges(event, refs, want);
  const detail = requestEventDetail(event);
  const site = requestEventSiteLabel(event.site);
  const when = [formatWhen(event.createdAt), requestEventActorLabel(event), site]
    .filter((s): s is string => s !== null && s !== '')
    .join(' · ');
  return (
    <li data-testid="request-event" data-kind={event.kind} data-reason={event.reason}>
      <span className="timeline__type" title={event.writer}>
        {requestEventReasonLabel(event.reason)}
      </span>
      {changes.length > 0 ? (
        <dl className="request-event__changes">
          {changes.map((c) => (
            <div key={c.column} className="request-event__change" data-column={c.column}>
              <dt>{c.label}</dt>
              <dd>
                {c.from !== null && c.to !== null ? (
                  <>
                    <Value value={c.from} />
                    <span className="request-event__arrow" aria-hidden="true">
                      →
                    </span>
                    <span className="sr-only"> changed to </span>
                    <Value value={c.to} />
                  </>
                ) : (
                  <Value value={(c.to ?? c.from)!} />
                )}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
      {detail.length > 0 ? (
        <span className="timeline__detail request-event__detail">
          {detail.map((p, i) => (
            <Fragment key={p.label}>
              {i > 0 ? ' · ' : null}
              {p.label}: <Value value={p.value} />
            </Fragment>
          ))}
        </span>
      ) : null}
      <span className="muted timeline__when">{when}</span>
    </li>
  );
}

/**
 * The History list for one want. `requestId` need not name a live want: a deleted want keeps its events.
 */
export function RequestEventHistory({ requestId }: { requestId: string }) {
  const events = trpc.books.requestEvents.useInfiniteQuery(
    { requestId, limit: REQUEST_EVENTS_PAGE_SIZE },
    { getNextPageParam: (last) => last.nextCursor ?? undefined },
  );

  if (events.isLoading) return <p className="muted">Loading the history…</p>;
  if (events.error) {
    return (
      <p className="alert" role="alert">
        Couldn’t load the history: {events.error.message}
      </p>
    );
  }
  const pages = events.data?.pages ?? [];
  const list = pages.flatMap((p) => p.events);
  const refs: RequestEventRefsLike = { items: {}, collections: {} };
  for (const p of pages) {
    Object.assign(refs.items, p.refs.items);
    Object.assign(refs.collections, p.refs.collections);
  }
  // The same on every page: the want's origin and a collection want's one format.
  const want: RequestEventWantLike | null = pages[0]?.want ?? null;
  const since = recordedFromLabel();

  if (list.length === 0) {
    return (
      <p className="muted" data-testid="request-events-empty">
        No changes recorded for this want yet. Changes are recorded from {since}.
      </p>
    );
  }
  // The want's whole story is here when its oldest event is the mint; otherwise it began before recording did.
  const oldest = list[list.length - 1]!;
  const startsBeforeRecording = !events.hasNextPage && oldest.kind !== 'mint';

  return (
    <>
      <ol className="timeline request-events" data-testid="request-events">
        {list.map((e) => (
          <EventRow key={e.id} event={e} refs={refs} want={want} />
        ))}
      </ol>
      {events.hasNextPage ? (
        <div className="load-more">
          <button
            type="button"
            className="btn sm"
            data-testid="request-events-more"
            disabled={events.isFetchingNextPage}
            onClick={() => void events.fetchNextPage()}
          >
            {events.isFetchingNextPage ? 'Loading…' : 'Older changes'}
          </button>
        </div>
      ) : null}
      {startsBeforeRecording ? (
        <p className="muted request-events__note" data-testid="request-events-before">
          Changes before {since} were not recorded.
        </p>
      ) : null}
    </>
  );
}
