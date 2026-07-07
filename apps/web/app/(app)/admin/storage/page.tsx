'use client';

// ADR-030 / DESIGN-013 D-05 (PLAN-013) — /admin/storage: the native half of the HYBRID metrics
// surface. Top to bottom:
//   1. Utilization — one capacity meter per physical media array (*arr /diskspace via
//      storage.utilization), the space target drawn as a tick; tone deepens as usedPct approaches/
//      passes the target (color only — never layout, ADR-015). A downed *arr renders a muted
//      degraded card, never an error page (C-03).
//   2. Space targets — inline per-array percent ceiling → storage.targets.set (audited server-side
//      through the app_settings single-writer); optimistic tick move, reflow-free save feedback.
//   3. Grafana deep-link — the fill/drain TIME-SERIES lives in Grafana and is deep-linked, not
//      embedded (ADR-030 C-04).
//   4. Reclaim — window switcher → storage.reclaim: headline totals, the bang-for-buck bars
//      (category × resolution, pre-sorted bytes-desc), the cumulative step strip, the per-batch
//      table, and the best-effort expedite footnote (never folded into totals, C-01b).
import { useState, type FormEvent } from 'react';
import { ConfirmButton } from '@hnet/ui';
import { trpc } from '@/lib/trpc-client';
import { describeMutationError } from '@/lib/app-error';
import { formatBytes, formatWhen } from '@/lib/media';
import {
  ARRAY_TARGET_SLUGS,
  RECLAIM_WINDOW_OPTIONS,
  categoryResolutionLabel,
  cumulativeStepGeometry,
  formatCapacity,
  reclaimHeadline,
  sharePct,
  utilizationSummary,
  utilizationTone,
  windowDescription,
  type ReclaimWindow,
  type StorageArrayUtilization,
} from '@/lib/storage';
import {
  POLICY_ARRAY_KEY,
  POLICY_ARRAY_LABEL,
  arrayEnabled,
  effectiveCooldownDays,
  graduationVerdict,
  nextEligibleLabel,
  overTargetLabel,
  saveRateLabel,
  withArrayConfig,
  withEnabled,
} from '@/lib/space-policy';

/** ADR-030 C-04 / OPS-007 — the deep-linked (never embedded) free-space trend dashboard. */
const GRAFANA_TREND_URL = 'https://grafana.haynesops.com/d/media-storage-utilization';

const CUMULATIVE_W = 600;
const CUMULATIVE_H = 64;

// ---------------------------------------------------------------------------------------------------
// Utilization card (meter + inline target editor)
// ---------------------------------------------------------------------------------------------------

function ArrayCard({ array }: { array: StorageArrayUtilization }) {
  const utils = trpc.useUtils();
  const targets = trpc.storage.targets.get.useQuery();
  const slug = ARRAY_TARGET_SLUGS[array.key];

  // Draft overlays the stored target once edited (the motd-page pattern — no prefill effect);
  // null ⇒ mirror the server value. '' ⇒ "no target".
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const storedTarget = slug ? (targets.data?.[slug] ?? null) : null;
  const value = draft ?? (storedTarget == null ? '' : String(storedTarget));
  const parsed = value === '' ? null : Number(value);
  const invalid = parsed != null && (!Number.isInteger(parsed) || parsed < 0 || parsed > 100);
  const dirty = draft != null && value !== (storedTarget == null ? '' : String(storedTarget));

  const save = trpc.storage.targets.set.useMutation({
    // Optimistic (ADR-015-friendly): the tick moves immediately; a failure rolls it back.
    onMutate: async (vars) => {
      await Promise.all([utils.storage.targets.get.cancel(), utils.storage.utilization.cancel()]);
      const prevTargets = utils.storage.targets.get.getData();
      const prevUtil = utils.storage.utilization.getData();
      utils.storage.targets.get.setData(undefined, vars.targets);
      utils.storage.utilization.setData(undefined, (rows) =>
        rows?.map((r) => {
          const rowSlug = ARRAY_TARGET_SLUGS[r.key];
          return rowSlug ? { ...r, target: vars.targets[rowSlug] ?? null } : r;
        }),
      );
      return { prevTargets, prevUtil };
    },
    onError: (err, _vars, ctx) => {
      utils.storage.targets.get.setData(undefined, ctx?.prevTargets);
      utils.storage.utilization.setData(undefined, ctx?.prevUtil);
      setError(describeMutationError(err));
      setSaved(false);
    },
    onSuccess: () => {
      setError(null);
      setSaved(true);
      setDraft(null); // re-sync the input to the freshly-saved value
    },
    onSettled: () =>
      Promise.all([utils.storage.targets.get.invalidate(), utils.storage.utilization.invalidate()]),
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!slug || invalid || !dirty) return;
    setSaved(false);
    // Merge into the FULL map — targets.set replaces the whole space_targets value, and the other
    // slugs' ceilings (reserved haynesops/hayneskube) must survive an edit here.
    const next = { ...(targets.data ?? {}) };
    if (parsed == null) delete next[slug];
    else next[slug] = parsed;
    save.mutate({ targets: next });
  }

  const tone = utilizationTone(array.usedPct, array.target);
  const summary = utilizationSummary(array);

  return (
    <article
      className={`card storage-array storage-array--${tone}`}
      data-testid={`array-${array.key}`}
      data-unavailable={array.unavailable || undefined}
    >
      <header className="storage-array__head">
        <h2>{array.label}</h2>
        <span className="storage-array__path">{array.path ?? '—'}</span>
      </header>

      {/* role=meter requires a value, so an unavailable array renders the track as plain
          decoration (the degraded stats line carries the state for AT users). */}
      <div
        className="storage-array__meter"
        role={array.usedPct != null ? 'meter' : undefined}
        aria-hidden={array.usedPct == null || undefined}
        aria-label={array.usedPct != null ? `${array.label} used space` : undefined}
        aria-valuemin={array.usedPct != null ? 0 : undefined}
        aria-valuemax={array.usedPct != null ? 100 : undefined}
        aria-valuenow={array.usedPct ?? undefined}
        aria-valuetext={
          array.usedPct != null
            ? `${array.usedPct}% used${array.target != null ? `, target ${array.target}%` : ''}`
            : undefined
        }
      >
        {array.usedPct != null ? (
          <div
            className="storage-array__fill"
            style={{ width: `${Math.min(array.usedPct, 100)}%` }}
          />
        ) : null}
        {array.target != null ? (
          <span
            className="storage-array__tick"
            data-testid={`target-tick-${array.key}`}
            data-target={array.target}
            style={{ left: `${array.target}%` }}
          />
        ) : null}
      </div>

      {summary ? (
        <p className="storage-array__stats" data-testid={`array-stats-${array.key}`}>
          <strong className="storage-array__pct">{array.usedPct}%</strong> used ·{' '}
          {formatCapacity(array.freeSpace!)} free of {formatCapacity(array.totalSpace!)}
        </p>
      ) : (
        <p className="storage-array__stats storage-array__stats--degraded">
          Unavailable — couldn’t reach a source *arr for this array right now.
        </p>
      )}

      {slug ? (
        <form className="storage-target" onSubmit={submit}>
          <label className="storage-target__label">
            <span>Target</span>
            <input
              type="number"
              inputMode="numeric"
              min={0}
              max={100}
              step={1}
              value={value}
              aria-label={`${array.label} target percent used`}
              aria-invalid={invalid || undefined}
              data-testid={`target-input-${array.key}`}
              onChange={(e) => {
                setDraft(e.target.value);
                setSaved(false);
              }}
            />
            <span>% used</span>
          </label>
          <button
            type="submit"
            className="btn sm"
            data-testid={`target-save-${array.key}`}
            disabled={!dirty || invalid || save.isPending}
          >
            Save
          </button>
          {/* Reserved slot — appearing text recolors the row, never reflows it (ADR-015). */}
          <span className="storage-target__status" role="status">
            {invalid ? 'Whole 0–100 only' : saved ? 'Saved' : dirty ? 'Unsaved' : ' '}
          </span>
        </form>
      ) : (
        <p className="storage-target storage-target--none muted">
          No space target for this array yet.
        </p>
      )}

      {error ? (
        <p className="alert" role="alert">
          {error}
        </p>
      ) : null}
    </article>
  );
}

// ---------------------------------------------------------------------------------------------------
// Reclaim section
// ---------------------------------------------------------------------------------------------------

function ReclaimSection() {
  const [win, setWindow] = useState<ReclaimWindow>('90d');
  // placeholderData keeps the previous report on screen while a window switch refetches — the
  // section swaps numbers, never collapses (ADR-015).
  const reclaim = trpc.storage.reclaim.useQuery(
    { window: win },
    { placeholderData: (prev) => prev },
  );
  const report = reclaim.data;
  const empty = report != null && report.totals.items === 0;
  const geometry = report
    ? cumulativeStepGeometry(
        report.cumulative,
        CUMULATIVE_W,
        CUMULATIVE_H,
        new Date().toISOString().slice(0, 10),
      )
    : null;

  return (
    <section className="storage-reclaim admin-section" aria-label="Reclaim">
      <div className="storage-reclaim__head">
        <h2>Reclaim</h2>
        <div className="seg" role="group" aria-label="Reclaim window">
          {RECLAIM_WINDOW_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              className={win === opt.value ? 'is-active' : undefined}
              onClick={() => setWindow(opt.value)}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {reclaim.isLoading ? <p className="muted">Loading reclaim…</p> : null}
      {reclaim.error ? (
        <p className="alert" role="alert">
          Failed to load reclaim: {reclaim.error.message}
        </p>
      ) : null}

      {report ? (
        <>
          <p className="storage-reclaim__headline" data-testid="reclaim-headline">
            {reclaimHeadline(report.totals)}{' '}
            <span className="muted">· {windowDescription(report.window)}</span>
          </p>

          {empty ? (
            <div className="card storage-reclaim__empty" data-testid="reclaim-empty">
              <p>Nothing swept in this window yet — and that’s the normal starting state.</p>
              <p className="muted">
                Reclaim accrues when Leaving-Soon batches expire and sweep: each swept item lands
                here with its frozen size, category, and resolution, so you can see exactly where
                the space came back from.
              </p>
            </div>
          ) : (
            <>
              {/* The bang-for-buck view: category × resolution, pre-sorted by reclaimed bytes. */}
              <ol className="reclaim-bars" data-testid="reclaim-bars">
                {report.byCategoryResolution.map((row) => {
                  const share = sharePct(row.reclaimedBytes, report.totals.reclaimedBytes);
                  return (
                    <li key={`${row.mediaKind}-${row.resolution}`} className="reclaim-bar">
                      <div className="reclaim-bar__meta">
                        <span className="reclaim-bar__label">
                          {categoryResolutionLabel(row.mediaKind, row.resolution)}
                        </span>
                        <span className="reclaim-bar__value">
                          {formatBytes(row.reclaimedBytes)} ({share}%) · {row.items} item
                          {row.items === 1 ? '' : 's'}
                        </span>
                      </div>
                      <div className="reclaim-bar__track">
                        <div className="reclaim-bar__fill" style={{ width: `${share}%` }} />
                      </div>
                    </li>
                  );
                })}
              </ol>

              {geometry ? (
                <figure className="reclaim-cumulative" data-testid="reclaim-cumulative">
                  <figcaption className="muted">Cumulative reclaim over the window</figcaption>
                  <svg
                    viewBox={`0 0 ${CUMULATIVE_W} ${CUMULATIVE_H}`}
                    preserveAspectRatio="none"
                    aria-hidden="true"
                  >
                    <path className="reclaim-cumulative__area" d={geometry.area} />
                    <path
                      className="reclaim-cumulative__line"
                      d={geometry.line}
                      vectorEffect="non-scaling-stroke"
                    />
                  </svg>
                  <div className="reclaim-cumulative__axis muted">
                    <span>{geometry.startDay}</span>
                    <span>today · {formatBytes(report.totals.reclaimedBytes)} total</span>
                  </div>
                </figure>
              ) : null}

              <table className="admin-table storage-batches" data-testid="reclaim-batches">
                <thead>
                  <tr>
                    <th>Swept</th>
                    <th>Kind</th>
                    <th>Green-lit by</th>
                    <th>Items</th>
                    <th>Reclaimed</th>
                  </tr>
                </thead>
                <tbody>
                  {report.batches.map((b) => (
                    <tr key={b.batchId}>
                      <td data-label="Swept">
                        {b.lastDeletedAt ? formatWhen(b.lastDeletedAt) : '—'}
                      </td>
                      <td data-label="Kind">{b.mediaKind === 'movie' ? 'Movies' : 'TV'}</td>
                      <td data-label="Green-lit by">{b.greenlitByName ?? '—'}</td>
                      <td data-label="Items">{b.items}</td>
                      <td data-label="Reclaimed">{formatBytes(b.reclaimedBytes)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}

          {report.expedited.items > 0 ? (
            <p className="muted storage-reclaim__expedited" data-testid="reclaim-expedited">
              + {report.expedited.items} direct expedite{report.expedited.items === 1 ? '' : 's'} ·{' '}
              {formatBytes(report.expedited.reclaimedBytes)}, best-effort — not in the totals.
            </p>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------------------------------------------
// Space policy card (ADR-031 / DESIGN-014 — propose-only; the admin gate stays the human check)
// ---------------------------------------------------------------------------------------------------

/** The rescue-rate + graduation block (trash.tuning). Reads only — the owner tunes rules by hand. */
function TuningBlock() {
  const tuning = trpc.trash.tuning.useQuery();
  const report = tuning.data;
  if (tuning.isLoading) return <p className="muted">Loading tuning…</p>;
  if (!report) return null;

  const g = report.graduation;
  const empty = report.overall.proposed === 0;

  return (
    <div className="policy-tuning" data-testid="policy-tuning">
      <h3>Rules tuning &amp; graduation</h3>
      <p className="muted">
        What the family rescued vs. what the sweep deleted — the labelled false positives you tune the
        Maintainerr rules against. Save-rate is rescued ÷ (rescued + deleted); a high rate means the
        rules are too aggressive for that slice.
      </p>

      {empty ? (
        <p className="muted" data-testid="tuning-empty">
          No curated batches have reached a keep-or-delete verdict yet — this fills in as batches sweep.
        </p>
      ) : (
        <>
          <p data-testid="tuning-overall">
            Overall: {report.overall.rescued} rescued · {report.overall.deleted} deleted ·{' '}
            {report.overall.skipped} guardian-kept · save-rate{' '}
            <strong>{saveRateLabel(report.overall.saveRatePct)}</strong>
          </p>
          <table className="admin-table" data-testid="tuning-resolution">
            <caption className="sr-only">Rescue rate by resolution</caption>
            <thead>
              <tr>
                <th>Resolution</th>
                <th>Rescued</th>
                <th>Deleted</th>
                <th>Save-rate</th>
              </tr>
            </thead>
            <tbody>
              {report.byResolution.map((row) => (
                <tr key={row.key}>
                  <td data-label="Resolution">{row.label}</td>
                  <td data-label="Rescued">{row.rescued}</td>
                  <td data-label="Deleted">{row.deleted}</td>
                  <td data-label="Save-rate">{saveRateLabel(row.saveRatePct)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <table className="admin-table" data-testid="tuning-rating">
            <caption className="sr-only">Rescue rate by rating band</caption>
            <thead>
              <tr>
                <th>Rating band</th>
                <th>Rescued</th>
                <th>Deleted</th>
                <th>Save-rate</th>
              </tr>
            </thead>
            <tbody>
              {report.byRatingBand.map((row) => (
                <tr key={row.key}>
                  <td data-label="Rating band">{row.label}</td>
                  <td data-label="Rescued">{row.rescued}</td>
                  <td data-label="Deleted">{row.deleted}</td>
                  <td data-label="Save-rate">{saveRateLabel(row.saveRatePct)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      <div
        className="policy-graduation"
        data-testid="policy-graduation"
        data-meets={g.meetsCriteria || undefined}
      >
        <strong>Skip-gate graduation readiness</strong>
        <p data-testid="graduation-verdict">{graduationVerdict(g)}</p>
        <p className="muted">
          The bar (ADR-031 C-05): at least {g.thresholds.minCompletedBatches} completed policy batches,
          an aggregate save-rate at or below {g.thresholds.maxSaveRatePct}%, and no restores of swept
          items. Flipping the skip-gate stays an owner action, in Trash → Batches → settings.
        </p>
      </div>
    </div>
  );
}

function SpacePolicyCard() {
  const utils = trpc.useUtils();
  const policy = trpc.storage.policy.get.useQuery();
  const status = trpc.storage.policy.status.useQuery();
  const utilization = trpc.storage.utilization.useQuery();
  const [cooldownDraft, setCooldownDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const save = trpc.storage.policy.set.useMutation({
    onSuccess: () => {
      setError(null);
      setCooldownDraft(null);
      void utils.storage.policy.get.invalidate();
      void utils.storage.policy.status.invalidate();
    },
    onError: (err: unknown) => setError(describeMutationError(err)),
  });

  const p = policy.data;
  const enabled = p?.enabled === true;
  const arrOn = p ? arrayEnabled(p, POLICY_ARRAY_KEY) : false;
  const cooldown = p ? effectiveCooldownDays(p, POLICY_ARRAY_KEY) : 7;
  const cooldownValue = cooldownDraft ?? String(cooldown);
  const parsedCooldown = Number(cooldownValue);
  const cooldownValid = Number.isInteger(parsedCooldown) && parsedCooldown >= 0 && parsedCooldown <= 365;

  const tower = utilization.data?.find((a) => a.key === POLICY_ARRAY_KEY) ?? null;
  const towerKinds = status.data?.kinds ?? [];

  const flipEnabled = async (next: boolean): Promise<'ok' | 'failed'> => {
    if (!p) return 'failed';
    try {
      await save.mutateAsync(withEnabled(p, next));
      return 'ok';
    } catch {
      return 'failed';
    }
  };

  return (
    <section className="card space-policy admin-section" data-testid="space-policy" aria-label="Space policy">
      <h2>Space policy</h2>
      <p className="muted">
        When an array is over its space target, the policy PROPOSES a Leaving-Soon batch for admin
        review — it never deletes on its own. The admin gate stays the human check.
      </p>
      {error !== null ? (
        <p className="alert" role="alert">
          {error}
        </p>
      ) : null}

      {/* Global enable — mirrors the Trash skip-gate ceremony (ConfirmButton to arm; plain to disable). */}
      <div className="space-policy__row">
        <div className="space-policy__copy">
          <strong>Automatic proposals</strong>
          <p data-testid="policy-state">
            {policy.isLoading
              ? 'Loading…'
              : enabled
                ? 'ON — the hourly job proposes batches for over-target, opted-in arrays.'
                : 'OFF — no batches are proposed automatically (default).'}
          </p>
        </div>
        {enabled ? (
          <button
            type="button"
            className="btn sm"
            data-testid="policy-disable"
            disabled={save.isPending || policy.isLoading}
            onClick={() => void flipEnabled(false)}
          >
            Turn off
          </button>
        ) : (
          <ConfirmButton
            className="btn sm"
            data-testid="policy-enable"
            label="Turn on proposals"
            reArmOnFailure
            disabled={save.isPending || policy.isLoading}
            restingAriaLabel="Turn on automatic space-policy proposals — batches are proposed for admin review, never deleted automatically — click twice to confirm"
            confirmAriaLabel="Confirm turning on automatic proposals"
            onConfirm={() => flipEnabled(true)}
          />
        )}
      </div>

      {/* Per-array (HaynesTower) opt-in + cooldown. */}
      <div className="space-policy__row" data-testid={`policy-array-${POLICY_ARRAY_KEY}`}>
        <div className="space-policy__copy">
          <strong>{POLICY_ARRAY_LABEL}</strong>
          <p className="muted" data-testid="policy-array-target">
            {tower ? overTargetLabel(tower.usedPct, tower.target) : 'utilization loading…'}
          </p>
          <p data-testid="policy-array-state">
            {arrOn
              ? 'Opted in — over-target proposals may fire for Movies + TV.'
              : 'Not opted in — this array never proposes, even over target.'}
          </p>
        </div>
        <div className="space-policy__controls">
          {arrOn ? (
            <button
              type="button"
              className="btn sm"
              data-testid="policy-array-disable"
              disabled={save.isPending || !p}
              onClick={() => p && save.mutate(withArrayConfig(p, POLICY_ARRAY_KEY, { enabled: false }))}
            >
              Opt out
            </button>
          ) : (
            <button
              type="button"
              className="btn sm"
              data-testid="policy-array-enable"
              disabled={save.isPending || !p}
              onClick={() => p && save.mutate(withArrayConfig(p, POLICY_ARRAY_KEY, { enabled: true }))}
            >
              Opt in
            </button>
          )}
          <label className="space-policy__field">
            <span className="muted">Cooldown</span>
            <input
              type="number"
              min={0}
              max={365}
              value={cooldownValue}
              data-testid="policy-cooldown"
              aria-label={`${POLICY_ARRAY_LABEL} proposal cooldown in days`}
              onChange={(e) => setCooldownDraft(e.target.value)}
            />
            <span className="muted">days</span>
            <button
              type="button"
              className="btn sm"
              data-testid="policy-cooldown-save"
              disabled={save.isPending || !p || !cooldownValid || cooldownDraft === null}
              onClick={() =>
                p && save.mutate(withArrayConfig(p, POLICY_ARRAY_KEY, { cooldownDays: parsedCooldown }))
              }
            >
              Save
            </button>
          </label>
        </div>
      </div>

      {/* Status line — last proposal + next-eligible per kind (live over/under is on the array card). */}
      <div className="space-policy__status" data-testid="policy-status">
        <strong>Status</strong>
        {status.isLoading ? (
          <p className="muted">Loading status…</p>
        ) : (
          <>
            <p>
              Last proposal:{' '}
              {status.data?.lastProposalAt ? formatWhen(status.data.lastProposalAt) : 'none yet'}
            </p>
            <ul className="space-policy__kinds">
              {towerKinds.map((k) => (
                <li key={k.mediaKind} data-testid={`policy-kind-${k.mediaKind}`}>
                  {k.mediaKind === 'movie' ? 'Movies' : 'TV'}:{' '}
                  {k.hasOpenBatch
                    ? 'an open batch is holding the slot'
                    : k.lastProposal
                      ? `last ${formatWhen(k.lastProposal.proposedAt)} · ${nextEligibleLabel(k.nextEligibleAt)}`
                      : 'no proposal yet · eligible now'}
                </li>
              ))}
            </ul>
          </>
        )}
      </div>

      <TuningBlock />
    </section>
  );
}

// ---------------------------------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------------------------------

export default function AdminStoragePage() {
  const utilization = trpc.storage.utilization.useQuery();

  return (
    <>
      <div className="admin-head">
        <h1>Storage</h1>
      </div>
      <p className="muted">
        Current disk utilization per media array against its space target, and what the Trash
        pipeline’s sweeps have reclaimed — by category, resolution, and batch.
      </p>

      {utilization.isLoading ? <p className="muted">Loading utilization…</p> : null}
      {utilization.error ? (
        <p className="alert" role="alert">
          Failed to load utilization: {utilization.error.message}
        </p>
      ) : null}

      <section className="storage-arrays" aria-label="Disk utilization">
        {utilization.data?.map((array) => (
          <ArrayCard key={array.key} array={array} />
        ))}
      </section>

      {/* ADR-031 / DESIGN-014 — the propose-only space policy + rules-tuning / graduation block. */}
      <SpacePolicyCard />

      {/* ADR-030 C-04 — the fill/drain history is Grafana, deep-linked (never an iframe). */}
      <a
        className="card storage-grafana"
        href={GRAFANA_TREND_URL}
        target="_blank"
        rel="noreferrer"
        data-testid="grafana-trend-link"
      >
        <span className="storage-grafana__title">Free-space trend &amp; history →</span>
        <span className="muted">
          Opens the Grafana dashboard in a new tab — same Authentik sign-in you already hold.
        </span>
      </a>

      <ReclaimSection />
    </>
  );
}
