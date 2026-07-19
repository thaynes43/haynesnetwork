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
import { ConfirmButton, MediaAction, PhaseChip, ReservedActionSlot } from '@hnet/ui';
import { Modal } from '@/components/modal';
import { trpc } from '@/lib/trpc-client';
import { describeMutationError } from '@/lib/app-error';
import {
  COLLECTIONS_NAME,
  COLLECTION_BUILDER_LABELS,
  COLLECTION_MEDIA_TYPE_LABELS,
  collectionProgress,
  isKometaMedia,
  type CollectionBuilderTypeName,
  type CollectionMediaTypeName,
} from '@/lib/collections';
import { CollectionCatch } from '@/components/collection-catch';
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

// DESIGN-044 — the add/edit composer is no longer a Modal on this page. "New collection" and every Edit
// PUSH the full-page builder at `/collections/new?tab=..` / `/collections/<id>/edit?tab=..` (the owner-ruled
// replacement for the tiny popup). Back returns to this list (D-01/D-19). The RecipeDraft/composer machinery
// that used to live here moved to builder-client.tsx.

// ── Read-only (books) + hand-file (Kometa) collections ───────────────────────────────────────
// Books/Audiobooks: a read-only row is a hand-made Kavita/Audiobookshelf collection with no Libretto
// recipe — listed so the tab is complete, with a short "made in ..." chip (owner verbosity critique).
// Movies/TV: the estate's Kometa collections are now EDITABLE in place (owner ruling 2026-07-18) — see
// HandCollection below; there is no read-only Kometa group.

interface ReadOnlyCollection {
  name: string;
  itemCount: number | null;
  managedBy: 'kometa_config' | 'hand_made';
  source: 'kavita' | 'audiobookshelf' | null;
}

/** The muted state chip for a book read-only row — short (owner tone, no em-dashes, no names). */
function readOnlyChipLabel(row: ReadOnlyCollection): string {
  if (row.source === 'audiobookshelf') return 'made in Audiobookshelf';
  return 'made in Kavita';
}

// A Kometa hand-authored config collection (owner ruling 2026-07-18) or a Defaults-produced mirror row.
// `source: 'hand'` lives in a config file the app can edit; `source: 'default'` has no file (never
// editable). One list, source-badged; editable rows get an active Edit, the rest a disabled Edit + tooltip.
interface HandCollection {
  name: string;
  file: string | null;
  source: 'hand' | 'default';
  builderType: string | null;
  builderRef: string | null;
  findMissing: boolean;
  editable: boolean;
  editableReason: string | null;
  itemCount: number | null;
  mediaType: CollectionMediaTypeName;
}

/** The short SOURCE badge for a Kometa row — the owner's verbosity critique (was a long sentence). */
function kometaSourceLabel(source: 'managed' | 'hand' | 'default'): string {
  return source === 'managed' ? 'Added here' : 'Kometa config';
}

// ── The shell ──────────────────────────────────────────────────────────────────────────────

function CollectionsContent({ isAdmin }: { isAdmin: boolean }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const available = tabsFor(isAdmin);
  const active = resolveTab(searchParams.get('tab'), available);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  // DESIGN-043 D-01/D-09 amend (2026-07-18, owner-ruled) — the Library wall drill nav-out deep-links
  // here as `?tab=<mediaType>&edit=<recipeId>` (or `&new=1`). The matching MediaSection opens the
  // composer pre-loaded with that recipe (the existing openEdit path) and then CLEARS the param from
  // the URL (a REPLACE, so refresh/Back behave). An unknown recipeId just shows the tab, no error.
  const editRecipeId = searchParams.get('edit');
  const wantsNew = searchParams.get('new') === '1';

  const clearDeepLink = () => {
    // Drop `edit`/`new` but keep the resolved tab — a replace (not a push) so Back/refresh land on the
    // plain sub-section, never re-triggering the composer.
    const params = new URLSearchParams();
    params.set('tab', active);
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  };

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
          <MediaSection
            key={active}
            mediaType={active}
            isAdmin={isAdmin}
            deepLinkEditRecipeId={editRecipeId}
            deepLinkNew={wantsNew}
            onDeepLinkConsumed={clearDeepLink}
          />
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
  deepLinkEditRecipeId = null,
  deepLinkNew = false,
  onDeepLinkConsumed,
}: {
  mediaType: CollectionMediaTypeName;
  isAdmin: boolean;
  /** DESIGN-043 D-01/D-09 amend — a wall-drill deep link's `?edit=<recipeId>` (null = none). */
  deepLinkEditRecipeId?: string | null;
  /** `?new=1` — open the create composer. */
  deepLinkNew?: boolean;
  /** Clears the `edit`/`new` param from the URL once consumed (a replace). */
  onDeepLinkConsumed?: () => void;
}) {
  const router = useRouter();
  const utils = trpc.useUtils();
  const overviewQ = trpc.collections.overview.useQuery({ mediaType }, { retry: false });

  // One search box filters BOTH groups by title substring (client-side — 400+ config rows must stay
  // usable). Filtering re-renders list CONTENT (a deliberate content change, ADR-015); the box itself
  // holds its place and never reflows.
  const [search, setSearch] = useState('');

  const invalidate = () => void utils.collections.overview.invalidate({ mediaType });
  const label = COLLECTION_MEDIA_TYPE_LABELS[mediaType];

  // ── The builder-page openers (DESIGN-044 D-01) — add/edit is now a full PAGE, not a Modal. Each opener
  //    PUSHES the builder route (Back returns to this list, D-19); the tab seeds the provider binding, and a
  //    hand-authored Kometa collection carries its config file so the page routes Save to editHandCollection.
  const openCreate = () => router.push(`/collections/new?tab=${mediaType}`);
  const openEdit = (recipe: { id: string }) =>
    router.push(`/collections/${encodeURIComponent(recipe.id)}/edit?tab=${mediaType}`);
  const openEditHand = (hand: HandCollection) => {
    const params = new URLSearchParams({ tab: mediaType });
    if (hand.file) params.set('hand', hand.file);
    router.push(`/collections/${encodeURIComponent(hand.name)}/edit?${params.toString()}`);
  };

  // DESIGN-044 D-01 (was DESIGN-043 D-09 modal) — a wall-drill deep link (`?edit=<recipeId>` / `?new=1`) now
  // RESOLVES to a PUSH of the builder page. Consume it exactly once as soon as the overview loads (so an
  // `edit` link can carry the media tab the page needs); an unknown recipe id just clears the param and stays
  // on the list (no error, D-01). The push replaces this sub-section in history so Back lands on the list.
  const [deepLinkConsumed, setDeepLinkConsumed] = useState(false);
  const wantsDeepLink = deepLinkEditRecipeId !== null || deepLinkNew;
  if (!deepLinkConsumed && wantsDeepLink && overviewQ.data) {
    setDeepLinkConsumed(true);
    if (deepLinkEditRecipeId !== null) {
      const recipe = overviewQ.data.recipes.find((r) => r.id === deepLinkEditRecipeId);
      onDeepLinkConsumed?.();
      if (recipe) openEdit(recipe);
    } else if (deepLinkNew) {
      onDeepLinkConsumed?.();
      openCreate();
    }
  }

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

  // Movies/TV render ONE list (app-managed recipes + the estate's hand-file/Defaults collections, each
  // source-badged — owner ruling 2026-07-18). Books keep two groups (managed + read-only). One search box
  // filters everything by title substring.
  const isKometa = isKometaMedia(mediaType);
  const readOnly: ReadOnlyCollection[] = data.readOnly ?? [];
  const handCollections: HandCollection[] = (data.handCollections ?? []) as HandCollection[];
  const q = search.trim().toLowerCase();
  const matches = (name: string) => q === '' || name.toLowerCase().includes(q);
  const filteredRecipes = data.recipes.filter((r) => matches(r.name ?? r.id));
  const filteredReadOnly = readOnly.filter((r) => matches(r.name));
  const filteredHand = handCollections.filter((h) => matches(h.name));
  const secondaryCount = isKometa ? handCollections.length : readOnly.length;
  const totalCount = data.recipes.length + secondaryCount;
  const noMatches = isKometa
    ? filteredRecipes.length === 0 && filteredHand.length === 0
    : filteredRecipes.length === 0 && filteredReadOnly.length === 0;

  return (
    <>
      <div className="collections-toolbar">
        <p className="muted">
          These are the recipes that build your {label.toLowerCase()} collections. Everyone can add and
          edit them; a very large collection files a quick request for an admin to approve. Run history keeps
          only the most recent runs.
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

      {data.pendingPrs.length > 0 ? (
        <section className="card collections-attention" data-testid="collections-pending-prs">
          <h2 className="collections-attention__title">Awaiting merge</h2>
          <p className="muted">
            These changes need an admin to merge the estate config before the next collection run picks
            them up.
          </p>
          <ul className="collections-attention__list">
            {data.pendingPrs.map((pr) => (
              <li key={pr.number}>
                <span className="badge badge--info">pending merge</span>{' '}
                <a href={pr.url} target="_blank" rel="noreferrer">
                  {pr.title}
                </a>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {totalCount === 0 ? (
        <section className="card empty-state" data-testid="collections-empty">
          <p className="muted">No {label.toLowerCase()} collections yet. Add one to start building.</p>
        </section>
      ) : (
        <>
          <div className="collections-search">
            <input
              type="search"
              className="library-search"
              data-testid="collections-search"
              placeholder={`Search ${label.toLowerCase()} collections`}
              aria-label={`Search ${label.toLowerCase()} collections`}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>

          {noMatches ? (
            <p className="muted" data-testid="collections-no-matches">
              Nothing matches that search.
            </p>
          ) : null}

          {isKometa ? (
            /* Movies/TV — ONE list: app-managed recipes + the estate's hand-file/Defaults collections,
               each with a short SOURCE badge ("Added here" / "Kometa config" — owner ruling 2026-07-18). */
            filteredRecipes.length > 0 || filteredHand.length > 0 ? (
              <section className="collections-group" data-testid="collections-managed-group">
                <ul className="collections-list" data-testid="collections-list">
                  {filteredRecipes.map((recipe) => (
                    <ManagedRecipeRow
                      key={`m-${recipe.id}`}
                      recipe={recipe}
                      produced={collectionByRecipe.get(recipe.id)}
                      canFindMissing={data.canFindMissing}
                      canForceSearch={data.canForceSearch}
                      isAdmin={isAdmin}
                      mediaType={mediaType}
                      showSource
                      onEdit={() => openEdit(recipe)}
                      onDone={invalidate}
                    />
                  ))}
                  {filteredHand.map((hand, i) => (
                    <HandCollectionRow
                      key={`h-${i}-${hand.name}`}
                      hand={hand}
                      canFindMissing={data.canFindMissing}
                      isAdmin={isAdmin}
                      onEdit={() => openEditHand(hand)}
                      onDone={invalidate}
                    />
                  ))}
                </ul>
              </section>
            ) : null
          ) : (
            <>
              {filteredRecipes.length > 0 ? (
                <section className="collections-group" data-testid="collections-managed-group">
                  <h2 className="collections-attention__title">Managed here</h2>
                  <ul className="collections-list" data-testid="collections-list">
                    {filteredRecipes.map((recipe) => (
                      <ManagedRecipeRow
                        key={recipe.id}
                        recipe={recipe}
                        produced={collectionByRecipe.get(recipe.id)}
                        canFindMissing={data.canFindMissing}
                        canForceSearch={data.canForceSearch}
                        isAdmin={isAdmin}
                        mediaType={mediaType}
                        showSource={false}
                        onEdit={() => openEdit(recipe)}
                        onDone={invalidate}
                      />
                    ))}
                  </ul>
                </section>
              ) : null}

              {filteredReadOnly.length > 0 ? (
                <section className="collections-group" data-testid="collections-readonly-group">
                  <h2 className="collections-attention__title">Made in your library apps</h2>
                  <p className="muted collections-group__note">
                    These were made outside the app, so they show here to keep the list complete. There is
                    nothing to change on them here.
                  </p>
                  <ul className="collections-list" data-testid="collections-readonly-list">
                    {filteredReadOnly.map((row, i) => (
                      <li
                        key={`readonly-${i}-${row.name}`}
                        className="collection-row"
                        data-testid="collection-row-readonly"
                      >
                        <div className="collection-row__main">
                          <span className="collection-row__title">{row.name}</span>
                          <span className="collection-row__meta">
                            <span className="muted" data-testid="collection-size">
                              {row.itemCount ?? 0} in collection
                            </span>
                          </span>
                        </div>
                        <div className="collection-row__actions">
                          <span className="badge badge--muted" data-testid="collection-readonly-chip">
                            {readOnlyChipLabel(row)}
                          </span>
                        </div>
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}
            </>
          )}
        </>
      )}
    </>
  );
}

/**
 * One app-managed recipe row (books "Managed here" group + the Movies/TV unified list). On Kometa it shows
 * the short "Added here" source badge; Libretto keeps the on-demand Apply. The row anatomy is the shared
 * grid so armed/pending states only recolor, never reflow (ADR-015).
 */
function ManagedRecipeRow({
  recipe,
  produced,
  canFindMissing,
  canForceSearch,
  isAdmin,
  mediaType,
  showSource,
  onEdit,
  onDone,
}: {
  recipe: {
    id: string;
    name?: string | null;
    builderType?: string | null;
    builderRef?: string | null;
    findMissing?: boolean | null;
    missingCount?: number | null;
    state?: 'live' | 'pending_run' | null;
  };
  produced: { itemCount: number | null } | undefined;
  canFindMissing: boolean;
  /** ADR-071 — the caller may fire the on-demand collection Force Search (books force_search_book grant). */
  canForceSearch: boolean;
  isAdmin: boolean;
  mediaType: CollectionMediaTypeName;
  showSource: boolean;
  onEdit: () => void;
  onDone: () => void;
}) {
  const findMissing = recipe.findMissing ?? false;
  return (
    <li className="collection-row" data-testid="collection-row">
      <div className="collection-row__main">
        <span className="collection-row__title">{recipe.name ?? recipe.id}</span>
        <span className="collection-row__meta">
          {showSource ? (
            <span className="badge badge--ok" data-testid="collection-source-badge">
              {kometaSourceLabel('managed')}
            </span>
          ) : null}
          <span className="badge badge--info">
            {COLLECTION_BUILDER_LABELS[recipe.builderType as CollectionBuilderTypeName] ??
              recipe.builderType ??
              'recipe'}
          </span>
          {recipe.builderRef ? <span className="muted">{recipe.builderRef}</span> : null}
          {produced ? (
            // Owner REDESIGN ruling 2026-07-18 — the gamified held/total read (never the cap). When the
            // mirror knows the missing count (Libretto books/audiobooks), a complete collection celebrates
            // "caught em all"; otherwise we honestly show just what is in the collection (no cap chrome).
            recipe.missingCount != null ? (
              <CollectionCatch
                progress={collectionProgress(
                  produced.itemCount ?? 0,
                  (produced.itemCount ?? 0) + recipe.missingCount,
                )}
              />
            ) : (
              <span className="muted" data-testid="collection-size">
                {produced.itemCount ?? 0} in collection
              </span>
            )
          ) : recipe.state === 'pending_run' ? (
            <span className="muted" data-testid="collection-pending">
              pending next collection run
            </span>
          ) : (
            <span className="muted">not built yet</span>
          )}
        </span>
      </div>
      <div className="collection-row__actions">
        <FindMissingPuck
          recipeId={recipe.id}
          mediaType={mediaType}
          findMissing={findMissing}
          canToggle={canFindMissing}
          onDone={onDone}
        />
        {isKometaMedia(mediaType) || !canForceSearch ? null : (
          <CollectionForceSearchButton
            recipeId={recipe.id}
            missingCount={recipe.missingCount ?? null}
            onDone={onDone}
          />
        )}
        <button type="button" className="btn sm" onClick={onEdit}>
          Edit
        </button>
        {isAdmin ? (
          <DeleteControl
            recipeId={recipe.id}
            recipeName={recipe.name ?? recipe.id}
            mediaType={mediaType}
            onDone={onDone}
          />
        ) : null}
      </div>
    </li>
  );
}

/**
 * One of the estate's hand-authored Kometa collections (owner ruling 2026-07-18) or a Defaults-produced
 * mirror row. Carries the short "Kometa config" source badge. Editable rows (a single allowlisted builder
 * with a valid ref) get an active Edit that surgically splices that collection's ref in its config file
 * (human-merged PR); non-editable rows show a DISABLED Edit with the honest reason as its tooltip — the app
 * never does a lossy rewrite of config it cannot fully model. Find-missing + delete act on the config file.
 */
function HandCollectionRow({
  hand,
  canFindMissing,
  isAdmin,
  onEdit,
  onDone,
}: {
  hand: HandCollection;
  canFindMissing: boolean;
  isAdmin: boolean;
  onEdit: () => void;
  onDone: () => void;
}) {
  const builderLabel = hand.builderType
    ? (COLLECTION_BUILDER_LABELS[hand.builderType as CollectionBuilderTypeName] ?? hand.builderType)
    : null;
  return (
    <li className="collection-row" data-testid="collection-row-hand">
      <div className="collection-row__main">
        <span className="collection-row__title">{hand.name}</span>
        <span className="collection-row__meta">
          <span className="badge badge--muted" data-testid="collection-source-badge">
            {kometaSourceLabel(hand.source)}
          </span>
          {builderLabel ? <span className="badge badge--info">{builderLabel}</span> : null}
          {hand.builderRef ? <span className="muted">{hand.builderRef}</span> : null}
          <span className="muted" data-testid="collection-size">
            {hand.itemCount ?? 0} in collection
          </span>
        </span>
      </div>
      <div className="collection-row__actions">
        {/* Find-missing applies to any hand-file collection (a surgical, human-merged splice of the
            add_missing keys); a Defaults-produced row has no file, so no toggle. */}
        {hand.source === 'hand' && hand.file ? (
          <FindMissingPuck
            recipeId={hand.name}
            mediaType={hand.mediaType}
            findMissing={hand.findMissing}
            canToggle={canFindMissing}
            handFile={hand.file}
            onDone={onDone}
          />
        ) : null}
        {hand.editable ? (
          <button type="button" className="btn sm" data-testid="collection-edit-hand" onClick={onEdit}>
            Edit
          </button>
        ) : (
          <button
            type="button"
            className="btn sm"
            data-testid="collection-edit-disabled"
            disabled
            title={hand.editableReason ?? undefined}
          >
            Edit
          </button>
        )}
        {isAdmin && hand.source === 'hand' && hand.file ? (
          <DeleteControl
            recipeId={hand.name}
            recipeName={hand.name}
            mediaType={hand.mediaType}
            handFile={hand.file}
            onDone={onDone}
          />
        ) : null}
      </div>
    </li>
  );
}

/**
 * DESIGN-043 D-14 (PLAN-052 PR4c) — the per-collection FIND-MISSING knob. Render-only for a caller without
 * the grant (the honest state); a granted caller (or admin — the server folds admin into canFindMissing)
 * gets a TOGGLE. Enabling opens an explanatory Modal confirm (the acquisition lever — owner tone, no
 * em-dashes); disabling is a direct click (turning acquisition off is never the blast radius). The puck
 * reserves the width of its widest label, so ON/OFF/pending only recolor, never reflow (ADR-015). For a
 * Kometa collection, enabling opens a human-merged config PR, so the row's overview refetch then shows the
 * honest "Awaiting merge" band while the puck reflects the requested state.
 */
function FindMissingPuck({
  recipeId,
  mediaType,
  findMissing,
  canToggle,
  handFile,
  onDone,
}: {
  recipeId: string;
  mediaType: CollectionMediaTypeName;
  findMissing: boolean;
  canToggle: boolean;
  /** Set for a hand-authored Kometa collection: the config file the splice targets (human-merged). */
  handFile?: string | null;
  onDone: () => void;
}) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mutation = trpc.collections.setFindMissing.useMutation({
    onError: (err: unknown) => setError(describeMutationError(err)),
    onSuccess: () => {
      setError(null);
      setConfirmOpen(false);
      onDone();
    },
  });

  const label = findMissing ? 'Find missing on' : 'Find missing off';
  const puckClass = `acq-puck ${findMissing ? 'acq-puck--on' : 'acq-puck--off'}`;

  // No grant: the honest read-only puck (server re-checks regardless of what the client renders).
  if (!canToggle) {
    return (
      <span
        className={puckClass}
        data-testid="find-missing-puck"
        title={
          findMissing
            ? "Find missing on: the estate pulls this collection's missing titles on its next runs"
            : 'Find missing off. Ask an admin for the find-missing grant to turn it on.'
        }
      >
        {label}
      </span>
    );
  }

  const handArg = handFile ? { handFile } : {};
  const disable = () => mutation.mutate({ id: recipeId, mediaType, on: false, ...handArg });

  return (
    <>
      <button
        type="button"
        className={puckClass}
        data-testid="find-missing-puck"
        aria-pressed={findMissing}
        disabled={mutation.isPending}
        title={
          findMissing
            ? 'Find missing is on. Click to turn it off.'
            : "Turn on find missing: the estate pulls this collection's missing titles on its next runs."
        }
        onClick={() => (findMissing ? disable() : setConfirmOpen(true))}
      >
        {mutation.isPending ? 'Saving…' : label}
      </button>
      <Modal
        open={confirmOpen}
        title="Turn on find missing"
        onClose={() => setConfirmOpen(false)}
        banner={
          error ? (
            <p className="alert" role="alert">
              {error}
            </p>
          ) : null
        }
      >
        <div className="find-missing-confirm">
          <p>
            With find missing on, the estate pulls this collection&rsquo;s missing titles on its next
            runs and keeps looking for them.
          </p>
          {isKometaMedia(mediaType) ? (
            <p className="muted">
              For this collection an admin merges the estate config first, so it starts on the next run
              after that. The row shows the pending state until then.
            </p>
          ) : null}
          <div className="form-actions">
            <button
              type="button"
              className="btn primary"
              data-testid="find-missing-confirm"
              disabled={mutation.isPending}
              onClick={() => mutation.mutate({ id: recipeId, mediaType, on: true, ...handArg })}
            >
              {mutation.isPending ? 'Turning on…' : 'Turn on find missing'}
            </button>
            <button
              type="button"
              className="btn"
              disabled={mutation.isPending}
              onClick={() => setConfirmOpen(false)}
            >
              Cancel
            </button>
          </div>
        </div>
      </Modal>
    </>
  );
}

/**
 * ADR-071 / DESIGN-043 D-02/D-07 amend (owner ruling 2026-07-18) — the on-demand collection FORCE SEARCH that
 * replaces the retired "Run now" on the Books/Audiobooks rows. Renders the estate-standard outline
 * <MediaAction action="forceSearch"> (the action-anatomy drift guard demands it); a collection-level search is
 * a bulk explanatory confirm, so firing opens the shared Modal (hard rule 8) that states the missing count and
 * what the whole action does. After firing, the reserved slot swaps the button for the honest in-place
 * progressing chip (recolor, no reflow — ADR-015); the run-counts polling keeps informing the row's counts.
 * Only mounted when the caller holds the books Force Search grant (server FORBIDDEN regardless).
 */
function CollectionForceSearchButton({
  recipeId,
  missingCount,
  onDone,
}: {
  recipeId: string;
  missingCount: number | null;
  onDone: () => void;
}) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [runId, setRunId] = useState<string | null>(null);
  const [state, setState] = useState<'idle' | 'fired' | 'unreachable'>('idle');
  const search = trpc.collections.forceSearchCollection.useMutation({
    onSuccess: (res) => {
      setConfirmOpen(false);
      if (res.unreachable) {
        setState('unreachable');
      } else {
        setState('fired');
        if (res.runId) setRunId(res.runId);
      }
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

  let live = null;
  if (search.isPending) {
    live = <PhaseChip phase="searching" label="Searching…" tone="neutral" pulse meter />;
  } else if (state === 'fired') {
    live = (
      <PhaseChip
        phase="fired"
        label="Search started"
        tone="info"
        pulse
        meter
        title="The recipe was re-applied and the missing books are being searched for now."
      />
    );
  } else if (state === 'unreachable') {
    live = (
      <PhaseChip
        phase="noop"
        label="Service unreachable"
        tone="warning"
        title="The collections service was unreachable, so nothing was searched. Try again in a bit."
      />
    );
  } else if (search.error) {
    live = (
      <PhaseChip
        phase="failed"
        label="Search failed"
        tone="danger"
        title={describeMutationError(search.error)}
      />
    );
  }

  const hasCount = missingCount != null && missingCount > 0;
  return (
    <span className="collection-row__apply">
      <ReservedActionSlot reserve="roll" live={live} testId="collection-force-search">
        <MediaAction
          action="forceSearch"
          size="sm"
          testId="collection-force-search-btn"
          onFire={() => setConfirmOpen(true)}
        />
      </ReservedActionSlot>
      {counts ? (
        <span className="muted collection-row__runcounts" data-testid="collection-runcounts">
          {counts.matched ?? 0} matched · {counts.missing ?? 0} missing
          {counts.acquired ? ` · ${counts.acquired} pulled` : ''}
        </span>
      ) : null}
      <Modal
        open={confirmOpen}
        title="Force Search this collection"
        onClose={() => setConfirmOpen(false)}
        banner={
          search.error ? (
            <p className="alert" role="alert">
              {describeMutationError(search.error)}
            </p>
          ) : null
        }
      >
        <div className="find-missing-confirm" data-testid="collection-force-search-modal">
          <p>
            {hasCount
              ? `Search for the ${missingCount} missing book${missingCount === 1 ? '' : 's'} in this collection now.`
              : 'Search for the missing books in this collection now.'}
          </p>
          <p className="muted">
            This re-applies the recipe, refreshes the missing list, and searches for the missing titles
            right away. Titles already on the shelf are left alone.
          </p>
          <div className="form-actions">
            <button
              type="button"
              className="btn primary"
              data-testid="collection-force-search-confirm"
              disabled={search.isPending}
              onClick={() => search.mutate({ recipeId })}
            >
              {search.isPending ? 'Searching…' : 'Search now'}
            </button>
            <button
              type="button"
              className="btn"
              disabled={search.isPending}
              onClick={() => setConfirmOpen(false)}
            >
              Cancel
            </button>
          </div>
        </div>
      </Modal>
    </span>
  );
}

/**
 * Delete (admin) — a QUIET row button opening an explanatory Modal (hard rule 8: a destructive
 * confirm with an option is a multi-field confirm ⇒ Modal, not an inline checkbox+ConfirmButton;
 * Fable UX pass 2026-07-18). The default keeps the built collection (it survives orphaned in the
 * library); the opt-in cascades the delete where the provider supports it. `mediaType` routes the
 * write to the right provider (Movies/TV → Kometa managed-include PR; Books/Audiobooks → Libretto).
 */
function DeleteControl({
  recipeId,
  recipeName,
  mediaType,
  handFile,
  onDone,
}: {
  recipeId: string;
  recipeName: string;
  mediaType: CollectionMediaTypeName;
  /** Set for a hand-authored Kometa collection: delete surgically removes its block from this config file. */
  handFile?: string | null;
  onDone: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [also, setAlso] = useState(false);
  const remove = trpc.collections.remove.useMutation({
    onSuccess: () => {
      setOpen(false);
      setAlso(false);
      onDone();
    },
  });
  return (
    <>
      <button
        type="button"
        className="btn sm danger"
        data-testid="collection-delete-open"
        onClick={() => setOpen(true)}
      >
        Delete
      </button>
      <Modal open={open} title="Delete this collection?" onClose={() => setOpen(false)}>
        <div className="over-cap" data-testid="collection-delete-modal">
          <p>
            This removes the recipe that builds <strong>{recipeName}</strong>. The built collection
            stays in the library until you also remove it below.
          </p>
          {remove.error ? (
            <p className="alert" role="alert">
              {describeMutationError(remove.error)}
            </p>
          ) : null}
          <label className="composer-inline">
            <input
              type="checkbox"
              checked={also}
              onChange={(e) => setAlso(e.target.checked)}
              data-testid="collection-delete-also"
            />
            Also delete the built collection from the library
          </label>
          <div className="form-actions">
            <button
              type="button"
              className="btn danger"
              disabled={remove.isPending}
              data-testid="collection-delete-confirm"
              onClick={() =>
                remove.mutate({
                  id: recipeId,
                  mediaType,
                  deleteCollection: also,
                  ...(handFile ? { handFile } : {}),
                })
              }
            >
              {remove.isPending ? 'Deleting…' : also ? 'Delete both' : 'Delete the recipe'}
            </button>
            <button type="button" className="btn" disabled={remove.isPending} onClick={() => setOpen(false)}>
              Cancel
            </button>
          </div>
        </div>
      </Modal>
    </>
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
  showRequester = false,
}: {
  ticket: {
    collectionName: string;
    mediaType: string | null;
    size: number | null;
    status: string;
    requestedBy?: string | null;
  };
  /** The admin approve lens shows who asked; the requester's own list doesn't repeat their name. */
  showRequester?: boolean;
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
      {showRequester && ticket.requestedBy ? (
        <span className="muted" data-testid="ticket-requester">
          asked by {ticket.requestedBy}
        </span>
      ) : null}
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
    requestedBy?: string | null;
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
        <TicketMeta ticket={ticket} showRequester />
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
