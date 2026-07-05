// Pure reorder geometry (ADR-015, DESIGN-004) — framework-free, DOM-free.
// Ported from demo-console's dependency-free drag-and-drop mechanism.

// Given each row's top/height (viewport coords) and a pointer Y, return the
// insertion index: the first row whose vertical midpoint sits below the pointer
// (i.e. the pointer is in that row's top half), else past the last row.
export function computeDropIndex(
  rowRects: Array<{ top: number; height: number }>,
  clientY: number,
): number {
  for (let i = 0; i < rowRects.length; i++) {
    const r = rowRects[i];
    if (r && r.top + r.height / 2 > clientY) return i;
  }
  return rowRects.length;
}

// Translate a between-rows drop index into a destination array index, adjusting
// for the item's own removal when it moves downward.
export function resolveReorderIndex(fromIndex: number, dropIndex: number): number {
  if (fromIndex < 0) return fromIndex;
  return fromIndex < dropIndex ? dropIndex - 1 : dropIndex;
}
