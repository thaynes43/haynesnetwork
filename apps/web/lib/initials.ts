// DESIGN-004 D-08 / Q-02 (coordinator default) — the topbar avatar is an
// initial-letter circle: first letter of the display name, uppercased.

/** Single avatar initial for a display name; '?' when nothing usable exists. */
export function initialFor(displayName: string | null | undefined): string {
  const first = (displayName ?? '').trim()[0];
  return first ? first.toUpperCase() : '?';
}
