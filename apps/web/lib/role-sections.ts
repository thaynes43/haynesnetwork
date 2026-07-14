// ADR-049 C-01 / DESIGN-004 D-18 (PLAN-027 roles-grid clarity) — the SECTION CAPABILITY MAP.
//
// The /admin/roles grid used to render the same Edit / Read-only / Disabled dropdown for EVERY
// section, but for most sections "Edit" grants nothing (the owner asked what each column did three
// times in one day). This map is the single source of truth for WHICH LEVELS EACH SECTION
// DISTINGUISHES, so the grid offers only meaningful choices:
//
//   - control 'tri'    → Edit / Read-only / Disabled. The section's tRPC surface actually gates a
//                        distinct `edit` rung (some procedure passes minLevel 'edit').
//   - control 'toggle' → Enabled / Disabled ONLY. The section only ever gates on `read_only` (its
//                        `edit` rung is a no-op); "Enabled" stores `read_only`, "Disabled" stores
//                        `disabled`. The stored SECTION_PERMISSION_LEVELS enum + DB values are
//                        UNCHANGED — this is a UI presentation + labelling change. A section that
//                        LATER gains a real Edit (e.g. ytdlsub per PLAN-025) just flips to 'tri'
//                        here — no grid rewrite.
//
// DERIVED FROM THE ACTUAL GATING CODE (verified 2026-07-11), NOT guessed:
//   • ledger  → 'tri'.   ledger-admin.bulkAddAndSearch = sectionProcedure('ledger','edit') (bulk
//               monitor-and-search); browse/count/run/runs are read_only. Edit ≠ Read-only.
//   • trash   → 'tri'.   trash.saveRule / trash.deleteRule = trashActionProcedure('edit_rules','edit')
//               (Maintainerr rule editing needs section EDIT) and /settings/trash requires level
//               'edit' (top-bar.tsx showTrashSettings + settings/trash/page.tsx). Edit ≠ Read-only.
//   • bulletin→ 'toggle'. feed / messages both gate on ('bulletin','read_only'); post/moderate are
//               separate MESSAGE-ACTION grants; feed/messages visibility is the ADR-049 SUB-VIEW
//               grant. No 'edit' rung exists → 2-state (its Feed/Messages checkboxes live alongside).
//   • metrics → 'toggle'. metricsProcedure = sectionProcedure('metrics','read_only'); the full|limited
//               DETAIL level is a SEPARATE control (roles.metrics_level). The section has no 'edit' rung.
//   • ytdlsub → 'toggle'. ytdlsubProcedure = sectionProcedure('ytdlsub','read_only'); read-only surface
//               by design (ADR-038) — every route gates '!= disabled'. No 'edit' rung (yet — PLAN-025).
//   • books   → 'toggle'. booksProcedure = sectionProcedure('books','read_only'); read-only walls. No
//               'edit' rung. (Not surfaced in the grid as its own column yet — the Books train owns that.)
//
// This is a UI-PRESENTATION construct: the server gating code remains the source of truth for
// BEHAVIOUR; this map only decides which options the dropdown shows. Client components never import
// @hnet/db (it pulls in server-only Postgres), so the section-id / level literals mirror the enums
// there — same convention as lib/bulletin.ts / lib/trash.ts. Keep in lockstep with SECTION_IDS.

/** The section ids that get a per-role control in the grid (mirrors @hnet/db SECTION_IDS, minus the
 *  ones with no column yet). */
export type GridSectionId =
  | 'ledger'
  | 'trash'
  | 'bulletin'
  | 'metrics'
  | 'ytdlsub'
  | 'books'
  | 'integrations';

/** A stored section level (mirrors @hnet/db SECTION_PERMISSION_LEVELS). */
export type SectionLevel = 'edit' | 'read_only' | 'disabled';

export type SectionControl = 'tri' | 'toggle';

/** The single source of truth for the grid: which control each section renders. */
export const SECTION_CONTROL: Record<GridSectionId, SectionControl> = {
  ledger: 'tri',
  trash: 'tri',
  bulletin: 'toggle',
  metrics: 'toggle',
  ytdlsub: 'toggle',
  books: 'toggle',
  // PLAN-044 — the Integrations tab gates on read_only only (no edit rung); 2-state Enabled/Disabled.
  integrations: 'toggle',
};

/** The canonical "Enabled" stored value for a 2-state section (read_only — the section only ever
 *  gates on read_only, so this is the meaningful "visible" level). */
export const TOGGLE_ENABLED_LEVEL: SectionLevel = 'read_only';

/**
 * The dropdown option list a section offers, derived from its control. 'tri' sections keep the full
 * Edit / Read-only / Disabled; 'toggle' sections offer Enabled (stored read_only) / Disabled.
 */
export function sectionLevelOptions(
  sectionId: GridSectionId,
): ReadonlyArray<{ value: SectionLevel; label: string }> {
  if (SECTION_CONTROL[sectionId] === 'tri') {
    return [
      { value: 'edit', label: 'Edit' },
      { value: 'read_only', label: 'Read-only' },
      { value: 'disabled', label: 'Disabled' },
    ];
  }
  return [
    { value: TOGGLE_ENABLED_LEVEL, label: 'Enabled' },
    { value: 'disabled', label: 'Disabled' },
  ];
}

/**
 * Normalize a role's STORED level to the value the section's <select> should show. A 'toggle'
 * section whose stored level is a legacy `edit` (no toggle option for it) reads as Enabled
 * (read_only) — edit and read_only are behaviourally identical for a section with no edit rung.
 */
export function selectValueFor(sectionId: GridSectionId, storedLevel: SectionLevel): SectionLevel {
  if (SECTION_CONTROL[sectionId] === 'tri') return storedLevel;
  return storedLevel === 'disabled' ? 'disabled' : TOGGLE_ENABLED_LEVEL;
}

/** Whether the section is currently ENABLED (visible) at the given stored level — i.e. not disabled.
 *  Used to grey the Bulletin sub-view checkboxes when Bulletin is Disabled. */
export function isSectionEnabled(storedLevel: SectionLevel): boolean {
  return storedLevel !== 'disabled';
}
