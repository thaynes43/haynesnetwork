'use client';

// ADR-030/031 · DESIGN-013/014 · IA reshuffle (2026-07-09, build B) — the STORAGE tab of the tabbed
// Trash Settings hub. Everything storage / target / policy, RELOCATED verbatim from the retired
// /admin/storage page (the storage.* + trash.* routers/procedures are UNCHANGED — only the UI moved):
//   1. Utilization — one capacity meter per media array + the inline space-TARGET editor (each array
//      keeps its own optimistic, reflow-free tick save — a direct manipulation, ADR-015, not a form).
//   2. Grafana deep-link — the fill/drain TIME-SERIES lives in Grafana, deep-linked (ADR-030 C-04).
//   3. Space policy — the propose-only automatic policy: enable ceremony + per-array opt-in + the
//      rules-tuning / graduation block (ADR-031).
//   4. Batch policy — the #134 form (mode / min candidates / cooldown / per-kind caps) with its
//      single green Save. Admin-only (this whole tab is adminProcedure reads).
import { useState, type FormEvent } from 'react';
import { ConfirmButton } from '@hnet/ui';
import type { SpacePolicy, SpacePolicyMode } from '@hnet/domain';
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
import { BYTES_PER_GB } from '@/lib/trash-batches';

/** ADR-030 C-04 / OPS-007 — the deep-linked (never embedded) free-space trend dashboard. */
const GRAFANA_TREND_URL = 'https://grafana.haynesops.com/d/media-storage-utilization';

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
          items. Flipping the skip-gate stays an owner action, on the General tab.
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
// Batch policy card (#134) — mode / min candidates / cooldown / per-kind caps, single green Save.
// Relocated from /settings/trash's pipeline card (the default save window moved to the General tab).
// ---------------------------------------------------------------------------------------------------

const POLICY_MODES = ['over-target', 'continuous'] as const;
const MODE_LABELS: Record<SpacePolicyMode, string> = {
  'over-target': 'Only over the disk target',
  continuous: 'Continuous (candidates + cooldown)',
};
const MODE_HELP: Record<SpacePolicyMode, string> = {
  'over-target':
    'Propose a batch only when a media array is over its space target (set above). Under target, nothing is proposed.',
  continuous:
    'Propose whenever there are at least the minimum candidates and the cooldown has elapsed — the disk target is NOT required. Utilization is still read for reporting.',
};

interface KindCapsDraft {
  maxItems: { enabled: boolean; value: string };
  targetGb: { enabled: boolean; value: string };
}
interface PolicyDraft {
  mode: SpacePolicyMode;
  minCandidates: string;
  cooldownDays: string;
  perKind: Record<'movie' | 'tv', KindCapsDraft>;
}

const gbFromBytes = (bytes: number): string => String(Math.round((bytes / BYTES_PER_GB) * 10) / 10);

function kindToDraft(caps: SpacePolicy['perKind']['movie']): KindCapsDraft {
  return {
    maxItems: { enabled: caps.maxItems.enabled, value: String(caps.maxItems.value) },
    targetGb: { enabled: caps.targetBytes.enabled, value: gbFromBytes(caps.targetBytes.value) },
  };
}

function toDraft(policy: SpacePolicy): PolicyDraft {
  return {
    mode: policy.mode,
    minCandidates: String(policy.minCandidates),
    cooldownDays: String(policy.cooldownDays),
    perKind: { movie: kindToDraft(policy.perKind.movie), tv: kindToDraft(policy.perKind.tv) },
  };
}

const intOrNaN = (s: string): number => (/^-?\d+$/.test(s.trim()) ? Number(s) : NaN);

function draftValid(d: PolicyDraft): boolean {
  const min = intOrNaN(d.minCandidates);
  if (!(min >= 0 && min <= 100000)) return false;
  const cd = intOrNaN(d.cooldownDays);
  if (!(cd >= 0 && cd <= 365)) return false;
  for (const kind of ['movie', 'tv'] as const) {
    const k = d.perKind[kind];
    if (k.maxItems.enabled) {
      const v = intOrNaN(k.maxItems.value);
      if (!(v >= 1 && v <= 100000)) return false;
    }
    if (k.targetGb.enabled) {
      const v = Number(k.targetGb.value);
      if (!(Number.isFinite(v) && v > 0)) return false;
    }
  }
  return true;
}

function draftToPolicy(d: PolicyDraft, base: SpacePolicy): SpacePolicy {
  const kindFromDraft = (
    k: KindCapsDraft,
    baseCaps: SpacePolicy['perKind']['movie'],
  ): SpacePolicy['perKind']['movie'] => ({
    maxItems: {
      enabled: k.maxItems.enabled,
      value: Number.isFinite(intOrNaN(k.maxItems.value))
        ? intOrNaN(k.maxItems.value)
        : baseCaps.maxItems.value,
    },
    targetBytes: {
      enabled: k.targetGb.enabled,
      value: Number.isFinite(Number(k.targetGb.value))
        ? Math.round(Number(k.targetGb.value) * BYTES_PER_GB)
        : baseCaps.targetBytes.value,
    },
  });
  return {
    ...base,
    mode: d.mode,
    minCandidates: intOrNaN(d.minCandidates),
    cooldownDays: intOrNaN(d.cooldownDays),
    perKind: {
      movie: kindFromDraft(d.perKind.movie, base.perKind.movie),
      tv: kindFromDraft(d.perKind.tv, base.perKind.tv),
    },
  };
}

function KindCapsRow({
  kind,
  label,
  caps,
  disabled,
  onChange,
}: {
  kind: 'movie' | 'tv';
  label: string;
  caps: KindCapsDraft;
  disabled: boolean;
  onChange: (next: KindCapsDraft) => void;
}) {
  return (
    <div className="batch-policy__kind" data-testid={`policy-kind-caps-${kind}`}>
      <strong className="batch-policy__kind-label">{label}</strong>
      <label className="batch-policy__cap">
        <input
          type="checkbox"
          checked={caps.maxItems.enabled}
          disabled={disabled}
          data-testid={`policy-cap-maxitems-${kind}-enabled`}
          onChange={(e) => onChange({ ...caps, maxItems: { ...caps.maxItems, enabled: e.target.checked } })}
        />
        <span>Cap item count</span>
        <input
          type="number"
          className="batch-window-input"
          min={1}
          max={100000}
          value={caps.maxItems.value}
          disabled={disabled || !caps.maxItems.enabled}
          data-testid={`policy-cap-maxitems-${kind}-value`}
          aria-label={`${label} — max items per batch`}
          onChange={(e) => onChange({ ...caps, maxItems: { ...caps.maxItems, value: e.target.value } })}
        />
        <span className="muted">items</span>
      </label>
      <label className="batch-policy__cap">
        <input
          type="checkbox"
          checked={caps.targetGb.enabled}
          disabled={disabled}
          data-testid={`policy-cap-targetbytes-${kind}-enabled`}
          onChange={(e) => onChange({ ...caps, targetGb: { ...caps.targetGb, enabled: e.target.checked } })}
        />
        <span>Cap size</span>
        <input
          type="number"
          className="batch-window-input"
          min={1}
          value={caps.targetGb.value}
          disabled={disabled || !caps.targetGb.enabled}
          data-testid={`policy-cap-targetbytes-${kind}-value`}
          aria-label={`${label} — target GB to free per batch`}
          onChange={(e) => onChange({ ...caps, targetGb: { ...caps.targetGb, value: e.target.value } })}
        />
        <span className="muted">GB</span>
      </label>
    </div>
  );
}

function BatchPolicyCard() {
  const utils = trpc.useUtils();
  const policy = trpc.storage.policy.get.useQuery();
  const [draft, setDraft] = useState<PolicyDraft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const savePolicy = trpc.storage.policy.set.useMutation();

  const loaded = policy.data !== undefined;
  const server = loaded ? toDraft(policy.data as SpacePolicy) : null;
  const form = draft ?? server;

  const dirty = form !== null && server !== null && JSON.stringify(form) !== JSON.stringify(server);
  const valid = form !== null && draftValid(form);
  const saving = savePolicy.isPending;

  const patch = (next: Partial<PolicyDraft>) => {
    if (form === null) return;
    setSaved(false);
    setDraft({ ...form, ...next });
  };

  const onSave = async () => {
    if (form === null || policy.data === undefined || !valid) return;
    setError(null);
    setSaved(false);
    try {
      await savePolicy.mutateAsync(draftToPolicy(form, policy.data as SpacePolicy));
      setDraft(null);
      setSaved(true);
      void utils.storage.policy.get.invalidate();
      void utils.storage.policy.status.invalidate();
    } catch (err) {
      setError(describeMutationError(err));
    }
  };

  return (
    <section className="card batch-settings" data-testid="trash-settings-batch">
      <h2 className="batch-settings__head">Batch policy</h2>
      {error !== null ? (
        <p className="alert" role="alert">
          {error}
        </p>
      ) : null}

      <div className="batch-policy" data-testid="batch-policy">
        <p className="muted">
          How the automatic space policy proposes batches (it only ever proposes — the admin gate stays
          the human check). These caps also pre-fill the manual “Start a batch” picker.
        </p>

        <div className="batch-settings__row">
          <div className="batch-settings__copy">
            <strong>Proposal mode</strong>
            <p className="muted" data-testid="policy-mode-help">
              {form ? MODE_HELP[form.mode] : ''}
            </p>
          </div>
          <span className="batch-settings__field">
            <select
              className="batch-strategy-select"
              value={form?.mode ?? 'over-target'}
              disabled={!loaded}
              data-testid="policy-mode"
              aria-label="Space-policy proposal mode"
              onChange={(e) => patch({ mode: e.target.value as SpacePolicyMode })}
            >
              {POLICY_MODES.map((m) => (
                <option key={m} value={m}>
                  {MODE_LABELS[m]}
                </option>
              ))}
            </select>
          </span>
        </div>

        <div className="batch-settings__row">
          <div className="batch-settings__copy">
            <strong>Minimum candidates</strong>
            <p className="muted">Don’t propose a batch unless at least this many items are pending.</p>
          </div>
          <span className="batch-settings__field">
            <input
              type="number"
              className="batch-window-input"
              min={0}
              max={100000}
              value={form?.minCandidates ?? ''}
              disabled={!loaded}
              data-testid="policy-mincandidates"
              aria-label="Minimum candidates to propose a batch"
              onChange={(e) => patch({ minCandidates: e.target.value })}
            />
            <span className="muted">items</span>
          </span>
        </div>

        <div className="batch-settings__row">
          <div className="batch-settings__copy">
            <strong>Cooldown</strong>
            <p className="muted">Don’t re-propose a kind within this many days of its last policy batch.</p>
          </div>
          <span className="batch-settings__field">
            <input
              type="number"
              className="batch-window-input"
              min={0}
              max={365}
              value={form?.cooldownDays ?? ''}
              disabled={!loaded}
              data-testid="policy-cooldowndays"
              aria-label="Proposal cooldown in days"
              onChange={(e) => patch({ cooldownDays: e.target.value })}
            />
            <span className="muted">days</span>
          </span>
        </div>

        <div className="batch-settings__row batch-settings__row--stack">
          <div className="batch-settings__copy">
            <strong>Per-kind caps</strong>
            <p className="muted">
              Cap how big a proposed (or manually started) batch gets. Enable either cap — when both are
              on, the batch stops at the first one it hits. Policy batches take the worst-rated first.
            </p>
          </div>
          <div className="batch-policy__kinds">
            {form
              ? (['movie', 'tv'] as const).map((kind) => (
                  <KindCapsRow
                    key={kind}
                    kind={kind}
                    label={kind === 'movie' ? 'Movies' : 'TV'}
                    caps={form.perKind[kind]}
                    disabled={!loaded}
                    onChange={(next) => patch({ perKind: { ...form.perKind, [kind]: next } })}
                  />
                ))
              : null}
          </div>
        </div>
      </div>

      <div className="form-actions batch-settings__save">
        <button
          type="button"
          className="btn primary"
          data-testid="settings-save"
          disabled={!loaded || saving || !dirty || !valid}
          onClick={() => void onSave()}
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
        <span className="batch-settings__status" role="status">
          {!valid && form !== null ? 'Check the values' : saved ? 'Saved' : dirty ? 'Unsaved' : ' '}
        </span>
      </div>
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
        Current disk utilization per media array against its space target, the automatic space policy,
        and the batch composition caps. What the Trash pipeline reclaims lives on the Reclaim tab.
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

      <SpacePolicyCard />
      <BatchPolicyCard />
    </>
  );
}
