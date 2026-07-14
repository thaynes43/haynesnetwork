'use client';

// ADR-055 / DESIGN-028 (PLAN-044) — the Integrations tab client. Three stacked views (ADR-015 reflow-free,
// tokens-only, 320/390 portrait-safe): the LINK card (enter a Goodreads profile URL / vanity / id → validate
// → linked state; UNLINK is destructive-ish → the @hnet/ui ConfirmButton two-step, hard rule 8), the SHELF
// summary + COVERAGE % (a "first sync in progress" pending state until the first sync stamps last_synced_at,
// never a "0% / 0 of 0" dead-end — fix 3b), and the requests / Missing WALL (per-format status chips + a
// plain "Search again" on Missing entries — non-destructive, so a plain button, NOT ConfirmButton).
import { useState, type FormEvent } from 'react';
import { ConfirmButton, PhaseChip, type PhaseTone } from '@hnet/ui';
import { KindIcon } from '@/components/kind-icon';
import { trpc, type RouterOutputs } from '@/lib/trpc-client';
import { coverageView, isFirstSyncPending } from '@/lib/integrations-coverage';
import type { BookRequestStatus } from '@hnet/db';

// While a just-linked integration waits on its first background sync, poll so the pending → data swap
// happens without a manual refresh (React Query auto-pauses the interval on a hidden tab).
const PENDING_POLL_MS = 4000;

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
  // Poll the link status while the first sync is in flight so the linked-state copy stays current.
  const statusQ = trpc.integrations.status.useQuery(undefined, {
    refetchInterval: (query) => {
      const d = query.state.data;
      return d && isFirstSyncPending(d.integration.linked, d.integration.lastSyncedAt)
        ? PENDING_POLL_MS
        : false;
    },
  });
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
          {/* Unlink is destructive-ish (drops the link + its requests from view) → the two-step confirm
              (hard rule 8 / ADR-014). The button reserves width for the armed label so the swap can't
              reflow the card (ADR-015 — .btn.confirm-btn min-width). */}
          <ConfirmButton
            className="btn sm danger"
            data-testid="integrations-unlink-btn"
            disabled={unlink.isPending}
            label={unlink.isPending ? 'Unlinking…' : 'Unlink'}
            confirmLabel="Confirm unlink?"
            restingAriaLabel="Unlink your Goodreads account — click twice to confirm"
            confirmAriaLabel="Confirm unlink your Goodreads account"
            onConfirm={() => unlink.mutate()}
          />
        </div>
      ) : (
        <form className="integrations-link-form" onSubmit={onSubmit}>
          <label className="field">
            <span className="field__label">Your public Goodreads profile</span>
            <input
              type="text"
              inputMode="url"
              className="integrations-input"
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

function ShelfSummary({ pending }: { pending: boolean }) {
  const shelfQ = trpc.integrations.shelf.useQuery(undefined, {
    refetchInterval: pending ? PENDING_POLL_MS : false,
  });
  const coverage = shelfQ.data?.coverage ?? { total: 0, covered: 0, pct: 0 };
  const lastSyncedAt = shelfQ.data?.integration.lastSyncedAt ?? null;
  const view = coverageView({ lastSyncedAt, coverage });

  // ADR-015 — the pending state and the coverage state occupy the SAME footprint (the stat block reserves
  // its min-width/height either way), so the first-sync → data swap never reflows the requests wall below.
  return (
    <section className="card integrations-summary" data-testid="integrations-summary">
      {view.kind === 'pending' ? (
        <>
          <div
            className="integrations-stat integrations-stat--pending"
            data-testid="integrations-coverage"
            data-pending="true"
          >
            <span className="integrations-stat__spinner" aria-hidden="true" />
            <span className="integrations-stat__label">First sync in progress</span>
          </div>
          <div className="integrations-summary__detail">
            <p className="integrations-summary__count">Pulling your want-to-read shelf…</p>
            <p className="muted">
              We’re reading your shelf and matching it against the library. This usually takes a moment —
              coverage appears here as soon as the first sync finishes.
            </p>
          </div>
        </>
      ) : (
        <>
          <div className="integrations-stat" data-testid="integrations-coverage">
            <span className="integrations-stat__value">{view.pct}%</span>
            <span className="integrations-stat__label">of your shelf in the library</span>
          </div>
          <div className="integrations-summary__detail">
            <p className="integrations-summary__count">
              We have <strong>{view.covered}</strong> of <strong>{view.total}</strong> books on your
              want-to-read shelf.
            </p>
            <p className="muted">
              {lastSyncedAt ? `Last synced ${new Date(lastSyncedAt).toLocaleString()}` : ''}
            </p>
          </div>
        </>
      )}
    </section>
  );
}

function RequestCard({ request, onSearched }: { request: RequestWire; onSearched: () => void }) {
  const search = trpc.integrations.search.useMutation({ onSuccess: onSearched });
  return (
    <li className="integrations-request" data-testid="request-card" data-request-id={request.id}>
      <div className="integrations-request__art" aria-hidden="true">
        <KindIcon kind="book" className="integrations-request__icon" />
      </div>
      <div className="integrations-request__body">
        <p className="integrations-request__title">{request.title}</p>
        <p className="integrations-request__author muted">{request.author ?? 'Unknown author'}</p>
        <div className="integrations-request__chips">
          <StatusChip format="Ebook" status={request.ebookStatus} />
          <StatusChip format="Audio" status={request.audioStatus} />
        </div>
        <div className="integrations-request__action">
          {request.unroutableReason === 'comic' ? (
            <span className="muted integrations-request__note">
              Comic — routes via Kapowarr (saga pairing phase), not queued in LazyLibrarian.
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
          ) : request.inLibrary ||
            request.ebookStatus === 'landed' ||
            request.audioStatus === 'landed' ? (
            <span className="muted integrations-request__note">In your library.</span>
          ) : (
            <span className="muted integrations-request__note">Queued — searching.</span>
          )}
        </div>
      </div>
    </li>
  );
}

function RequestsWall({ pending }: { pending: boolean }) {
  const utils = trpc.useUtils();
  const requestsQ = trpc.integrations.requests.useQuery(undefined, {
    refetchInterval: pending ? PENDING_POLL_MS : false,
  });
  const requests = requestsQ.data?.requests ?? [];
  const onSearched = () => void utils.integrations.requests.invalidate();

  if (requestsQ.isSuccess && requests.length === 0) {
    // During the first sync the wall is legitimately empty — say so, don't imply "nothing to request".
    return (
      <section className="card empty-state" data-testid="integrations-requests-empty">
        {pending ? (
          <>
            <p>First sync in progress…</p>
            <p className="muted">Your want-to-read books appear here as soon as the first sync finishes.</p>
          </>
        ) : (
          <>
            <p>No requests yet.</p>
            <p className="muted">
              Add books to your Goodreads want-to-read shelf; the next sync turns them into requests.
            </p>
          </>
        )}
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
  const statusQ = trpc.integrations.status.useQuery(undefined, {
    refetchInterval: (query) => {
      const d = query.state.data;
      return d && isFirstSyncPending(d.integration.linked, d.integration.lastSyncedAt)
        ? PENDING_POLL_MS
        : false;
    },
  });
  const integration = statusQ.data?.integration;
  const linked = integration?.linked ?? false;
  const pending = isFirstSyncPending(linked, integration?.lastSyncedAt ?? null);

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
          <ShelfSummary pending={pending} />
          <RequestsWall pending={pending} />
        </>
      ) : null}
    </div>
  );
}
