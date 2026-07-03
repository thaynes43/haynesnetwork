// DESIGN-001 D-02 — enum value sets. Enums are `text` + CHECK constraint in SQL
// (not Postgres enum types); these const arrays are the single source of truth,
// typed into columns via `$type<...>()`.

export const ROLES = ['Member', 'Admin'] as const; // PRD-001 Actors & roles
export type Role = (typeof ROLES)[number];

export const ROLE_INITIATOR_KINDS = ['system', 'admin'] as const; // R-02 system, R-04 admin
export type RoleInitiatorKind = (typeof ROLE_INITIATOR_KINDS)[number];

export const PERMISSION_AUDIT_ACTIONS = [
  'grant_app',
  'revoke_app', // R-15
  'create_tag',
  'update_tag',
  'delete_tag', // R-20
  'apply_tag',
  'remove_tag', // R-21
  'set_family',
  'unset_family', // family designation (direct)
  'create_app',
  'update_app',
  'delete_app', // R-11 catalog edits
] as const;
export type PermissionAuditAction = (typeof PERMISSION_AUDIT_ACTIONS)[number];
