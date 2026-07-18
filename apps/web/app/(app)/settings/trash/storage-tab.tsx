'use client';

// ADR-030/031 · DESIGN-013/014 · IA reshuffle (2026-07-09, build B) — the STORAGE tab of the tabbed
// Trash Settings hub. Everything storage / target / policy, RELOCATED verbatim from the retired
// /admin/storage page (the storage.* + trash.* routers/procedures are UNCHANGED — only the UI moved):
//   1. Utilization — one capacity meter per media array + the inline space-TARGET editor (each array
//      keeps its own optimistic, reflow-free tick save — a direct manipulation, ADR-015, not a form).
//   2. Free-space trend — the fill/drain TIME-SERIES, now a NATIVE chart off in-cluster Prometheus
//      (ADR-030 C-04 amendment 2026-07-09 — the LAN-only Grafana deep-link retired to a footnote).
//   3. Space policy — the propose-only automatic policy: enable ceremony + per-array opt-in + the
//      rules-tuning / graduation block (ADR-031).
// Admin-only (this whole tab is adminProcedure reads). The Batch policy form (#134) MOVED to the
// General tab (build C, 2026-07-09) — batch composition is pipeline behavior, not storage.
import { useState, type FormEvent } from 'react';
import { ConfirmButton } from '@hnet/ui';
import { trpc } from '@/lib/trpc-client';
import { describeMutationError } from '@/lib/app-error';
import { formatWhen } from '@/lib/media';
import {
  ARRAY_TARGET_SLUGS,
  formatCapacity,
  utilizationSummary,
  utilizationTone,
  type StorageArrayUtilization,
} from '@/lib/storage';
import { FreespaceTrend } from './freespace-trend';
import {
  POLICY_ARRAY_KEY,
  POLICY_ARRAY_LABEL,
  arrayEnabled,
  graduationVerdict,
  overTargetLabel,
  saveRateLabel,
  withArrayConfig,
  withEnabled,
} from '@/lib/space-policy';

// ---------------------------------------------------------------------------------------------------
// Utilization card (meter + inline target editor) — moved verbatim from /admin/storage.
// ---------------------------------------------------------------------------------------------------

function ArrayCard({ array }: { array: StorageArrayUtilization }) {
  const utils = trpc.useUtils();
  const targets = trpc.storage.targets.get.useQuery();
  const slug = ARRAY_TARGET_SLUGS[array.key];

  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const storedTarget = slug ? (targets.data?.[slug] ?? null) : null;
  const value = draft ?? (storedTarget == null ? '' : String(storedTarget));
  const parsed = value === '' ? null : Number(value);
  const invalid = parsed != null && (!Number.isInteger(parsed) || parsed < 0 || parsed > 100);
  const dirty = draft != null && value !== (storedTarget == null ? '' : String(storedTarget));

  const save = trpc.storage.targets.set.useMutation({
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
      setDraft(null);
    },
    onSettled: () =>
      Promise.all([utils.storage.targets.get.invalidate(), utils.storage.utilization.invalidate()]),
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!slug || invalid || !dirty) return;
    setSaved(false);
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
          <span className="storage-target__status" role="status">
            {invalid ? 'Whole 0–100 only' : saved ? 'Saved' : dirty ? 'Unsaved' : ' '}
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
// Space policy card (ADR-031 / DESIGN-014 — propose-only) + rules-tuning / graduation block.
// ---------------------------------------------------------------------------------------------------

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
        What the family rescued vs. what the sweep deleted — the labelled false positives you tune
        the Maintainerr rules against. Save-rate is rescued ÷ (rescued + deleted); a high rate means
        the rules are too aggressive for that slice.
      </p>

      {empty ? (
        <p className="muted" data-testid="tuning-empty">
          No curated batches have reached a keep-or-delete verdict yet — this fills in as batches
          sweep.
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
          The bar (ADR-031 C-05): at least {g.thresholds.minCompletedBatches} completed policy
          batches, an aggregate save-rate at or below {g.thresholds.maxSaveRatePct}%, and no
          restores of swept items. Flipping the skip-gate stays an owner action, on the General tab.
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
  const [error, setError] = useState<string | null>(null);

  const save = trpc.storage.policy.set.useMutation({
    onSuccess: () => {
      setError(null);
      void utils.storage.policy.get.invalidate();
      void utils.storage.policy.status.invalidate();
    },
    onError: (err: unknown) => setError(describeMutationError(err)),
  });

  const p = policy.data;
  const enabled = p?.enabled === true;
  const arrOn = p ? arrayEnabled(p, POLICY_ARRAY_KEY) : false;

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
    <section
      className="card space-policy admin-section"
      data-testid="space-policy"
      aria-label="Space policy"
    >
      <h2>Space policy</h2>
      <p className="muted">
        When an array is over its space target, the policy posts a Leaving-Soon batch on its own — with
        the save window open — so the cycle runs unattended. It never deletes on its own: only the
        windowed sweep reclaims once the save window closes.
      </p>
      {error !== null ? (
        <p className="alert" role="alert">
          {error}
        </p>
      ) : null}

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
              onClick={() =>
                p && save.mutate(withArrayConfig(p, POLICY_ARRAY_KEY, { enabled: false }))
              }
            >
              Opt out
            </button>
          ) : (
            <button
              type="button"
              className="btn sm"
              data-testid="policy-array-enable"
              disabled={save.isPending || !p}
              onClick={() =>
                p && save.mutate(withArrayConfig(p, POLICY_ARRAY_KEY, { enabled: true }))
              }
            >
              Opt in
            </button>
          )}
        </div>
      </div>

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
                      ? `last ${formatWhen(k.lastProposal.proposedAt)}`
                      : 'no proposal yet'}
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
// Storage tab
// ---------------------------------------------------------------------------------------------------

export function StorageTab() {
  const utilization = trpc.storage.utilization.useQuery();

  return (
    <>
      <p className="muted">
        Current disk utilization per media array against its space target and the automatic space
        policy. Batch composition caps live on the General tab; what the Trash pipeline reclaims
        lives on the Reclaim tab.
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

      {/* ADR-030 C-04 amendment (2026-07-09) — the fill/drain history is now a NATIVE chart off
          in-cluster Prometheus; the LAN-only Grafana dashboard survives as the card's footnote. */}
      <FreespaceTrend />

      <SpacePolicyCard />
    </>
  );
}
