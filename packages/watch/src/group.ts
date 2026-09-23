// Grouping by shared identity keys (union-find). Two records land in one group when they share a key,
// transitively — the same title seen by sources that know different ids.

/** Groups in order of first appearance; members keep their input order. */
export function groupByKeys<T>(items: readonly T[], keysOf: (item: T) => readonly string[]): T[][] {
  const parent = items.map((_, i) => i);
  const find = (i: number): number => {
    let root = i;
    while (parent[root] !== root) root = parent[root] ?? root;
    let node = i;
    while (parent[node] !== root) {
      const next = parent[node] ?? root;
      parent[node] = root;
      node = next;
    }
    return root;
  };
  const owner = new Map<string, number>();
  items.forEach((item, i) => {
    for (const key of keysOf(item)) {
      const seen = owner.get(key);
      if (seen === undefined) {
        owner.set(key, i);
        continue;
      }
      const a = find(seen);
      const b = find(i);
      if (a !== b) parent[Math.max(a, b)] = Math.min(a, b);
    }
  });
  const groups = new Map<number, T[]>();
  items.forEach((item, i) => {
    const root = find(i);
    const group = groups.get(root);
    if (group) group.push(item);
    else groups.set(root, [item]);
  });
  return [...groups.values()];
}
