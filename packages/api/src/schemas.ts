// DESIGN-003 D-04/D-06 — shared zod v4 input fragments (single zod version per
// ADR-001 C-05). These are the sketches from the design doc, verbatim.
import { z } from 'zod';
import { ICON_KEYS } from '@hnet/ui/icons';

/**
 * D-04 layer 1 (edge) — lenient: accept any non-empty string. The catalog now takes any
 * URL (BRANCH-A: no host rules), and @hnet/domain's assertCatalogUrl normalizes + validates
 * authoritatively before the write, storing the canonical form. Keeping the edge schema
 * dumb avoids re-implementing (and drifting from) that normalizer here.
 */
export const catalogUrlSchema = z
  .string()
  .trim()
  .min(1, 'Enter a URL.')
  .max(2048, 'That URL is too long.');

/**
 * ADR-012 — a Role's editable shape. `appIds` is the whole app set (replace-whole-bundle
 * semantics on update — role_app_grants). The Admin role is immutable and the Default role
 * can't be renamed; the domain writers enforce that, not this schema.
 */
export const RoleInput = z.object({
  name: z.string().trim().min(1).max(64),
  description: z.string().trim().max(280).default(''),
  appIds: z.array(z.uuid()).default([]),
  grantsAll: z.boolean().default(false), // "All apps" — grants every app, incl. future ones
});

/** ADR-012 — roles.update: id required, every editable field optional (true PATCH). */
export const RolePatchInput = z.object({
  id: z.uuid(),
  name: z.string().trim().min(1).max(64).optional(),
  description: z.string().trim().max(280).optional(),
  appIds: z.array(z.uuid()).optional(),
  grantsAll: z.boolean().optional(),
});

// Default-free field set shared by create and update. In zod v4, `.partial()` on a
// field carrying `.default()` still APPLIES the default when the key is absent —
// which would silently rewrite icon/description on every partial update — so the
// defaults live only on CatalogEntryInput (create), and catalog.update derives its
// patch schema from this base (true PATCH semantics).
const catalogEntryFields = z.object({
  slug: z
    .string()
    .trim()
    .regex(/^[a-z0-9-]+$/)
    .min(1)
    .max(48), // stable machine key (DESIGN-001 D-05)
  name: z.string().trim().min(1).max(64),
  description: z.string().trim().max(280),
  icon: z.enum(ICON_KEYS).nullable(), // code-shipped icon registry key, D-10
  url: catalogUrlSchema, // D-04 — lenient edge; domain normalizes/validates
});

/** D-06 — catalog entry shape for catalog.create (update omits the immutable slug). */
export const CatalogEntryInput = catalogEntryFields.extend({
  description: catalogEntryFields.shape.description.default(''),
  icon: catalogEntryFields.shape.icon.default(null),
});

/** D-06 — catalog.update: immutable slug omitted, everything else optional. */
export const CatalogEntryPatchInput = catalogEntryFields
  .omit({ slug: true })
  .partial()
  .extend({ id: z.uuid() });
