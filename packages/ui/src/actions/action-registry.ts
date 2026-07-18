// ADR-071 / DESIGN-004 D-24 — the MEDIA-ACTION REGISTRY: the single source of truth for
// every per-item media action's canonical label + look, the action analog of
// LIBRARY_VIEW_REGISTRY (ADR-051 C-01 "config, not components"). NO call site ever types a
// media-action label or a `btn` class again — a surface names an action TYPE and the registry
// supplies the ONE canonical string + variant. Adding or changing an action is a registry-row
// edit; the `action-anatomy` lint guard (DESIGN-004 D-24) fails CI the moment anyone hand-rolls
// a Fix/Force-Search button instead.
//
// React-free on purpose (mirrors icons/registry.ts) so non-React consumers — @hnet/api, guards —
// can import it without pulling React types.
import type { IconKey } from '../icons/registry';

/** Every per-item media action the estate exposes. One entry per verb, keyed here. */
export type MediaActionType = 'fix' | 'forceSearch' | 'consume' | 'retryImport' | 'notOnDisk';

/** The two canonical looks: `primary` = green accent pill (`.btn.primary`); `outline` = neutral
 *  surface pill (`.btn`). Owner rule (ADR-071): Fix is ALWAYS the green pill; Force Search is
 *  ALWAYS the outline pill — even when Force Search is a missing item's only action. */
export type MediaActionVariant = 'primary' | 'outline';

export interface MediaActionSpec {
  type: MediaActionType;
  /** The ONE canonical label for this verb (per-app only for `consume`; see MEDIA_ACTIONS). */
  label: string;
  variant: MediaActionVariant;
  /** true ⇒ the fire path is an inline two-step ConfirmButton (ADR-014, hard rule 8); false ⇒ a
   *  plain button (the action opens its own explanatory Modal/dialog, or is inert). */
  destructive: boolean;
  /** consume only — renders the external ↗ jump (target=_blank, rel=noopener). */
  external?: boolean;
  /** Optional leading glyph (unused today; reserved so an action can gain an icon by registry edit). */
  icon?: IconKey;
}

/**
 * The registry. This is the WHOLE vocabulary of media-action looks/labels:
 * - `fix` — the green primary "repair this grab" pill. On-disk items only.
 * - `forceSearch` — the outline "re-grab / go find it" pill. On-disk AND missing items.
 * - `consume` — the primary external ↗ pill (Watch on Plex / Read in Kavita / Listen on ABS). Its
 *   label is the ONLY per-app label (correct — it names the serving app), so it is passed at the
 *   call site through <ConsumeLink label=…>; the entry here fixes the look, not the string.
 * - `retryImport` — the activity-failure "retry the stuck import" outline pill.
 * - `notOnDisk` — the inert, disabled "Not on Disk" pill shown where a missing item has no consume.
 */
export const MEDIA_ACTIONS: Record<MediaActionType, MediaActionSpec> = {
  fix: { type: 'fix', label: 'Fix', variant: 'primary', destructive: false },
  forceSearch: { type: 'forceSearch', label: 'Force Search', variant: 'outline', destructive: false },
  // consume's label is supplied per-app at the call site (Watch on Plex / Read in Kavita …).
  consume: { type: 'consume', label: '', variant: 'primary', external: true, destructive: false },
  retryImport: { type: 'retryImport', label: 'Retry import', variant: 'outline', destructive: false },
  notOnDisk: { type: 'notOnDisk', label: 'Not on Disk', variant: 'outline', destructive: false },
};

/** The action types (registry keys) — for exhaustive iteration in guards/tests. */
export const MEDIA_ACTION_TYPES = Object.keys(MEDIA_ACTIONS) as MediaActionType[];

/** Compose the on-button label: the canonical verb, plus an optional grain qualifier appended as
 *  " · {scopeLabel}" (e.g. "Force Search · Season 2", "Fix · Whole show"). Scope is a qualifier,
 *  never a fork of the label string (ADR-071 — "Force Search show"/"Fix season" are retired). */
export function composeActionLabel(spec: MediaActionSpec, scopeLabel?: string | null): string {
  const base = spec.label;
  return scopeLabel ? `${base} · ${scopeLabel}` : base;
}
