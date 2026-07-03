// DESIGN-003 D-04/D-06 — shared zod v4 input fragments (single zod version per
// ADR-001 C-05). These are the sketches from the design doc, verbatim.
import { z } from 'zod';
import { ICON_KEYS } from '@hnet/ui/icons';

/**
 * D-04 layer 1 (edge) — R-14: only `https://<sub>.haynesnetwork.com[/path?query]`
 * survives. `*.haynesops.com` (LAN-only Traefik ingress, CLAUDE.md hard rule 3), every
 * other host, `http:`, the bare apex, ports, credentials, IP literals, and the suffix
 * attack `evil.haynesnetwork.com.attacker.io` are all rejected (the hostname regex is
 * end-anchored). Layer 2 is @hnet/domain's assertUserFacingUrl; layer 3 is the
 * app_catalog_url_haynesnetwork_only DB CHECK (DESIGN-001 D-05).
 */
export const catalogUrlSchema = z
  .url({
    protocol: /^https$/,
    hostname: /^([a-z0-9-]+\.)+haynesnetwork\.com$/i, // ≥1 subdomain label
  })
  .refine(
    (raw) => {
      const u = new URL(raw);
      return u.port === '' && u.username === '' && u.password === '';
    },
    {
      error:
        'Catalog URLs must be https://<sub>.haynesnetwork.com — no ports, no credentials, and never *.haynesops.com',
    },
  );

/** D-06 — a tag's permission bundle (replace-whole-bundle semantics on update). */
export const TagBundleInput = z.object({
  appIds: z.array(z.uuid()).default([]), // → tag_app_grants (DESIGN-001 D-08)
  isFamily: z.boolean().default(false), // → tags.is_family (R-20 family designation)
  // allowedPlexLibraries: RESERVED for Phase 3 (R-20/R-26/R-27) — do not add ad hoc.
});

// Default-free field set shared by create and update. In zod v4, `.partial()` on a
// field carrying `.default()` still APPLIES the default when the key is absent —
// which would silently rewrite defaultVisible/icon/description on every partial
// update — so the defaults live only on CatalogEntryInput (create), and
// catalog.update derives its patch schema from this base (true PATCH semantics).
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
  url: catalogUrlSchema, // D-04, R-14
  defaultVisible: z.boolean(), // R-12 seeds true; R-13 seeds false
});

/** D-06 — catalog entry shape for catalog.create (update omits the immutable slug). */
export const CatalogEntryInput = catalogEntryFields.extend({
  description: catalogEntryFields.shape.description.default(''),
  icon: catalogEntryFields.shape.icon.default(null),
  defaultVisible: catalogEntryFields.shape.defaultVisible.default(false),
});

/** D-06 — catalog.update: immutable slug omitted, everything else optional. */
export const CatalogEntryPatchInput = catalogEntryFields
  .omit({ slug: true })
  .partial()
  .extend({ id: z.uuid() });
