// ADR-091 / DESIGN-050 D-01 — the OAuth single-writers: EVERY write to the six OAuth tables (the five of D-03 plus
// oauth_audit) goes through this directory (the no-direct-state-writes guard lists all six). @hnet/oauth decides;
// these functions read, apply the decision and write. Consent grant / deny, disconnect and reuse revocation each
// write their oauth_audit row in the same transaction (hard rule 6).
export * from './clients';
export * from './authorizations';
export * from './consent';
export * from './tokens';
export * from './connections';
export * from './usage';
export * from './prune';
