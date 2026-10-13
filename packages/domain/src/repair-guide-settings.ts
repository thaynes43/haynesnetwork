// ADR-109 / DESIGN-055 D-01, D-09 (PLAN-077 P1) — the Repair Guide's two audited app settings, read and written only
// through the generic app-settings single writer (setAppSetting: the row and its `update_app_setting` audit row in one
// transaction, hard rule 6):
// - `repair_guide_remedies`: the per-remedy kill switch (the ADR-082 pattern). Every remedy ships off; off means Fix keeps
//   today's dialog and today's server behaviour for that remedy, so a remedy is turned on only after its live check.
// - `playback_known_issue_servers`: the Known-Issue Servers (T-314), Plex server slugs whose playback has a known fault.
import {
  PLEX_SERVER_SLUGS,
  REPAIR_GUIDE_REMEDIES,
  type DbClient,
  type PlexServerSlug,
  type RepairGuideRemedy,
} from '@hnet/db';
import { getAppSetting, setAppSetting } from './app-settings';

export type RepairGuideRemedies = Record<RepairGuideRemedy, boolean>;

/** Every remedy off: the stored-nothing state. */
export function allRemediesOff(): RepairGuideRemedies {
  return Object.fromEntries(REPAIR_GUIDE_REMEDIES.map((r) => [r, false])) as RepairGuideRemedies;
}

/** Strictly normalize a stored value: only known remedies, only a literal `true` turns one on. */
export function normalizeRemedies(stored: unknown): RepairGuideRemedies {
  const out = allRemediesOff();
  if (stored === null || typeof stored !== 'object' || Array.isArray(stored)) return out;
  for (const remedy of REPAIR_GUIDE_REMEDIES) {
    out[remedy] = (stored as Record<string, unknown>)[remedy] === true;
  }
  return out;
}

/**
 * The remedies that belong to Fix (DESIGN-055 D-08, D-09). `import_check` (D-07, PLAN-077 P2) belongs to Force Search,
 * and `release_pick` (D-06, PLAN-077 P5) to Force Search and a re-map's emptied episodes, so neither opens the Fix guide
 * on its own. `audio_preference` and `language_search` (D-08, PLAN-077 P6) act only after `language_check` has read the
 * audio, so they do not open it either.
 */
export const FIX_GUIDE_REMEDIES: readonly RepairGuideRemedy[] = REPAIR_GUIDE_REMEDIES.filter(
  (r) => r !== 'import_check' && r !== 'release_pick' && r !== 'audio_preference' && r !== 'language_search',
);

/** Whether any Fix remedy is on (the web app shows the Repair Guide instead of today's Fix dialog). */
export function anyRemedyOn(remedies: RepairGuideRemedies): boolean {
  return FIX_GUIDE_REMEDIES.some((r) => remedies[r]);
}

/** The effective remedies (absent or malformed row ⇒ all off). */
export async function getRepairGuideRemedies(db?: DbClient): Promise<RepairGuideRemedies> {
  return normalizeRemedies(await getAppSetting(db, 'repair_guide_remedies'));
}

export interface SetRepairGuideRemediesInput {
  db?: DbClient;
  /** The remedies to change; a remedy left out keeps its current value. */
  remedies: Partial<Record<RepairGuideRemedy, boolean>>;
  /** The admin making the change, or null for the coordinator (the janitor-flip precedent, PLAN-065). */
  actorId: string | null;
}

/** Audited write of the kill switch. The whole normalized object is stored, so a read back shows every remedy. */
export async function setRepairGuideRemedies(
  input: SetRepairGuideRemediesInput,
): Promise<{ before: RepairGuideRemedies; after: RepairGuideRemedies }> {
  const before = await getRepairGuideRemedies(input.db);
  const after = { ...before };
  for (const [key, value] of Object.entries(input.remedies)) {
    if (!(REPAIR_GUIDE_REMEDIES as readonly string[]).includes(key)) continue;
    if (typeof value === 'boolean') after[key as RepairGuideRemedy] = value;
  }
  await setAppSetting({ db: input.db, key: 'repair_guide_remedies', value: after, actorId: input.actorId });
  return { before, after };
}

/** Keep only known Plex server slugs, in the canonical order, once each. */
export function normalizeServerSlugs(stored: unknown): PlexServerSlug[] {
  if (!Array.isArray(stored)) return [];
  const wanted = new Set(stored.filter((s): s is string => typeof s === 'string'));
  return PLEX_SERVER_SLUGS.filter((slug) => wanted.has(slug));
}

/** The Known-Issue Servers (T-314); absent or malformed ⇒ none. */
export async function getKnownIssueServers(db?: DbClient): Promise<PlexServerSlug[]> {
  return normalizeServerSlugs(await getAppSetting(db, 'playback_known_issue_servers'));
}

/** Audited write of the Known-Issue Servers (unknown slugs are dropped). */
export async function setKnownIssueServers(input: {
  db?: DbClient;
  servers: readonly string[];
  actorId: string | null;
}): Promise<{ before: PlexServerSlug[]; after: PlexServerSlug[] }> {
  const before = await getKnownIssueServers(input.db);
  const after = normalizeServerSlugs(input.servers);
  await setAppSetting({ db: input.db, key: 'playback_known_issue_servers', value: after, actorId: input.actorId });
  return { before, after };
}
