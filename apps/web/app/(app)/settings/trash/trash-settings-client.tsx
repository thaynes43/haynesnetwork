'use client';

// ADR-032 / DESIGN-004 D-16 · IA reshuffle (2026-07-09, build B) — /settings/trash is now a TABBED
// hub. The SafetyBanner sits above the tab strip (it governs rule edits regardless of tab); the tabs
// are the URL-driven `?tab=` pattern shared with /trash · /library · /ledger (role="tablist" +
// roving-tabindex keyboard nav, `.library-tabs`):
//
//   • General — admin gate + default save window + the Notifications delivery window + the Batch
//               policy form (batch composition is pipeline behavior, not storage). Admin-only.
//   • Storage — utilization meters + space targets + Space policy + the Grafana deep-link
//               (everything storage/target, moved from /admin/storage). Admin-only.
//   • Reclaim — the reclaim-attribution report (moved from /admin/storage). Admin-only.
//   • Rules   — the Maintainerr deletion-rules list (arm/disarm/delete). Trash-EDIT (the page gate).
//
// GATING: the page gate is Trash-section EDIT (ADR-032); admins imply it. Every General/Storage/
// Reclaim control reads an adminProcedure, so those three tabs are ADMIN-ONLY — a trash-edit-but-not-
// admin viewer sees ONLY the Rules tab (the tab strip lists just what they can use). The retired
// /admin/storage route redirects to `/settings/trash?tab=storage`.
import { useEffect, useState, type KeyboardEvent } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { ConfirmButton } from '@hnet/ui';
import { trpc } from '@/lib/trpc-client';
import { SafetyBanner } from '@/components/trash-safety';
import type { TrashAccess } from '@/components/trash-shield';
import { describeMutationError } from '@/lib/app-error';
import { GeneralTab } from './general-tab';
import { StorageTab } from './storage-tab';
import { ReclaimTab } from './reclaim-tab';

// ── Rules (readable list + arm/disarm/delete — the Rules tab) ─────────────────────────────

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

// ── the tabbed hub shell ──────────────────────────────────────────────────────────────────

const TAB_DEFS = [
  { key: 'general', label: 'General', adminOnly: true },
  { key: 'storage', label: 'Storage', adminOnly: true },
  { key: 'reclaim', label: 'Reclaim', adminOnly: true },
  { key: 'rules', label: 'Rules', adminOnly: false },
] as const;
type TabKey = (typeof TAB_DEFS)[number]['key'];

export function TrashSettingsClient({
  access,
  viewerIsAdmin,
}: {
  access: TrashAccess;
  /** Admin unlocks the General/Storage/Reclaim tabs (their controls are adminProcedure). */
  viewerIsAdmin: boolean;
}) {
  const status = trpc.trash.status.useQuery();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const tabs = TAB_DEFS.filter((t) => viewerIsAdmin || !t.adminOnly);
  const fallback: TabKey = tabs[0]!.key;
  const rawTab = searchParams.get('tab');
  const active: TabKey = tabs.some((t) => t.key === rawTab) ? (rawTab as TabKey) : fallback;

  // Canonicalize an unknown / not-permitted ?tab (e.g. a non-admin deep-linked to ?tab=storage, or a
  // bare /settings/trash) to the first available tab — same replace-only contract as the other hubs.
  useEffect(() => {
    if (rawTab !== active) {
      const params = new URLSearchParams();
      params.set('tab', active);
      router.replace(`${pathname}?${params.toString()}`, { scroll: false });
    }
  }, [rawTab, active, pathname, router]);

  const selectTab = (key: TabKey) => {
    // A screen-level tab switch PUSHES a history entry (DESIGN-004 D-19) so Back returns to
    // the prior tab. (The canonicalize effect above stays router.replace: folding an
    // unknown/not-permitted ?tab to the first available tab must not mint a history entry.)
    const params = new URLSearchParams();
    params.set('tab', key);
    router.push(`${pathname}?${params.toString()}`, { scroll: false });
  };

  const onTabKeyDown = (e: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let nextIndex: number | null = null;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') nextIndex = (index + 1) % tabs.length;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp')
      nextIndex = (index - 1 + tabs.length) % tabs.length;
    else if (e.key === 'Home') nextIndex = 0;
    else if (e.key === 'End') nextIndex = tabs.length - 1;
    if (nextIndex === null) return;
    e.preventDefault();
    const key = tabs[nextIndex]!.key;
    selectTab(key);
    document.getElementById(`settingstab-${key}`)?.focus();
  };

  return (
    <>
      <h1 className="page-title">Trash settings</h1>

      <SafetyBanner
        status={status.data}
        loading={status.isLoading}
        failed={status.error !== null}
      />

      <div className="library-tabs" role="tablist" aria-label="Trash settings sections">
        {tabs.map((tab, index) => (
          <button
            key={tab.key}
            type="button"
            role="tab"
            id={`settingstab-${tab.key}`}
            data-testid={`settingstab-${tab.key}`}
            aria-selected={active === tab.key}
            aria-controls="settings-panel"
            tabIndex={active === tab.key ? 0 : -1}
            onClick={() => selectTab(tab.key)}
            onKeyDown={(e) => onTabKeyDown(e, index)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div id="settings-panel" role="tabpanel" aria-labelledby={`settingstab-${active}`}>
        {active === 'general' && viewerIsAdmin ? <GeneralTab /> : null}
        {active === 'storage' && viewerIsAdmin ? <StorageTab /> : null}
        {active === 'reclaim' && viewerIsAdmin ? <ReclaimTab /> : null}
        {active === 'rules' ? (
          <section className="settings-section">
            <h2 className="settings-section__head">Deletion rules</h2>
            <RulesSection access={access} reachable={status.data?.reachable === true} />
          </section>
        ) : null}
      </div>
    </>
  );
}
