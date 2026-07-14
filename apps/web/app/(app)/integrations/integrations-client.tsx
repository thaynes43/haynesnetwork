'use client';

// ADR-055 / DESIGN-028 (PLAN-044) — the Integrations tab client. Three stacked views (ADR-015 reflow-free,
// tokens-only, 320/390 portrait-safe): the LINK card (enter a Goodreads profile URL / vanity / id → validate
// → linked state), the SHELF summary + COVERAGE %, and the requests / Missing WALL (per-format status chips
// + a plain "Search again" on Missing entries — non-destructive, so a plain button, NOT ConfirmButton).
import { useState, type FormEvent } from 'react';
import { PhaseChip, type PhaseTone } from '@hnet/ui';
import { KindIcon } from '@/components/kind-icon';
import { trpc, type RouterOutputs } from '@/lib/trpc-client';
import type { BookRequestStatus } from '@hnet/db';

type RequestWire = RouterOutputs['integrations']['requests']['requests'][number];

const STATUS_LABEL: Record<BookRequestStatus, string> = {
  requested: 'Requested',
  wanted: 'Wanted',
  grabbed: 'Grabbed',
  landed: 'Have it',
  missing: 'Missing',
};

// The status → tone seam (follows the estate conventions: info=asked, warning=searching, progress=downloading,
// success=have, danger=dead-end Missing). PhaseChip supports the blue `progress` tone the badges lack.
const STATUS_TONE: Record<BookRequestStatus, PhaseTone> = {
  requested: 'info',
  wanted: 'warning',
  grabbed: 'progress',
  landed: 'success',
  missing: 'danger',
};

function StatusChip({ format, status }: { format: string; status: BookRequestStatus }) {
  return (
    <PhaseChip
      phase={status}
      tone={STATUS_TONE[status]}
      label={`${format}: ${STATUS_LABEL[status]}`}
      pulse={status === 'wanted' || status === 'grabbed'}
    />
  );
}

function LinkCard() {
  const utils = trpc.useUtils();
  const statusQ = trpc.integrations.status.useQuery();
  const [profileRef, setProfileRef] = useState('');
  const link = trpc.integrations.link.useMutation({
    onSuccess: () => {
      setProfileRef('');
      void utils.integrations.invalidate();
    },
  });
  const unlink = trpc.integrations.unlink.useMutation({
    onSuccess: () => void utils.integrations.invalidate(),
  });

  const integration = statusQ.data?.integration;
  const linked = integration?.linked ?? false;

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (profileRef.trim().length === 0) return;
    link.mutate({ profileRef: profileRef.trim() });
  };

  return (
    <section className="card integrations-card" data-testid="integrations-link-card">
      <header className="integrations-card__head">
        <span className="integrations-provider">
          <span className="integrations-provider__glyph" aria-hidden="true">
            G
          </span>
          <span className="integrations-provider__name">Goodreads</span>
        </span>
        {linked ? (
          <span className="badge badge--ok" data-testid="integrations-linked">
            Linked
          </span>
        ) : (
          <span className="badge badge--muted">Not linked</span>
        )}
      </header>

      {linked && integration ? (
        <div className="integrations-linked-state">
          <p className="integrations-linked-state__ref">
            {integration.profileRef ?? `Goodreads user ${integration.externalUserId}`}
          </p>
          <p className="muted integrations-linked-state__sub">
            Syncing shelves: {integration.shelves.join(', ')}
            {integration.lastSyncError ? (
              <span className="integrations-error"> — last sync: {integration.lastSyncError}</span>
            ) : null}
          </p>
          <button
            type="button"
            className="btn sm"
            data-testid="integrations-unlink-btn"
            disabled={unlink.isPending}
            onClick={() => unlink.mutate()}
          >
            {unlink.isPending ? 'Unlinking…' : 'Unlink'}
          </button>
        </div>
      ) : (
        <form className="integrations-link-form" onSubmit={onSubmit}>
          <label className="field">
            <span className="field__label">Your public Goodreads profile</span>
            <input
              type="text"
              inputMode="url"
              placeholder="https://www.goodreads.com/yourname"
              value={profileRef}
              onChange={(e) => setProfileRef(e.target.value)}
              aria-invalid={link.isError || undefined}
              data-testid="integrations-profile-input"
            />
            <span className="field-hint">
              Paste your profile URL or numeric id. Your shelves must be PUBLIC (Settings → Privacy).
            </span>
          </label>
          {link.isError ? (
            <p className="field-error" role="alert" data-testid="integrations-link-error">
              {link.error.message}
            </p>
          ) : null}
          <div className="form-actions">
            <button
              type="submit"
              className="btn primary"
              data-testid="integrations-link-btn"
              disabled={link.isPending || profileRef.trim().length === 0}
            >
              {link.isPending ? 'Linking…' : 'Link Goodreads'}
            </button>
          </div>
        </form>
      )}
    </section>
  );
}

function ShelfSummary() {
  const shelfQ = trpc.integrations.shelf.useQuery();
  const coverage = shelfQ.data?.coverage ?? { total: 0, covered: 0, pct: 0 };
  const lastSyncedAt = shelfQ.data?.integration.lastSyncedAt ?? null;

  return (
    <section className="card integrations-summary" data-testid="integrations-summary">
      <div className="integrations-stat" data-testid="integrations-coverage">
        <span className="integrations-stat__value">{coverage.pct}%</span>
        <span className="integrations-stat__label">of your shelf in the library</span>
      </div>
      <div className="integrations-summary__detail">
        <p className="integrations-summary__count">
          We have <strong>{coverage.covered}</strong> of <strong>{coverage.total}</strong> books on
          your want-to-read shelf.
        </p>
        <p className="muted">
          {lastSyncedAt
            ? `Last synced ${new Date(lastSyncedAt).toLocaleString()}`
            : 'Not synced yet — the next sync will pull your shelf.'}
        </p>
      </div>
    </section>
  );
}

function RequestCard({ request, onSearched }: { request: RequestWire; onSearched: () => void }) {
  const search = trpc.integrations.search.useMutation({ onSuccess: onSearched });
  // ADR-056 (PLAN-046) — a COMIC (comicStatus non-null) is routed to Kapowarr, not LazyLibrarian: it shows a
  // single Comic status chip (not Ebook/Audio), and a parked comic (no ComicVine match yet) shows the routing
  // note. The full Comics-wall poster redesign is PLAN-045; this keeps the 044 wall coherent for comics.
  const isComic = request.comicStatus != null;
  const landed = request.comicStatus === 'landed' || request.ebookStatus === 'landed' || request.audioStatus === 'landed';
  return (
    <li className="integrations-request" data-testid="request-card" data-request-id={request.id}>
      <div className="integrations-request__art" aria-hidden="true">
        <KindIcon kind={isComic ? 'comic' : 'book'} className="integrations-request__icon" />
      </div>
      <div className="integrations-request__body">
        <p className="integrations-request__title">{request.title}</p>
        <p className="integrations-request__author muted">{request.author ?? 'Unknown author'}</p>
        <div className="integrations-request__chips">
          {isComic ? (
            <StatusChip format="Comic" status={request.comicStatus!} />
          ) : (
            <>
              <StatusChip format="Ebook" status={request.ebookStatus} />
              <StatusChip format="Audio" status={request.audioStatus} />
            </>
          )}
        </div>
        <div className="integrations-request__action">
          {isComic && request.unroutableReason === 'comic' ? (
            <span className="muted integrations-request__note">
              Comic — routing to Kapowarr (waiting on a ComicVine match).
            </span>
          ) : request.searchable ? (
            <button
              type="button"
              className="btn sm"
              data-testid="request-search-btn"
              disabled={search.isPending}
              onClick={() => search.mutate({ requestId: request.id })}
            >
              {search.isPending ? 'Searching…' : 'Search again'}
            </button>
          ) : request.inLibrary || landed ? (
            <span className="muted integrations-request__note">In your library.</span>
          ) : (
            <span className="muted integrations-request__note">
              {isComic ? 'Monitored in Kapowarr — searching.' : 'Queued — searching.'}
            </span>
          )}
        </div>
      </div>
    </li>
  );
}

function RequestsWall() {
  const utils = trpc.useUtils();
  const requestsQ = trpc.integrations.requests.useQuery();
  const requests = requestsQ.data?.requests ?? [];
  const onSearched = () => void utils.integrations.requests.invalidate();

  if (requestsQ.isSuccess && requests.length === 0) {
    return (
      <section className="card empty-state" data-testid="integrations-requests-empty">
        <p>No requests yet.</p>
        <p className="muted">
          Add books to your Goodreads want-to-read shelf; the next sync turns them into requests.
        </p>
      </section>
    );
  }

  return (
    <section className="integrations-requests" data-testid="integrations-requests">
      <h2 className="integrations-section-title">Requests &amp; Missing</h2>
      <ul className="integrations-request-grid">
        {requests.map((request) => (
          <RequestCard key={request.id} request={request} onSearched={onSearched} />
        ))}
      </ul>
    </section>
  );
}

export function IntegrationsClient() {
  const statusQ = trpc.integrations.status.useQuery();
  const linked = statusQ.data?.integration.linked ?? false;

  return (
    <div className="integrations-page">
      <h1 className="page-title">Integrations</h1>
      <p className="muted integrations-intro">
        Link your reading and watching accounts so we can be your source. Goodreads is first: link
        your public want-to-read shelf and we’ll request the books you don’t have yet.
      </p>
      <LinkCard />
      {linked ? (
        <>
          <ShelfSummary />
          <RequestsWall />
        </>
      ) : null}
    </div>
  );
}
