# ADR-014: Inline two-step confirmation replaces native `window.confirm` dialogs

- **Status:** Accepted
- **Date:** 2026-07-05
- **Deciders:** Tom Haynes

## Context and problem statement

Two destructive admin actions guard themselves with a native `window.confirm()` dialog:

- **catalog-entry delete** — `apps/web/app/(app)/admin/catalog/page.tsx` (grants to the entry
  cascade away);
- **role delete** — `apps/web/app/(app)/admin/roles/page.tsx` (the role's members fall back to
  the Default role — ADR-012).

Native `window.confirm` is a poor fit for this app: it is an OS-chrome modal that ignores the
`data-theme` token theming (ADR-005), cannot be styled to match the distinct-visual-identity
rule (DESIGN-006), blocks the main thread, and reads inconsistently across the phone/tablet/PC
matrix the app targets (R-60). It also forces e2e to drive a browser dialog handler rather than
the DOM.

The sibling `../demo-console` repo already solves misclick-guarding for destructive buttons with
an inline **arm-to-confirm** mechanism: the first click *arms* the button (relabel + a danger
tint), a second click within a short window fires the action, and it auto-reverts otherwise — no
popup, no main-thread block. Per the repo rule "port the mechanism, never the look"
(distinct-visual-identity memory; DESIGN-006), we want that mechanism, styled with haynesnetwork
tokens rather than demo-console's palette.

Not every confirm is a misclick guard. The **failsafe restore**, **Fix**, and **Force-search**
flows are explanatory and/or multi-field — they need a body of text and/or inputs, and already
render as `Modal`s (DESIGN-005). Those are out of scope; only the two bare yes/no `window.confirm`
sites are being replaced.

## Decision drivers

1. **Token-themed, on-brand chrome** — the confirmation must theme with `data-theme` and use
   `--color-*` tokens, not OS dialog chrome (ADR-005, hard rule 2, DESIGN-006).
2. **Misclick guard, not a speed bump with a wall** — a bare yes/no does not need a modal; an
   inline two-step is lighter and stays in flow.
3. **Reuse the proven donor mechanism** — port demo-console's armed-button behavior rather than
   invent one; keep the look ours (port-mechanism-not-look).
4. **Testable via the DOM** — e2e should assert a DOM state transition, not hook a native dialog.
5. **Right tool per confirm** — explanatory/multi-field confirms stay `Modal`s; only bare
   yes/no `window.confirm`s become inline two-step.

## Considered options

- **Inline two-step arm-to-confirm button** (chosen). A new `@hnet/ui` `ConfirmButton` (thin
  wrapper over a headless `useConfirm` hook) renders a single `<button>`: first click arms it
  (relabel to "Confirm?", danger tint, `data-armed`), a second click within `CONFIRM_MS` (3000ms)
  fires; otherwise it auto-reverts. Ported from demo-console's mechanism, styled with
  haynesnetwork tokens.
- **A confirmation `Modal` for the two sites too.** Rejected: a bare yes/no delete does not
  warrant a modal, and it would make the two lightest confirms heavier than the explanatory ones
  they sit beside; the inline guard keeps the admin in the row.
- **Keep `window.confirm`.** Rejected: un-themeable OS chrome, main-thread block, inconsistent
  across the device matrix, and forces dialog-handler e2e — the exact problems above.
- **A toast with an Undo affordance** (soft-delete + undo window). Rejected for Phase 2: it
  changes the delete *semantics* (deferred/undoable delete) rather than just guarding the click,
  and the mutations here are immediate; revisit only if undo is desired product-wide.

## Decision outcome

Chosen option: **Inline two-step arm-to-confirm — a `@hnet/ui` `ConfirmButton` (arm-to-confirm)
replaces the two native `window.confirm` dialogs.**

- The component is `@hnet/ui` `ConfirmButton` (thin wrapper) over a headless `useConfirm` hook
  (`packages/ui/src/controls/ConfirmButton.tsx`, `'use client'`, re-exported from the package
  index). Module-scope `CONFIRM_MS = 3000`.
- **Behavior (faithful to the donor):** first click arms — the button relabels to "Confirm?",
  sets `data-armed`, adds a `confirming` class, and swaps its accessible name to the
  confirm-phase label; a second click within `CONFIRM_MS` fires `onConfirm` and disarms;
  otherwise a single timer auto-reverts. The **only** reverts are the timeout and firing — no
  blur / pointer-leave / Escape / outside-click handling. Disarm-before-fire plus a per-instance
  boolean is what prevents a double fire (no disable/debounce during the action). An optional
  `reArmOnFailure` re-arms when `onConfirm` resolves the literal string `'failed'`.
- **Look is ours, not the donor's:** the component ships **no color**. The armed look comes from
  `apps/web/app/app.css` `.confirm-btn` / `.confirm-btn.confirming` rules built on
  `var(--color-danger)` (with `color-mix`) plus the caller's existing `btn sm danger` classes —
  token-only, no raw hex (hard rule 2). `.confirm-btn` reserves a `min-width` so relabeling to
  "Confirm?" cannot reflow the row.
- **Scope:** exactly the two `window.confirm` sites (catalog-entry delete, role delete). The
  **failsafe restore, Fix, and Force-search** confirms intentionally **remain `Modal`s**
  (explanatory / multi-field — DESIGN-005); they are not touched.

### Consequences

| ID | Consequence |
|----|-------------|
| C-01 | Good: no native `window.confirm` dialogs remain in the app. Both destructive-delete sites use the token-themed inline two-step, so the confirmation chrome themes with `data-theme` and matches the visual identity (ADR-005, DESIGN-006) instead of showing un-styleable OS chrome. |
| C-02 | Good: the mechanism is a reusable `@hnet/ui` primitive — `ConfirmButton` (wrapper) + `useConfirm` (headless hook) — so future destructive buttons get the same guard for free. Ported from demo-console; the armed *look* lives in `app.css` tokens, keeping "port the mechanism, never the look." |
| C-03 | Scope (intentional): explanatory / multi-field confirms — **failsafe restore, Fix, Force-search** — **remain `Modal`s** (DESIGN-005). Only bare yes/no `window.confirm`s become inline two-step; this ADR does not convert modal confirms to buttons. |
| C-04 | Change: e2e drops its native-dialog handlers (the `acceptNextDialog` helper in `apps/web/e2e/admin.spec.ts` and the inline `page.once('dialog', …)` in `dashboard.spec.ts`) in favor of a two-step click sequence targeted by `data-testid` (`catalog-row-delete` / `role-row-delete`) — click, assert the button reads "Confirm?", click again, assert the row is gone. `library.spec.ts` is unchanged (Fix/Force-search stay Modals). |
| C-05 | Note (deferred follow-up): the role-reassignment `<select>` on the user detail page has no confirm at all and is **not** in scope here — reassigning a user's role still applies on change without a guard. Adding a confirm there (inline or modal) is a separate follow-up. |

## More information

- **Component contract & DOM output:** `ConfirmButton` / `useConfirm` at
  `packages/ui/src/controls/ConfirmButton.tsx` (re-exported from `packages/ui/src/index.ts`);
  the button always carries the `confirm-btn` class and adds `confirming` + `data-armed` when
  armed, showing `confirmLabel` ("Confirm?"). The resting `aria-label` ends with
  "— click twice to confirm". See **DESIGN-004 D-13** for the normative convention note.
- **Armed CSS:** `apps/web/app/app.css` `.confirm-btn` / `.confirm-btn.confirming`
  (`var(--color-danger)`, `color-mix`, `min-width` reservation) — tokens only (hard rule 2).
- **Call sites:** `apps/web/app/(app)/admin/catalog/page.tsx` (catalog row delete),
  `apps/web/app/(app)/admin/roles/page.tsx` (role delete, rendered only for non-default,
  non-admin roles).
- **Sibling ADRs / docs:** ADR-005 (CSS-token theming via `data-theme`), ADR-012 (unified role
  model — role delete falls members back to Default), DESIGN-005 (arr ledger + fix — the
  Fix/Force-search/restore Modals that stay Modals), DESIGN-006 (visual identity — the
  port-mechanism-not-look rule this ADR follows).
- **Donor:** `../demo-console` — the arm-to-confirm mechanism (single armed state, ~3s
  auto-revert, relabel to "Confirm?" with a danger tint); its palette is **not** ported.
