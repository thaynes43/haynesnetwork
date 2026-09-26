'use client';

// ADR-093 / DESIGN-052 D-10 (PLAN-072) — the READ-ONLY "Watchlists" card on the Trash settings General tab (admins).
// It says when the Watchlist Registry last checked everyone's watchlists and how many accounts could be read, then the
// per-class and per-status counts as small labelled numbers. Counts only: never a name, never a title, never whose
// watchlist (ADR-093 C-06). A second part shows the Release Block (the blocked releases per *arr against the cap and
// the oldest one's age), the import-list exclusion counts read live, and the re-adds of the last 30 days (D-23).
import { trpc } from '@/lib/trpc-client';
import {
  RELEASE_BLOCK_KIND_LABELS,
  WATCHLIST_CLASS_LABELS,
  WATCHLIST_LIST_LABELS,
  WATCHLIST_LIST_ORDER,
  blockedReleasesValue,
  exclusionCountValue,
  oldestBlockLabel,
  readdSummaryLine,
  watchlistsHeadline,
} from '@/lib/trash';

/** The order the labelled numbers read in (known keys first; an unknown key renders last, verbatim). */
const CLASS_ORDER = ['owner', 'home_full', 'home_managed', 'friend', 'seerr_only'];

function ordered(
  counts: Record<string, number>,
  order: readonly string[],
): Array<[string, number]> {
  const known = order
    .filter((k) => (counts[k] ?? 0) > 0)
    .map((k) => [k, counts[k]!] as [string, number]);
  const extra = Object.entries(counts).filter(([k, n]) => !order.includes(k) && n > 0);
  return [...known, ...extra];
}

function Counts({
  label,
  entries,
  labels,
  testId,
}: {
  label: string;
  entries: Array<[string, number | string]>;
  labels: Record<string, string>;
  testId: string;
}) {
  if (entries.length === 0) return null;
  return (
    <div className="watchlists-card__group" data-testid={testId}>
      <span className="watchlists-card__label">{label}</span>
      <ul className="watchlists-card__counts">
        {entries.map(([key, n]) => (
          <li key={key}>
            <span className="muted">{labels[key] ?? key}</span> <strong>{n}</strong>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function WatchlistsCard() {
  const summary = trpc.trash.watchlists.useQuery(undefined, { refetchInterval: 60_000 });
  const data = summary.data;
  const lastFailed =
    data?.lastRun !== null && data?.lastRun !== undefined && data.lastRun.status === 'failed';
  return (
    <section className="card batch-settings watchlists-card" data-testid="trash-watchlists">
      <h2 className="batch-settings__head">Watchlists</h2>
      <p className="watchlists-card__headline" data-testid="watchlists-headline">
        {summary.isLoading
          ? 'Loading…'
          : data
            ? watchlistsHeadline(data)
            : "Couldn't load the watchlist check."}
      </p>
      {data ? (
        <>
          <Counts
            label="Accounts"
            entries={ordered(data.byClass, CLASS_ORDER)}
            labels={WATCHLIST_CLASS_LABELS}
            testId="watchlists-by-class"
          />
          {/* D-25bg — every account once, split the same way as the headline (Read = its n; the rest = its m). */}
          <Counts
            label="Lists"
            entries={ordered(data.byList, WATCHLIST_LIST_ORDER)}
            labels={WATCHLIST_LIST_LABELS}
            testId="watchlists-by-status"
          />
          {lastFailed ? (
            <p className="muted watchlists-card__note" data-testid="watchlists-last-failed">
              The latest check didn&apos;t finish. The counts are from the one before.
            </p>
          ) : null}
          <Counts
            label="Blocked releases"
            entries={data.releaseBlock.kinds.map((k) => [
              k.arrKind,
              blockedReleasesValue(k.terms, k.cap),
            ])}
            labels={RELEASE_BLOCK_KIND_LABELS}
            testId="watchlists-release-block"
          />
          <Counts
            label="Oldest block"
            entries={data.releaseBlock.kinds.flatMap((k) => {
              const age = oldestBlockLabel(k.oldestTermDays);
              return age === null ? [] : [[k.arrKind, age] as [string, string]];
            })}
            labels={RELEASE_BLOCK_KIND_LABELS}
            testId="watchlists-oldest-block"
          />
          <Counts
            label="Import list exclusions"
            entries={data.releaseBlock.kinds.map((k) => [
              k.arrKind,
              exclusionCountValue(k.importListExclusions),
            ])}
            labels={RELEASE_BLOCK_KIND_LABELS}
            testId="watchlists-exclusions"
          />
          <p className="muted watchlists-card__note" data-testid="watchlists-readds">
            {readdSummaryLine(data.releaseBlock.readds)}
          </p>
        </>
      ) : null}
    </section>
  );
}
