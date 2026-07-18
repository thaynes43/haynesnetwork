'use client';

// ADR-057 / DESIGN-029 (PLAN-045) — the Integrations HUB: one provider CARD per integration (the
// Trash-Overview card idiom — a whole-card button, token tones, reserved stat blocks), pushing into
// the provider's SUB-SECTION (D-19: sub-navigation PUSHES — /integrations/goodreads is a screen of
// its own; Back returns to the hub). The v0.49.0 flat page (link card + coverage + requests wall)
// moved INTO the Goodreads sub-section; this hub stays a stable directory as the saga's future
// providers (Hardcover / Trakt / …) slot in as sibling cards.
import { useRouter } from 'next/navigation';
import { trpc } from '@/lib/trpc-client';
import { isFirstSyncPending } from '@/lib/integrations-coverage';

const PENDING_POLL_MS = 4000;

function GoodreadsCard() {
  const router = useRouter();
  // Poll while a just-linked integration awaits its first sync so the card's stats fill in live.
  const overviewQ = trpc.integrations.overview.useQuery(undefined, {
    refetchInterval: (query) => {
      const d = query.state.data;
      return d && isFirstSyncPending(d.integration.linked, d.integration.lastSyncedAt)
        ? PENDING_POLL_MS
        : false;
    },
  });
  const data = overviewQ.data;
  const linked = data?.integration.linked ?? false;
  const pending = isFirstSyncPending(linked, data?.integration.lastSyncedAt ?? null);
  const shelvedTotal = data?.shelves.reduce((sum, s) => sum + s.total, 0) ?? 0;

  return (
    <button
      type="button"
      className="hub-card"
      data-testid="hub-card-goodreads"
      onClick={() => router.push('/integrations/goodreads')}
    >
      <span className="hub-card__head">
        <span className="integrations-provider">
          <span className="integrations-provider__glyph" aria-hidden="true">
            G
          </span>
          <span className="integrations-provider__name">Goodreads</span>
        </span>
        {linked ? (
          <span className="badge badge--ok">Linked</span>
        ) : (
          <span className="badge badge--muted">Not linked</span>
        )}
      </span>
      {/* The stat block reserves its footprint either way (ADR-015) — the not-linked / pending /
          linked swaps recolor and re-copy, never reflow. */}
      <span className="hub-card__stats">
        {!linked ? (
          <span className="hub-card__hint">
            Link your public shelves and we&rsquo;ll request the books you don&rsquo;t have yet.
          </span>
        ) : pending ? (
          <span className="hub-card__hint" data-testid="hub-card-pending">
            First sync in progress…
          </span>
        ) : (
          <>
            <span className="hub-card__stat" data-testid="hub-card-coverage">
              <span className="hub-card__num">{data?.headline.pct ?? 0}%</span>
              <span className="hub-card__unit">of your want shelf</span>
            </span>
            <span className="hub-card__stat">
              <span className="hub-card__num">{shelvedTotal}</span>
              <span className="hub-card__unit">shelved books</span>
            </span>
          </>
        )}
      </span>
      <span className="hub-card__open" aria-hidden="true">
        Open ›
      </span>
    </button>
  );
}

// ADR-072 / DESIGN-043 D-01/D-15 (PLAN-052 PR4a) — the Collections manager is now a first-class
// top-level /collections page (its own nav entry), no longer an Integrations hub card. The card was
// removed in the move; the old /integrations/collections route redirects to /collections.

export function IntegrationsClient() {
  return (
    <div className="integrations-page">
      <h1 className="page-title">Integrations</h1>
      <p className="muted integrations-intro">
        Link your reading and watching accounts so we can be your source. Each provider gets its own
        page with stats and your shelved items.
      </p>
      <div className="hub-cards" data-testid="integrations-hub">
        <GoodreadsCard />
        {/* The saga's future providers slot in here as sibling cards — an honest placeholder, not a
            dead control (no button semantics). */}
        <div className="hub-card hub-card--ghost" aria-hidden="true">
          <span className="hub-card__head">
            <span className="integrations-provider">
              <span className="integrations-provider__glyph integrations-provider__glyph--ghost">+</span>
              <span className="integrations-provider__name muted">More providers</span>
            </span>
          </span>
          <span className="hub-card__stats">
            <span className="hub-card__hint">Hardcover, Trakt and friends arrive with the saga.</span>
          </span>
        </div>
      </div>
    </div>
  );
}
