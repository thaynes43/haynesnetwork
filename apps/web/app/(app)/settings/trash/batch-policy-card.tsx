'use client';

// ADR-032 · IA reshuffle (2026-07-09, build C) — the Batch policy card, RELOCATED from the Storage tab
// to the GENERAL tab (owner-directed 2026-07-09: batch composition is PIPELINE behavior, not storage —
// it belongs with the other pipeline knobs). The storage.policy.* router/procedures are UNCHANGED — only
// the UI moved. It keeps its OWN single green Save (data-testid="settings-save"): a self-contained
// section that commits mode / min candidates / per-kind caps together (#134 pattern), a
// sibling of — not folded into — the General tab's consolidated Admin-gate/save-window/Notifications
// form (which has its own separate single Save). Two save units, two cards.
import { useState } from 'react';
import type { SpacePolicy, SpacePolicyMode } from '@hnet/domain';
import { trpc } from '@/lib/trpc-client';
import { describeMutationError } from '@/lib/app-error';
import { BYTES_PER_GB } from '@/lib/trash-batches';

const POLICY_MODES = ['over-target', 'continuous'] as const;
const MODE_LABELS: Record<SpacePolicyMode, string> = {
  'over-target': 'Only over the disk target',
  continuous: 'Continuous (whenever there are candidates)',
};
const MODE_HELP: Record<SpacePolicyMode, string> = {
  'over-target':
    'Propose a batch only when a media array is over its space target (set on the Storage tab). Under target, nothing is proposed.',
  continuous:
    'Propose whenever there are at least the minimum candidates and no batch is open — the disk target is NOT required. Utilization is still read for reporting.',
};

interface KindCapsDraft {
  maxItems: { enabled: boolean; value: string };
  targetGb: { enabled: boolean; value: string };
}
interface PolicyDraft {
  mode: SpacePolicyMode;
  minCandidates: string;
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
    perKind: { movie: kindToDraft(policy.perKind.movie), tv: kindToDraft(policy.perKind.tv) },
  };
}

const intOrNaN = (s: string): number => (/^-?\d+$/.test(s.trim()) ? Number(s) : NaN);

function draftValid(d: PolicyDraft): boolean {
  const min = intOrNaN(d.minCandidates);
  if (!(min >= 0 && min <= 100000)) return false;
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
          onChange={(e) =>
            onChange({ ...caps, maxItems: { ...caps.maxItems, enabled: e.target.checked } })
          }
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
          onChange={(e) =>
            onChange({ ...caps, maxItems: { ...caps.maxItems, value: e.target.value } })
          }
        />
        <span className="muted">items</span>
      </label>
      <label className="batch-policy__cap">
        <input
          type="checkbox"
          checked={caps.targetGb.enabled}
          disabled={disabled}
          data-testid={`policy-cap-targetbytes-${kind}-enabled`}
          onChange={(e) =>
            onChange({ ...caps, targetGb: { ...caps.targetGb, enabled: e.target.checked } })
          }
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
          onChange={(e) =>
            onChange({ ...caps, targetGb: { ...caps.targetGb, value: e.target.value } })
          }
        />
        <span className="muted">GB</span>
      </label>
    </div>
  );
}

export function BatchPolicyCard() {
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
          How the automatic space policy proposes batches. When it proposes, it posts the batch straight
          to Leaving Soon with the save window — the cycle runs unattended; only the windowed sweep
          deletes. These caps also pre-fill the manual “Start a batch” picker.
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
            <p className="muted">
              Don’t propose a batch unless at least this many items are pending.
            </p>
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

        <div className="batch-settings__row batch-settings__row--stack">
          <div className="batch-settings__copy">
            <strong>Per-kind caps</strong>
            <p className="muted">
              Cap how big a proposed (or manually started) batch gets. Enable either cap — when both
              are on, the batch stops at the first one it hits. Policy batches take the worst-rated
              first.
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
