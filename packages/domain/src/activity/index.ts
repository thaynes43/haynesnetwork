// ADR-059 / DESIGN-030 (PLAN-048 — Activity / In-Flight) — the Activity module barrel: the source-agnostic
// read-model contract, the aggregator (merge + section-gate + counts + failure-ledger join + wall stages),
// the BOOKS adapter (LL + SAB), the durable failure-ledger single-writer + audited actions, and the client
// bundle. The *arr + Kapowarr adapters (the fan-out) add a file here and one line to the API's adapter list.
export * from './contract';
export * from './aggregate';
export * from './books-adapter';
export * from './arr-adapter';
export * from './failures';
export * from './clients';
