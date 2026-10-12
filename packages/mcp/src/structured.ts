// ADR-107 / DESIGN-054 D-04: keep every candidate/page item, bound optional metadata and declare clipping.
export const MAX_STRUCTURED_BYTES = 64 * 1024;

type JsonObject = Record<string, unknown>;

const object = (v: unknown): JsonObject | null =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as JsonObject) : null;

/** Canonical IDs, evidence totals and pagination survive; optional descriptive detail is clipped first. */
export function boundedWatchContent(data: object): JsonObject {
  const out = structuredClone(data) as JsonObject;
  const entries = Array.isArray(out.results)
    ? out.results
    : Array.isArray(out.items)
      ? out.items
      : [];
  let clipped = false;
  const clipText = (row: JsonObject, key: string, limit: number) => {
    const value = row[key];
    if (typeof value === 'string' && value.length > limit) {
      row[key] = value.slice(0, limit);
      clipped = true;
    }
  };
  const clipList = (row: JsonObject, key: string, limit: number) => {
    const value = row[key];
    if (Array.isArray(value) && value.length > limit) {
      row[key] = value.slice(0, limit);
      clipped = true;
    }
  };
  const trim = (optionalLimit: number) => {
    for (const entry of entries) {
      const row = object(entry);
      if (!row) continue;
      clipText(row, 'reason', 500);
      const identity = object(row.identity);
      if (identity) {
        clipText(identity, 'title', 200);
        clipText(identity, 'titleKey', 500);
      }
      const input = object(row.input);
      if (input) clipText(input, 'title', 200);
      clipList(row, 'options', 5);
      if (Array.isArray(row.options)) {
        for (const option of row.options) {
          const item = object(option);
          if (item) {
            clipText(item, 'title', 200);
            clipText(item, 'titleKey', 500);
          }
        }
      }
      const evidence = object(row.evidence);
      if (!evidence) continue;
      clipList(evidence, 'genres', optionalLimit);
      clipList(evidence, 'statements', optionalLimit);
      if (Array.isArray(evidence.genres)) {
        evidence.genres = evidence.genres.map((genre) => {
          if (typeof genre !== 'string' || genre.length <= 80) return genre;
          clipped = true;
          return genre.slice(0, 80);
        });
      }
    }
    if (clipped) {
      out.metadataClipped = true;
      const coverage = object(out.coverage);
      if (coverage) coverage.clipped = true;
    }
  };
  trim(20);
  const size = () => Buffer.byteLength(JSON.stringify(out), 'utf8');
  if (size() > MAX_STRUCTURED_BYTES) trim(5);
  if (size() > MAX_STRUCTURED_BYTES) trim(0);
  // Never truncate canonical identity into a different title or silently omit a requested result.
  if (size() > MAX_STRUCTURED_BYTES)
    throw new Error('Watch evidence exceeds its structured response bound');
  return out;
}
