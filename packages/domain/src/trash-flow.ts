import { hasRestoreKeep } from './trash-restore';
// ADR-023 / DESIGN-010 — the Trash section orchestrators over Maintainerr (the deletion system of
// record). Read-through pending (no mirror table), the preflight SAFETY audit, the confined
// exclusion/expedite/rules write surface, the cross-server watch guardian, and the recently-deleted
// + restore paths. The mutating Maintainerr surface (@hnet/arr/write) stays confined here (ADR-008
// guard). Music/Lidarr is NEVER a Trash target (R-87) — rejected at the orchestrator, not just UI.
import {
  ledgerEvents,
  mediaItems,
  mediaMetadata,
  notifications,
  trashBatchItems,
  trashBatchSaves,
  trashBatches,
  trashSaveIntents,
  trashRestoreKeeps,
  users,
  TRASH_BATCH_OPEN_STATES,
  type ArrKind,
  type DbClient,
  type Transaction,
} from '@hnet/db';
import { and, desc, eq, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import { inTransaction, resolveDb } from './db-client';
import {
  MaintainerrRuleDriftError,
  MaintainerrUnsafeError,
  MaintainerrUpstreamError,
  ReleaseIdentityUnavailableError,
  TrashMusicUnsupportedError,
} from './errors';
import {
  abandonReleaseRecords,
  recordAndBlockReleases,
  reconcileReleaseBlock,
  settleReleaseRecords,
  type ReleaseBlockArrClients,
  type ReleaseRecordDraft,
} from './release-block';
import { guardMaintainerrCall, type MaintainerrClientBundle } from './maintainerr-clients';
import { executeRestore, type ExecuteArrAddResult } from './restore-flow';
import {
  hasOpenSaveIntent,
  openSaveIntent,
  revokeSaveIntent,
  trashMediaKindForArrKind,
} from './trash-save-intents';
import {
  applySaveIntentExclusion,
  SAVE_ENFORCE_DEADLINE_MS,
  withMaintainerrDeadline,
} from './trash-save-enforcement';
import { consoleDomainLogger, type DomainLogger } from './domain-logger';
import { judgeAge, loadAgeEvidence, type TrashAgeGuard } from './trash-age-guard';
import { loadReleaseNameStates, type TrashReleaseName } from './trash-release-name';
import {
  evaluateRegistryGate,
  evaluateWatchlist,
  isOnLateWatchlist,
  type DeleteWatchlistSnapshot,
  type WatchlistSnapshot,
} from './watchlist-registry';

/** The Maintainerr-managed protective tag (addendum b): enabled on Radarr/Sonarr via the settings
 *  patch (a deploy step), Maintainerr stamps it when it excludes an item and removes it on
 *  un-exclude ("remove tag on un-exclude" ON). We READ it off the synced media_items.arrTags as
 *  the first-class "protected" signal — we never hand-apply it (it stays Maintainerr-managed). */
export const PROTECTED_TAG = 'dnd';

/**
 * ADR-118 / DESIGN-052 D-30 — the Seerr add tag. A title whose ledger tags include this exact label is kept.
 * A personal requester tag (`<n>-…`) is not this tag and is not a keep.
 */
export const MEDIA_REQUEST_TAG = 'mediarequests';

/** True when the ledger tag list contains `mediarequests` as its own label (not a prefix of another label). */
export function hasMediaRequestTag(tags: readonly string[] | null | undefined): boolean {
  return Array.isArray(tags) && tags.includes(MEDIA_REQUEST_TAG);
}

/** Addendum a — the cross-server watch guardian window. An item watched on ANY of the three Plex
 *  servers within this many days (media_metadata.last_viewed_at = cross-server MAX, PLAN-004) is
 *  auto-protected from deletion and flagged in the pending tables. A constant for now (Q-01:
 *  admin/per-role configurability is deferred — the plan says "else constant + Q"). */
export const RECENTLY_WATCHED_WINDOW_DAYS = 30;

/** The two media kinds Trash covers — Music (Lidarr) is structurally undeletable (R-87). */
export type TrashMedia = 'movie' | 'tv';

/** ADR-025 (Q-09) — the rolling per-kind "Leaving Soon" collection titles. Defined here (the shared
 *  Maintainerr read module) so the batch drive that CREATES them (trash-batches.ts) and the pending
 *  derivation that must never treat them as rule-collection sources agree on the exact name. */
export const LEAVING_SOON_COLLECTION_TITLES = {
  movie: 'Leaving Soon — Movies',
  tv: 'Leaving Soon — TV',
} as const;

/** True when a Maintainerr collection title is one of OUR manual Leaving-Soon collections. */
export function isLeavingSoonCollectionTitle(title: string | null | undefined): boolean {
  return (
    title === LEAVING_SOON_COLLECTION_TITLES.movie || title === LEAVING_SOON_COLLECTION_TITLES.tv
  );
}

/** Map a Trash media kind to the owning *arr (movie→radarr, tv→sonarr). */
export function arrKindForTrashMedia(media: TrashMedia): 'radarr' | 'sonarr' {
  return media === 'movie' ? 'radarr' : 'sonarr';
}

// ---------------------------------------------------------------------------
// Preflight safety audit (D4)
// ---------------------------------------------------------------------------

export interface MaintainerrIntegrations {
  plex: boolean;
  radarr: boolean;
  sonarr: boolean;
  tautulli: boolean;
  seerr: boolean;
}

export interface MaintainerrAudit {
  /** SAFE = reachable AND every required integration connected (the destructive-path gate). */
  safe: boolean;
  reachable: boolean;
  version: string | null;
  integrations: MaintainerrIntegrations;
  /** Active rule groups poised to schedule deletions (context for the owner — not a gate). */
  armedRules: number;
  /** Active collections currently holding pending-deletion items. */
  activeCollections: number;
  /** DESIGN-010 errata (2026-07-09 aging-invariant incident) — human-readable reasons the
   *  Maintainerr aging worker could self-delete a pool OUTSIDE this app's batch/guardian pipeline
   *  (a rule pool with too-short a delete-after horizon or a non-DELETE arrAction; a Leaving-Soon
   *  pool that is not Do-Nothing). Non-empty ⇒ `safe` is false and destructive actions stay gated. */
  agingViolations: string[];
}

/** The integrations that MUST be connected for a destructive Trash action to be SAFE (the plan's
 *  preflight requires all of Plex/Radarr/Sonarr/Tautulli/Seerr — the deletion + watch/keep signal
 *  chain). Tune here if the estate's required set changes. */
const REQUIRED_INTEGRATIONS: Array<keyof MaintainerrIntegrations> = [
  'plex',
  'radarr',
  'sonarr',
  'tautulli',
  'seerr',
];

const includesAny = (haystack: string, needles: string[]): boolean =>
  needles.some((n) => haystack.includes(n));

// ---------------------------------------------------------------------------
// Aging-invariant safeguard (DESIGN-010 errata / ADR-036 — incident 2026-07-09)
// ---------------------------------------------------------------------------
// Maintainerr's OWN aging worker deletes a collection's media when
// `addDate <= now - deleteAfterDays * 86_400_000`, skipping ONLY collections whose
// `arrAction === ServarrAction.DO_NOTHING` (verified against v3.17.0 collection-worker.service.ts —
// there is NO null/0 guard, so a null/0 horizon deletes IMMEDIATELY). That path bypasses this app's
// batch/save/guardian pipeline entirely. To keep the *arrs the source of truth and every deletion on
// the app's rails, we assert two invariants on every ACTIVE collection and fold any breach into the
// SAFE gate that already blocks the destructive paths (expedite + batch sweep).

/** ServarrAction the aging worker DELETEs with. Rule pools MUST stay here so the app's per-item
 *  `/collections/media/handle` still deletes; raising the horizon (below) is what defuses AUTO-delete. */
const RULE_POOL_ARR_ACTION = 0;
/** ServarrAction the aging worker SKIPS (DO_NOTHING). Our app-managed Leaving-Soon manual
 *  collections MUST be this so Maintainerr never deletes curated items out from under the pipeline. */
const LEAVING_SOON_ARR_ACTION = 4;
/** Minimum delete-after horizon (days) an active rule pool must carry to be considered defused —
 *  ~10 years pushes Maintainerr's dangerDate far enough in the past that no real item qualifies. */
export const AGING_HORIZON_MIN_DAYS = 3650;

/** The collection fields the aging invariant reads (a structural subset of a Maintainerr collection,
 *  so the check is unit-testable without the read client). */
export interface AgingCollectionView {
  title: string | null | undefined;
  isActive: boolean | null | undefined;
  deleteAfterDays: number | null | undefined;
  arrAction: number | null | undefined;
  manualCollection: boolean | null | undefined;
  /** ADR-093 C-10 / DESIGN-052 D-16 — a rule pool's delete must write an import-list exclusion (ADR-084 E-3). */
  listExclusions?: boolean | null | undefined;
  /** DESIGN-052 D-16 — a rule pool's delete must also clear the Seerr media record (the re-request path). */
  forceSeerr?: boolean | null | undefined;
  /** The collection's media type (`movie` | `show` | `season` | `episode`, or Maintainerr's 1..4). Maintainerr never
   *  stores `forceSeerr` on an episode collection, so an episode pool is not held to it (D-25bt, as `ruleGroupDrift`). */
  type?: string | number | null | undefined;
}

/**
 * Evaluate the aging invariants over the live collections; returns a human-readable violation string
 * per breach (empty ⇒ all pools are on the app's rails). A violation makes the audit UNSAFE.
 *
 * Rule pool (an active NON-Leaving-Soon collection — Maintainerr's aging worker owns it):
 *   MUST have deleteAfterDays >= AGING_HORIZON_MIN_DAYS (else Maintainerr auto-deletes it) AND
 *   arrAction === 0 (else the app can no longer drive its deletions).
 * App-managed Leaving-Soon manual collection (title match, ADR-025):
 *   MUST have arrAction === 4 (DO_NOTHING) so Maintainerr never deletes its curated members.
 *
 * ADR-093 C-10 / DESIGN-052 D-16 — the invariant grows: an active rule pool MUST also have `listExclusions: true` and
 * `forceSeerr: true`, so a drift (an Arm/Disarm save that dropped them) refuses the sweep instead of silently changing
 * what a delete does. An EPISODE pool is exempt from `forceSeerr` (D-25bt): Maintainerr 3.29.0 stores it only when
 * `collectionType !== 'episode'`, so nothing could ever satisfy it there (an episode delete leaves the series and its
 * Seerr record in place anyway).
 */
export function evaluateAgingInvariants(collections: readonly AgingCollectionView[]): string[] {
  const violations: string[] = [];
  for (const c of collections) {
    if (c.isActive !== true) continue;
    const label = c.title ?? 'untitled collection';
    if (isLeavingSoonCollectionTitle(c.title)) {
      if (c.arrAction !== LEAVING_SOON_ARR_ACTION) {
        violations.push(
          `The Leaving-Soon '${label}' collection is set to auto-delete (arrAction ${c.arrAction ?? 'unset'}, must be Do-Nothing) — Maintainerr could delete curated items outside the batch pipeline`,
        );
      }
      continue;
    }
    const horizon = c.deleteAfterDays;
    if (typeof horizon !== 'number' || horizon < AGING_HORIZON_MIN_DAYS) {
      const when =
        typeof horizon === 'number' && horizon > 0
          ? `in ${horizon} day${horizon === 1 ? '' : 's'}`
          : 'imminently (no delete-after horizon set)';
      violations.push(
        `Maintainerr would self-delete the '${label}' pool ${when} — raise its delete-after horizon`,
      );
    }
    if (c.arrAction !== RULE_POOL_ARR_ACTION) {
      violations.push(
        `The '${label}' rule pool has arrAction ${c.arrAction ?? 'unset'} (must be Delete/0) — the app can no longer manage its deletions`,
      );
    }
    if (c.listExclusions !== true) {
      violations.push(
        `The '${label}' rule pool no longer adds deleted titles to the import list exclusions. Turn that setting back on in Maintainerr.`,
      );
    }
    const episodePool = c.type === 'episode' || c.type === 4;
    if (c.forceSeerr !== true && !episodePool) {
      violations.push(
        `The '${label}' rule pool no longer clears deleted titles from Seerr. Turn that setting back on in Maintainerr.`,
      );
    }
  }
  return violations;
}

/** Maintainerr's NOT_CONTAINS action. The live movie and TV clauses used 9 on 2026-11-13; the 2026-10-30
 *  clause table names that code NOT_CONTAINS. */
const REQUEST_CLAUSE_ACTION = 9;

/** Radarr tags are application 1 property 2; Sonarr show tags are application 2 property 2.
 *  Both ids were read from Maintainerr `GET /api/rules/constants` on 2026-11-13. */
function requestTagFirstVal(dataType: unknown): readonly [number, number] | null {
  if (dataType === 'movie' || dataType === 1) return [1, 2];
  if (
    dataType === 'show' ||
    dataType === 2 ||
    dataType === 'season' ||
    dataType === 3 ||
    dataType === 'episode' ||
    dataType === 4
  ) {
    return [2, 2];
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** One Maintainerr rule after `ruleJson` is decoded. `active` is false only when the entity or the body says so. */
export interface DecodedTrashRule {
  action: unknown;
  operator: unknown;
  firstVal: unknown;
  /** The other property, when the clause compares two properties instead of a custom value. */
  lastVal: unknown;
  section: unknown;
  value: unknown;
  active: boolean;
}

/** Decode a GET rule entity (`ruleJson` string) or a PUT rule body. Null when the JSON does not parse. */
export function decodeTrashRule(rule: unknown): DecodedTrashRule | null {
  const entity = asRecord(rule);
  if (!entity) return null;
  let body = entity;
  if (typeof entity.ruleJson === 'string') {
    try {
      const parsed: unknown = JSON.parse(entity.ruleJson);
      const rec = asRecord(parsed);
      if (!rec) return null;
      body = rec;
    } catch {
      return null;
    }
  }
  const custom = body.customVal;
  const value = typeof custom === 'string' ? custom : asRecord(custom)?.value;
  return {
    action: body.action,
    operator: body.operator,
    firstVal: body.firstVal,
    lastVal: body.lastVal,
    section: body.section ?? entity.section,
    value,
    active: entity.isActive !== false && body.isActive !== false,
  };
}

/** Maintainerr coerces clause ids with `Number` (`+` in its comparator). A string `"0"` is AND. */
function asNumber(value: unknown): number {
  return Number(value);
}

function samePair(value: unknown, pair: readonly [number, number]): boolean {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    asNumber(value[0]) === pair[0] &&
    asNumber(value[1]) === pair[1]
  );
}

/**
 * A custom value names `mediarequests`. Maintainerr lower-cases both sides and treats a JSON list
 * (`["a","b"]`, or that text) as a set that matches when it contains the tag.
 */
function valueExcludesMediaRequests(value: unknown): boolean {
  const want = MEDIA_REQUEST_TAG;
  const one = (item: unknown): boolean =>
    typeof item === 'string' && item.trim().toLowerCase() === want;
  if (one(value)) return true;
  if (Array.isArray(value)) return value.some(one);
  if (typeof value === 'string' && value.trim().startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed.some(one);
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * The clause that keeps a requested title out of the pool: tags do not contain `mediarequests`.
 * Compared the way Maintainerr's editor stores a clause (action and operator through `Number`,
 * the value lower-cased). Which section it sits in is not part of the match: a later section
 * joined by AND still excludes. The group's other clauses are what stop an OR from adding the
 * title back.
 */
function ruleKeepsRequests(rule: DecodedTrashRule, dataType: unknown): boolean {
  const pair = requestTagFirstVal(dataType);
  if (!pair || !rule.active) return false;
  if (asNumber(rule.action) !== REQUEST_CLAUSE_ACTION) return false;
  if (!valueExcludesMediaRequests(rule.value)) return false;
  if (!samePair(rule.firstVal, pair)) return false;
  // The first clause's operator is null, and JSON.stringify drops an undefined key, so the key can
  // be absent. Number(undefined) is NaN, so that absence has to be accepted here rather than through
  // Number. A later null or missing operator is OR; laterClauseIsAnd refuses that.
  return rule.operator === null || rule.operator === undefined || asNumber(rule.operator) === 0;
}

/**
 * A clause after the first is AND only when its operator is present and `Number` of it is 0.
 * Maintainerr treats a null or missing operator on a later clause as OR.
 */
function laterClauseIsAnd(operator: unknown): boolean {
  if (operator === null || operator === undefined) return false;
  return asNumber(operator) === 0;
}

/**
 * ADR-118 / DESIGN-052 D-30 — an armed rule group must still exclude `mediarequests`.
 * A missing clause is a violation string, folded into the audit the same way a dropped `listExclusions`
 * or `forceSeerr` is. A disarmed group is not checked. An armed group is exempt only when
 * `useRules` is false (a Leaving Soon shell is that, and the name alone does not exempt it).
 * Anything else with a missing or non-array `rules` list is a violation: the clause cannot be confirmed.
 */
export function evaluateRequestClauses(groups: readonly unknown[]): string[] {
  const violations: string[] = [];
  for (const raw of groups) {
    const group = asRecord(raw);
    if (!group || group.isActive !== true || group.useRules === false) continue;
    const label =
      typeof group.name === 'string' && group.name !== '' ? group.name : 'untitled rule group';
    if (!Array.isArray(group.rules)) {
      violations.push(
        `The '${label}' rule group is armed and its clauses could not be read, so the request clause cannot be confirmed. Destructive actions are blocked until they can be.`,
      );
      continue;
    }
    const rules = group.rules;
    let orJoin = false;
    for (let i = 1; i < rules.length; i += 1) {
      const decoded = decodeTrashRule(rules[i]);
      if (!decoded || !laterClauseIsAnd(decoded.operator)) {
        orJoin = true;
        break;
      }
    }
    if (orJoin) {
      violations.push(
        `The '${label}' rule group joins a later clause with OR, so a requested title can be included. Every clause after the first has to be AND.`,
      );
    }
    if (requestTagFirstVal(group.dataType) === null) {
      violations.push(
        `The '${label}' rule group is armed and its type cannot be checked for the request clause. Destructive actions are blocked until it can be confirmed.`,
      );
      continue;
    }
    const ok = rules.some((rule) => {
      const decoded = decodeTrashRule(rule);
      return decoded !== null && ruleKeepsRequests(decoded, group.dataType);
    });
    if (!ok) {
      violations.push(
        `The '${label}' rule group no longer excludes requested titles (the mediarequests tag). Turn that clause back on in Maintainerr.`,
      );
    }
  }
  return violations;
}

/** Property names read from Maintainerr `GET /api/rules/constants` on 2026-11-13. An unknown id is named by its ids. */
const RULE_PROPERTY_LABELS: Record<string, string> = {
  '0,0': 'Plex date added',
  '0,5': 'Plex times viewed',
  '0,17': 'Plex total views',
  '1,2': 'Radarr tags',
  '1,16': 'Radarr IMDb rating',
  '1,19': 'Radarr IMDb vote count',
  '0,27': 'Plex last episode aired',
  '2,2': 'Sonarr tags',
  '2,7': 'Sonarr show ended',
  '2,19': 'Sonarr show rating',
  '2,20': 'Sonarr show vote count',
};

function propertyLabel(firstVal: unknown): string {
  if (Array.isArray(firstVal) && firstVal.length >= 2) {
    const left = asNumber(firstVal[0]);
    const right = asNumber(firstVal[1]);
    if (Number.isFinite(left) && Number.isFinite(right)) {
      const key = `${left},${right}`;
      return RULE_PROPERTY_LABELS[key] ?? `property ${key}`;
    }
    return `property ${String(firstVal[0])},${String(firstVal[1])}`;
  }
  return 'property';
}

/** The text a clause is compared against: its custom value, or the second property of a two-property clause. */
function comparedValue(rule: DecodedTrashRule): string {
  if (rule.value !== null && rule.value !== undefined && String(rule.value) !== '') {
    return Array.isArray(rule.value) ? JSON.stringify(rule.value) : String(rule.value);
  }
  if (Array.isArray(rule.lastVal) && rule.lastVal.length >= 2) return propertyLabel(rule.lastVal);
  return '';
}

/** Action 5 is a date compared as seconds before now. An exact number of days is written as days. */
function beforePhrase(shown: string): string {
  const seconds = Number(shown);
  if (shown !== '' && Number.isFinite(seconds) && seconds >= 0 && seconds % 86_400 === 0) {
    const days = seconds / 86_400;
    return `is before ${days} day${days === 1 ? '' : 's'}`;
  }
  return `is before ${shown}`.trim();
}

/**
 * ADR-118 C-06 — the description the app writes for a rule group, taken from the clauses it is writing.
 * Action words follow the 2026-10-30 clause table (0 above, 1 below, 2 equals, 5 before, 9 does not contain);
 * the action number is included so an unnamed action still matches the body. A date comparison (action 5)
 * whose value is a whole number of days is written in days.
 */
export function describeTrashRules(rules: readonly unknown[]): string {
  const parts: string[] = [];
  for (const [index, raw] of rules.entries()) {
    const rule = decodeTrashRule(raw);
    if (!rule) {
      parts.push(`rule ${index + 1} could not be read`);
      continue;
    }
    const value = comparedValue(rule);
    const action = asNumber(rule.action);
    const phrase =
      action === 0
        ? `is above ${value}`.trim()
        : action === 1
          ? `is below ${value}`.trim()
          : action === 2
            ? `equals ${value}`.trim()
            : action === 5
              ? beforePhrase(value)
              : action === 9
                ? `does not contain ${value}`.trim()
                : `action ${String(rule.action)} ${value}`.trim();
    const oddJoin =
      index > 0 &&
      !laterClauseIsAnd(rule.operator) &&
      rule.operator !== null &&
      rule.operator !== undefined
        ? ` (operator ${String(rule.operator)})`
        : '';
    parts.push(`${rule.active ? '' : 'off: '}${propertyLabel(rule.firstVal)} ${phrase}${oddJoin}`);
  }
  return parts.join(', and ');
}

/** The refusal text for an unsafe audit, including each violation so the log and the error say why. */
export function maintainerrUnsafeMessage(action: string, audit: MaintainerrAudit): string {
  const why = audit.agingViolations.length > 0 ? ` ${audit.agingViolations.join(' ')}` : '';
  return (
    `Maintainerr is not in a safe state to ${action} (reachable=${audit.reachable}, ` +
    `integrations ${JSON.stringify(audit.integrations)}).${why} Refusing.`
  );
}

/**
 * ADR-023 D-04 — the read-only preflight audit. Writes NO state. Reachability + version come from
 * `GET /api/app/status`; Plex from `GET /api/settings/test/plex`; the other integrations from
 * `GET /api/rules/constants` (Maintainerr filters its `applications` list to CONFIGURED
 * integrations — the cleanest keyless connectivity signal); armed rules + active collections from
 * `GET /api/rules` + `GET /api/collections`. Each sub-read fails closed (unreachable ⇒ safe:false).
 */
export async function auditMaintainerr(input: {
  maintainerr: Pick<MaintainerrClientBundle, 'read'>;
}): Promise<MaintainerrAudit> {
  const read = input.maintainerr.read;

  let reachable = false;
  let version: string | null = null;
  try {
    const status = await read.getAppStatus();
    reachable = true;
    version = status.version ?? null;
  } catch {
    // Unreachable — nothing else can be trusted; fail closed.
    return {
      safe: false,
      reachable: false,
      version: null,
      integrations: { plex: false, radarr: false, sonarr: false, tautulli: false, seerr: false },
      armedRules: 0,
      activeCollections: 0,
      agingViolations: [],
    };
  }

  // The four post-reachability sub-reads are independent and each fails closed on its own, so run
  // them CONCURRENTLY (ADR-035 perf pass — the serial chain cost ~1.7 s cold on the live install,
  // and the audit rides the same request flight as the first wall paint).
  const [plex, integrationFlags, armedRules, collectionsResult] = await Promise.all([
    (async () => {
      try {
        const test = await read.testPlex();
        return (test.status ?? '').toUpperCase() === 'OK';
      } catch {
        return false;
      }
    })(),
    (async () => {
      // Integration presence: the constants `applications` names are only present for CONFIGURED
      // integrations (Radarr/Sonarr/Tautulli/Seerr dropped if not set up — Maintainerr filters at
      // runtime). Match by lowercased application name.
      const flags = { radarr: false, sonarr: false, tautulli: false, seerr: false };
      try {
        const constants = await read.getRuleConstants();
        const names = (constants.applications ?? []).map((a) => (a.name ?? '').toLowerCase());
        for (const n of names) {
          if (n.includes('radarr')) flags.radarr = true;
          if (n.includes('sonarr')) flags.sonarr = true;
          if (n.includes('tautulli')) flags.tautulli = true;
          if (includesAny(n, ['overseerr', 'jellyseerr', 'seerr'])) flags.seerr = true;
        }
      } catch {
        // Leave the integration flags false — fail closed.
      }
      return flags;
    })(),
    (async () => {
      try {
        const rules = await read.getRules();
        return {
          armedRules: rules.filter((r) => r.isActive === true).length,
          clauseViolations: evaluateRequestClauses(rules),
        };
      } catch {
        // A rules outage cannot prove the request clause is still there, so the sweep refuses (ADR-118).
        return {
          armedRules: 0,
          clauseViolations: [
            'Maintainerr rules could not be read, so the request clause cannot be confirmed. Destructive actions are blocked until they can be.',
          ],
        };
      }
    })(),
    (async () => {
      try {
        const collections = await read.getCollections();
        const activeCollections = collections.filter((c) => c.isActive === true).length;
        // Aging safeguard (DESIGN-010 errata 2026-07-09): a rule pool with too-short a horizon (or a
        // Leaving-Soon pool that isn't Do-Nothing) would let Maintainerr's own worker mass-delete
        // outside this app's pipeline. Evaluate over the SAME read; a breach forces safe:false.
        const agingViolations = evaluateAgingInvariants(
          collections.map((c) => ({
            title: c.title ?? null,
            isActive: c.isActive,
            deleteAfterDays: c.deleteAfterDays ?? null,
            arrAction: c.arrAction ?? null,
            manualCollection: c.manualCollection ?? null,
            listExclusions: c.listExclusions ?? null,
            forceSeerr: c.forceSeerr ?? null,
            type: c.type ?? null,
          })),
        );
        return { activeCollections, agingViolations };
      } catch {
        // Fail closed: if we cannot read the collections we cannot prove the pools are defused, so
        // block the destructive paths rather than assume safety.
        return {
          activeCollections: 0,
          agingViolations: [
            'Could not read Maintainerr collections to verify the auto-delete safeguard — destructive actions are blocked until it can be confirmed',
          ],
        };
      }
    })(),
  ]);
  const { radarr, sonarr, tautulli, seerr } = integrationFlags;
  const { activeCollections, agingViolations: agingOnly } = collectionsResult;
  const agingViolations = [...agingOnly, ...armedRules.clauseViolations];

  const integrations: MaintainerrIntegrations = { plex, radarr, sonarr, tautulli, seerr };
  const safe =
    reachable &&
    REQUIRED_INTEGRATIONS.every((k) => integrations[k]) &&
    agingViolations.length === 0;
  return {
    safe,
    reachable,
    version,
    integrations,
    armedRules: armedRules.armedRules,
    activeCollections,
    agingViolations,
  };
}

// ---------------------------------------------------------------------------
// Read-through pending list (D2) + recently-deleted (D2)
// ---------------------------------------------------------------------------

export interface TrashPendingItem {
  /** Maintainerr's item id (Plex ratingKey) — the exclusion/handle key. Null ⇒ can't be actioned. */
  maintainerrMediaId: string | null;
  collectionId: number;
  collectionTitle: string | null;
  tmdbId: number | null;
  tvdbId: number | null;
  sizeBytes: number;
  addedToCollectionAt: string | null;
  deleteAfterDays: number | null;
  /** ISO — addedToCollectionAt + deleteAfterDays; null when either input is missing. */
  scheduledDeleteAt: string | null;
  // Our ledger join (null when the item is unknown to our ledger — still listed).
  mediaItemId: string | null;
  title: string;
  year: number | null;
  arrKind: 'radarr' | 'sonarr' | null;
  arrTags: string[];
  /** arrTags includes the Maintainerr-managed protective tag (already safe from deletion). */
  protectedByTag: boolean;
  /** Live-repro fix (2026-07-06) — this item is currently on Maintainerr's exclusion (whitelist)
   *  list per a direct read, independent of whether the `dnd` tag has synced into arrTags yet. Only
   *  populated when listTrashPending is called with `includeLiveExclusions` (the pending TAB);
   *  false otherwise. The UI treats tag-OR-exclusion as Protected (closes the cross-session window
   *  where an exclusion made outside this session shows Unprotected until the tag round-trips). */
  protectedByExclusion: boolean;
  /** last_viewed_at (cross-server MAX) is within RECENTLY_WATCHED_WINDOW_DAYS — never delete. */
  recentlyWatched: boolean;
  lastViewedAt: string | null;
  /** DESIGN-010 D-12 — cross-server watch VISIBILITY (info, NOT protection). lastWatchedAt is the
   *  MAX last-watch instant across all three Tautulli histories (full history); lastWatchedServer is
   *  the estate slug that owns it. The wall shows a muted "watched a while ago" indicator when
   *  lastWatchedAt is set but the item is NOT recentlyWatched — the tile stays fully actionable. */
  lastWatchedAt: string | null;
  lastWatchedServer: string | null;
  requesters: string[];
  sourceCollections: string[];
  posterSource: string | null;
  // DESIGN-010 D-09 (UX pass, 2026-07-06) — the harvested facet fields the shared filter engine
  // chips over (genre/resolution/rating). Same media_metadata join the fields above ride; all
  // empty/null when the item is unknown to our ledger.
  genres: string[];
  resolution: string | null;
  imdbRating: number | null;
  tmdbRating: number | null;
  /** ADR-093 / DESIGN-052 D-06 — Maintainerr's `mediaData.guid` (`plex://movie|show/<24 hex>`), null when absent. */
  plexGuid: string | null;
  /** D-09 — Maintainerr flagged this item's rule data as transiently unavailable: the guardian keeps it. */
  ruleEvaluationFailed: boolean;
  /** D-06 — the item is on a watchlist in the snapshot the caller evaluated with (the Watchlist Keep, T-263). */
  onWatchlist: boolean;
  /** D-06 — whether the snapshot could decide `onWatchlist` for this item at all; false ⇒ kept `unevaluable`. */
  watchlistEvaluable: boolean;
  /**
   * DESIGN-052 D-26 — the Age Guard: `recent` when the newest of its last download import (new or upgrade) and its
   * date added on every Plex server holding it is inside 180 days (never proposed, kept `recently_added` at the
   * sweep); `unknown` when that cannot be told (kept `unevaluable` at the sweep); `clear` otherwise.
   */
  ageGuard: TrashAgeGuard;
  /** D-26 — that newest date (ISO), null when there is none. */
  newestAddedAt: string | null;
  /**
   * ADR-099 D-4 — the title has an OPEN save intent: somebody saved it and nobody un-saved it. The app's own record,
   * so it is authoritative whether or not Maintainerr holds the exclusion yet: the guardian keeps it (`saved`), no
   * batch ever proposes it, and the walls show it saved.
   */
  saveIntent: boolean;
  restoreKeep?: boolean;
  /**
   * ADR-117 / DESIGN-052 D-29 — the Release Name Check (`trash-release-name.ts`): `unverified` when the database
   * holds no verified posted release name for the file on disk, only the name the *arr rebuilt when it renamed the
   * file. Such a title is kept `release_unverified`, never proposed and never offered by the default wall.
   * `unchecked` (and absent) is not judged here: a series, or an item with no ledger row; the delete path's own
   * read decides.
   */
  releaseName?: TrashReleaseName;
  /**
   * DESIGN-052 D-10 amendment (2026-11-13, story 832) — Wall Protection for this row, or null when the
   * wall may offer it. Set by `listTrashPendingPage`. Reads that do not run that page leave it absent.
   */
  protectionReason?: TrashWallProtectionReason | null;
}

export interface TrashPendingResult {
  items: TrashPendingItem[];
  totalSizeBytes: number;
  count: number;
}

/** Normalize a Maintainerr collection `type` (string 'movie'|'show'|… OR number 1..4) → our kind. */
function collectionMediaKind(type: unknown): 'movie' | 'tv' | null {
  if (typeof type === 'string') {
    const t = type.toLowerCase();
    if (t === 'movie') return 'movie';
    if (t === 'show' || t === 'tv' || t === 'season' || t === 'episode') return 'tv';
    return null;
  }
  if (typeof type === 'number') {
    if (type === 1) return 'movie';
    if (type === 2 || type === 3 || type === 4) return 'tv';
  }
  return null;
}

const asString = (v: string | number | null | undefined): string | null =>
  v === null || v === undefined ? null : String(v);

export interface FlatPending {
  collectionId: number;
  collectionTitle: string | null;
  deleteAfterDays: number | null;
  collectionKind: 'movie' | 'tv' | null;
  maintainerrMediaId: string | null;
  tmdbId: number | null;
  tvdbId: number | null;
  sizeBytes: number;
  addDate: string | null;
  /** ADR-093 / DESIGN-052 D-06 — Maintainerr's `mediaData.guid` (null when it carries none). */
  plexGuid: string | null;
  /** D-09 — Maintainerr's `ruleEvaluationFailed` flag. */
  ruleEvaluationFailed: boolean;
}

/** Collection-content page size (ADR-035 live profile, 2026-07-09): Maintainerr's PER-CALL cost
 *  dominates — a 50-item page cost 0.4–5.8 s in-cluster while ONE 742-item call answered in
 *  ~0.16 s — so we page BIG (typically one call per collection at household scale). */
const CONTENT_PAGE_SIZE = 500;
/** How many collections crawl in flight at once (polite to an in-cluster service). */
const COLLECTION_READ_CONCURRENCY = 4;

/** Fetch every active collection's FULL membership (paged) with per-item size + ids.
 *  ADR-035 — big pages + bounded-parallel collections (see constants above); the result is
 *  deterministic (collections order, then page order) regardless of completion order. Shared by
 *  the LIVE safety paths (guardian/expedite/batch snapshot) and the candidate-snapshot refresher. */
export async function fetchMaintainerrPending(
  maintainerr: Pick<MaintainerrClientBundle, 'read'>,
): Promise<FlatPending[]> {
  const collections = await guardMaintainerrCall('maintainerr GET /collections', () =>
    maintainerr.read.getCollections(),
  );
  // OUR manually-driven Leaving-Soon collections are NOT rule-collection sources (ADR-025 C-04):
  // their members are the SAME physical media the rule collections already surface, so folding them
  // in would double-count sizes AND — worse — let the sweep re-derive an item's collectionId to the
  // Leaving-Soon collection, whose arrAction is DO_NOTHING → a per-item handle there deletes nothing.
  // Skip them (verified 2026-07-07: v3.17.0 GET /api/collections returns manual collections too).
  const active = collections.filter(
    (c): c is typeof c & { id: number } =>
      c.isActive === true &&
      c.id !== null &&
      c.id !== undefined &&
      !isLeavingSoonCollectionTitle(c.title),
  );
  const perCollection = new Map<number, FlatPending[]>();
  await mapWithConcurrency(active, COLLECTION_READ_CONCURRENCY, async (c) => {
    const collectionId = c.id;
    const collectionKind = collectionMediaKind(c.type);
    const rows: FlatPending[] = [];
    let page = 1;
    let seen = 0;
    // Page until we've collected the reported totalSize (bounded — household scale).
    for (;;) {
      const content = await guardMaintainerrCall(
        `maintainerr GET /collections/media/${collectionId}/content/${page}`,
        () => maintainerr.read.getCollectionContent(collectionId, page, CONTENT_PAGE_SIZE),
      );
      for (const m of content.items) {
        rows.push({
          collectionId,
          collectionTitle: c.title ?? null,
          deleteAfterDays: c.deleteAfterDays ?? null,
          collectionKind,
          maintainerrMediaId: asString(m.mediaServerId ?? m.plexId ?? null),
          tmdbId: m.tmdbId ?? null,
          tvdbId: m.tvdbId ?? null,
          sizeBytes: m.sizeBytes ?? 0,
          addDate: m.addDate ?? null,
          plexGuid: m.mediaData?.guid?.trim() || null,
          ruleEvaluationFailed: m.ruleEvaluationFailed === true,
        });
      }
      seen += content.items.length;
      if (content.items.length === 0 || seen >= content.totalSize) break;
      page += 1;
    }
    perCollection.set(collectionId, rows);
  });
  return active.flatMap((c) => perCollection.get(c.id) ?? []);
}

/** Bucket the flat crawl by media kind: the collection's declared kind wins; a kind-less
 *  collection falls back to which external id the item carries (movie→tmdbId, tv→tvdbId). */
export function bucketFlatPendingForMedia(
  flat: readonly FlatPending[],
  media: TrashMedia,
): FlatPending[] {
  return flat.filter((f) => {
    if (f.collectionKind !== null) return f.collectionKind === media;
    return media === 'movie' ? f.tmdbId !== null : f.tvdbId !== null;
  });
}

/** addDate + deleteAfterDays days → ISO, or null when either is missing/unparseable. */
function scheduledDeleteAt(addDate: string | null, deleteAfterDays: number | null): string | null {
  if (addDate === null || deleteAfterDays === null) return null;
  const base = Date.parse(addDate);
  if (Number.isNaN(base)) return null;
  return new Date(base + deleteAfterDays * 86_400_000).toISOString();
}

/**
 * Shape one media kind's FLAT pending rows into wire items: merged with our media_items/
 * media_metadata by tmdbId (movie→radarr) / tvdbId (tv→sonarr). The join supplies title/poster/
 * facets — resolved AT READ TIME so they stay as fresh as the media sync regardless of where the
 * flat rows came from (a live Maintainerr crawl OR the ADR-035 candidate snapshot). An item
 * unknown to our ledger is STILL listed with Maintainerr's own fields. `protectedByExclusion` is
 * left FALSE here — the LIVE-exclusion cross-check is applied by the callers that need it
 * (page-scoped in the paginated read; whole-set in listTrashPending's live path).
 */
export async function shapePendingItems(input: {
  db?: DbClient;
  media: TrashMedia;
  flat: readonly FlatPending[];
  watchWindowDays?: number;
  /**
   * ADR-093 / DESIGN-052 D-06 — REQUIRED, no default: the watchlist snapshot every item is evaluated against, carrying
   * its purpose (`delete` from the Registry Gate, `propose`, or `display`). `null` is a MISSING snapshot and fails
   * closed: every item reads not evaluable, so the guardian keeps it (`unevaluable`) — never "not listed, deletable".
   */
  watchlist: WatchlistSnapshot | null;
}): Promise<TrashPendingResult> {
  const db = resolveDb(input.db);
  const arrKind = arrKindForTrashMedia(input.media);
  const windowMs = (input.watchWindowDays ?? RECENTLY_WATCHED_WINDOW_DAYS) * 86_400_000;
  const now = Date.now();
  const forMedia = input.flat;

  // Gather the external ids to join our ledger on.
  const ids = new Set<number>();
  for (const f of forMedia) {
    const ext = input.media === 'movie' ? f.tmdbId : f.tvdbId;
    if (ext !== null) ids.add(ext);
  }

  interface LedgerJoin {
    mediaItemId: string;
    title: string;
    year: number | null;
    arrTags: string[];
    posterSource: string | null;
    lastViewedAt: Date | null;
    lastWatchedAt: Date | null;
    lastWatchedServer: string | null;
    requesters: string[];
    sourceCollections: string[];
    genres: string[];
    resolution: string | null;
    imdbRating: number | null;
    tmdbRating: number | null;
  }
  /** Drizzle numeric columns arrive as strings — normalize to number|null for the wire. */
  const numOrNull = (v: string | null | undefined): number | null =>
    v === null || v === undefined ? null : Number(v);
  const byExtId = new Map<number, LedgerJoin>();
  if (ids.size > 0) {
    const extCol = input.media === 'movie' ? mediaItems.tmdbId : mediaItems.tvdbId;
    const rows = await db
      .select({
        extId: extCol,
        mediaItemId: mediaItems.id,
        title: mediaItems.title,
        year: mediaItems.year,
        arrTags: mediaItems.arrTags,
        posterSource: mediaMetadata.posterSource,
        lastViewedAt: mediaMetadata.lastViewedAt,
        lastWatchedAt: mediaMetadata.lastWatchedAt,
        lastWatchedServer: mediaMetadata.lastWatchedServer,
        requesters: mediaMetadata.requesters,
        sourceCollections: mediaMetadata.sourceCollections,
        genres: mediaMetadata.genres,
        resolution: mediaMetadata.resolution,
        imdbRating: mediaMetadata.imdbRating,
        tmdbRating: mediaMetadata.tmdbRating,
      })
      .from(mediaItems)
      .leftJoin(mediaMetadata, eq(mediaMetadata.mediaItemId, mediaItems.id))
      .where(and(eq(mediaItems.arrKind, arrKind), inArray(extCol, [...ids])));
    for (const r of rows) {
      if (r.extId === null) continue;
      byExtId.set(r.extId, {
        mediaItemId: r.mediaItemId,
        title: r.title,
        year: r.year,
        arrTags: r.arrTags ?? [],
        posterSource: r.posterSource,
        lastViewedAt: r.lastViewedAt,
        lastWatchedAt: r.lastWatchedAt,
        lastWatchedServer: r.lastWatchedServer,
        requesters: r.requesters ?? [],
        sourceCollections: r.sourceCollections ?? [],
        genres: r.genres ?? [],
        resolution: r.resolution ?? null,
        imdbRating: numOrNull(r.imdbRating),
        tmdbRating: numOrNull(r.tmdbRating),
      });
    }
  }

  // ADR-099 D-4 — which joined titles carry an open save intent (one read; the intent table is small).
  const joinedIds = [...byExtId.values()].map((j) => j.mediaItemId);
  const savedIds = new Set<string>();
  const restoredIds = new Set<string>();
  if (joinedIds.length > 0) {
    const keeps = await db
      .select({ id: trashRestoreKeeps.mediaItemId })
      .from(trashRestoreKeeps)
      .where(
        and(inArray(trashRestoreKeeps.mediaItemId, joinedIds), isNull(trashRestoreKeeps.revokedAt)),
      );
    keeps.forEach((k) => restoredIds.add(k.id));
  }
  if (joinedIds.length > 0) {
    const open = await db
      .select({ mediaItemId: trashSaveIntents.mediaItemId })
      .from(trashSaveIntents)
      .where(and(inArray(trashSaveIntents.mediaItemId, joinedIds), isNull(trashSaveIntents.revokedAt)));
    for (const r of open) savedIds.add(r.mediaItemId);
  }

  // DESIGN-052 D-26 — the Age Guard's evidence for every joined ledger item (two grouped reads).
  const ageEvidence = await loadAgeEvidence({
    db: input.db,
    arrKind,
    mediaItemIds: [...byExtId.values()].map((j) => j.mediaItemId),
  });
  // ADR-117 / D-29 — the Release Name Check for every joined ledger item (three grouped reads; movies only).
  const releaseNames = await loadReleaseNameStates({
    db: input.db,
    arrKind,
    mediaItemIds: joinedIds,
  });

  let totalSizeBytes = 0;
  const items: TrashPendingItem[] = forMedia.map((f) => {
    const ext = input.media === 'movie' ? f.tmdbId : f.tvdbId;
    const joined = ext !== null ? byExtId.get(ext) : undefined;
    const age = judgeAge(joined ? ageEvidence.get(joined.mediaItemId) : undefined, now);
    totalSizeBytes += f.sizeBytes;
    const arrTags = joined?.arrTags ?? [];
    const lastViewed = joined?.lastViewedAt ?? null;
    const recentlyWatched = lastViewed !== null && now - lastViewed.getTime() <= windowMs;
    const watch = evaluateWatchlist(input.watchlist, {
      media: input.media,
      plexGuid: f.plexGuid,
      tmdbId: f.tmdbId,
      tvdbId: f.tvdbId,
    });
    return {
      maintainerrMediaId: f.maintainerrMediaId,
      collectionId: f.collectionId,
      collectionTitle: f.collectionTitle,
      tmdbId: f.tmdbId,
      tvdbId: f.tvdbId,
      sizeBytes: f.sizeBytes,
      addedToCollectionAt: f.addDate,
      deleteAfterDays: f.deleteAfterDays,
      scheduledDeleteAt: scheduledDeleteAt(f.addDate, f.deleteAfterDays),
      mediaItemId: joined?.mediaItemId ?? null,
      title:
        joined?.title ??
        `tmdb:${f.tmdbId ?? ''}${f.tvdbId !== null ? ` tvdb:${f.tvdbId}` : ''}`.trim(),
      year: joined?.year ?? null,
      arrKind: joined ? arrKind : null,
      arrTags,
      protectedByTag: arrTags.includes(PROTECTED_TAG),
      protectedByExclusion: false,
      recentlyWatched,
      lastViewedAt: lastViewed === null ? null : lastViewed.toISOString(),
      lastWatchedAt: joined?.lastWatchedAt ? joined.lastWatchedAt.toISOString() : null,
      lastWatchedServer: joined?.lastWatchedServer ?? null,
      requesters: joined?.requesters ?? [],
      sourceCollections: joined?.sourceCollections ?? [],
      posterSource: joined?.posterSource ?? null,
      genres: joined?.genres ?? [],
      resolution: joined?.resolution ?? null,
      imdbRating: joined?.imdbRating ?? null,
      tmdbRating: joined?.tmdbRating ?? null,
      plexGuid: f.plexGuid,
      ruleEvaluationFailed: f.ruleEvaluationFailed,
      onWatchlist: watch.onWatchlist,
      watchlistEvaluable: watch.watchlistEvaluable,
      ageGuard: age.ageGuard,
      newestAddedAt: age.newestAddedAt,
      saveIntent: joined !== undefined && savedIds.has(joined.mediaItemId),
      restoreKeep: joined !== undefined && restoredIds.has(joined.mediaItemId),
      releaseName: (joined ? releaseNames.get(joined.mediaItemId) : undefined) ?? 'unchecked',
    };
  });

  return { items, totalSizeBytes, count: items.length };
}

/**
 * ADR-023 / DESIGN-010 D-02 — the read-through pending list for one media kind (movie|tv, NEVER
 * combined; music rejected upstream at the router). See buildPendingItems. Kept for the internal
 * expedite/guardian paths (and any whole-set caller) — the USER-FACING pending TAB now reads the
 * PAGINATED `listTrashPendingPage` (owner-directed 2026-07-09), which scopes the costly live-
 * exclusion cross-check to the returned page instead of the entire set.
 */
export async function listTrashPending(input: {
  db?: DbClient;
  maintainerr: Pick<MaintainerrClientBundle, 'read'>;
  media: TrashMedia;
  /** Window override for the recently-watched flag (default RECENTLY_WATCHED_WINDOW_DAYS). */
  watchWindowDays?: number;
  /**
   * Live-repro fix (2026-07-06) — when true, cross-check each pending item against Maintainerr's LIVE
   * exclusion list and set `protectedByExclusion`. Whole-set here (the legacy behaviour); the pending
   * TAB no longer uses this — it pages and cross-checks only the visible page (listTrashPendingPage).
   */
  includeLiveExclusions?: boolean;
  /** ADR-093 / DESIGN-052 D-06 — REQUIRED (see `shapePendingItems`): every delete path passes a `delete` snapshot. */
  watchlist: WatchlistSnapshot | null;
}): Promise<TrashPendingResult> {
  const flat = await fetchMaintainerrPending(input.maintainerr);
  const base = await shapePendingItems({
    db: input.db,
    media: input.media,
    flat: bucketFlatPendingForMedia(flat, input.media),
    watchWindowDays: input.watchWindowDays,
    watchlist: input.watchlist,
  });
  if (input.includeLiveExclusions !== true) return base;
  const liveExcludedIds = await fetchLiveExclusions(input.maintainerr, [
    ...new Set(
      base.items.map((i) => i.maintainerrMediaId).filter((id): id is string => id !== null),
    ),
  ]);
  const items = base.items.map((i) => ({
    ...i,
    protectedByExclusion:
      i.maintainerrMediaId !== null && liveExcludedIds.has(i.maintainerrMediaId),
  }));
  return { items, totalSizeBytes: base.totalSizeBytes, count: items.length };
}


/** The Maintainerr ids that belong to the OPEN batch (if any) for a kind — the set the future-batch
 *  strip subtracts from the live candidates so the strip shows only what could enter a NEXT batch. */
export async function listOpenBatchMediaIds(input: {
  db?: DbClient;
  media: TrashMedia;
}): Promise<string[]> {
  const db = resolveDb(input.db);
  const rows = await db
    .select({ maintainerrMediaId: trashBatchItems.maintainerrMediaId })
    .from(trashBatchItems)
    .innerJoin(trashBatches, eq(trashBatches.id, trashBatchItems.batchId))
    .where(
      and(
        eq(trashBatches.mediaKind, input.media),
        inArray(trashBatches.state, [...TRASH_BATCH_OPEN_STATES]),
      ),
    );
  return rows.map((r) => r.maintainerrMediaId);
}

export interface RecentlyDeletedItem {
  mediaItemId: string;
  title: string;
  year: number | null;
  arrKind: ArrKind;
  tmdbId: number | null;
  tvdbId: number | null;
  sizeOnDisk: number;
  deletedAt: string | null;
  posterSource: string | null;
  /** WHO expedited the deletion (the most-recent `trash_expedited` event's attributed app user's
   *  display name), or null when the tombstone came from a sync pass with no actor ("system"). */
  deletedBy: string | null;
}

/**
 * ADR-023 / DESIGN-010 D-02 — Recently-Deleted from OUR durable records, newest first. An item is
 * "recently deleted" when EITHER:
 *
 *   (A) it is TOMBSTONED (`deleted_from_arr_at` set, T-41) — the sync pass detected the *arr removal, OR
 *   (B) it carries an app-initiated `trash_expedited` ledger event that has NOT been superseded by a
 *       later restore (`trash_restored` / `restored`).
 *
 * Branch (B) is the fix for the deletion-audit gap: Expedite deletes PER ITEM via Maintainerr's
 * `/collections/media/handle`, which can delete the FILE while leaving the *arr entry — so the item is
 * never "missing" for the tombstone pass, and worse, any tombstone we DO write is CLEARED the next time
 * sync re-sees the still-present *arr entry (media-sync un-tombstones live rows). The append-only
 * `trash_expedited` event is therefore the durable source of truth for an app deletion; Maintainerr
 * exposes no deletion-history API of its own. The deletion time is the tombstone time when present,
 * else the latest expedite time; the actor (`deletedBy`) is the latest `trash_expedited` event's
 * attributed user (null ⇒ a sync-only tombstone with no app actor → "system"). Restore re-adds via the
 * existing executeRestore path and writes a restore event, which drops the item from this list.
 */
export async function listRecentlyDeleted(input: {
  db?: DbClient;
  media: TrashMedia;
  limit?: number;
}): Promise<RecentlyDeletedItem[]> {
  const db = resolveDb(input.db);
  const arrKind = arrKindForTrashMedia(input.media);
  // Correlated: the item's latest app-expedite time and its latest restore time (branch B + supersede).
  const expeditedAt = sql<Date | null>`(
    SELECT max(le.occurred_at) FROM ${ledgerEvents} le
    WHERE le.media_item_id = ${mediaItems.id} AND le.event_type = 'trash_expedited'
  )`;
  const restoredAt = sql<Date | null>`(
    SELECT max(le.occurred_at) FROM ${ledgerEvents} le
    WHERE le.media_item_id = ${mediaItems.id} AND le.event_type IN ('trash_restored', 'restored')
  )`;
  // Branch B: has a trash_expedited event NOT superseded by a later restore.
  const expeditedNotRestored = sql`(${expeditedAt}) IS NOT NULL AND ((${restoredAt}) IS NULL OR (${expeditedAt}) > (${restoredAt}))`;
  const deletedAtExpr = sql<Date | null>`coalesce(${mediaItems.deletedFromArrAt}, (${expeditedAt}))`;
  const rows = await db
    .select({
      mediaItemId: mediaItems.id,
      title: mediaItems.title,
      year: mediaItems.year,
      arrKind: mediaItems.arrKind,
      tmdbId: mediaItems.tmdbId,
      tvdbId: mediaItems.tvdbId,
      sizeOnDisk: mediaItems.sizeOnDisk,
      deletedAt: deletedAtExpr,
      posterSource: mediaMetadata.posterSource,
      // The actor of the item's latest `trash_expedited` event (null ⇒ sync-only tombstone → system).
      deletedBy: sql<string | null>`(
        SELECT ${users.displayName}
        FROM ${ledgerEvents}
        JOIN ${users} ON ${users.id} = ${ledgerEvents.requestedByUserId}
        WHERE ${ledgerEvents.mediaItemId} = ${mediaItems.id}
          AND ${ledgerEvents.eventType} = 'trash_expedited'
        ORDER BY ${ledgerEvents.occurredAt} DESC
        LIMIT 1
      )`,
    })
    .from(mediaItems)
    .leftJoin(mediaMetadata, eq(mediaMetadata.mediaItemId, mediaItems.id))
    .where(
      and(
        eq(mediaItems.arrKind, arrKind),
        or(isNotNull(mediaItems.deletedFromArrAt), expeditedNotRestored),
      ),
    )
    .orderBy(desc(deletedAtExpr))
    .limit(input.limit ?? 100);
  return rows.map((r) => ({
    mediaItemId: r.mediaItemId,
    title: r.title,
    year: r.year,
    arrKind: r.arrKind,
    tmdbId: r.tmdbId,
    tvdbId: r.tvdbId,
    sizeOnDisk: r.sizeOnDisk,
    deletedAt: r.deletedAt === null ? null : new Date(r.deletedAt).toISOString(),
    posterSource: r.posterSource,
    deletedBy: r.deletedBy ?? null,
  }));
}

// ---------------------------------------------------------------------------
// Exclusion writes (D5 — protective ordering) + the dnd/watch guardian (D6)
// ---------------------------------------------------------------------------

const nowDate = () => new Date();

/**
 * ADR-023 / DESIGN-010 D-05 (as amended by ADR-099) — Save/whitelist an item so it is never deleted.
 *
 * ADR-099 — a USER Save (the pending wall, the library shield; `reason` 'user' or unset) on a title our ledger knows
 * is RECORDED FIRST: one transaction writes the `trash_excluded` audit row, opens the durable save intent (ADR-086)
 * and flips a matching open-batch row to `saved`, and only then is Maintainerr asked for the exclusion, under a short
 * deadline. A busy or unreachable Maintainerr no longer loses the Save: the intent is the protection every deletion
 * path reads, and the keeper (`keepTrashSaves`) applies the exclusion on its next tick. The owner's requirement
 * (2026-10-03): "if someone clicks save it's saved forever".
 *
 * The Maintainerr-first ordering (ADR-023 C-05: write the exclusion, then the ledger row) stays for the SYSTEM
 * protections, which record no Save (`watch_guardian`, inside a destructive flow that must protect before it
 * deletes; `relink` / `reapply`, the keeper itself), for a scoped exclusion (`collectionId`), and for an item with
 * no durable identity (unknown to our ledger, or a non-Trash *arr kind, ADR-086 D-13). Such an item can never be
 * deleted by the app either: every deletion path keeps an item unknown to the ledger (`unevaluable`).
 */
export interface SaveExclusionInput {
  db?: DbClient;
  maintainerr: MaintainerrClientBundle;
  /** Maintainerr's item id (Plex ratingKey) — the exclusion key. */
  maintainerrMediaId: string;
  /** Our ledger id, when the item is known (for event attribution). */
  mediaItemId?: string | null;
  /** Scope to a collection's rule group; omit for a GLOBAL exclusion (recommended for a save). */
  collectionId?: number;
  actorId: string | null;
  /** Attribution note for the ledger payload (e.g. 'user' | 'watch_guardian'). */
  reason?: string;
  /** ADR-099 — how long a record-first Save waits for Maintainerr before answering (tests shorten it). */
  enforceDeadlineMs?: number;
}

export interface SaveExclusionResult {
  /** Maintainerr holds the exclusion now (written by this call, or confirmed already there on the record-first path). */
  excluded: boolean;
  /** Maintainerr-first path only: the exclusion was already there, nothing was written. */
  alreadyExcluded: boolean;
  /** ADR-099 — the Save is recorded (an open save intent): durable whatever Maintainerr answered. */
  recorded: boolean;
  /** ADR-099 — `pending` when Maintainerr did not take the exclusion in time; the keeper finishes it. */
  exclusion: 'applied' | 'pending';
}

/** The open batch row a Save made outside the batch wall should flip (DESIGN-011 D-07 (d)). */
interface OpenBatchSaveTarget {
  itemId: string;
  batchId: string;
  itemMediaId: string;
  collectionId: number | null;
}

async function findOpenBatchSaveTarget(
  db: DbClient | undefined,
  input: { maintainerrMediaId: string; mediaItemId: string | null },
): Promise<OpenBatchSaveTarget | null> {
  const byMediaId = eq(trashBatchItems.maintainerrMediaId, input.maintainerrMediaId);
  const identity =
    input.mediaItemId === null
      ? byMediaId
      : or(byMediaId, eq(trashBatchItems.mediaItemId, input.mediaItemId));
  const [row] = await resolveDb(db)
    .select({
      itemId: trashBatchItems.id,
      batchId: trashBatchItems.batchId,
      itemMediaId: trashBatchItems.maintainerrMediaId,
      collectionId: trashBatches.maintainerrCollectionId,
    })
    .from(trashBatchItems)
    .innerJoin(trashBatches, eq(trashBatches.id, trashBatchItems.batchId))
    .where(
      and(
        inArray(trashBatches.state, [...TRASH_BATCH_OPEN_STATES]),
        eq(trashBatchItems.state, 'pending'),
        identity,
      ),
    )
    .limit(1);
  return row ?? null;
}

/** Flip the row to `saved` and append its `trash_batch_saves` row, inside the caller's transaction. Guarded on
 *  `state = 'pending'`: a concurrent wall save loses the race instead of double-recording. */
async function flipOpenBatchRowSaved(
  tx: Transaction,
  input: { itemId: string; actorId: string | null },
): Promise<boolean> {
  const updated = await tx
    .update(trashBatchItems)
    .set({ state: 'saved', savedBy: input.actorId, savedAt: nowDate(), savedReason: null })
    .where(and(eq(trashBatchItems.id, input.itemId), eq(trashBatchItems.state, 'pending')))
    .returning({ id: trashBatchItems.id });
  if (updated.length === 0) return false;
  await tx
    .insert(trashBatchSaves)
    .values({ batchItemId: input.itemId, userId: input.actorId, action: 'save' });
  return true;
}

/** Best effort: pull a saved poster out of the visible Leaving-Soon collection. A failure is cosmetic (the row is
 *  `saved`, outside the sweep) and the keeper tidies it on its next tick (ADR-099 D-6). Both keys go when the frozen
 *  snapshot key and the saved key differ (a re-key); removing an absent member is a tolerant no-op. */
async function removeSavedFromLeavingSoon(input: {
  maintainerr: MaintainerrClientBundle;
  collectionId: number | null;
  keys: readonly string[];
  deadlineMs?: number;
}): Promise<boolean> {
  const { collectionId } = input;
  if (collectionId === null) return true; // pre-green-light: there is no collection yet
  const keys = [...new Set(input.keys)];
  const call = () =>
    guardMaintainerrCall('maintainerr POST /collections/remove', () =>
      input.maintainerr.write.removeFromCollection(collectionId, keys),
    );
  try {
    if (input.deadlineMs === undefined) await call();
    else await withMaintainerrDeadline('maintainerr POST /collections/remove', input.deadlineMs, call);
    return true;
  } catch (err) {
    if (!(err instanceof MaintainerrUpstreamError)) throw err;
    return false;
  }
}

/**
 * DESIGN-011 D-07 amendment 2026-09-19 (d) — A SAVE MADE OUTSIDE THE WALL REACHES THE WALL.
 *
 * The batch poster wall is not the only place a title gets rescued: the pending wall and the library
 * shield both save through `saveExclusion`, which never touched `trash_batch_items`. The batch row
 * stayed `pending` (red trash glyph, counted in `Deleting`) even though the sweep would keep it as
 * `liveExcluded` — found while auditing the 2026-09-19 owner report (latent; no wrong deletion was
 * possible, the wall was simply dishonest about the row).
 *
 * This is the Maintainerr-first form of that cross-surface flip (a Save with no durable identity, ADR-099 keeps the
 * old ordering there); the record-first Save flips the row inside its own transaction instead. The external write
 * (pulling the poster out of the visible Leaving-Soon collection) happens first, then ONE transaction flips the row to
 * `saved` (+ `saved_by`/`saved_at`) and appends the `trash_batch_saves` 'save' row (the PLAN-014 tuning dataset). The
 * UPDATE is guarded (`AND state = 'pending'`) and the save-event row is written only when it actually changed a row,
 * so a concurrent wall save loses the race instead of double-recording.
 *
 * Scope:
 *   - OPEN batches only (draft/admin_review/leaving_soon). A terminal batch's rows are history.
 *   - `pending` rows only. `saved`/`protected`/`deleted`/`skipped` are inert.
 *   - PROTECTIVE DIRECTION ONLY — there is no un-save counterpart: an un-save made outside the wall
 *     leaves the batch row `saved` (the title is kept for this batch and competes again in the next).
 *   - Identity is matched on EITHER key the two surfaces share: the Maintainerr id (Plex ratingKey)
 *     or, when the caller knows it, our stable `media_item_id` — which is what still matches after a
 *     file replacement re-keys the Plex item (ADR-086).
 *
 * The collection removal is BEST-EFFORT: a Maintainerr failure there must never undo or shadow the
 * protective exclusion the caller already established, and it must never block the row flip — the
 * flip is itself protective (a `saved` row is outside the sweep), while a stale poster in the
 * Leaving-Soon collection is cosmetic and is tidied by the keeper. Non-upstream errors still propagate.
 */
export async function applyOpenBatchSave(input: {
  db?: DbClient;
  maintainerr: MaintainerrClientBundle;
  /** The Maintainerr id (Plex ratingKey) that was just excluded. */
  maintainerrMediaId: string;
  /** Our stable ledger id, when known — the identity that survives a Plex re-key. */
  mediaItemId?: string | null;
  actorId: string | null;
}): Promise<{ flipped: boolean; batchId: string | null; batchItemId: string | null }> {
  const row = await findOpenBatchSaveTarget(input.db, {
    maintainerrMediaId: input.maintainerrMediaId,
    mediaItemId: input.mediaItemId ?? null,
  });
  // Not in any open batch (the common case) — a clean no-op, no transaction, no Maintainerr call.
  if (!row) return { flipped: false, batchId: null, batchItemId: null };

  // 1) The external write first: pull the poster out of the visible Leaving-Soon collection.
  await removeSavedFromLeavingSoon({
    maintainerr: input.maintainerr,
    collectionId: row.collectionId,
    keys: [row.itemMediaId, input.maintainerrMediaId],
  });

  // 2) Then the DB, in ONE transaction: state + holder + the append-only save-event row.
  const flipped = await inTransaction(input.db, (tx) =>
    flipOpenBatchRowSaved(tx, { itemId: row.itemId, actorId: input.actorId }),
  );
  return { flipped, batchId: row.batchId, batchItemId: row.itemId };
}

/**
 * The (d) hook on the Maintainerr-first path. Gated on the save's ORIGIN so it never double-applies and never invents
 * a human rescue:
 *   - `batch_save` — the wall path itself (`setBatchItemSaved`) records its own flip + save row.
 *   - `watch_guardian` / `relink` / `reapply` — SYSTEM protections, not rescues. `trash_batch_saves` is the
 *     "which items get rescued, BY WHOM" tuning dataset (PLAN-014) and the batch model deliberately
 *     has no system auto-save any more (ADR-025 errata 2026-07-09), so a cron must not author one.
 *   - `user` (or unset) — the pending wall / library shield. THIS is the case (d) is about.
 */
async function reconcileOpenBatchFromSave(input: SaveExclusionInput): Promise<void> {
  if ((input.reason ?? 'user') !== 'user') return;
  await applyOpenBatchSave({
    db: input.db,
    maintainerr: input.maintainerr,
    maintainerrMediaId: input.maintainerrMediaId,
    mediaItemId: input.mediaItemId ?? null,
    actorId: input.actorId,
  });
}

/** The reasons whose exclusion is the enforcement of a human Save, and so carries a durable save intent. A
 *  `watch_guardian` auto-protection never does (ADR-086 D-10; it used to open a `user` intent, which ADR-099 makes
 *  authoritative and therefore permanent). */
function intentOriginFor(reason: string | undefined): 'user' | 'batch_save' | 'relink' | null {
  const r = reason ?? 'user';
  if (r === 'user') return 'user';
  if (r === 'batch_save') return 'batch_save';
  if (r === 'relink' || r === 'reapply') return 'relink';
  return null;
}

/** The Trash media kind of a ledger item, or null when it has none (unknown, or not Radarr/Sonarr). */
async function trashKindOfMediaItem(
  db: DbClient | undefined,
  mediaItemId: string,
): Promise<'movie' | 'tv' | null> {
  const [row] = await resolveDb(db)
    .select({ arrKind: mediaItems.arrKind })
    .from(mediaItems)
    .where(eq(mediaItems.id, mediaItemId))
    .limit(1);
  return trashMediaKindForArrKind(row?.arrKind ?? null);
}

export async function saveExclusion(input: SaveExclusionInput): Promise<SaveExclusionResult> {
  // ADR-099 — the record-first Save: a user Save, global, on a title with a durable identity.
  if (
    (input.reason ?? 'user') === 'user' &&
    input.collectionId === undefined &&
    input.mediaItemId != null &&
    (await trashKindOfMediaItem(input.db, input.mediaItemId)) !== null
  ) {
    return recordUserSave({ ...input, mediaItemId: input.mediaItemId });
  }

  const origin = intentOriginFor(input.reason);
  // Idempotency: is the item already excluded? (Maintainerr returns [] with no params, so query
  // by the item's mediaServerId.)
  const existing = await guardMaintainerrCall('maintainerr GET /rules/exclusion', () =>
    input.maintainerr.read.getExclusions({ mediaServerId: input.maintainerrMediaId }),
  );
  if (existing.length > 0) {
    // ADR-086 D-1 — the intent is written even here. This early return is EXACTLY what a re-save
    // after a lapse hits (Maintainerr already holds the exclusion under the current key), and it is
    // the one path that historically recorded nothing at all. No duplicate ledger row: the
    // protection already exists and was already audited when it was first established.
    if (input.mediaItemId != null && origin !== null) {
      const mediaItemId = input.mediaItemId;
      await inTransaction(input.db, async (tx) => {
        await openSaveIntent(tx, {
          mediaItemId,
          maintainerrMediaId: input.maintainerrMediaId,
          origin: origin === 'relink' ? 'user' : origin,
          actorId: input.actorId,
          relink: origin === 'relink',
          exclusionConfirmed: true,
        });
      });
    }
    // DESIGN-011 D-07 (d) — a re-save of an already-excluded title still reconciles the wall.
    await reconcileOpenBatchFromSave(input);
    return { excluded: false, alreadyExcluded: true, recorded: origin !== null && input.mediaItemId != null, exclusion: 'applied' };
  }

  // 1) Establish the protective state FIRST (external).
  await guardMaintainerrCall('maintainerr POST /rules/exclusion', () =>
    input.maintainerr.write.addExclusion(input.maintainerrMediaId, input.collectionId),
  );

  // 2) Then record the durable audit event (source 'maintainerr') AND the durable intent, in ONE
  //    transaction (hard rule 6 — ADR-086 D-1). The intent is what survives a Plex re-key; the
  //    exclusion above is only the enforcement of it.
  await inTransaction(input.db, async (tx) => {
    await tx.insert(ledgerEvents).values({
      mediaItemId: input.mediaItemId ?? null,
      eventType: 'trash_excluded',
      source: 'maintainerr',
      occurredAt: nowDate(),
      requestedByUserId: input.actorId ?? null,
      payload: {
        action: 'save',
        maintainerrMediaId: input.maintainerrMediaId,
        ...(input.collectionId !== undefined ? { collectionId: input.collectionId } : {}),
        reason: input.reason ?? 'user',
      },
    });
    // ADR-086 D-13 — a save on an item unknown to our ledger has no durable identity to relink.
    // It is still excluded and still audited; it simply cannot be rescued after a re-key.
    if (input.mediaItemId != null && origin !== null) {
      await openSaveIntent(tx, {
        mediaItemId: input.mediaItemId,
        maintainerrMediaId: input.maintainerrMediaId,
        origin: origin === 'relink' ? 'user' : origin,
        actorId: input.actorId,
        relink: origin === 'relink',
        exclusionConfirmed: input.collectionId === undefined,
      });
    }
  });

  // 3) DESIGN-011 D-07 (d) — a save made OUTSIDE the batch wall reaches the wall: flip a matching
  //    `pending` row of an OPEN batch to `saved` (protective Maintainerr write first, then DB).
  await reconcileOpenBatchFromSave(input);

  return { excluded: true, alreadyExcluded: false, recorded: origin !== null && input.mediaItemId != null, exclusion: 'applied' };
}

/**
 * ADR-099 D-1 — the record-first user Save. Transaction first: the `trash_excluded` audit row (only for a title with
 * no open intent: a re-save of a saved title was audited when it was first saved), the save intent (pending until
 * Maintainerr is read back holding the exclusion), and the open-batch row flip with its `trash_batch_saves` row. The
 * Save is durable when this commits. Then, under the short deadline, the exclusion and the Leaving-Soon removal; what
 * does not finish in time is the keeper's.
 */
async function recordUserSave(
  input: SaveExclusionInput & { mediaItemId: string },
): Promise<SaveExclusionResult> {
  const startedAt = Date.now();
  const deadlineMs = input.enforceDeadlineMs ?? SAVE_ENFORCE_DEADLINE_MS;
  const recorded = await inTransaction(input.db, async (tx) => {
    const [open] = await tx
      .select({ id: trashSaveIntents.id })
      .from(trashSaveIntents)
      .where(
        and(eq(trashSaveIntents.mediaItemId, input.mediaItemId), isNull(trashSaveIntents.revokedAt)),
      )
      .limit(1);
    if (!open) {
      await tx.insert(ledgerEvents).values({
        mediaItemId: input.mediaItemId,
        eventType: 'trash_excluded',
        source: 'maintainerr',
        occurredAt: nowDate(),
        requestedByUserId: input.actorId ?? null,
        payload: { action: 'save', maintainerrMediaId: input.maintainerrMediaId, reason: 'user' },
      });
    }
    const intent = await openSaveIntent(tx, {
      mediaItemId: input.mediaItemId,
      maintainerrMediaId: input.maintainerrMediaId,
      origin: 'user',
      actorId: input.actorId,
      exclusionConfirmed: false,
    });
    if (intent === null) throw new Error(`save intent for ${input.mediaItemId} could not be opened`);
    const target = await findOpenBatchSaveTarget(tx, {
      maintainerrMediaId: input.maintainerrMediaId,
      mediaItemId: input.mediaItemId,
    });
    const flipped =
      target !== null && (await flipOpenBatchRowSaved(tx, { itemId: target.itemId, actorId: input.actorId }));
    return { intentId: intent.intentId, target: flipped ? target : null };
  });

  // Enforcement, inside the deadline. The Save above already stands whatever happens here.
  const outcome = await applySaveIntentExclusion({
    db: input.db,
    maintainerr: input.maintainerr,
    intentId: recorded.intentId,
    maintainerrMediaId: input.maintainerrMediaId,
    deadlineMs,
  });
  const left = deadlineMs - (Date.now() - startedAt);
  if (recorded.target !== null && outcome === 'applied' && left > 0) {
    await removeSavedFromLeavingSoon({
      maintainerr: input.maintainerr,
      collectionId: recorded.target.collectionId,
      keys: [recorded.target.itemMediaId, input.maintainerrMediaId],
      deadlineMs: left,
    });
  }
  return {
    excluded: outcome === 'applied',
    alreadyExcluded: false,
    recorded: true,
    exclusion: outcome === 'applied' ? 'applied' : 'pending',
  };
}

/**
 * ADR-023 / DESIGN-010 D-05 — un-save: remove the item's Maintainerr exclusion(s). Symmetric to
 * saveExclusion — external removal FIRST, then the `trash_excluded` (action 'unsave') audit event.
 * Idempotent: nothing excluded ⇒ no-op, no event.
 */
export async function removeExclusion(input: {
  db?: DbClient;
  maintainerr: MaintainerrClientBundle;
  maintainerrMediaId: string;
  mediaItemId?: string | null;
  actorId: string | null;
}): Promise<{ removed: boolean; intentRevoked: boolean }> {
  const existing = await guardMaintainerrCall('maintainerr GET /rules/exclusion', () =>
    input.maintainerr.read.getExclusions({ mediaServerId: input.maintainerrMediaId }),
  );
  if (existing.length === 0) {
    // ADR-086 D-3 — nothing to un-exclude, but there may still be an OPEN INTENT. This is exactly
    // the lapsed state (the exclusion was pruned when a file replacement re-keyed the Plex item),
    // and it is the state in which the owner most needs to be able to say "stop keeping this".
    // If revocation were gated on a successful un-exclude, both un-save affordances would no-op
    // here and the relink reconciler would re-protect the title forever with no brake.
    if (input.mediaItemId != null) {
      const mediaItemId = input.mediaItemId;
      const revoked = await inTransaction(input.db, async (tx) => {
        const didRevoke = await revokeSaveIntent(tx, { mediaItemId, actorId: input.actorId });
        if (didRevoke) {
          await tx.insert(ledgerEvents).values({
            mediaItemId,
            eventType: 'trash_excluded',
            source: 'maintainerr',
            occurredAt: nowDate(),
            requestedByUserId: input.actorId ?? null,
            payload: {
              action: 'unsave',
              maintainerrMediaId: input.maintainerrMediaId,
              reason: 'lapsed',
            },
          });
        }
        return didRevoke;
      });
      // `removed` stays false — no exclusion was removed — but the intent revocation IS a real,
      // audited state change, so surface it distinctly rather than hiding it behind a bare no-op.
      return { removed: false, intentRevoked: revoked };
    }
    return { removed: false, intentRevoked: false };
  }

  await guardMaintainerrCall('maintainerr DELETE /rules/exclusions', () =>
    input.maintainerr.write.removeExclusion(input.maintainerrMediaId),
  );

  let intentRevoked = false;
  await inTransaction(input.db, async (tx) => {
    await tx.insert(ledgerEvents).values({
      mediaItemId: input.mediaItemId ?? null,
      eventType: 'trash_excluded',
      source: 'maintainerr',
      occurredAt: nowDate(),
      requestedByUserId: input.actorId ?? null,
      payload: { action: 'unsave', maintainerrMediaId: input.maintainerrMediaId },
    });
    if (input.mediaItemId != null) {
      intentRevoked = await revokeSaveIntent(tx, {
        mediaItemId: input.mediaItemId,
        actorId: input.actorId,
      });
    }
  });

  return { removed: true, intentRevoked };
}

/**
 * Why an item is kept out of a deletion. `tag` ⇒ already whitelisted by the Maintainerr-managed
 * `dnd` tag; `recently_watched` ⇒ the watch guardian (auto-whitelist, owner-ratified exception —
 * covers viewing that starts mid-window); `unevaluable` ⇒ FAIL-CLOSED: the item is not resolved to
 * our ledger, so we have NO cross-server watch signal to positively clear it (P4) — we never delete
 * what we cannot evaluate.
 *
 * SEPARATION OF RESPONSIBILITIES (owner ruling 2026-07-09): "Maintainerr rules decide what gets
 * promoted; the app controls how much and when it's deleted." A personal requester tag is not a
 * keep (surfaced as a wall meta badge). See ADR-025 errata (2026-07-09).
 *
 * SUPERSEDED FOR ONE TAG (owner ruling 2026-11-13, ADR-118): a title whose ledger tags include
 * `mediarequests` IS a keep (`media_request`). The tag lasts until it is removed. The earlier keeps
 * below still win, in the same order, so a title kept today is kept for the same reason.
 */
export type GuardianKeepReason =
  | 'saved'
  | 'tag'
  | 'recently_watched'
  | 'watchlisted'
  | 'recently_added'
  // ADR-118 — after the keeps that existed before it, and before `unevaluable`.
  | 'media_request'
  | 'admin_restored'
  | 'unevaluable'
  // ADR-117 / DESIGN-052 D-29 — after `unevaluable`, where that decision placed it.
  | 'release_unverified';
export type GuardianVerdict = { keep: true; reason: GuardianKeepReason } | { keep: false };

/** The fields the guardian reads. A structural subset of `TrashPendingItem` (every real caller still
 *  passes a whole pending item) so the shared expedite derivation below can compose it without an
 *  unchecked cast. `arrTags` is optional so a fixture that does not model tags is not requested. */
export type GuardianInput = Pick<
  TrashPendingItem,
  | 'protectedByTag'
  | 'recentlyWatched'
  | 'mediaItemId'
  | 'onWatchlist'
  | 'watchlistEvaluable'
  | 'ruleEvaluationFailed'
  | 'ageGuard'
  | 'saveIntent'
  | 'releaseName'
> & { arrTags?: readonly string[]; restoreKeep?: boolean };

/**
 * The guardian's per-item verdict (P4 — fail closed). An item is expeditable ONLY when it is
 * positively evaluated (resolved to our ledger) AND cold (not tag-protected, not recently watched,
 * not on a watchlist, not recently added, and not tagged `mediarequests`).
 * Anything we cannot positively clear — including an item unknown to our ledger — is KEPT. A personal
 * requester tag is NOT a keep (owner ruling 2026-07-09). The `mediarequests` tag IS a keep (owner
 * ruling 2026-11-13, ADR-118). The `media`-param bypass (P3) is defeated by callers running this over
 * the item's REAL pending identity, never a client-declared kind.
 */
export function classifyGuardian(item: GuardianInput): GuardianVerdict {
  // ADR-099 D-4 — a Save is the app's record, checked first: authoritative whether or not Maintainerr holds the
  // exclusion yet (a Save tapped while Maintainerr ran its rules is applied by the keeper minutes later).
  if (item.saveIntent) return { keep: true, reason: 'saved' };
  if (item.protectedByTag) return { keep: true, reason: 'tag' };
  if (item.recentlyWatched) return { keep: true, reason: 'recently_watched' };
  // ADR-093 C-03 / DESIGN-052 D-09 — the Watchlist Keep (T-263): on anybody's read watchlist ⇒ kept. Not a Save:
  // when the title leaves every watchlist it is deletable again.
  if (item.onWatchlist) return { keep: true, reason: 'watchlisted' };
  // DESIGN-052 D-26 / Q-14 — the Age Guard: downloaded, upgraded or added to any Plex server in the last 180 days ⇒
  // kept on every delete path (the sweep and both Expedite scopes). Not a Save: it lapses when the title ages out.
  if (item.ageGuard === 'recent') return { keep: true, reason: 'recently_added' };
  // ADR-118 / DESIGN-052 D-30 — the Request Keep. After every earlier keep, so those reasons are unchanged, and
  // before `unevaluable`, so a tagged title is reported as requested. The tags are the full sync's copy
  // (04:30, up to 24 hours). It lasts while that copy contains the tag.
  if (hasMediaRequestTag(item.arrTags)) return { keep: true, reason: 'media_request' };
  if (item.restoreKeep) return { keep: true, reason: 'admin_restored' };
  // Fail closed: no ledger resolution ⇒ no watch data ⇒ we cannot confirm it is safe. Likewise an item whose
  // watchlist status cannot be evaluated (no verified snapshot, or no guid while a registry title of its kind is
  // unmapped), an item Maintainerr flags `ruleEvaluationFailed` (its own handler skips those), and an item whose
  // age cannot be told (a Plex match not dated yet, D-26).
  if (
    item.mediaItemId === null ||
    item.watchlistEvaluable !== true ||
    item.ruleEvaluationFailed ||
    item.ageGuard === 'unknown'
  ) {
    return { keep: true, reason: 'unevaluable' };
  }
  // ADR-117 / DESIGN-052 D-29 (owner ruling 2026-11-13) — a release that was grabbed is never grabbed again, and a
  // term built from the renamed file is not a verified block. A title whose file on disk has no verified posted
  // name is kept on every delete path. Not a Save: it is deletable once a name is on record.
  if (item.releaseName === 'unverified') return { keep: true, reason: 'release_unverified' };
  return { keep: false };
}

/**
 * A pending title that takes a deletion slot: not saved, not `dnd`, not watchlisted, not inside the Age Guard,
 * and not tagged `mediarequests` (ADR-118). ADR-117 also leaves out a title whose file has no verified
 * posted release name. createBatchFromPending leaves a requested title out of every batch; this
 * predicate is the slot math and the space-policy count.
 */
export function countsTowardDeletion(item: {
  saveIntent: boolean;
  restoreKeep?: boolean;
  protectedByTag: boolean;
  onWatchlist: boolean;
  ageGuard: 'recent' | 'clear' | 'unknown';
  arrTags?: readonly string[];
  releaseName?: string;
}): boolean {
  return (
    !item.saveIntent &&
    !item.restoreKeep &&
    !item.protectedByTag &&
    !item.onWatchlist &&
    item.ageGuard !== 'recent' &&
    !hasMediaRequestTag(item.arrTags) &&
    item.releaseName !== 'unverified'
  );
}

/** The minimal item surface an expedite verdict reads — the guardian's three fields plus the
 *  Maintainerr id the 'all' loop pre-checks. */
export interface ExpediteVerdictInput extends GuardianInput {
  maintainerrMediaId: TrashPendingItem['maintainerrMediaId'];
}

/**
 * Why an item survives (or not) an expedite:
 * - `deletable`         — cold + positively evaluated ⇒ the server WILL delete it. A personal requester
 *                         tag stays informational (owner ruling 2026-07-09). A `mediarequests` tag is
 *                         `protected_request` (owner ruling 2026-11-13, ADR-118).
 * - `protected_saved`   — kept because somebody saved it (ADR-099: the app's record, exclusion or not).
 * - `protected_tag` / `protected_watched` — kept deliberately (whitelist / watch guardian).
 * - `protected_request` — kept because the ledger tags include `mediarequests`.
 * - `unverifiable`      — kept because it CANNOT be verified safe (no Maintainerr id, or unknown to
 *                         our ledger) ⇒ counted as SKIPPED, never deleted. NOT the same thing as
 *                         protected — surface it distinctly (ADR-023 C-07b).
 */
export type ExpediteVerdict =
  | 'deletable'
  | 'protected_saved'
  | 'protected_tag'
  | 'protected_watched'
  | 'protected_watchlist'
  | 'protected_recent'
  | 'protected_request'
  | 'protected_restore'
  | 'unverifiable';

/**
 * ADR-086 D-11 / DESIGN-048 D-06 — THE one expedite-partition derivation. It composes the
 * enforcement truth (`classifyGuardian`, immediately above) with the expedite 'all' loop's
 * unactionable pre-check, so a preview built on it cannot drift from what the server actually does.
 *
 * It exists because three hand-synced copies of this rule had already drifted: the server preview
 * (`trash-candidates.ts` partitionPendingForExpedite) still counted `requesters.length > 0` as
 * protected long after the 2026-07-09 owner ruling made requesters informational, so the
 * Expedite-all confirm UNDERSTATED what would be deleted. The server preview now calls THIS, so
 * that copy is gone. The remaining mirror is the client's `previewGuardian`
 * (apps/web/lib/trash.ts) — app lib code must not import @hnet/domain (it would drag drizzle/pg
 * into the browser bundle), so parity is a test contract instead of an import:
 * `apps/web/lib/__tests__/trash.test.ts` compares the two case-by-case in the node context (the
 * same arrangement lib/library-views.ts uses). Change this and that test fails until the mirror
 * follows.
 */
export function classifyForExpedite(item: ExpediteVerdictInput): ExpediteVerdict {
  // The expedite 'all' loop skips unactionable items (no Maintainerr id) BEFORE the guardian.
  if (item.maintainerrMediaId === null) return 'unverifiable';
  const verdict = classifyGuardian(item);
  if (!verdict.keep) return 'deletable';
  if (verdict.reason === 'saved') return 'protected_saved';
  if (verdict.reason === 'tag') return 'protected_tag';
  if (verdict.reason === 'recently_watched') return 'protected_watched';
  if (verdict.reason === 'watchlisted') return 'protected_watchlist';
  if (verdict.reason === 'recently_added') return 'protected_recent';
  if (verdict.reason === 'media_request') return 'protected_request';
  if (verdict.reason === 'admin_restored') return 'protected_restore';
  return 'unverifiable'; // 'unevaluable' — kept because it cannot be cleared, not whitelisted.
}

/**
 * DESIGN-052 D-10 amendment (2026-11-13, story 832) — Wall Protection (DDD-001 T-333).
 * Why the pending wall will not offer this title for deletion, or null when it will.
 * The same order as `classifyGuardian`, with `unevaluable` named by the check that failed.
 * A page-scoped live exclusion is applied by the caller after this returns null (`live_excluded`);
 * it is not an input here because ADR-035 keeps that read off the whole set.
 * This does not decide a delete. The sweep and Expedite keep using `classifyGuardian`.
 */
export const TRASH_WALL_PROTECTION_REASONS = [
  'saved',
  'tag',
  'recently_watched',
  'watchlisted',
  'recently_added',
  'media_request',
  'admin_restored',
  'not_in_ledger',
  'watchlist_unknown',
  'rules_unknown',
  'age_unknown',
  'unactionable',
  'live_excluded',
  // ADR-117 / DESIGN-052 D-29 — no verified posted release name for the file on disk (the Release Name Check).
  'release_unverified',
] as const;
export type TrashWallProtectionReason = (typeof TRASH_WALL_PROTECTION_REASONS)[number];

export function trashWallProtection(item: ExpediteVerdictInput): TrashWallProtectionReason | null {
  if (item.maintainerrMediaId === null) return 'unactionable';
  if (item.saveIntent) return 'saved';
  if (item.protectedByTag) return 'tag';
  if (item.recentlyWatched) return 'recently_watched';
  if (item.onWatchlist) return 'watchlisted';
  if (item.ageGuard === 'recent') return 'recently_added';
  // ADR-118 — the same place as classifyGuardian, so a requested title is not offered.
  if (hasMediaRequestTag(item.arrTags)) return 'media_request';
  if (item.restoreKeep) return 'admin_restored';
  if (item.mediaItemId === null) return 'not_in_ledger';
  if (item.watchlistEvaluable !== true) return 'watchlist_unknown';
  if (item.ruleEvaluationFailed) return 'rules_unknown';
  if (item.ageGuard === 'unknown') return 'age_unknown';
  if (item.releaseName === 'unverified') return 'release_unverified';
  return null;
}

/**
 * Addendum a — the cross-server watch guardian. Given the pending set for a media kind, auto-protect
 * (whitelist in Maintainerr) every item watched on ANY server within the window that is not already
 * protected, BEFORE any expedite. Returns the protected + surviving (expeditable) partitions. Each
 * protection records a `trash_excluded` (reason 'watch_guardian') event. Items with no Maintainerr id
 * (unactionable) or that the guardian cannot positively evaluate are kept out of the expeditable set
 * (fail closed, P4). NOTE this returns only ids; `expediteDeletion` scope 'all' runs the richer
 * per-item loop directly (it needs each survivor's collectionId for `handleCollectionMedia`).
 */
export async function guardRecentlyWatched(input: {
  db?: DbClient;
  maintainerr: MaintainerrClientBundle;
  media: TrashMedia;
  actorId: string | null;
  watchWindowDays?: number;
  /** ADR-093 / DESIGN-052 D-06 — a delete path: the Registry Gate's verified `delete` snapshot. */
  watchlist: DeleteWatchlistSnapshot;
}): Promise<{ protectedCount: number; protectedIds: string[]; expeditableIds: string[] }> {
  const pending = await listTrashPending({
    db: input.db,
    maintainerr: input.maintainerr,
    media: input.media,
    watchWindowDays: input.watchWindowDays,
    watchlist: input.watchlist,
  });
  const protectedIds: string[] = [];
  const expeditableIds: string[] = [];
  for (const item of pending.items) {
    if (item.maintainerrMediaId === null) continue;
    const verdict = classifyGuardian(item);
    if (verdict.keep) {
      if (verdict.reason === 'recently_watched') {
        const res = await saveExclusion({
          db: input.db,
          maintainerr: input.maintainerr,
          maintainerrMediaId: item.maintainerrMediaId,
          mediaItemId: item.mediaItemId,
          actorId: input.actorId,
          reason: 'watch_guardian',
        });
        if (res.excluded || res.alreadyExcluded) protectedIds.push(item.maintainerrMediaId);
      } else {
        // tag-protected (already whitelisted), watchlisted (kept, NEVER auto-saved — a watchlist is not a Save,
        // DESIGN-052 D-09) or unevaluable (kept, not force-whitelisted).
        protectedIds.push(item.maintainerrMediaId);
      }
    } else {
      expeditableIds.push(item.maintainerrMediaId);
    }
  }
  return { protectedCount: protectedIds.length, protectedIds, expeditableIds };
}

/**
 * Resolve a pending item to its REAL identity + media kind by scanning the actual Maintainerr
 * pending sets (both movie and tv), NOT trusting any client-declared `media` param (P3). Returns the
 * merged pending row (which carries the true collectionId, arrKind, watch/requester facets the
 * guardian needs) or null when the item is not present in ANY pending set. At household scale
 * (currently zero collections) the two-kind scan is negligible.
 */
async function resolvePendingTarget(input: {
  db?: DbClient;
  maintainerr: MaintainerrClientBundle;
  maintainerrMediaId: string;
  collectionId?: number;
  watchWindowDays?: number;
  /** ADR-093 / DESIGN-052 D-06 — a delete path: the Registry Gate's verified `delete` snapshot. */
  watchlist: DeleteWatchlistSnapshot;
}): Promise<{ item: TrashPendingItem; media: TrashMedia } | null> {
  for (const media of ['movie', 'tv'] as const) {
    const pending = await listTrashPending({
      db: input.db,
      maintainerr: input.maintainerr,
      media,
      watchWindowDays: input.watchWindowDays,
      watchlist: input.watchlist,
    });
    const item = pending.items.find(
      (p) =>
        p.maintainerrMediaId === input.maintainerrMediaId &&
        (input.collectionId === undefined || p.collectionId === input.collectionId),
    );
    if (item) return { item, media };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Expedite (destructive — D5 intent-first ordering) + rules + restore
// ---------------------------------------------------------------------------

/**
 * ADR-023 / DESIGN-010 D-04/D-05 — expedite deletion (DESTRUCTIVE). Every call re-runs the preflight
 * audit and refuses (MaintainerrUnsafeError → PRECONDITION_FAILED) unless SAFE.
 *
 * P1b/P5 (dated ruling 2026-07-06, Fable): Maintainerr's `POST /collections/handle` processes EVERY
 * active collection (all media kinds, incl. items outside our ledger) and is NOT scopeable — so
 * expedite NEVER calls it. Both scopes delete PER ITEM via `POST /collections/media/handle`, guarded
 * individually. This keeps deletion scoped to exactly the media kind / set the user saw and
 * guarantees every deleted item passed the guardian.
 *
 * F1 (2026-07-06 review) — BOTH scopes first consult the LIVE Maintainerr exclusion set
 * (`fetchLiveExclusions`) and treat a currently-excluded item as PROTECTED, closing the window where
 * a just-SAVED item's `dnd` tag has not yet synced to `classifyGuardian`'s inputs. F2 — scope 'all'
 * is pinned to `snapshotMediaIds` (the set the user saw); only its intersection with the current
 * pending set is processed (stale ids → `stalePending`; newly-pending items are never touched).
 *
 * scope 'item' — resolve the target's REAL identity from the actual pending set (NOT the client
 * `media` param, P3); if it cannot be resolved to run the guardian, REFUSE (don't fail open). scope
 * 'all' — a two-pass loop over the (pinned) pending targets: PASS 1 runs the guardian over each
 * item (auto-whitelisting watched/requested; a failed protection SKIPS the item, never deletes it —
 * P4/P5); PASS 2 deletes each SURVIVOR individually, committing the `trash_expedited` intent event
 * BEFORE its handle call (the Fix D-09 destructive-ordering discipline). Music/Lidarr is rejected
 * upstream at the router (media is movie|tv only, R-87).
 */
export interface ExpediteDeletionInput {
  db?: DbClient;
  maintainerr: MaintainerrClientBundle;
  scope: 'item' | 'all';
  media: TrashMedia;
  actorId: string | null;
  watchWindowDays?: number;
  /** scope 'item' — the target. */
  item?: {
    collectionId: number;
    maintainerrMediaId: string;
    mediaItemId?: string | null;
  };
  /**
   * F2 (2026-07-06 pre-ship review) — scope 'all' ONLY: the maintainerrMediaId snapshot the user
   * actually SAW in the confirm modal. The run processes EXACTLY the intersection of this list with
   * the CURRENT pending set: ids no longer pending are counted `stalePending` (never deleted), and
   * items that became pending AFTER the snapshot are NEVER touched (the user never consented to
   * them). Omit for the legacy/internal whole-set behaviour (process the entire current pending set).
   */
  snapshotMediaIds?: string[];
  /** ADR-093 C-07 / DESIGN-052 D-11..D-14 — the Radarr / Sonarr reads and the confined release-profile writes: every
   *  expedited item's release is recorded and blocked before its handle (REQUIRED). */
  arr: ReleaseBlockArrClients;
  /** D-21 log seam for the gate line (defaults to the JSON-lines console logger). */
  logger?: DomainLogger;
  /** Clock seam for the Registry Gate (tests). */
  now?: Date;
}

export interface ExpediteDeletionResult {
  scope: 'item' | 'all';
  /** items kept by the guardian (whitelisted / already tag-protected / LIVE-excluded) instead of
   *  deleted. */
  protectedCount: number;
  /** items handed to Maintainerr's per-item handler (each passed the guardian). */
  expeditedCount: number;
  /** items NOT deleted because the guardian could not clear them: unevaluable (unknown to our
   *  ledger), unactionable (no Maintainerr id), or a failed protection write. Never deleted. */
  skippedCount: number;
  /** F2 — scope 'all': snapshot ids that were no longer pending at run time (the pending set moved
   *  under the user). Not deleted, not an error — just no longer applicable. Always 0 for scope 'item'
   *  and for an unpinned 'all' run. */
  stalePending: number;
  /** ADR-035 — the Maintainerr ids actually handed to the per-item delete handler this run, so the
   *  caller can drop them from the candidate read-model without waiting for the next refresh. */
  expeditedIds: string[];
  /** ADR-093 / DESIGN-052 D-11 — of `skippedCount`, the items kept because their release could not be recorded (no
   *  term, no delete). Since ADR-117 / D-29 it includes the two counts below. */
  unrecordedCount: number;
  /** ADR-117 / D-29 — of `skippedCount`, the items kept because a file on disk has no verified posted release name
   *  (the guardian's ledger check, or the delete path's read of the *arr's files). Never deleted. */
  unverifiedNameCount: number;
  /** D-29 — of `skippedCount`, the items kept because their terms would not fit under the Release Block's cap. */
  blockFullCount: number;
  /** D-29 — posted names of the deleted items that got no term because they name no release. */
  skippedNames: number;
}

/**
 * F1 (2026-07-06 pre-ship review) — the LIVE-exclusion safety seam. `classifyGuardian` reads only
 * the SYNCED facets (arrTags/watched/requesters); a just-SAVED item's protective `dnd` tag has not
 * yet round-tripped Maintainerr → the *arr → our ledger, so the guardian would (wrongly) clear a
 * freshly-saved cold item as deletable — the save→expedite race the review found. Before any
 * expedite deletes anything we therefore ask Maintainerr DIRECTLY whether each candidate is
 * currently excluded (whitelisted) and treat a live exclusion as PROTECTED — never handled.
 *
 * Gathered ONCE per run (before the guardian loop). Real Maintainerr returns [] for `getExclusions`
 * with no params, so we query per candidate by mediaServerId — bounded by the (household-scale)
 * candidate set. Read-only; failures fail closed via guardMaintainerrCall like every other call.
 */
export async function fetchLiveExclusions(
  maintainerr: Pick<MaintainerrClientBundle, 'read'>,
  ids: readonly string[],
): Promise<Set<string>> {
  // Perf (2026-07-09, owner-directed trash-wall paging): the per-item exclusion GET was the
  // dominant cost of the pending TAB — a SEQUENTIAL loop of one round-trip per candidate (776
  // movies ⇒ 776 serial Maintainerr calls ⇒ the observed 15-30 s). Two fixes land together: the
  // paginated read only ever asks this for the RETURNED PAGE (≤ limit ids, not the whole set), and
  // the reads now run with bounded concurrency instead of strictly serial. Read-only; each call
  // still fails closed via guardMaintainerrCall exactly as before.
  const excluded = new Set<string>();
  await mapWithConcurrency(ids, EXCLUSION_READ_CONCURRENCY, async (id) => {
    const rows = await guardMaintainerrCall('maintainerr GET /rules/exclusion', () =>
      maintainerr.read.getExclusions({ mediaServerId: id }),
    );
    if (rows.length > 0) excluded.add(id);
  });
  return excluded;
}

/** How many Maintainerr exclusion reads run in flight at once (polite to an in-cluster service;
 *  a page is ≤ limit items so this bounds the burst). */
const EXCLUSION_READ_CONCURRENCY = 8;

/** Run `worker` over `items` with at most `limit` promises in flight (order-independent). */
export async function mapWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return;
  const width = Math.max(1, Math.min(limit, items.length));
  let cursor = 0;
  const runners = Array.from({ length: width }, async () => {
    for (;;) {
      const i = cursor;
      cursor += 1;
      if (i >= items.length) return;
      await worker(items[i] as T);
    }
  });
  await Promise.all(runners);
}

/** A compact human byte size for the Activity notification body. Domain-side (the web UI has its own
 *  richer `formatBytes`, but Activity renders the stored notification body verbatim). */
export function formatBytesShort(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / 1024 ** i;
  return `${value >= 100 || i === 0 ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
}

/** Resolve an actor's display name for deletion attribution (null actor / unknown id ⇒ null). */
export async function resolveActorName(
  db: DbClient | undefined,
  actorId: string | null,
): Promise<string | null> {
  if (actorId === null) return null;
  const [row] = await resolveDb(db)
    .select({ displayName: users.displayName })
    .from(users)
    .where(eq(users.id, actorId))
    .limit(1);
  return row?.displayName ?? null;
}

export interface DeletionAuditInput {
  mediaItemId: string | null;
  title: string;
  sizeBytes: number;
  tmdbId: number | null;
  tvdbId: number | null;
  arrKind: 'radarr' | 'sonarr';
  actorId: string | null;
  actorName: string | null;
  scope: 'item' | 'all' | 'batch';
  // ADR-030 / DESIGN-013 (PLAN-013) — reclaim forward-capture (optional; batch-sweep callers already
  // freeze these on trash_batch_items, so they pass them through here too for the notification payload).
  resolution?: string | null;
  imdbRating?: number | null;
  tmdbRating?: number | null;
}

/**
 * The deletion-audit seam shared by BOTH destructive paths (direct Expedite + the batch expiry sweep).
 * Runs INSIDE the caller's transaction — same-tx as the `trash_expedited` intent event and the delete
 * decision (audit-in-transaction discipline). It writes an Activity notification (source 'trash')
 * carrying the actor + title + size so an app-initiated deletion shows in the Activity tab:
 * Maintainerr does NOT webhook our API-triggered per-item `/collections/media/handle` calls, so
 * without this app-initiated deletions never reach Activity.
 *
 * NOTE it deliberately does NOT tombstone the media_item: `deleted_from_arr_at` means "gone from the
 * *arr" and is SYNC-OWNED (CLAUDE.md rule 4) — a per-item Maintainerr delete can remove the FILE while
 * leaving the *arr entry, so the item is still live for sync (which would immediately un-tombstone any
 * value we wrote). Recently Deleted instead surfaces app-expedited items from the durable append-only
 * `trash_expedited` ledger event (listRecentlyDeleted branch B), which the callers write same-tx.
 */
export async function recordDeletionAudit(
  tx: Transaction,
  input: DeletionAuditInput,
): Promise<void> {
  await tx.insert(notifications).values({
    source: 'trash',
    type: 'deleted',
    title: input.title,
    body:
      (input.actorName !== null ? `Deleted by ${input.actorName}` : 'Deleted') +
      (input.sizeBytes > 0 ? ` · ${formatBytesShort(input.sizeBytes)} freed` : ''),
    tmdbId: input.tmdbId,
    tvdbId: input.tvdbId,
    mediaItemId: input.mediaItemId,
    actorUserId: input.actorId,
    payload: {
      scope: input.scope,
      arrKind: input.arrKind,
      sizeBytes: input.sizeBytes,
      // PLAN-013 reclaim forward-capture — present when the caller froze them (undefined ⇒ omitted).
      resolution: input.resolution ?? null,
      imdbRating: input.imdbRating ?? null,
      tmdbRating: input.tmdbRating ?? null,
    },
  });
}

interface ExpediteSurvivor {
  collectionId: number;
  maintainerrMediaId: string;
  mediaItemId: string | null;
  /** Deletion-audit facets (Recently Deleted + Activity) — carried from the pending row the user saw. */
  title: string;
  sizeBytes: number;
  tmdbId: number | null;
  tvdbId: number | null;
  arrKind: 'radarr' | 'sonarr';
  /** D-19 / D-25ay — the late watchlist re-read's keys: the item's kind and Maintainerr's `mediaData.guid`. */
  media: 'movie' | 'tv';
  plexGuid: string | null;
  // ADR-030 / DESIGN-013 (PLAN-013) — reclaim forward-capture. The direct-expedite path (unlike the
  // batch sweep, which freezes these on trash_batch_items) carried NO size/resolution into any durable
  // record. Freeze them here from the SAME live/pending row already in scope so the reclaim report can
  // fold in a best-effort direct-expedite series (no new table/migration — they ride the jsonb payloads).
  resolution: string | null;
  imdbRating: number | null;
  tmdbRating: number | null;
}

/**
 * Commit the `trash_expedited` intent event for one item + its deletion audit (tombstone + Activity
 * notification, `recordDeletionAudit`) in ONE transaction, THEN trigger its per-item handle. The
 * intent + audit are durable before the (lost-response-prone) destructive call — Fix D-09 discipline.
 *
 * D-19 / D-25ay — first, the owner's Watchlist Changes made since the gate's snapshot are re-read: an item added to
 * the owner's watchlist while Expedite runs is kept (`watchlisted`), its records abandoned, and nothing is written.
 */
async function expediteOneSurvivor(
  input: Pick<ExpediteDeletionInput, 'db' | 'maintainerr' | 'actorId' | 'arr' | 'logger'>,
  scope: 'item' | 'all',
  actorName: string | null,
  survivor: ExpediteSurvivor,
  release: { recordIds: readonly string[]; arrItemId: number | null },
  watchlist: DeleteWatchlistSnapshot,
): Promise<'active' | 'abandoned' | 'in_flight' | 'none' | 'watchlisted' | 'saved'> {
  const logger = input.logger ?? consoleDomainLogger;
  // ADR-099 D-4 — a Save made after the guardian ran (a tap on the wall while this expedite runs) is re-read just
  // before the delete: the app's record keeps the title, exclusion or not.
  if (
    survivor.mediaItemId !== null &&
    ((await hasOpenSaveIntent(input.db, survivor.mediaItemId)) ||
      (await hasRestoreKeep(input.db, survivor.mediaItemId)))
  ) {
    await abandonReleaseRecords({ db: input.db, recordIds: release.recordIds });
    logger.info('[trash] kept', {
      scope,
      maintainerrMediaId: survivor.maintainerrMediaId,
      title: survivor.title,
      reason: 'saved',
    });
    return 'saved';
  }
  if (
    await isOnLateWatchlist({
      db: input.db,
      snapshot: watchlist,
      item: {
        media: survivor.media,
        plexGuid: survivor.plexGuid,
        tmdbId: survivor.tmdbId,
        tvdbId: survivor.tvdbId,
      },
    })
  ) {
    await abandonReleaseRecords({ db: input.db, recordIds: release.recordIds });
    logger.info('[trash] kept', {
      scope,
      maintainerrMediaId: survivor.maintainerrMediaId,
      title: survivor.title,
      reason: 'watchlisted',
    });
    return 'watchlisted';
  }
  await inTransaction(input.db, async (tx) => {
    await tx.insert(ledgerEvents).values({
      mediaItemId: survivor.mediaItemId,
      eventType: 'trash_expedited',
      source: 'maintainerr',
      occurredAt: nowDate(),
      requestedByUserId: input.actorId ?? null,
      payload: {
        scope,
        collectionId: survivor.collectionId,
        maintainerrMediaId: survivor.maintainerrMediaId,
        // PLAN-013 reclaim forward-capture — frozen at expedite time (best-effort reclaim source).
        sizeBytes: survivor.sizeBytes,
        resolution: survivor.resolution,
        imdbRating: survivor.imdbRating,
        tmdbRating: survivor.tmdbRating,
        // ADR-093 C-07 — the Deleted-Release Records this deletion wrote (ADR-084 D-4's audit row).
        releaseRecordIds: [...release.recordIds],
      },
    });
    // Same-tx deletion audit: tombstone so Recently Deleted surfaces it now (with actor), and write
    // the app-sourced Activity notification (Maintainerr never webhooks our per-item handle).
    await recordDeletionAudit(tx, {
      mediaItemId: survivor.mediaItemId,
      title: survivor.title,
      sizeBytes: survivor.sizeBytes,
      tmdbId: survivor.tmdbId,
      tvdbId: survivor.tvdbId,
      arrKind: survivor.arrKind,
      actorId: input.actorId ?? null,
      actorName,
      scope,
      resolution: survivor.resolution,
      imdbRating: survivor.imdbRating,
      tmdbRating: survivor.tmdbRating,
    });
  });
  // The destructive handle, then the settle of the item's records (DESIGN-052 D-14 step 7 / D-25ax), always by the
  // *arr's answer: a 404 makes them active even when the handle's answer was lost; a present item abandons them after
  // a 2xx or a definitive refusal and leaves them in flight after an ambiguous failure. A failed handle is rethrown.
  let handleError: unknown = null;
  try {
    await guardMaintainerrCall('maintainerr POST /collections/media/handle', () =>
      input.maintainerr.write.handleCollectionMedia(
        survivor.collectionId,
        survivor.maintainerrMediaId,
      ),
    );
  } catch (error) {
    handleError = error ?? new Error('handle failed');
  }
  const settled = await settleReleaseRecords({
    db: input.db,
    arr: input.arr.read,
    arrKind: survivor.arrKind,
    arrItemId: release.arrItemId,
    recordIds: release.recordIds,
    handleError,
    title: survivor.title,
    logger,
  });
  // D-21 / D-25az — one line per delete, after its settle.
  logger.info('[trash] expedited', {
    scope,
    maintainerrMediaId: survivor.maintainerrMediaId,
    title: survivor.title,
    handled: handleError === null,
    records: settled,
  });
  if (handleError !== null) throw handleError;
  return settled;
}

/**
 * ADR-093 / DESIGN-052 D-14 — Expedite's identity and Phase A for its survivors, through the seam the sweep shares
 * (`recordAndBlockReleases` in release-block.ts): identity (three consecutive *arr read failures abort with
 * ReleaseIdentityUnavailableError, nothing written, D-25bu), the unrecordable kept, then every recordable survivor recorded `in_flight` and
 * the Release Block written and read back (ReleaseBlockError ⇒ PRECONDITION_FAILED, nothing deleted).
 */
async function recordAndBlockExpediteReleases(
  input: Pick<ExpediteDeletionInput, 'db' | 'arr' | 'logger'>,
  survivors: readonly ExpediteSurvivor[],
): Promise<{
  deletable: Array<{
    survivor: ExpediteSurvivor;
    recordIds: string[];
    arrItemId: number | null;
    /** ADR-117 / D-29 — posted names of this item that got no term because they name no release. */
    skippedNames: number;
  }>;
  unrecorded: ExpediteSurvivor[];
  /** D-29 — of `unrecorded`, kept because a file on disk has no verified posted name. */
  unverified: number;
  /** D-29 — of `unrecorded`, kept because the terms would not fit under the cap. */
  blockFull: number;
}> {
  const blocked = await recordAndBlockReleases({
    db: input.db,
    arr: input.arr,
    survivors: survivors.map((s) => ({
      key: s.maintainerrMediaId,
      mediaItemId: s.mediaItemId as string,
      title: s.title,
    })),
    origin: 'expedite',
    logger: input.logger,
  });
  if (blocked.aborted) throw new ReleaseIdentityUnavailableError();
  const drafts = (s: ExpediteSurvivor): ReleaseRecordDraft[] =>
    blocked.recordable.get(s.maintainerrMediaId) ?? [];
  return {
    deletable: survivors
      .filter((s) => blocked.recordable.has(s.maintainerrMediaId))
      .map((survivor) => ({
        survivor,
        recordIds: blocked.recordIds.get(survivor.maintainerrMediaId) ?? [],
        arrItemId: drafts(survivor)[0]?.arrItemId ?? null,
        skippedNames: blocked.skippedNames.get(survivor.maintainerrMediaId) ?? 0,
      })),
    unrecorded: survivors.filter((s) => !blocked.recordable.has(s.maintainerrMediaId)),
    unverified: [...blocked.unrecorded.values()].filter((r) => r === 'unverified_name').length,
    blockFull: [...blocked.unrecorded.values()].filter((r) => r === 'cap').length,
  };
}

/** D-14 step 8 — after an abandoned record, reconcile so its term leaves the profile (best effort). */
async function reconcileAfterAbandon(
  input: Pick<ExpediteDeletionInput, 'db' | 'arr' | 'logger'>,
  arrKind: 'radarr' | 'sonarr',
): Promise<void> {
  try {
    // ADR-117 / D-29 — a delete path never prunes an older term (`prune: false`).
    await reconcileReleaseBlock({ db: input.db, arr: input.arr, arrKind, logger: input.logger, prune: false });
  } catch {
    // logged by the writer; the next reconcile removes the orphan term
  }
}

export async function expediteDeletion(
  input: ExpediteDeletionInput,
): Promise<ExpediteDeletionResult> {
  // Preflight SAFETY gate — destructive paths refuse on an unsafe install (fail closed).
  const audit = await auditMaintainerr({ maintainerr: input.maintainerr });
  if (!audit.safe) {
    throw new MaintainerrUnsafeError(maintainerrUnsafeMessage('expedite deletions', audit), {
      integrations: audit.integrations as unknown as Record<string, boolean>,
      reachable: audit.reachable,
    });
  }

  // ADR-093 C-04 / DESIGN-052 D-07 — the Registry Gate, purpose `delete`, on the CronJob's newest run (the web pod
  // never refreshes inline). Refused ⇒ WatchlistRegistryUnverifiedError (PRECONDITION_FAILED); nothing is deleted.
  const watchlist = await evaluateRegistryGate({
    db: input.db,
    purpose: 'delete',
    ...(input.now ? { now: input.now } : {}),
    ...(input.logger ? { logger: input.logger } : {}),
  });

  // Resolve the actor's display name ONCE for the deletion-audit attribution (Recently Deleted "By" +
  // the Activity notification body). Read-only; a null/unknown actor stays unattributed.
  const actorName = await resolveActorName(input.db, input.actorId);

  if (input.scope === 'item') {
    const item = input.item;
    if (!item) throw new Error('expediteDeletion scope "item" requires an item target');
    // P3 — resolve the target's REAL identity from the actual pending set; the client `media` param
    // never steers the guardian. Unresolvable ⇒ REFUSE, never fail open.
    const resolved = await resolvePendingTarget({
      db: input.db,
      maintainerr: input.maintainerr,
      maintainerrMediaId: item.maintainerrMediaId,
      collectionId: item.collectionId,
      watchWindowDays: input.watchWindowDays,
      watchlist,
    });
    if (!resolved) {
      throw new MaintainerrUnsafeError(
        `Cannot resolve pending item ${item.maintainerrMediaId} in any Maintainerr collection to ` +
          `run the deletion guardian. Refusing to expedite (fail closed).`,
        { reachable: true },
      );
    }
    const target = resolved.item;
    // target.maintainerrMediaId is guaranteed non-null (we matched on it above).
    const targetMediaId = target.maintainerrMediaId as string;
    // F1 — a LIVE Maintainerr exclusion protects the item even if its dnd tag hasn't synced yet.
    // Checked BEFORE the guardian so a just-saved cold item is never handled (closes the race).
    const liveExcluded = await fetchLiveExclusions(input.maintainerr, [targetMediaId]);
    if (liveExcluded.has(targetMediaId)) {
      return { scope: 'item', protectedCount: 1, expeditedCount: 0, skippedCount: 0, stalePending: 0, expeditedIds: [], unrecordedCount: 0, unverifiedNameCount: 0, blockFullCount: 0, skippedNames: 0 };
    }
    const verdict = classifyGuardian(target);
    if (verdict.keep) {
      // Watched ⇒ auto-whitelist; tag ⇒ already protected; unevaluable ⇒ keep (fail closed). A
      // personal requester tag is not a keep (owner ruling 2026-07-09). The mediarequests tag is
      // (ADR-118): kept, never auto-saved.
      if (verdict.reason === 'recently_watched') {
        await saveExclusion({
          db: input.db,
          maintainerr: input.maintainerr,
          maintainerrMediaId: targetMediaId,
          mediaItemId: target.mediaItemId,
          actorId: input.actorId,
          reason: 'watch_guardian',
        });
        return { scope: 'item', protectedCount: 1, expeditedCount: 0, skippedCount: 0, stalePending: 0, expeditedIds: [], unrecordedCount: 0, unverifiedNameCount: 0, blockFullCount: 0, skippedNames: 0 };
      }
      if (
        verdict.reason === 'saved' ||
        verdict.reason === 'tag' ||
        verdict.reason === 'watchlisted' ||
        verdict.reason === 'recently_added' ||
        verdict.reason === 'media_request' ||
        verdict.reason === 'admin_restored'
      ) {
        // Saved (ADR-099 D-4: the app's record; the keeper owns its exclusion), already whitelisted, on a watchlist
        // (the Watchlist Keep), inside the Age Guard (D-26) or tagged mediarequests (ADR-118): refused like a
        // tagged item, never auto-saved.
        return { scope: 'item', protectedCount: 1, expeditedCount: 0, skippedCount: 0, stalePending: 0, expeditedIds: [], unrecordedCount: 0, unverifiedNameCount: 0, blockFullCount: 0, skippedNames: 0 };
      }
      // unevaluable, or no verified release name on record (ADR-117 / D-29) — not deleted, not force-whitelisted.
      return {
        scope: 'item',
        protectedCount: 0,
        expeditedCount: 0,
        skippedCount: 1,
        stalePending: 0,
        expeditedIds: [],
        unrecordedCount: 0,
        unverifiedNameCount: verdict.reason === 'release_unverified' ? 1 : 0,
        blockFullCount: 0,
        skippedNames: 0,
      };
    }

    // Cold + positively evaluated ⇒ delete this one item (intent-first). Use the RESOLVED
    // collectionId, not the client's (defence in depth against a mismatched request).
    const survivor: ExpediteSurvivor = {
      collectionId: target.collectionId,
      maintainerrMediaId: targetMediaId,
      mediaItemId: target.mediaItemId,
      title: target.title,
      sizeBytes: target.sizeBytes,
      tmdbId: target.tmdbId,
      tvdbId: target.tvdbId,
      arrKind: arrKindForTrashMedia(resolved.media),
      media: resolved.media === 'tv' ? 'tv' : 'movie',
      plexGuid: target.plexGuid,
      resolution: target.resolution,
      imdbRating: target.imdbRating,
      tmdbRating: target.tmdbRating,
    };
    // ADR-093 / DESIGN-052 D-14 — identity, then Phase A (record + Release Block + read-back), then the delete.
    const releases = await recordAndBlockExpediteReleases(input, [survivor]);
    const one = releases.deletable[0];
    if (!one) {
      // No recordable release (D-11), no verified name for a file on disk, or no room under the cap (D-29): kept,
      // never deleted.
      return {
        scope: 'item',
        protectedCount: 0,
        expeditedCount: 0,
        skippedCount: 1,
        stalePending: 0,
        expeditedIds: [],
        unrecordedCount: 1,
        unverifiedNameCount: releases.unverified,
        blockFullCount: releases.blockFull,
        skippedNames: 0,
      };
    }
    let settled: Awaited<ReturnType<typeof expediteOneSurvivor>>;
    try {
      settled = await expediteOneSurvivor(input, 'item', actorName, survivor, one, watchlist);
    } catch (error) {
      await reconcileAfterAbandon(input, survivor.arrKind);
      throw error;
    }
    if (settled === 'abandoned' || settled === 'watchlisted' || settled === 'saved') {
      await reconcileAfterAbandon(input, survivor.arrKind);
    }
    if (settled === 'watchlisted' || settled === 'saved') {
      // Added to the owner's watchlist after the gate's snapshot (D-25ay), or saved meanwhile (ADR-099): kept.
      return { scope: 'item', protectedCount: 1, expeditedCount: 0, skippedCount: 0, stalePending: 0, expeditedIds: [], unrecordedCount: 0, unverifiedNameCount: 0, blockFullCount: 0, skippedNames: 0 };
    }
    return {
      scope: 'item',
      protectedCount: 0,
      expeditedCount: 1,
      skippedCount: 0,
      stalePending: 0,
      expeditedIds: [targetMediaId],
      unrecordedCount: 0,
      unverifiedNameCount: 0,
      blockFullCount: 0,
      skippedNames: one.skippedNames,
    };
  }

  // scope 'all' — per-item loop over the REQUESTED kind's pending set (never /collections/handle).
  const pending = await listTrashPending({
    db: input.db,
    maintainerr: input.maintainerr,
    media: input.media,
    watchWindowDays: input.watchWindowDays,
    watchlist,
  });

  // F2 — pin to the snapshot the user SAW. Only actionable pending items are eligible; when a
  // snapshot is supplied the eligible set is narrowed to its intersection with the current pending
  // set. Snapshot ids no longer pending are counted `stalePending`; items that became pending after
  // the snapshot are absent from `targets` and thus NEVER touched. Unpinned (snapshot === null) is
  // the legacy whole-set behaviour: every actionable pending item is a target; unactionable (no
  // Maintainerr id) items are counted skipped exactly as before.
  const snapshot = input.snapshotMediaIds === undefined ? null : new Set(input.snapshotMediaIds);
  const actionable = pending.items.filter(
    (p): p is TrashPendingItem & { maintainerrMediaId: string } => p.maintainerrMediaId !== null,
  );
  let stalePending = 0;
  if (snapshot !== null) {
    const pendingIds = new Set(actionable.map((p) => p.maintainerrMediaId));
    for (const id of snapshot) if (!pendingIds.has(id)) stalePending += 1;
  }
  const targets =
    snapshot === null
      ? actionable
      : actionable.filter((p) => snapshot.has(p.maintainerrMediaId));

  // F1 — live-exclusion safety seam: fetch which targets are currently excluded (whitelisted) ONCE,
  // before the guardian loop, and treat any live exclusion as PROTECTED (never handled).
  const excludedIds = await fetchLiveExclusions(
    input.maintainerr,
    targets.map((p) => p.maintainerrMediaId),
  );

  const arrKind = arrKindForTrashMedia(input.media);
  // PASS 1 — guardian: whitelist watched, skip anything we can't positively clear. A personal requester
  // tag is not a keep (owner ruling 2026-07-09). A mediarequests tag is (ADR-118): kept, never auto-saved.
  const survivors: ExpediteSurvivor[] = [];
  let protectedCount = 0;
  // Legacy (unpinned) parity: unactionable items still count as skipped. When pinned they are simply
  // not targets (never in the snapshot) and are left untouched, uncounted.
  let skippedCount =
    snapshot === null ? pending.items.filter((p) => p.maintainerrMediaId === null).length : 0;
  // ADR-117 / D-29 — of the skipped, the items the guardian kept for want of a verified release name.
  let unverifiedNameCount = 0;
  for (const p of targets) {
    const mediaId = p.maintainerrMediaId;
    // F1 — a LIVE exclusion protects the item even before its dnd tag round-trips.
    if (excludedIds.has(mediaId)) {
      protectedCount += 1;
      continue;
    }
    const verdict = classifyGuardian(p);
    if (verdict.keep) {
      if (verdict.reason === 'recently_watched') {
        // A FAILED protection must never be followed by that item's deletion (P5): skip it.
        try {
          await saveExclusion({
            db: input.db,
            maintainerr: input.maintainerr,
            maintainerrMediaId: mediaId,
            mediaItemId: p.mediaItemId,
            actorId: input.actorId,
            reason: 'watch_guardian',
          });
          protectedCount += 1;
        } catch (err) {
          if (err instanceof MaintainerrUpstreamError) {
            skippedCount += 1;
            continue;
          }
          throw err;
        }
      } else if (verdict.reason === 'saved') {
        protectedCount += 1; // ADR-099 D-4 — saved: the app's record keeps it, exclusion or not.
      } else if (verdict.reason === 'tag') {
        protectedCount += 1; // already whitelisted by the dnd tag.
      } else if (verdict.reason === 'watchlisted') {
        protectedCount += 1; // the Watchlist Keep — kept, never auto-saved (a watchlist is not a Save).
      } else if (verdict.reason === 'recently_added') {
        protectedCount += 1; // the Age Guard (D-26) — kept, never auto-saved (it lapses when the title ages out).
      } else if (verdict.reason === 'admin_restored') {
        protectedCount += 1; // ADR-121: deliberate admin Restore, kept until admin removal.
      } else if (verdict.reason === 'media_request') {
        protectedCount += 1; // the Request Keep (ADR-118) — kept while the tag is on the title, never auto-saved.
      } else {
        skippedCount += 1; // unevaluable, or no verified release name on record (D-29) — fail closed.
        if (verdict.reason === 'release_unverified') unverifiedNameCount += 1;
      }
      continue;
    }
    survivors.push({
      collectionId: p.collectionId,
      maintainerrMediaId: mediaId,
      mediaItemId: p.mediaItemId,
      title: p.title,
      sizeBytes: p.sizeBytes,
      tmdbId: p.tmdbId,
      tvdbId: p.tvdbId,
      arrKind,
      media: input.media === 'tv' ? 'tv' : 'movie',
      plexGuid: p.plexGuid,
      resolution: p.resolution,
      imdbRating: p.imdbRating,
      tmdbRating: p.tmdbRating,
    });
  }

  // ADR-093 / DESIGN-052 D-14 — identity, then Phase A for every survivor, before any delete. An item whose release
  // cannot be recorded is kept (skipped): no term, no delete.
  const releases = await recordAndBlockExpediteReleases(input, survivors);
  skippedCount += releases.unrecorded.length;

  // PASS 2 — delete each survivor individually (intent-first, then per-item handle, then the settle).
  let expeditedCount = 0;
  const expeditedIds: string[] = [];
  let anyAbandoned = false;
  let skippedNames = 0;
  for (const [index, { survivor, recordIds, arrItemId, skippedNames: skipped }] of releases.deletable.entries()) {
    try {
      const settled = await expediteOneSurvivor(
        input,
        'all',
        actorName,
        survivor,
        { recordIds, arrItemId },
        watchlist,
      );
      if (settled === 'abandoned') anyAbandoned = true;
      if (settled === 'watchlisted' || settled === 'saved') {
        // Added to the owner's watchlist after the gate's snapshot (D-25ay), or saved meanwhile (ADR-099): kept.
        anyAbandoned = true;
        protectedCount += 1;
        continue;
      }
    } catch (error) {
      // The handle failed (the run stops, as before): the survivors not reached keep blocking nothing.
      const rest = releases.deletable.slice(index + 1).flatMap((d) => d.recordIds);
      await abandonReleaseRecords({ db: input.db, recordIds: rest });
      await reconcileAfterAbandon(input, arrKind);
      throw error;
    }
    expeditedCount += 1;
    skippedNames += skipped;
    expeditedIds.push(survivor.maintainerrMediaId);
  }
  if (anyAbandoned) await reconcileAfterAbandon(input, arrKind);

  return {
    scope: 'all',
    protectedCount,
    expeditedCount,
    skippedCount,
    stalePending,
    expeditedIds,
    unrecordedCount: releases.unrecorded.length,
    unverifiedNameCount: unverifiedNameCount + releases.unverified,
    blockFullCount: releases.blockFull,
    skippedNames,
  };
}

/**
 * ADR-121 / DESIGN-052 D-32 — Admin's single-title Restore. Searches stay off; present
 * titles are skipped. The run intent records a local keep before an add. A successful
 * result records trash_restored in the same transaction as the result/tombstone clear.
 * The Release Block is read and verified without changing any term. Music is rejected.
 */
export async function restoreDeleted(input: {
  db?: DbClient;
  arr: Parameters<typeof executeRestore>[0]['arr'];
  arrKind: ArrKind;
  mediaItemId: string;
  actorId: string | null;
}): Promise<ExecuteArrAddResult> {
  if (input.arrKind === 'lidarr') {
    throw new TrashMusicUnsupportedError('Music (Lidarr) has no Trash restore surface (R-87).');
  }
  const result = await executeRestore({
    db: input.db,
    arr: input.arr,
    arrKind: input.arrKind,
    initiatedBy: input.actorId,
    mediaItemIds: [input.mediaItemId],
    trashRestore: true,
  });
  return result;
}

// ---------------------------------------------------------------------------
// Rule-group writes (D5 — gated behind edit_rules + section edit)
// ---------------------------------------------------------------------------

/**
 * Live-repro fix (2026-07-06, plan-006 live validation) — reconcile the Maintainerr GET/PUT rule
 * shapes. `GET /api/rules` returns each rule group's `rules[]` as the DB ENTITY shape (`RuleDbDto`:
 * `{ id, ruleJson: <stringified RuleDto>, section, ruleGroupId, isActive }`) — the actual filter is
 * an ENCODED `ruleJson` string. But `PUT /api/rules` (`updateRules`) validates each rule as a DECODED
 * `RuleDto` (it reads `firstVal`/`action`/`lastVal`/`customVal`); it does NOT decode `ruleJson`.
 * Maintainerr's own web UI decodes `ruleJson` → `RuleDto` before saving; our Rules tab round-trips
 * the GET object verbatim (`{ ...rule, isActive }`). So any rule group with a NON-EMPTY `rules[]`
 * fails `validateRule` upstream (`firstVal` is undefined) → Maintainerr answers `{ code:0, result:
 * 'First value is not available for this server' }` at HTTP 200/201 → the write client's P1a
 * ReturnStatus hardening throws MaintainerrWriteFailedError → BAD_GATEWAY. (An EMPTY `rules[]` skips
 * the loop, which is why the old stub/e2e — a rule with `rules: []` — never caught it.)
 *
 * We normalize here (the confined write seam, not the UI) so the payload we PUT matches the DTO
 * `updateRules` expects: each `rules[]` item that still carries a string `ruleJson` is replaced by
 * `JSON.parse(ruleJson)` (backfilling `section` from the column when the encoded rule lacks it).
 * Items already in decoded `RuleDto` shape (no `ruleJson`) and non-array/absent `rules` pass through
 * untouched — the transform is idempotent and shape-agnostic.
 */
function decodeRuleGroupRules(payload: Record<string, unknown>): Record<string, unknown> {
  const rules = payload.rules;
  if (!Array.isArray(rules)) return payload;
  const decoded = rules.map((rule) => {
    if (
      rule === null ||
      typeof rule !== 'object' ||
      typeof (rule as { ruleJson?: unknown }).ruleJson !== 'string'
    ) {
      return rule;
    }
    const entity = rule as { ruleJson: string; section?: unknown };
    let parsed: unknown;
    try {
      parsed = JSON.parse(entity.ruleJson);
    } catch {
      return rule; // leave undecodable rules as-is — Maintainerr surfaces the error as before.
    }
    if (parsed === null || typeof parsed !== 'object') return rule;
    const out = parsed as Record<string, unknown>;
    // `section` is a column on the entity; older ruleJson may not embed it — backfill from the row.
    if (out.section === undefined && entity.section !== undefined) out.section = entity.section;
    return out;
  });
  return { ...payload, rules: decoded };
}

/**
 * Live re-verification (2026-07-07, plan-006 staging) — backfill the GROUP-LEVEL server selection.
 * `GET /api/rules` nests the *arr server ids under the collection (`collection.radarrSettingsId` /
 * `collection.sonarrSettingsId` — they are columns on the COLLECTION entity, not the rule group), but
 * `PUT /api/rules` (`updateRules`) reads them at the GROUP level to run `validateRuleServerSelection`:
 * any rule whose `firstVal[0]`/`lastVal[0]` is Radarr (Application.RADARR=1) or Sonarr (=2) with NO
 * group-level `radarrSettingsId`/`sonarrSettingsId` is rejected `{code:0,"Radarr rules require a
 * Radarr server to be selected"}` → our write client fails closed (P1a) → 502. Round-tripping the GET
 * verbatim therefore drops the ids and re-arms fail. We copy them up from the nested collection when
 * the group level is absent.
 *
 * SAFETY (verified against v3.17.0 rules.service.ts `updateRules`): the server ids do NOT participate
 * in the crucial-change wipe. That comparison is EXACTLY `group.dataType !== params.dataType ||
 * manualCollection changed || manualCollectionName changed || params.libraryId !== dbCollection.libraryId`
 * — a mismatch wipes the collection's media + specific exclusions AND deletes the Plex collection.
 * `dataType` (contracts `MediaItemType`) is a STRING union ('movie'|'show'|'season'|'episode') stored
 * as varchar, and `libraryId` is a varchar string — so a pure isActive toggle must carry BOTH back
 * VERBATIM as the GET returned them (we never coerce dataType to a number or libraryId to a number).
 * This backfill only ever ADDS the two server ids and never touches dataType/libraryId, so it can
 * never turn a toggle into a crucial change.
 */
function backfillGroupServerSelection(payload: Record<string, unknown>): Record<string, unknown> {
  const collection = payload.collection;
  if (collection === null || typeof collection !== 'object') return payload;
  const nested = collection as Record<string, unknown>;
  let out = payload;
  for (const key of ['radarrSettingsId', 'sonarrSettingsId'] as const) {
    const current = payload[key];
    if ((current === undefined || current === null) && typeof nested[key] === 'number') {
      if (out === payload) out = { ...payload };
      out[key] = nested[key];
    }
  }
  return out;
}

/**
 * ADR-023 / DESIGN-010 — create/update a Maintainerr rule group. Maintainerr owns the rule engine
 * and validation; we pass the RulesDto payload through the confined write client. `POST` when no id
 * (create), `PUT` when an id is present (update). Only reachable via the edit_rules-gated router.
 * Two GET→PUT reconciliations run FIRST, both required for a round-tripped rule group to survive
 * `updateRules`: (1) decodeRuleGroupRules turns each `rules[]` entity's encoded `ruleJson` back into
 * the decoded RuleDto `updateRules` validates against; (2) backfillGroupServerSelection lifts the
 * server ids from the nested collection to the group level `validateRuleServerSelection` reads. Neither
 * touches `dataType`/`libraryId`, which round-trip verbatim so a pure isActive toggle is never seen as
 * a crucial-setting change (which would WIPE the collection — see backfillGroupServerSelection).
 */
export async function upsertTrashRule(input: {
  maintainerr: MaintainerrClientBundle;
  payload: Record<string, unknown>;
  /** D-21 seam for `[trash] rule_save_drift`. */
  logger?: DomainLogger;
}): Promise<void> {
  const decoded = withDescribedRules(
    backfillGroupServerSelection(decodeRuleGroupRules(input.payload)),
  );
  const hasId = typeof decoded.id === 'number';
  if (!hasId) {
    await guardMaintainerrCall('maintainerr POST /rules', () =>
      input.maintainerr.write.createRuleGroup(decoded),
    );
    return;
  }
  // ADR-093 C-10 / DESIGN-052 D-16 — the update reads the LIVE group first and lifts every top-level-only flag the
  // payload omits from it, so an Arm/Disarm (isActive) toggle never resets listExclusions / forceSeerr / arrAction.
  const ruleGroupId = decoded.id as number;
  const live = await readLiveRuleGroup(input.maintainerr, ruleGroupId);
  const payload = buildRuleGroupUpdate(decoded, live);
  await guardMaintainerrCall('maintainerr PUT /rules', () => input.maintainerr.write.updateRuleGroup(payload));
  // …and verifies them after: a mismatch is an error the admin sees (and the audit's invariant catches the state).
  const after = await readLiveRuleGroup(input.maintainerr, ruleGroupId);
  const drift = ruleGroupDrift(payload, after);
  if (drift.length > 0) {
    (input.logger ?? consoleDomainLogger).error('[trash] rule_save_drift', { ruleGroupId, fields: drift });
    throw new MaintainerrRuleDriftError(ruleGroupId, drift);
  }
}

/**
 * DESIGN-052 D-16 — the fields Maintainerr 3.29.0's `updateRules` reads ONLY at the top level of the PUT body
 * (`rules.service.ts`: `arrAction`, `listExclusions`, `cleanupLeftoverFolders`, `forceSeerr`,
 * `tautulliWatchedPercentOverride`, the three `*SettingsId`, the three `*QualityProfileId`, `tagInArr`,
 * `keepInMaintainerrOnly`), while `GET /api/rules` returns them nested under `collection`. An omitted one is reset
 * (`params.listExclusions ? … : false`, `params.arrAction ? … : 0`, `?? null`).
 */
export const RULE_GROUP_TOP_LEVEL_FIELDS = [
  'arrAction',
  'listExclusions',
  'forceSeerr',
  'tagInArr',
  'keepInMaintainerrOnly',
  'cleanupLeftoverFolders',
  'tautulliWatchedPercentOverride',
  'radarrSettingsId',
  'sonarrSettingsId',
  'sportarrSettingsId',
  'radarrQualityProfileId',
  'sonarrQualityProfileId',
  'sportarrQualityProfileId',
] as const;

async function readLiveRuleGroup(
  maintainerr: MaintainerrClientBundle,
  ruleGroupId: number,
): Promise<Record<string, unknown>> {
  const groups = await guardMaintainerrCall('maintainerr GET /rules', () => maintainerr.read.getRules());
  const live = groups.find((g) => g.id === ruleGroupId);
  if (!live) {
    throw new MaintainerrUpstreamError(`Maintainerr has no rule group ${ruleGroupId} to update.`);
  }
  return live as Record<string, unknown>;
}

/**
 * DESIGN-052 D-16 — the PUT body for an update: each top-level-only flag from the payload's top level when present,
 * else from the live group's `collection`; `useRules` from the live group when missing. `useRules: false` with rules
 * present is refused (Maintainerr would delete every rule row). `dataType`, `libraryId` and the manual-collection
 * fields still round-trip verbatim from the payload (a change there wipes membership). Pure; exported for tests.
 */
export function buildRuleGroupUpdate(
  payload: Record<string, unknown>,
  live: Record<string, unknown>,
): Record<string, unknown> {
  const liveCollection =
    live.collection !== null && typeof live.collection === 'object'
      ? (live.collection as Record<string, unknown>)
      : {};
  const out: Record<string, unknown> = { ...payload };
  for (const key of RULE_GROUP_TOP_LEVEL_FIELDS) {
    if (out[key] === undefined && liveCollection[key] !== undefined) out[key] = liveCollection[key];
  }
  if (out.useRules === undefined && typeof live.useRules === 'boolean') out.useRules = live.useRules;
  const rules = Array.isArray(out.rules) ? out.rules : [];
  if (out.useRules === false && rules.length > 0) {
    throw new MaintainerrUpstreamError(
      'Refusing to save a rule group with rules but useRules off: Maintainerr would delete every rule.',
    );
  }
  // ADR-118 C-06 — a group that carries clauses gets a description taken from those clauses. The
  // person's notes stay after the marker ` | Notes: `. A description with no marker is all notes,
  // dashes included. An empty list (Leaving Soon) keeps the caller's text.
  return withDescribedRules(out);
}

/**
 * The only boundary between the generated sentence and the person's notes: space, vertical bar,
 * space, the word Notes, colon, space. Ordinary writing does not contain this string. The first
 * occurrence is the boundary. A description with none of it is all notes.
 */
const RULE_DESCRIPTION_NOTES_SEPARATOR = ' | Notes: ';

/**
 * Set a rule group's description from its clauses.
 * A description with no marker is kept whole, character for character, after the new sentence and
 * the marker, once. A later save replaces only the sentence before the marker and leaves the notes
 * after it unchanged. A further marker inside those notes stays in the notes. An empty description
 * is the generated sentence alone, with no marker. No rules means the payload is unchanged.
 */
function withDescribedRules(payload: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(payload.rules) || payload.rules.length === 0) return payload;
  const generated = describeTrashRules(payload.rules);
  if (typeof payload.description !== 'string' || payload.description.trim() === '') {
    return { ...payload, description: generated };
  }
  const caller = payload.description;
  if (caller.trim() === generated) return { ...payload, description: generated };
  const separator = RULE_DESCRIPTION_NOTES_SEPARATOR;
  const splitAt = caller.indexOf(separator);
  if (splitAt === -1) return { ...payload, description: `${generated}${separator}${caller}` };
  const notes = caller.slice(splitAt + separator.length);
  if (notes.trim() === '') return { ...payload, description: generated };
  return { ...payload, description: `${generated}${separator}${notes}` };
}

/**
 * DESIGN-052 D-16 — after the PUT: the flags Maintainerr stores as intended? Compares `arrAction`, `listExclusions`,
 * `forceSeerr`, `tagInArr`, the Radarr / Sonarr server ids and `collection.deleteAfterDays` (the safety-relevant set;
 * `cleanupLeftoverFolders` and `keepInMaintainerrOnly` depend on the collection type and are not compared). Returns
 * the drifted field names. Pure; exported for tests.
 */
export function ruleGroupDrift(
  sent: Record<string, unknown>,
  after: Record<string, unknown>,
): string[] {
  const got =
    after.collection !== null && typeof after.collection === 'object'
      ? (after.collection as Record<string, unknown>)
      : {};
  const sentCollection =
    sent.collection !== null && typeof sent.collection === 'object'
      ? (sent.collection as Record<string, unknown>)
      : {};
  const episode = sent.dataType === 'episode' || got.type === 'episode';
  const intended: Record<string, unknown> = {
    arrAction: typeof sent.arrAction === 'number' && sent.arrAction !== 0 ? sent.arrAction : 0,
    listExclusions: sent.listExclusions === true,
    forceSeerr: !episode && sent.forceSeerr === true,
    tagInArr: sent.tagInArr === true,
    radarrSettingsId: sent.radarrSettingsId ?? null,
    sonarrSettingsId: sent.sonarrSettingsId ?? null,
  };
  const drift: string[] = [];
  for (const [key, want] of Object.entries(intended)) {
    const have =
      typeof want === 'boolean' ? got[key] === true : key === 'arrAction' ? (got[key] ?? 0) : (got[key] ?? null);
    if (have !== want) drift.push(key);
  }
  const wantDays = sentCollection.deleteAfterDays;
  if (wantDays !== undefined && wantDays !== null && Number(got.deleteAfterDays) !== Number(wantDays)) {
    drift.push('deleteAfterDays');
  }
  return drift;
}

/** ADR-023 / DESIGN-010 — delete a Maintainerr rule group (edit_rules-gated). */
export async function deleteTrashRule(input: {
  maintainerr: MaintainerrClientBundle;
  ruleGroupId: number;
}): Promise<void> {
  await guardMaintainerrCall('maintainerr DELETE /rules/:id', () =>
    input.maintainerr.write.deleteRuleGroup(input.ruleGroupId),
  );
}
