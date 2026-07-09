'use client';

// ADR-032 / DESIGN-004 D-16 — the Trash SETTINGS surface, relocated from the /trash tabs
// (the Rules tab + the Batches tab's settings card were settings living among user-facing
// surfaces). Two sections, both verbatim relocations — the controls, testids, gates, and
// ceremony (ADR-014 two-step for the skip-gate; rule delete stays a ConfirmButton) are
// unchanged so the server contracts and the specs keep their shape:
//
// - RULES (DESIGN-010 D-09 scope): the readable Maintainerr rule list + arm/disarm/delete.
//   Editing needs section Edit + the edit_rules grant AND a reachable Maintainerr — the page
//   gate already required Edit, so here only the grant + reachability vary.
// - PIPELINE SETTINGS (ADR-025 C-06/C-07): the audited skip-gate flip + the default save
//   window. trash.settings.* is adminProcedure, so the card renders for admins only.
//
// The safety banner sits on top (shared component) — rule edits are disabled while
// Maintainerr is unreachable, and the banner is the honest WHY (ADR-015: reserved height).
import { useState } from 'react';
import { ConfirmButton } from '@hnet/ui';
import type { SpacePolicy, SpacePolicyMode } from '@hnet/domain';
import { trpc } from '@/lib/trpc-client';
import { SafetyBanner } from '@/components/trash-safety';
import type { TrashAccess } from '@/components/trash-shield';
import { describeMutationError } from '@/lib/app-error';
import { BYTES_PER_GB } from '@/lib/trash-batches';

// ── Rules (readable list + arm/disarm/delete — moved verbatim from trash-client.tsx) ─────

/** GET /rules `dataType` is a STRING `MediaItemType` ('movie'|'show'|'season'|'episode') on v3.17.0
 *  (verified against source — the rule_group column is varchar; DESIGN-010 D-02 flag (a), resolved).
 *  Display-only: we still accept the legacy numeric spelling (1=movie…) defensively, but this label
 *  NEVER feeds the arm/disarm PUT — that round-trips dataType verbatim (a coerced value would be a
 *  crucial-setting change that wipes the collection). */
function ruleKindLabel(dataType: unknown): string {
  if (dataType === 1 || dataType === 'movie') return 'Movies';
  if (dataType === 2 || dataType === 'show') return 'TV';
  if (dataType === 3 || dataType === 'season') return 'TV (seasons)';
  if (dataType === 4 || dataType === 'episode') return 'TV (episodes)';
  return '—';
}

function RulesSection({ access, reachable }: { access: TrashAccess; reachable: boolean }) {
  const utils = trpc.useUtils();
  const rules = trpc.trash.rules.useQuery();
  const [error, setError] = useState<string | null>(null);
  const canEditRules =
    access.level === 'edit' && access.actions.includes('edit_rules') && reachable;

  const invalidate = () => {
    void utils.trash.rules.invalidate();
    void utils.trash.status.invalidate();
  };
  const saveRule = trpc.trash.saveRule.useMutation({
    onError: (err: unknown) => setError(describeMutationError(err)),
    onSuccess: () => {
      setError(null);
      invalidate();
    },
  });
  const deleteRule = trpc.trash.deleteRule.useMutation({
    onError: (err: unknown) => setError(describeMutationError(err)),
    onSuccess: () => {
      setError(null);
      invalidate();
    },
  });
  const busy = saveRule.isPending || deleteRule.isPending;

  if (rules.isLoading) return <p className="muted">Loading rules…</p>;
  if (rules.error) {
    return (
      <p className="alert" role="alert">
        Couldn’t load the rules: {rules.error.message}
      </p>
    );
  }
  const list = rules.data ?? [];

  return (
    <div data-testid="trash-rules">
      <p className="muted">
        Maintainerr’s rules decide what lands in the Trash pending walls.{' '}
        {canEditRules
          ? 'You can arm, disarm, or delete a rule here; building new rules still happens in Maintainerr for now.'
          : 'Read-only — changing rules needs the edit-rules grant (and a reachable Maintainerr).'}
      </p>
      {error !== null ? (
        <p className="alert" role="alert">
          {error}
        </p>
      ) : null}
      {list.length === 0 ? (
        <p className="muted">No rules configured — nothing is scheduled for deletion.</p>
      ) : (
        <table className="admin-table">
          <thead>
            <tr>
              <th>Rule</th>
              <th>Applies to</th>
              <th>Deletes after</th>
              <th>State</th>
              {canEditRules ? <th>Actions</th> : null}
            </tr>
          </thead>
          <tbody>
            {list.map((rule, i) => {
              // The wire schema is passthrough (round-trip PUTs) — normalize the shell keys.
              const ruleId = typeof rule.id === 'number' ? rule.id : null;
              const ruleName = typeof rule.name === 'string' ? rule.name : `Rule ${ruleId ?? i}`;
              const description = typeof rule.description === 'string' ? rule.description : '';
              const collection = (rule.collection ?? {}) as Record<string, unknown>;
              const deleteAfterDays =
                typeof collection.deleteAfterDays === 'number' ? collection.deleteAfterDays : null;
              const active = rule.isActive === true;
              return (
                <tr key={ruleId ?? i} data-testid="trash-rule-row">
                  <td data-label="Rule">
                    <strong>{ruleName}</strong>
                    {description !== '' ? <span className="muted"> — {description}</span> : null}
                  </td>
                  <td data-label="Applies to">{ruleKindLabel(rule.dataType)}</td>
                  <td data-label="Deletes after">
                    {deleteAfterDays !== null ? `${deleteAfterDays} days` : '—'}
                  </td>
                  <td data-label="State">
                    <span className={`badge badge--${active ? 'warn' : 'muted'}`}>
                      {active ? 'Armed' : 'Disarmed'}
                    </span>
                  </td>
                  {canEditRules ? (
                    <td data-label="Actions">
                      <span className="row-actions">
                        <button
                          type="button"
                          className="btn sm"
                          data-testid="trash-rule-toggle"
                          disabled={busy}
                          onClick={() =>
                            saveRule.mutate({ payload: { ...rule, isActive: !active } })
                          }
                        >
                          {active ? 'Disarm' : 'Arm'}
                        </button>
                        {ruleId !== null ? (
                          <ConfirmButton
                            className="btn sm danger"
                            data-testid="trash-rule-delete"
                            disabled={busy}
                            label="Delete"
                            restingAriaLabel={`Delete rule ${ruleName} — its collection stops scheduling deletions — click twice to confirm`}
                            confirmAriaLabel={`Confirm delete rule ${ruleName}`}
                            onConfirm={() => deleteRule.mutate({ ruleGroupId: ruleId })}
                          />
                        ) : null}
                      </span>
                    </td>
                  ) : null}
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ── Pipeline settings (admin — ADR-025 C-06/C-07; DESIGN-011/014 amendment 2026-07-09, build A) ──
// The whole card is ONE form with ONE green Save at the bottom (owner form pattern 2026-07-09): the
// save window AND the batch-policy knobs (mode, per-kind caps, minCandidates, cooldownDays) commit
// together. Only the Admin GATE stays a separate immediate action (its own audited ConfirmButton
// ceremony). ADR-015: cap inputs stay rendered (disabled, dimmed) when a cap is off — toggling never
// reflows the form.

/** The proposal modes (mirrors @hnet/domain SPACE_POLICY_MODES — the client can't import the pkg). */
const POLICY_MODES = ['over-target', 'continuous'] as const;
const MODE_LABELS: Record<SpacePolicyMode, string> = {
  'over-target': 'Only over the disk target',
  continuous: 'Continuous (candidates + cooldown)',
};
const MODE_HELP: Record<SpacePolicyMode, string> = {
  'over-target':
    'Propose a batch only when a media array is over its space target (set on the Storage page). Under target, nothing is proposed.',
  continuous:
    'Propose whenever there are at least the minimum candidates and the cooldown has elapsed — the disk target is NOT required. Utilization is still read for reporting.',
};

/** A per-kind draft: strings for the inputs, booleans for the enable checkboxes (GB in the UI). */
interface KindCapsDraft {
  maxItems: { enabled: boolean; value: string };
  targetGb: { enabled: boolean; value: string };
}
interface PolicyDraft {
  windowDays: string;
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

/** Build the editable draft from the server values (the untouched baseline the form diffs against). */
function toDraft(windowDays: number, policy: SpacePolicy): PolicyDraft {
  return {
    windowDays: String(windowDays),
    mode: policy.mode,
    minCandidates: String(policy.minCandidates),
    cooldownDays: String(policy.cooldownDays),
    perKind: { movie: kindToDraft(policy.perKind.movie), tv: kindToDraft(policy.perKind.tv) },
  };
}

const intOrNaN = (s: string): number => (/^-?\d+$/.test(s.trim()) ? Number(s) : NaN);

/** Whether every field in the draft is in range (drives the Save button + per-field markers). */
function draftValid(d: PolicyDraft): boolean {
  const win = intOrNaN(d.windowDays);
  if (!(win >= 1 && win <= 365)) return false;
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

/** Fold the draft's policy fields onto the server base (preserving `enabled` + `perArray`, edited on
 *  the Storage page). A disabled cap keeps its last number so an off→on toggle restores it. */
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

function TrashSettingsCard() {
  const utils = trpc.useUtils();
  const settings = trpc.trash.settings.get.useQuery();
  const policy = trpc.storage.policy.get.useQuery();
  const [draft, setDraft] = useState<PolicyDraft | null>(null);
  const [error, setError] = useState<string | null>(null);

  const gateMut = trpc.trash.settings.set.useMutation({
    onSuccess: () => {
      setError(null);
      void utils.trash.settings.get.invalidate();
    },
    onError: (err: unknown) => setError(describeMutationError(err)),
  });
  const saveWindow = trpc.trash.settings.set.useMutation();
  const savePolicy = trpc.storage.policy.set.useMutation();

  const skipGate = settings.data?.trash_skip_admin_gate === true;
  const serverDays = settings.data?.trash_default_window_days ?? 21;
  const loaded = settings.data !== undefined && policy.data !== undefined;
  const server = loaded ? toDraft(serverDays, policy.data as SpacePolicy) : null;
  const form = draft ?? server;

  const dirty = form !== null && server !== null && JSON.stringify(form) !== JSON.stringify(server);
  const valid = form !== null && draftValid(form);
  const saving = saveWindow.isPending || savePolicy.isPending;

  const patch = (next: Partial<PolicyDraft>) => {
    if (form === null) return;
    setDraft({ ...form, ...next });
  };

  const flipGate = async (next: boolean): Promise<'ok' | 'failed'> => {
    try {
      await gateMut.mutateAsync({ trashSkipAdminGate: next });
      return 'ok';
    } catch {
      return 'failed'; // gateMut.onError already set the message
    }
  };

  const onSave = async () => {
    if (form === null || server === null || policy.data === undefined || !valid) return;
    setError(null);
    try {
      // Only write the parts that actually changed (each write is an audited app_settings row).
      if (form.windowDays !== server.windowDays) {
        await saveWindow.mutateAsync({ trashDefaultWindowDays: intOrNaN(form.windowDays) });
      }
      const policyChanged =
        JSON.stringify({
          mode: form.mode,
          minCandidates: form.minCandidates,
          cooldownDays: form.cooldownDays,
          perKind: form.perKind,
        }) !==
        JSON.stringify({
          mode: server.mode,
          minCandidates: server.minCandidates,
          cooldownDays: server.cooldownDays,
          perKind: server.perKind,
        });
      if (policyChanged) {
        await savePolicy.mutateAsync(draftToPolicy(form, policy.data as SpacePolicy));
      }
      setDraft(null);
      void utils.trash.settings.get.invalidate();
      void utils.storage.policy.get.invalidate();
      void utils.storage.policy.status.invalidate();
    } catch (err) {
      setError(describeMutationError(err));
    }
  };

  return (
    <section className="card batch-settings" data-testid="trash-settings">
      <h2 className="batch-settings__head">Batch pipeline</h2>
      {error !== null ? (
        <p className="alert" role="alert">
          {error}
        </p>
      ) : null}

      {/* Admin gate — a SEPARATE, immediate action (its own audited ConfirmButton ceremony). */}
      <div className="batch-settings__row">
        <div className="batch-settings__copy">
          <strong>Admin gate</strong>
          <p className="muted">
            With the gate on, every batch waits in Admin review for the poster pass. Turning it off
            sends new batches <strong>straight to Leaving Soon</strong> — no human review before the
            save window opens. The flip is audited either way.
          </p>
          <p data-testid="skipgate-state">
            {settings.isLoading
              ? 'Loading…'
              : skipGate
                ? 'Admin gate is OFF — new batches go straight to Leaving Soon.'
                : 'Admin gate is ON — every batch waits for admin review.'}
          </p>
        </div>
        {skipGate ? (
          // Gate currently OFF → the safe restore. Label is the ACTION: "Enable".
          <button
            type="button"
            className="btn sm"
            data-testid="gate-enable"
            disabled={gateMut.isPending || settings.isLoading}
            onClick={() => void flipGate(false)}
          >
            Enable
          </button>
        ) : (
          // Gate currently ON → disabling it is the destructive move (keeps the two-step confirm).
          <ConfirmButton
            className="btn sm danger"
            data-testid="gate-disable"
            label="Disable"
            reArmOnFailure
            disabled={gateMut.isPending || settings.isLoading}
            restingAriaLabel="Disable the admin gate — new batches go straight to Leaving Soon without review — click twice to confirm"
            confirmAriaLabel="Confirm disabling the admin gate"
            onConfirm={() => flipGate(true)}
          />
        )}
      </div>

      {/* Default save window — now part of the shared form (no inline Save). */}
      <div className="batch-settings__row">
        <div className="batch-settings__copy">
          <strong>Default save window</strong>
          <p className="muted">
            How long a green-lit batch stays in Leaving Soon before the sweep deletes the remainder.
            Green-light can override per batch.
          </p>
        </div>
        <span className="batch-settings__field">
          <input
            type="number"
            className="batch-window-input"
            min={1}
            max={365}
            value={form?.windowDays ?? ''}
            disabled={!loaded}
            data-testid="settings-window"
            aria-label="Default save window in days"
            onChange={(e) => patch({ windowDays: e.target.value })}
          />
          <span className="muted">days</span>
        </span>
      </div>

      {/* Batch policy — mode + minCandidates/cooldown + per-kind composition caps. */}
      <div className="batch-policy" data-testid="batch-policy">
        <h3 className="batch-settings__subhead">Batch policy</h3>
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
                    onChange={(next) =>
                      patch({ perKind: { ...form.perKind, [kind]: next } })
                    }
                  />
                ))
              : null}
          </div>
        </div>
      </div>

      {/* The single green Save for the whole form (gate stays its own action above). */}
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
      </div>
    </section>
  );
}

// ── the page shell: banner → rules → (admin) pipeline settings ──────────────────────────

export function TrashSettingsClient({
  access,
  viewerIsAdmin,
}: {
  access: TrashAccess;
  /** Admin unlocks the pipeline-settings card (trash.settings.* is adminProcedure). */
  viewerIsAdmin: boolean;
}) {
  const status = trpc.trash.status.useQuery();

  return (
    <>
      <h1 className="page-title">Trash settings</h1>

      <SafetyBanner
        status={status.data}
        loading={status.isLoading}
        failed={status.error !== null}
      />

      <section className="settings-section">
        <h2 className="settings-section__head">Deletion rules</h2>
        <RulesSection access={access} reachable={status.data?.reachable === true} />
      </section>

      {viewerIsAdmin ? <TrashSettingsCard /> : null}
    </>
  );
}
