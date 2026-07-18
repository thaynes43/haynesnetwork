// ADR-071 / DESIGN-004 D-24 — the ONE reflow-safe "button ↔ live chip" slot (ADR-015 / hard
// rule 9), lifted from the item-detail `ActionSlot` idiom that was reimplemented 5× across the
// detail surfaces (item-detail, wanted-detail, activity-failure, books PairingSearchSlot,
// book-fix-dialog). It reserves width for its WIDEST state so swapping the resting buttons for a
// live PhaseChip — and the chip's percent ticking — never rewraps the row.
//
// Structure only: the width reservation lives in app.css (`.action-slot` / `--head` / `--roll`),
// themed by the token palette; no color here (CLAUDE.md rule 2). The polling/state-machine that
// decides WHEN to show `live` stays in the app (it needs trpc) — this component is just the
// reflow-safe container that shows `live` in place of `children` when `live` is set.
import type { ReactNode } from 'react';

/** Which width reservation the slot uses (maps to the app.css `.action-slot*` variants). */
export type ReservedActionSlotReserve = 'default' | 'head' | 'roll';

const RESERVE_CLASS: Record<ReservedActionSlotReserve, string | null> = {
  default: null,
  head: 'action-slot--head',
  roll: 'action-slot--roll',
};

export interface ReservedActionSlotProps {
  /** The live node (a PhaseChip) shown IN PLACE of the resting children while an action is in
   *  flight. When set, the resting children are not rendered — the slot's reserved width keeps the
   *  swap reflow-free. */
  live?: ReactNode;
  /** Width reservation for the widest state (`head` = the movie-head pair; `roll` = a single
   *  roll-up button; `default` = the child-row pair). */
  reserve?: ReservedActionSlotReserve;
  /** The resting content — the MediaAction button(s). */
  children: ReactNode;
  className?: string;
  testId?: string;
}

export function ReservedActionSlot({
  live,
  reserve = 'default',
  children,
  className,
  testId,
}: ReservedActionSlotProps) {
  return (
    <span
      className={['action-slot', RESERVE_CLASS[reserve], className].filter(Boolean).join(' ')}
      data-testid={testId}
    >
      {live != null ? live : children}
    </span>
  );
}
