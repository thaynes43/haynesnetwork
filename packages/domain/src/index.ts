// TODO(DESIGN-001 §audit rule): audited role/permission mutation helpers land here —
// the only allowed write path to role/permission tables, writing audit rows in the same
// transaction (docs/designs/001-database-schema.md, CLAUDE.md hard rule 6).
export const DOMAIN_PACKAGE = '@hnet/domain';
