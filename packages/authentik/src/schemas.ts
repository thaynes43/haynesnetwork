// ADR-045 / DESIGN-023 — the anti-corruption boundary for the Authentik REST API. Non-strict objects
// (extra upstream fields ignored); every schema paired with an inferred type. Shapes captured live
// 2026-07-10 against Authentik 2026.5.3 (`GET /api/v3/core/users/`, `.../groups/`).
import { z } from 'zod';

/** A `{pk, name}` group reference as it appears in a user's `groups_obj`. */
export const groupRefSchema = z.object({
  pk: z.string(),
  name: z.string(),
});
export type AuthentikGroupRef = z.infer<typeof groupRefSchema>;

/** A user as returned by `GET /api/v3/core/users/`. */
export const authentikUserSchema = z.object({
  pk: z.number(),
  username: z.string(),
  name: z.string().default(''),
  email: z.string().nullable().default(null),
  is_active: z.boolean().default(true),
  // 'external' | 'internal' | 'internal_service_account' (kept as string — the mirror's CHECK validates).
  type: z.string(),
  uid: z.string().nullable().default(null),
  // Source names live under attributes["goauthentik.io/user/sources"]; absent for native accounts.
  attributes: z.record(z.string(), z.unknown()).nullable().default(null),
  groups_obj: z.array(groupRefSchema).default([]),
});
export type AuthentikUser = z.infer<typeof authentikUserSchema>;

/** The DRF-style paginated envelope. `pagination.next` is 0 when there is no next page. */
export const paginatedUsersSchema = z.object({
  pagination: z.object({
    next: z.number().default(0),
    count: z.number().default(0),
  }),
  results: z.array(authentikUserSchema),
});
export type PaginatedUsers = z.infer<typeof paginatedUsersSchema>;

/** A group as returned by `GET /api/v3/core/groups/` and `POST /api/v3/core/groups/`. */
export const authentikGroupSchema = z.object({
  pk: z.string(),
  name: z.string(),
});
export type AuthentikGroup = z.infer<typeof authentikGroupSchema>;

export const paginatedGroupsSchema = z.object({
  pagination: z.object({
    next: z.number().default(0),
    count: z.number().default(0),
  }),
  results: z.array(authentikGroupSchema),
});
export type PaginatedGroups = z.infer<typeof paginatedGroupsSchema>;

/** Pull the source names out of a user's `attributes` (the Plex-source marker lives here). */
export function sourcesOf(user: AuthentikUser): string[] {
  const raw = user.attributes?.['goauthentik.io/user/sources'];
  return Array.isArray(raw) ? raw.filter((s): s is string => typeof s === 'string') : [];
}
