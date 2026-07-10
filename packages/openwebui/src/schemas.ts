// ADR-045 / DESIGN-023 — anti-corruption boundary for the Open WebUI group API. Shapes captured live
// 2026-07-10 against OWUI 0.7.2 (`GET /api/v1/groups/` returns a bare array of group objects).
import { z } from 'zod';

export const owuiGroupSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable().default(null),
});
export type OwuiGroup = z.infer<typeof owuiGroupSchema>;

export const owuiGroupListSchema = z.array(owuiGroupSchema);
