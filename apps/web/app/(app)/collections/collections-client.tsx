'use client';

// ADR-072 / DESIGN-043 (PLAN-052 PR4a — direct-add) — the first-class /collections page. A universal
// top-level surface (everyone sees it, like Library) with a media-type sub-navigation (Movies · TV ·
// Books · Audiobooks · Tickets · Settings). The DESIGN-029 sub-view idiom: the sub-nav PUSHES between
// sub-sections (D-19), within a sub-section chips/pucks recolor but never reflow (ADR-015). Each media
// sub-section reads its provider LIVE through the confined collections.* tRPC surface: Books/Audiobooks
// bind Libretto (available now, degrading honestly on an outage), Movies/TV bind Kometa (available:false —
// the auto-merge write path lands in PR4b, so an honest placeholder holds the seam). Everyone adds/edits
// within the size cap; over-cap files a collection_override ticket (D-11); admins delete + approve tickets
// + edit the cap. Owner tone: no em-dashes, plain friendly labels; all color via tokens (hard rule 2).
import { Suspense, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { ConfirmButton } from '@hnet/ui';
import { Modal } from '@/components/modal';
import { trpc } from '@/lib/trpc-client';
import { appCodeOf, describeMutationError } from '@/lib/app-error';
import {
  COLLECTIONS_NAME,
  COLLECTION_BUILDER_LABELS,
  COLLECTION_BUILDER_OPTIONS,
  COLLECTION_MEDIA_TYPE_LABELS,
  type CollectionBuilderTypeName,
  type CollectionMediaTypeName,
  type CollectionSyncModeName,
} from '@/lib/collections';
import {
  TICKET_STATUS_LABELS,
  ticketStatusTone,
  type TicketStatusName,
} from '@/lib/bulletin';

// The sub-nav keys: one per media type, then the Tickets lens, then admin-only Settings.
type TabKey = CollectionMediaTypeName | 'tickets' | 'settings';

const MEDIA_TABS: readonly CollectionMediaTypeName[] = ['movies', 'tv', 'books', 'audiobooks'];
const DEFAULT_TAB: TabKey = 'books';

function tabLabel(key: TabKey): string {
  if (key === 'tickets') return 'Tickets';
  if (key === 'settings') return 'Settings';
  return COLLECTION_MEDIA_TYPE_LABELS[key];
}

/** The sub-nav tabs the caller may see — Settings is admin-only (server re-checks regardless). */
function tabsFor(isAdmin: boolean): TabKey[] {
  const tabs: TabKey[] = [...MEDIA_TABS, 'tickets'];
  if (isAdmin) tabs.push('settings');
  return tabs;
}

/** Honor ?tab when it is a tab the caller may see, else fall back to Books (the default sub-section). */
function resolveTab(raw: string | null, available: readonly TabKey[]): TabKey {
  if (raw !== null && (available as readonly string[]).includes(raw)) return raw as TabKey;
  return DEFAULT_TAB;
}

const badgeToneClass: Record<'warn' | 'info' | 'ok' | 'muted', string> = {
  warn: 'badge--warn',
  info: 'badge--info',
  ok: 'badge--ok',
  muted: 'badge--muted',
};

// ── The composer draft ─────────────────────────────────────────────────────────────────────

interface RecipeDraft {
  id: string;
  name: string;
  builderType: CollectionBuilderTypeName;
  builderRef: string;
  targetLibrary: string;
  ordered: boolean;
  syncMode: CollectionSyncModeName;
}

const EMPTY_DRAFT: RecipeDraft = {
  id: '',
  name: '',
  builderType: 'hardcover_series',
  builderRef: '',
  targetLibrary: '',
  ordered: true,
  syncMode: 'sync',
};

// ── The shell ──────────────────────────────────────────────────────────────────────────────

function CollectionsContent({ isAdmin }: { isAdmin: boolean }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const available = tabsFor(isAdmin);
  const active = resolveTab(searchParams.get('tab'), available);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const selectTab = (key: TabKey) => {
    // A sub-section switch PUSHES a history entry (DESIGN-004 D-19) so Back returns to the prior
    // sub-section; scroll:false keeps the position (the sub-nav stays put — no reflow, ADR-015).
    const params = new URLSearchParams();
    params.set('tab', key);
    router.push(`${pathname}?${params.toString()}`, { scroll: false });
  };

  const onTabKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    const count = available.length;
    let next = index;
    if (e.key === 'ArrowRight') next = (index + 1) % count;
    else if (e.key === 'ArrowLeft') next = (index - 1 + count) % count;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = count - 1;
    else return;
    e.preventDefault();
    const target = available[next];
    if (target === undefined) return;
    selectTab(target);
    tabRefs.current[next]?.focus();
  };

  return (
    <div className="collections-page">
      <h1 className="page-title">{COLLECTIONS_NAME}</h1>

      <div className="library-tabs" role="tablist" aria-label={`${COLLECTIONS_NAME} sections`}>
        {available.map((key, index) => (
          <button
            key={key}
            ref={(el) => {
              tabRefs.current[index] = el;
            }}
            type="button"
            role="tab"
            id={`collectionstab-${key}`}
            aria-selected={active === key}
            aria-controls="collections-panel"
            tabIndex={active === key ? 0 : -1}
            data-testid={`collections-tab-${key}`}
            onClick={() => selectTab(key)}
            onKeyDown={(e) => onTabKeyDown(e, index)}
          >
            {tabLabel(key)}
          </button>
        ))}
      </div>

      <div id="collections-panel" role="tabpanel" aria-labelledby={`collectionstab-${active}`}>
        {active === 'tickets' ? (
          <TicketsSection isAdmin={isAdmin} />
        ) : active === 'settings' ? (
          <SettingsSection />
        ) : (
          <MediaSection key={active} mediaType={active} isAdmin={isAdmin} />
        )}
      </div>
    </div>
  );
}

export function CollectionsClient({ isAdmin }: { isAdmin: boolean }) {
  return (
    <Suspense fallback={<p className="muted">Loading…</p>}>
      <CollectionsContent isAdmin={isAdmin} />
    </Suspense>
  );
}

// ── A media-type sub-section (the provider-backed collection list) ───────────────────────────

function MediaSection({
  mediaType,
  isAdmin,
}: {
  mediaType: CollectionMediaTypeName;
  isAdmin: boolean;
}) {
  const utils = trpc.useUtils();
  const overviewQ = trpc.collections.overview.useQuery({ mediaType }, { retry: false });

  const [composerOpen, setComposerOpen] = useState(false);
  const [draft, setDraft] = useState<RecipeDraft>(EMPTY_DRAFT);
  const [editing, setEditing] = useState(false);

  const invalidate = () => void utils.collections.overview.invalidate({ mediaType });
  const label = COLLECTION_MEDIA_TYPE_LABELS[mediaType];

  if (overviewQ.isPending) {
    return (
      <section className="card">
        <p className="muted">Loading {label.toLowerCase()} collections…</p>
      </section>
    );
  }

  if (overviewQ.error) {
    return (
      <section className="card empty-state" data-testid="collections-error">
        <p>Could not load {label.toLowerCase()} collections.</p>
        <p className="muted">{describeMutationError(overviewQ.error)}</p>
      </section>
    );
  }

  const data = overviewQ.data;

  // Movies / TV — the Kometa auto-merge write path lands in a later step (PR4b). Honest placeholder,
  // never a fabricated row (D-09). The seam stays clean: when Kometa comes online this section renders
  // exactly like the Libretto ones below.
  if (!data.available) {
    return (
      <section className="card empty-state" data-testid="collections-placeholder">
        <p>{label} collections arrive in a later step.</p>
        <p className="muted">
          {label} collections are built through the estate&rsquo;s Kometa setup, and that write path is
          on the way. Books and Audiobooks collections are ready to add now.
        </p>
      </section>
    );
  }

  // Libretto is read LIVE — an outage degrades to an honest unreachable card, never a crash (D-02).
  if (!data.reachable) {
    return (
      <section className="card empty-state" data-testid="collections-unreachable">
        <p>The collections service is unreachable right now.</p>
        <p className="muted">
          This page reads the service that builds your book collections. Your existing collections on
          the Books walls are unaffected. Try again in a bit.
        </p>
      </section>
    );
  }

  const collectionByRecipe = new Map(
    data.collections.filter((c) => c.recipeId).map((c) => [c.recipeId as string, c]),
  );

  const openCreate = () => {
    setDraft(EMPTY_DRAFT);
    setEditing(false);
    setComposerOpen(true);
  };
  const openEdit = (recipe: (typeof data.recipes)[number]) => {
    setDraft({
      id: recipe.id,
      name: recipe.name ?? '',
      builderType: (recipe.builderType as CollectionBuilderTypeName | null) ?? 'hardcover_series',
      builderRef: recipe.builderRef ?? '',
      targetLibrary: '',
      ordered: recipe.ordered ?? true,
      syncMode: (recipe.syncMode as CollectionSyncModeName | null) ?? 'sync',
    });
    setEditing(true);
    setComposerOpen(true);
  };

  return (
    <>
      <div className="collections-toolbar">
        <p className="muted">
          These are the recipes that build your {label.toLowerCase()} collections. Everyone can add and
          edit up to the size limit of {data.sizeCap}; a bigger collection can be requested and an admin
          can approve the full size. Run history keeps only the most recent runs.
        </p>
        <button type="button" className="btn primary" onClick={openCreate} data-testid="collections-new">
          New collection
        </button>
      </div>

      {data.issues.length > 0 ? (
        <section className="card collections-attention" data-testid="collections-issues">
          <h2 className="collections-attention__title">Needs attention</h2>
          <ul className="collections-attention__list">
            {data.issues.map((iss, i) => (
              <li key={i}>
                <span className="badge badge--warn">recipe</span>{' '}
                {iss.recipeId ? `${iss.recipeId}: ` : ''}
                {iss.message ?? 'invalid recipe'}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {data.recipes.length === 0 ? (
        <section className="card empty-state" data-testid="collections-empty">
          <p className="muted">No {label.toLowerCase()} collections yet. Add one to start building.</p>
        </section>
      ) : (
        <ul className="collections-list" data-testid="collections-list">
          {data.recipes.map((recipe) => {
            const produced = collectionByRecipe.get(recipe.id);
            const findMissing = recipe.findMissing ?? false;
            return (
              <li key={recipe.id} className="collection-row" data-testid="collection-row">
                <div className="collection-row__main">
                  <span className="collection-row__title">{recipe.name ?? recipe.id}</span>
                  <span className="collection-row__meta">
                    <span className="badge badge--info">
                      {COLLECTION_BUILDER_LABELS[recipe.builderType as CollectionBuilderTypeName] ??
                        recipe.builderType ??
                        'recipe'}
                    </span>
                    {recipe.builderRef ? <span className="muted">{recipe.builderRef}</span> : null}
                    {produced ? (
                      <span className="muted" data-testid="collection-size">
                        {produced.itemCount ?? 0} in collection
                        <span className="collection-row__cap"> / {data.sizeCap} limit</span>
                      </span>
                    ) : (
                      <span className="muted">not built yet</span>
                    )}
                  </span>
                </div>
                <div className="collection-row__actions">
                  {/* The find-missing puck reserves its slot; ON/OFF recolors, never reflows (ADR-015).
                      Read-only in this step — the toggle wiring is a later step. */}
                  <span
                    className={`acq-puck ${findMissing ? 'acq-puck--on' : 'acq-puck--off'}`}
                    data-testid="find-missing-puck"
                    title={
                      findMissing
                        ? "Find missing on: pulls the collection's missing titles on each run"
                        : 'Find missing off'
                    }
                  >
                    {findMissing ? 'Finds missing' : 'No find'}
                  </span>
                  <ApplyButton recipeId={recipe.id} onDone={invalidate} />
                  <button type="button" className="btn sm" onClick={() => openEdit(recipe)}>
                    Edit
                  </button>
                  {isAdmin ? <DeleteControl recipeId={recipe.id} onDone={invalidate} /> : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <ComposerModal
        open={composerOpen}
        mediaType={mediaType}
        draft={draft}
        setDraft={setDraft}
        editing={editing}
        sizeCap={data.sizeCap}
        capBypass={data.capBypass}
        onClose={() => setComposerOpen(false)}
        onSaved={() => {
          setComposerOpen(false);
          invalidate();
        }}
      />
    </>
  );
}

function ApplyButton({ recipeId, onDone }: { recipeId: string; onDone: () => void }) {
  const [runId, setRunId] = useState<string | null>(null);
  const apply = trpc.collections.applyRecipe.useMutation({
    onSuccess: (res) => {
      setRunId(res.runId);
      onDone();
    },
  });
  const runQ = trpc.collections.run.useQuery(
    { runId: runId ?? '' },
    {
      enabled: runId !== null,
      refetchInterval: (q) => (q.state.data?.status === 'running' ? 2500 : false),
    },
  );
  const counts = runQ.data?.counts;
  return (
    <span className="collection-row__apply">
      <ConfirmButton
        className="btn sm"
        label="Run now"
        confirmLabel="Run it?"
        restingAriaLabel="Run this collection now — click twice to confirm"
        confirmAriaLabel="Confirm running this collection now"
        onConfirm={() => apply.mutate({ scope: recipeId })}
      />
      {counts ? (
        <span className="muted collection-row__runcounts" data-testid="collection-runcounts">
          {counts.matched ?? 0} matched · {counts.missing ?? 0} missing
          {counts.acquired ? ` · ${counts.acquired} pulled` : ''}
        </span>
      ) : null}
    </span>
  );
}

function DeleteControl({ recipeId, onDone }: { recipeId: string; onDone: () => void }) {
  const [also, setAlso] = useState(false);
  const remove = trpc.collections.remove.useMutation({ onSuccess: onDone });
  return (
    <span className="collection-row__delete">
      <label className="collection-row__alsodelete" title="Also delete the built collection in the library">
        <input type="checkbox" checked={also} onChange={(e) => setAlso(e.target.checked)} /> also delete
      </label>
      <ConfirmButton
        className="btn sm danger"
        label="Delete"
        confirmLabel={also ? 'Delete both?' : 'Delete recipe?'}
        restingAriaLabel="Delete this collection recipe — click twice to confirm"
        confirmAriaLabel="Confirm deleting this collection recipe"
        onConfirm={() => remove.mutate({ id: recipeId, deleteCollection: also })}
      />
    </span>
  );
}

// ── The composer (Modal — D-03) ──────────────────────────────────────────────────────────────

function ComposerModal({
  open,
  mediaType,
  draft,
  setDraft,
  editing,
  sizeCap,
  capBypass,
  onClose,
  onSaved,
}: {
  open: boolean;
  mediaType: CollectionMediaTypeName;
  draft: RecipeDraft;
  setDraft: (d: RecipeDraft) => void;
  editing: boolean;
  sizeCap: number;
  capBypass: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<{
    name?: string | null;
    workCount?: number | null;
    issues: string[];
  } | null>(null);
  // The over-cap Modal state (size = the resolved membership that breached the cap; the server resolves
  // the authoritative size itself on requestOverride — this drives only the copy).
  const [overCapSize, setOverCapSize] = useState<number | null>(null);
  const [overCapOpen, setOverCapOpen] = useState(false);

  const payload = {
    id: draft.id.trim(),
    ...(draft.name.trim() ? { name: draft.name.trim() } : {}),
    builderType: draft.builderType,
    builderRef: draft.builderRef.trim(),
    ...(draft.targetLibrary.trim() ? { targetLibrary: draft.targetLibrary.trim() } : {}),
    ordered: draft.ordered,
    syncMode: draft.syncMode,
  };
  const canSubmit = payload.id.length > 0 && payload.builderRef.length > 0;
  const collectionLabel = payload.name ?? payload.id;

  const validate = trpc.collections.validate.useMutation({
    onError: (e) => setError(describeMutationError(e)),
    onSuccess: (res) => {
      setError(null);
      setPreview({ name: res.resolved?.name ?? null, workCount: res.resolved?.workCount ?? null, issues: res.issues });
    },
  });
  const upsert = trpc.collections.upsert.useMutation({
    onError: (e) => {
      if (appCodeOf(e) === 'COLLECTION_SIZE_CAP_EXCEEDED') {
        setOverCapSize(preview?.workCount ?? null);
        setOverCapOpen(true);
        return;
      }
      setError(describeMutationError(e));
    },
    onSuccess: onSaved,
  });
  const requestOverride = trpc.collections.requestOverride.useMutation({
    onError: (e) => setError(describeMutationError(e)),
  });

  function submitSave() {
    if (!canSubmit) return;
    // Pre-empt the round trip when a non-admin has already previewed a too-large membership (the server
    // enforces regardless; this just opens the ticket Modal straight away).
    if (!capBypass && preview?.workCount != null && preview.workCount > sizeCap) {
      setOverCapSize(preview.workCount);
      setOverCapOpen(true);
      return;
    }
    upsert.mutate(payload);
  }

  return (
    <Modal
      open={open}
      title={editing ? 'Edit collection' : 'New collection'}
      onClose={onClose}
      banner={error ? <p className="alert" role="alert">{error}</p> : null}
    >
      <OverCapModal
        open={overCapOpen}
        size={overCapSize}
        cap={sizeCap}
        collectionName={collectionLabel}
        filing={requestOverride.isPending}
        filed={requestOverride.isSuccess}
        onRequest={() => requestOverride.mutate({ ...payload, mediaType })}
        onClose={() => {
          setOverCapOpen(false);
          setOverCapSize(null);
          requestOverride.reset();
        }}
      />
      <form
        className="composer-form"
        onSubmit={(e) => {
          e.preventDefault();
          submitSave();
        }}
      >
        <label className="composer-field">
          <span>Collection id</span>
          <input
            className="library-search"
            value={draft.id}
            disabled={editing}
            placeholder="stormlight-archive"
            onChange={(e) => setDraft({ ...draft, id: e.target.value })}
          />
        </label>
        <label className="composer-field">
          <span>Name</span>
          <input
            className="library-search"
            value={draft.name}
            placeholder="The Stormlight Archive"
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          />
        </label>
        <label className="composer-field">
          <span>Builder</span>
          <select
            className="library-search"
            value={draft.builderType}
            onChange={(e) =>
              setDraft({ ...draft, builderType: e.target.value as CollectionBuilderTypeName })
            }
          >
            {COLLECTION_BUILDER_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <label className="composer-field">
          <span>Reference</span>
          <input
            className="library-search"
            value={draft.builderRef}
            placeholder="the-stormlight-archive"
            onChange={(e) => setDraft({ ...draft, builderRef: e.target.value })}
          />
        </label>
        <label className="composer-field">
          <span>Target library</span>
          <input
            className="library-search"
            value={draft.targetLibrary}
            placeholder="optional (a library target)"
            onChange={(e) => setDraft({ ...draft, targetLibrary: e.target.value })}
          />
        </label>
        <div className="composer-row">
          <label className="composer-inline">
            <input
              type="checkbox"
              checked={draft.ordered}
              onChange={(e) => setDraft({ ...draft, ordered: e.target.checked })}
            />
            Keep reading order
          </label>
          <label className="composer-inline">
            Sync
            <select
              className="library-search composer-sync"
              value={draft.syncMode}
              onChange={(e) => setDraft({ ...draft, syncMode: e.target.value as CollectionSyncModeName })}
            >
              <option value="sync">replace to match</option>
              <option value="append">add only</option>
            </select>
          </label>
        </div>

        {preview ? (
          <div className="composer-preview" data-testid="composer-preview">
            {preview.name ? (
              <p>
                Resolved to <strong>{preview.name}</strong>
                {preview.workCount != null ? `, ${preview.workCount} works` : ''}
                {preview.workCount === 0 ? ' (this reference has no works, check it)' : ''}
              </p>
            ) : (
              <p className="muted">Could not resolve this reference. Check it before saving.</p>
            )}
            {preview.issues.length > 0 ? (
              <ul className="composer-preview__issues">
                {preview.issues.map((m, i) => (
                  <li key={i}>{m}</li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}

        <div className="composer-actions">
          <button
            type="button"
            className="btn sm"
            disabled={!canSubmit || validate.isPending}
            data-testid="composer-preview-btn"
            onClick={() => validate.mutate(payload)}
          >
            {validate.isPending ? 'Checking…' : 'Preview'}
          </button>
          <button type="submit" className="btn sm primary" disabled={!canSubmit || upsert.isPending}>
            {upsert.isPending ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/**
 * The over-cap Modal (D-11): a non-admin whose collection exceeds the size cap sees this explanatory,
 * multi-field confirm (hard rule 8 ⇒ a Modal, never window.confirm/ConfirmButton). The primary action
 * files a collection_override ticket CARRYING the full draft + mediaType so an admin can approve the
 * full size; once filed it acknowledges lightly. Overlay — no neighbor reflow (ADR-015).
 */
function OverCapModal({
  open,
  size,
  cap,
  collectionName,
  filing,
  filed,
  onRequest,
  onClose,
}: {
  open: boolean;
  size: number | null;
  cap: number;
  collectionName: string;
  filing: boolean;
  filed: boolean;
  onRequest: () => void;
  onClose: () => void;
}) {
  return (
    <Modal open={open} title="Collection is over the limit" onClose={onClose}>
      <div className="over-cap" data-testid="collection-over-cap">
        {filed ? (
          <>
            <p>
              Request sent. Track it under Tickets, where an admin can approve the full size for{' '}
              <strong>{collectionName}</strong>.
            </p>
            <div className="form-actions">
              <button type="button" className="btn primary" onClick={onClose}>
                Done
              </button>
            </div>
          </>
        ) : (
          <>
            <p>
              This collection is larger than the limit of {cap}
              {size != null ? ` (it resolves to ${size})` : ''}. Request it and an admin can approve the
              full size.
            </p>
            <div className="form-actions">
              <button
                type="button"
                className="btn primary"
                disabled={filing}
                onClick={onRequest}
                data-testid="collection-over-cap-request"
              >
                {filing ? 'Sending…' : 'Request it'}
              </button>
              <button type="button" className="btn" disabled={filing} onClick={onClose}>
                Cancel
              </button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}

// ── The Tickets sub-section (D-11) ───────────────────────────────────────────────────────────

function TicketStatusChip({ status }: { status: string }) {
  const known = (['open', 'in_progress', 'complete', 'rejected'] as const).includes(
    status as TicketStatusName,
  );
  const tone = known ? ticketStatusTone(status as TicketStatusName) : 'muted';
  const label = known ? TICKET_STATUS_LABELS[status as TicketStatusName] : status;
  return <span className={`badge ${badgeToneClass[tone]}`}>{label}</span>;
}

function TicketMeta({
  ticket,
}: {
  ticket: {
    collectionName: string;
    mediaType: string | null;
    size: number | null;
    status: string;
  };
}) {
  return (
    <span className="collection-row__meta">
      <TicketStatusChip status={ticket.status} />
      {ticket.mediaType ? (
        <span className="badge badge--muted">
          {COLLECTION_MEDIA_TYPE_LABELS[ticket.mediaType as CollectionMediaTypeName] ??
            ticket.mediaType}
        </span>
      ) : null}
      {ticket.size != null ? <span className="muted">{ticket.size} items</span> : null}
    </span>
  );
}

function TicketsSection({ isAdmin }: { isAdmin: boolean }) {
  const utils = trpc.useUtils();
  const mineQ = trpc.collections.myTickets.useQuery();
  const allQ = trpc.collections.allTickets.useQuery(undefined, { enabled: isAdmin });

  const invalidate = () => {
    void utils.collections.myTickets.invalidate();
    if (isAdmin) void utils.collections.allTickets.invalidate();
  };

  return (
    <div className="collections-tickets">
      <p className="muted collections-tickets__intro">
        Over-limit collection requests file a ticket. You can watch your own here; these tickets are
        also visible in the <Link href="/bulletin">Tickets</Link> helpdesk.
      </p>

      <section className="collections-ticketgroup">
        <h2 className="collections-attention__title">Your requests</h2>
        {mineQ.isPending ? (
          <p className="muted">Loading your requests…</p>
        ) : mineQ.error ? (
          <p className="alert" role="alert">
            {describeMutationError(mineQ.error)}
          </p>
        ) : mineQ.data.tickets.length === 0 ? (
          <section className="card empty-state" data-testid="my-tickets-empty">
            <p className="muted">
              You have no over-limit requests. Add a collection larger than the limit to file one.
            </p>
          </section>
        ) : (
          <ul className="collections-list" data-testid="my-tickets-list">
            {mineQ.data.tickets.map((t) => (
              <li key={t.id} className="collection-row" data-testid="my-ticket-row">
                <div className="collection-row__main">
                  <span className="collection-row__title">{t.collectionName}</span>
                  <TicketMeta ticket={t} />
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {isAdmin ? (
        <section className="collections-ticketgroup" data-testid="all-tickets-group">
          <h2 className="collections-attention__title">All requests</h2>
          {allQ.isPending ? (
            <p className="muted">Loading requests…</p>
          ) : allQ.error ? (
            <p className="alert" role="alert">
              {describeMutationError(allQ.error)}
            </p>
          ) : allQ.data.tickets.length === 0 ? (
            <section className="card empty-state" data-testid="all-tickets-empty">
              <p className="muted">No over-limit requests to review.</p>
            </section>
          ) : (
            <ul className="collections-list" data-testid="all-tickets-list">
              {allQ.data.tickets.map((t) => (
                <AdminTicketRow key={t.id} ticket={t} onDone={invalidate} />
              ))}
            </ul>
          )}
        </section>
      ) : null}
    </div>
  );
}

function AdminTicketRow({
  ticket,
  onDone,
}: {
  ticket: {
    id: string;
    status: string;
    collectionName: string;
    mediaType: string | null;
    size: number | null;
  };
  onDone: () => void;
}) {
  const [declining, setDeclining] = useState(false);
  const [reason, setReason] = useState('');
  const approve = trpc.collections.approveOverride.useMutation({ onSuccess: onDone });
  const decline = trpc.collections.declineOverride.useMutation({
    onSuccess: () => {
      setDeclining(false);
      setReason('');
      onDone();
    },
  });
  const actionable = ticket.status === 'open' || ticket.status === 'in_progress';

  return (
    <li className="collection-row" data-testid="admin-ticket-row">
      <div className="collection-row__main">
        <span className="collection-row__title">{ticket.collectionName}</span>
        <TicketMeta ticket={ticket} />
      </div>
      {actionable ? (
        declining ? (
          <div className="collection-row__actions">
            <input
              type="text"
              className="library-search"
              placeholder="Reason (the requester sees this)"
              aria-label="Decline reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
            <button
              type="button"
              className="btn sm danger"
              disabled={reason.trim().length === 0 || decline.isPending}
              onClick={() => decline.mutate({ ticketId: ticket.id, reason: reason.trim() })}
            >
              {decline.isPending ? 'Declining…' : 'Decline'}
            </button>
            <button type="button" className="btn sm" onClick={() => setDeclining(false)}>
              Cancel
            </button>
          </div>
        ) : (
          <div className="collection-row__actions">
            <ConfirmButton
              className="btn sm primary"
              label="Approve"
              confirmLabel="Approve it?"
              restingAriaLabel="Approve this request and build the full collection — click twice to confirm"
              confirmAriaLabel="Confirm approving this request"
              onConfirm={() => approve.mutate({ ticketId: ticket.id })}
            />
            <button type="button" className="btn sm" onClick={() => setDeclining(true)}>
              Decline
            </button>
          </div>
        )
      ) : null}
    </li>
  );
}

// ── The Settings sub-section (admin only — D-10) ─────────────────────────────────────────────

function SettingsSection() {
  const utils = trpc.useUtils();
  const settingsQ = trpc.collections.settings.useQuery();
  const [value, setValue] = useState<string>('');
  const [saved, setSaved] = useState(false);
  const setCap = trpc.collections.setSizeCap.useMutation({
    onSuccess: () => {
      setSaved(true);
      void utils.collections.settings.invalidate();
    },
  });

  // The field shows the caller's edit once they type; until then it mirrors the loaded limit.
  const current = settingsQ.data?.sizeCap;
  const fieldValue = value !== '' ? value : current !== undefined ? String(current) : '';
  const parsed = Number.parseInt(fieldValue, 10);
  const valid = Number.isFinite(parsed) && parsed >= 1 && parsed <= 100000;

  return (
    <div className="collections-settings">
      <section className="card collections-settingcard">
        <h2 className="collections-attention__title">Collection size limit</h2>
        <p className="muted">
          The most items a collection can have before it needs a request. Everyone can add and edit up to
          this limit; admins are not bound by it.
        </p>
        {settingsQ.isPending ? (
          <p className="muted">Loading the limit…</p>
        ) : settingsQ.error ? (
          <p className="alert" role="alert">
            {describeMutationError(settingsQ.error)}
          </p>
        ) : (
          <form
            className="collections-caplimit"
            onSubmit={(e) => {
              e.preventDefault();
              if (valid) setCap.mutate({ value: parsed });
            }}
          >
            <label className="composer-field">
              <span>Size limit</span>
              <input
                type="number"
                min={1}
                max={100000}
                className="library-search collections-capinput"
                value={fieldValue}
                data-testid="collections-cap-input"
                onChange={(e) => {
                  setValue(e.target.value);
                  setSaved(false);
                }}
              />
            </label>
            <button
              type="submit"
              className="btn primary"
              disabled={!valid || setCap.isPending}
              data-testid="collections-cap-save"
            >
              {setCap.isPending ? 'Saving…' : 'Save limit'}
            </button>
            {saved ? (
              <span className="badge badge--ok" data-testid="collections-cap-saved">
                Saved
              </span>
            ) : null}
            {setCap.error ? (
              <p className="alert" role="alert">
                {describeMutationError(setCap.error)}
              </p>
            ) : null}
          </form>
        )}
      </section>

      <section className="card collections-settingcard" data-testid="collections-findmissing-seam">
        <h2 className="collections-attention__title">Find missing grants</h2>
        <p className="muted">
          Find missing grants are managed on the <Link href="/admin">roles page</Link>. A granted role can
          turn on pulling a collection&rsquo;s missing titles.
        </p>
      </section>
    </div>
  );
}
