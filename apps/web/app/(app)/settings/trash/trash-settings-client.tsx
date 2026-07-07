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
import { trpc } from '@/lib/trpc-client';
import { SafetyBanner } from '@/components/trash-safety';
import type { TrashAccess } from '@/components/trash-shield';
import { describeMutationError } from '@/lib/app-error';

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

// ── Pipeline settings (admin — ADR-025 C-06/C-07; moved verbatim from batches-tab.tsx) ───

function TrashSettingsCard() {
  const utils = trpc.useUtils();
  const settings = trpc.trash.settings.get.useQuery();
  const [windowDraft, setWindowDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const save = trpc.trash.settings.set.useMutation({
    onSuccess: () => {
      setError(null);
      setWindowDraft(null);
      void utils.trash.settings.get.invalidate();
    },
    onError: (err: unknown) => setError(describeMutationError(err)),
  });

  const skipGate = settings.data?.trash_skip_admin_gate === true;
  const serverDays = settings.data?.trash_default_window_days ?? 21;
  const daysValue = windowDraft ?? String(serverDays);
  const parsedDays = Number(daysValue);
  const daysValid = Number.isInteger(parsedDays) && parsedDays >= 1 && parsedDays <= 365;

  const flipGate = async (next: boolean): Promise<'ok' | 'failed'> => {
    try {
      await save.mutateAsync({ trashSkipAdminGate: next });
      return 'ok';
    } catch {
      return 'failed'; // save.onError already set the message
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
      <div className="batch-settings__row">
        <div className="batch-settings__copy">
          <strong>Admin gate</strong>
          <p className="muted">
            With the gate on, every batch waits in Admin review for the poster pass. Skipping it
            sends new batches <strong>straight to Leaving Soon</strong> — no human review before the
            save window opens. The flip is audited either way.
          </p>
          <p data-testid="skipgate-state">
            {settings.isLoading
              ? 'Loading…'
              : skipGate
                ? 'Skip-gate is ON — new batches go straight to Leaving Soon.'
                : 'Gate is ON — every batch waits for admin review.'}
          </p>
        </div>
        {skipGate ? (
          <button
            type="button"
            className="btn sm"
            data-testid="skipgate-disable"
            disabled={save.isPending || settings.isLoading}
            onClick={() =>
              void save.mutateAsync({ trashSkipAdminGate: false }).catch(() => undefined)
            }
          >
            Restore the admin gate
          </button>
        ) : (
          <ConfirmButton
            className="btn sm danger"
            data-testid="skipgate-enable"
            label="Skip the admin gate"
            reArmOnFailure
            disabled={save.isPending || settings.isLoading}
            restingAriaLabel="Skip the admin gate — new batches go straight to Leaving Soon without review — click twice to confirm"
            confirmAriaLabel="Confirm skipping the admin gate"
            onConfirm={() => flipGate(true)}
          />
        )}
      </div>
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
            value={daysValue}
            data-testid="settings-window"
            aria-label="Default save window in days"
            onChange={(e) => setWindowDraft(e.target.value)}
          />
          <span className="muted">days</span>
          <button
            type="button"
            className="btn sm"
            data-testid="settings-window-save"
            disabled={save.isPending || !daysValid || windowDraft === null}
            onClick={() => save.mutate({ trashDefaultWindowDays: parsedDays })}
          >
            Save
          </button>
        </span>
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
