// ADR-023 / DESIGN-010 D-07 — the original Maintainerr webhook hardening helpers. ADR-026 /
// DESIGN-012 GENERALIZED this into the multi-source `webhook-sources.ts` (one secured receiver +
// per-source parsers); this module is kept as a thin re-export so the Maintainerr receiver + its
// unit test keep their stable import surface. New sources add a parser in `webhook-sources.ts`.
export {
  MAX_WEBHOOK_BODY_BYTES,
  secretsMatch,
  parseMaintainerrWebhook,
  type ParsedWebhook,
} from './webhook-sources';
