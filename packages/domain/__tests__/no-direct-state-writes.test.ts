import { readFile, readdir, stat } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * ADR-003 / ADR-010 — the single-writer CI guard (donor: todos-for-dues
 * packages/domain/__tests__/no-direct-state-writes.test.ts): role/permission tables may
 * only be written by the @hnet/domain helpers, which co-write their audit rows in the
 * same transaction (CLAUDE.md hard rule 6). This scan fails the build if any code
 * outside packages/domain/ (packages/api, apps/web, scripts, … as they appear) touches
 * the guarded tables directly — raw SQL or Drizzle call forms.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const ALLOWED_DIR_PREFIX = `packages${sep}domain${sep}`;

/**
 * Schema/constraint tests that exercise DB-level invariants directly (CHECK
 * constraints, seed semantics). They validate the schema, not the domain helpers.
 * New code should not add to this list — route through @hnet/domain instead.
 */
const ALLOWED_FILES = new Set<string>([
  'packages/db/__tests__/migrations.test.ts',
  'packages/db/__tests__/media-ledger.test.ts',
]);

// DESIGN-001 D-12 / ADR-012 guarded tables: users.role_id, roles, role_app_grants,
// app_catalog + the audit tables (user_role_transitions, permission_audit). DESIGN-005
// D-12 extends the watched list with the Phase 2 media-ledger tables: media_items,
// ledger_events, fix_requests, restore_runs, sync_runs, sync_state. ADR-017 / DESIGN-007
// D-01 adds the Phase 3 Plex tables: plex_servers, plex_libraries, role_library_grants,
// plex_share_audit (registry refresh + role grants + share ledger all go through
// packages/domain single-writers). ADR-018 / DESIGN-008 D-01 adds media_metadata (the
// metadata harvest writes only through upsertMediaMetadataBatch — same single-writer class
// as media_items itself; synced descriptive data, no per-row audit event required). ADR-021 /
// DESIGN-009 adds role_section_permissions (setSectionPermission co-writes permission_audit in-tx).
// ADR-024 adds role_plex_server_all_grants (setRoleLibraries co-writes update_role_libraries in-tx).
// ADR-023 / DESIGN-010 adds role_trash_action_grants (setRoleTrashActions co-writes permission_audit
// in-tx) and notifications (recordNotification is the sole writer — the webhook receiver's sink).
// ADR-025 / DESIGN-011 adds app_settings (setAppSetting co-writes permission_audit in-tx) and the
// three batch tables (trash_batches, trash_batch_items, trash_batch_saves — the trash-batches
// single-writers own every state write + same-tx transition/save event). ADR-026 / DESIGN-012
// adds role_message_action_grants (setRoleMessageActions co-writes permission_audit in-tx) and
// tickets / ticket_events / ticket_replies (ADR-050 — createTicket/transitionTicket/addTicketReply are
// the sole writers; ticket_events is append-only and the ticket_created outbox row rides the same tx).
// ADR-034 / DESIGN-015 adds notification_outbox (enqueueOutbox is the sole enqueuer — same-tx with the
// batch transition; deliverOutbox the sole updater — both @hnet/domain, the notify-outbox sync mode).
// ADR-035 adds trash_candidates + trash_candidates_state (the candidate READ-MODEL —
// refreshTrashCandidates/removeTrashCandidateRows in trash-candidates.ts are the sole writers;
// derived, rebuildable state, so those writers are the documented no-audit-row exemption).
// ADR-040 / DESIGN-020 (PLAN-019) adds smart_drive_state (the per-drive last-known SMART state the
// smart-alerts sync mode diffs against — evaluateSmartAlerts in smart-alerts.ts is the sole writer;
// it enqueues the notification_outbox transition row in the same tx, so the outbox row IS its audit
// trail — a documented no-ledger-row exemption like trash_candidates_state).
// ADR-043 / DESIGN-021 (PLAN-024) adds poster_guard_applications (the APPEND-ONLY Peloton poster apply
// ledger the poster-guard sync mode writes — runPelotonPosterGuard in poster-guard.ts is the sole writer;
// it inserts the drift-baseline+audit row in the same tx it records each re-apply). Append-only, so only
// the INSERT / .insert forms are guarded (rows are never updated or deleted).
// ADR-044 / DESIGN-022 (PLAN-021) adds ai_usage_chats (the synced Open WebUI chat-usage MIRROR the
// ai-usage-sync mode upserts — syncAiUsage in ai-usage.ts is the sole writer; it upserts one row per OWUI
// chat in a single transaction). A rebuildable read-model like trash_candidates/smart_drive_state — the
// data of record lives in Open WebUI, so the writer appends no ledger/audit row (documented exemption).
// Upserted (insert + on-conflict update), so the INSERT / UPDATE / .insert / .update forms are all guarded.
// ADR-045 / DESIGN-023 (PLAN-026) adds three tables: authentik_users (the Authentik-directory MIRROR the
// authentik-users sync + on-demand refresh + post-write re-read upsert — upsertAuthentikUsers in
// authentik-users.ts is the sole writer; a rebuildable read-model, documented no-audit exemption; guarded
// INSERT/UPDATE); pending_role_assignments (the parked role intent for an Authentik-only identity — the
// assignRolePortal orchestrator inserts+supersedes it with a same-tx permission_audit 'assign_pending_role'
// row, consumePendingRoleOnSignin marks it consumed via assignRole in one tx; guarded INSERT/UPDATE/DELETE);
// authentik_group_audit (the APPEND-ONLY external group-write ledger the portal writes AFTER each Authentik/
// OWUI apply, the plex_share_audit class; guarded INSERT only). NOTE consumePendingRoleOnSignin lives in
// packages/auth, not packages/domain — it is allow-listed below so the login-time consumer can stamp the
// pending row.
// ADR-046 / DESIGN-024 (PLAN-023) adds books_items (the synced Kavita + Audiobookshelf MIRROR the
// books-sync mode upserts — syncBooks in books.ts is the sole writer; it upserts the fresh snapshot AND
// tombstones vanished rows in one transaction). A rebuildable read-model like ai_usage_chats — the data
// of record lives in Kavita/ABS, so the writer appends no ledger/audit row (documented exemption).
// Upserted + tombstoned, so the INSERT / UPDATE / .insert / .update forms are guarded (never hard-deleted).
// ADR-047 / DESIGN-025 (PLAN-028) adds media_plex_matches (the *arr→Plex match cache the plex-match sync
// mode writes — syncPlexMatches in plex-match.ts is the sole writer; it upserts the resolved matches and
// HARD-DELETES the ones a fully-read library no longer serves, in one transaction). A rebuildable derived
// cache like trash_candidates — the *arrs + Plex are the sources of truth, so no ledger/audit row
// (documented exemption). Upserted + reconciled, so the INSERT / UPDATE / DELETE (+ Drizzle) forms are all
// guarded.
// ADR-064 / DESIGN-035 (PLAN-037) adds plex_collections + plex_collection_members (the mirrored Plex
// collections the collections-sync mode writes — syncPlexCollections in plex-collections.ts is the sole
// writer; it upserts the fresh collection/member snapshot and HARD-DELETES stale rows scoped to
// fully-read sections/collections, in one transaction). A rebuildable derived cache like
// media_plex_matches — external software (Plex/Kometa) is ALWAYS the collections source of truth
// (owner doctrine R1), so no ledger/audit row (documented exemption). Upserted + reconciled, so the
// INSERT / UPDATE / DELETE (+ Drizzle) forms are all guarded.
// ADR-054 / DESIGN-027 (PLAN-039) adds mam_gate_state (the MAM governor's single-row gate state the
// mam-governor sync mode upserts — evaluateMamGovernor in mam-governor.ts is the sole writer; on a gate
// transition / >48h zero-headroom it enqueues the notification_outbox row in the same tx, so the outbox row
// IS its audit trail — a documented no-ledger-row exemption like smart_drive_state). Upserted (insert +
// on-conflict update), so the INSERT / UPDATE / .insert / .update forms are guarded.
// ADR-049 / DESIGN-012 amend (PLAN-027) adds role_bulletin_view_grants (a role's Bulletin sub-view
// visibility grants — setRoleBulletinViews in bulletin-view-permissions.ts is the sole writer; it
// replace-sets the rows + co-writes a permission_audit 'update_bulletin_views' row in the SAME tx, exactly
// like setRoleMessageActions). Replace-set (delete-all + insert, never UPDATE), so the INSERT / DELETE
// (+ Drizzle .insert/.delete) forms are guarded; the raw-SQL seed lives in migrations (exempt dir).
// ADR-052/053 / DESIGN-026 (PLAN-029 — Library views + per-user state) adds four per-user tables, all
// UPSERTED (insert + on-conflict update), so the INSERT / UPDATE / .insert / .update forms are guarded
// (never DELETE — cascade FKs clean up on user/item delete). None writes an audit row — descriptive UI
// state / rebuildable synced read-models (the ADR-052 C-04 / media_metadata class, documented exemption):
//   • library_preferences   — the per-user, per-wall view/sort store (setLibraryPreference is the sole writer).
//   • notification_preferences — the per-user notification opt-ins (setNotificationPreference is the sole writer; ADR-060).
//   • book_fix_requests / role_books_action_grants — the books Fix aggregate + its grants (createBookFixRequest / setRoleBookActions — ADR-062).
//   • user_account_map       — the app-user↔account mapping (upsertUserAccountHandles / ensurePlexUserIdMapping).
//   • user_media_watch       — the per-user video watch read-model (upsertUserMediaWatchBatch).
//   • user_book_progress     — the per-user ABS book read-state (upsertUserBookProgressBatch).
// ADR-055 / DESIGN-028 (PLAN-044 — Goodreads requests MVP) adds three tables, all guarded to
// packages/domain single-writers: user_integrations (link/unlink audited — linkIntegration/
// unlinkIntegration co-write a permission_audit link_integration/unlink_integration row in the SAME tx;
// markIntegrationSynced is the unaudited sync-marker writer — guarded INSERT/UPDATE); integration_shelf_items
// (the synced shelf-RSS MIRROR — upsertShelfItems is the sole writer; a rebuildable read-model like
// books_items, documented no-audit exemption; upsert+tombstone ⇒ guarded INSERT/UPDATE); book_requests (the
// request/Missing LEDGER — syncShelfRequests/markRequestPushed/applyRequestReconcile mint+reconcile
// unaudited, recordManualSearch co-writes a permission_audit request_book_search row same-tx; upsert+update
// ⇒ guarded INSERT/UPDATE, never hard-deleted — the shelf-item cascade FK cleans up).
// ADR-066 / DESIGN-038 (PLAN-051) adds books_collections + books_collection_members (the mirrored book
// collections the books-collections-sync mode writes — syncBooksCollections in books-collections.ts is
// the sole writer; it upserts the fresh collection/member snapshot (resolving member refs against live
// books_items rows) and HARD-DELETES stale rows scoped to fully-read (source, kind) families /
// fully-read collections, in one transaction). A rebuildable derived cache like plex_collections —
// external software (Kavita/ABS) is ALWAYS the collections source of truth (owner doctrine R1 applied
// to books), so no ledger/audit row (documented exemption). Upserted + reconciled, so the INSERT /
// UPDATE / DELETE (+ Drizzle) forms are all guarded.
// ADR-065 / DESIGN-036 (PLAN-050 — book ⇄ audiobook pairing) adds books_format_pairs (the FORMAT PAIR
// derived cache the format-pairing sync mode rebuilds — syncFormatPairs in format-pairing.ts is the sole
// writer; it inserts fresh pairs, advances survivors, and DELETES pairs whose either side tombstoned, in
// one transaction). A rebuildable derived cache like media_plex_matches — the book servers are the sources
// of truth, so no ledger/audit row (documented exemption). Upserted + reconciled, so the INSERT / UPDATE /
// DELETE (+ Drizzle .insert/.update/.delete) forms are all guarded. The same change widens book_requests
// (origin='pairing' system wants) — already guarded above; mintPairingWants joins its writer set.
// ADR-067 / DESIGN-039 (PLAN-055 — GB quota resilience) adds gb_quota_state (the Google Books quota
// circuit breaker's single-row state — tripGbQuotaBreaker / clearGbQuotaBreaker / consultGbQuotaGate's
// probe claim in gb-quota-breaker.ts are the sole writers; consulted by every GB call site through the
// guardedGbResolve seam). Derived, rebuildable operational state like mam_gate_state — but with NO
// outbox row either (quota exhaustion is routine daily weather, ADR-067 C-09; the trail is the row +
// the one-line logs + the queued-fix actions_taken steps — a documented no-ledger-row exemption).
// Upserted + cleared; guarded in ALL SIX families (SQL INSERT/UPDATE/DELETE + Drizzle forms).
// ADR-072 / DESIGN-043 (PLAN-052 PR4a — direct-add) guards role_collection_action_grants (a role's
// fine-grained collection action grants — setRoleCollectionActions in collection-permissions.ts is the
// sole writer; it replace-sets the rows + co-writes a permission_audit 'update_collection_actions' row in
// the SAME tx, exactly like setRoleBookActions — delete-all + insert, never UPDATE, so INSERT/DELETE
// (+ Drizzle .insert/.delete) are guarded). The retired collection_suggestions table was DROPPED (migration
// 0069) and is no longer guarded. The over-cap definition rides tickets.collection_override_payload — the
// already-guarded `tickets` single-writer (createCollectionOverrideTicket) owns that write.
// DESIGN-038 D-13 (2026-07-18 — books/audiobooks collection Wanted tiles) mints origin='collection'
// book_requests from Libretto's missing set (syncCollectionWants in book-requests.ts is the sole writer,
// the syncPlexCollections wanted-row analog) and — new for book_requests — RECONCILE-DELETES the wants no
// longer missing (scoped to origin='collection' so goodreads/pairing wants are never touched). A
// rebuildable derived cache of Libretto's current missing set: no audit row (documented exemption). The
// INSERT/UPDATE guard already confines the mint to packages/domain; book_requests is intentionally NOT in
// the DELETE guard families (test cleanups delete it directly, and the reconcile lives in packages/domain,
// exempt from every pattern) — the established "book_requests is deleted only by the shelf-item cascade"
// stance, now widened to include the domain reconcile.
const FORBIDDEN_PATTERNS: Array<{ name: string; regex: RegExp }> = [
  {
    name: 'UPDATE users SET role_id (SQL)',
    regex: /UPDATE\s+users\s+SET\s+role_id\b/i,
  },
  {
    name: 'INSERT INTO guarded/audit table (SQL)',
    regex:
      /INSERT\s+INTO\s+(user_role_transitions|permission_audit|roles|role_app_grants|role_section_permissions|role_trash_action_grants|role_message_action_grants|role_bulletin_view_grants|notifications|notification_outbox|smart_drive_state|mam_gate_state|library_preferences|notification_preferences|book_fix_requests|role_books_action_grants|user_account_map|user_media_watch|user_book_progress|poster_guard_applications|ai_usage_chats|authentik_users|pending_role_assignments|authentik_group_audit|books_items|media_plex_matches|plex_collections|plex_collection_members|books_collections|books_collection_members|gb_quota_state|books_format_pairs|tickets|ticket_events|ticket_replies|app_settings|trash_batches|trash_batch_items|trash_batch_saves|trash_candidates|trash_candidates_state|app_catalog|media_items|media_metadata|ledger_events|fix_requests|restore_runs|sync_runs|sync_state|plex_servers|plex_libraries|role_library_grants|role_plex_server_all_grants|plex_share_audit|user_integrations|integration_shelf_items|book_requests|role_collection_action_grants)\b/i,
  },
  {
    name: 'UPDATE guarded table (SQL)',
    regex:
      /UPDATE\s+(roles|role_section_permissions|role_trash_action_grants|role_message_action_grants|notifications|notification_outbox|smart_drive_state|mam_gate_state|library_preferences|user_account_map|user_media_watch|user_book_progress|ai_usage_chats|authentik_users|pending_role_assignments|books_items|media_plex_matches|plex_collections|plex_collection_members|books_collections|books_collection_members|gb_quota_state|books_format_pairs|tickets|ticket_events|ticket_replies|app_settings|trash_batches|trash_batch_items|trash_batch_saves|trash_candidates|trash_candidates_state|app_catalog|media_items|media_metadata|ledger_events|fix_requests|restore_runs|sync_runs|sync_state|plex_servers|plex_libraries|role_library_grants|role_plex_server_all_grants|user_integrations|integration_shelf_items|book_requests)\s+SET\b/i,
  },
  {
    name: 'DELETE FROM guarded table (SQL)',
    regex:
      /DELETE\s+FROM\s+(role_app_grants|role_section_permissions|role_trash_action_grants|role_message_action_grants|role_bulletin_view_grants|notifications|notification_outbox|smart_drive_state|ai_usage_chats|pending_role_assignments|tickets|ticket_events|ticket_replies|app_settings|trash_batches|trash_batch_items|trash_batch_saves|trash_candidates|trash_candidates_state|roles|app_catalog|media_items|media_metadata|media_plex_matches|plex_collections|plex_collection_members|books_collections|books_collection_members|gb_quota_state|books_format_pairs|ledger_events|fix_requests|restore_runs|sync_runs|sync_state|plex_servers|plex_libraries|role_library_grants|role_plex_server_all_grants|role_collection_action_grants|plex_share_audit)\b/i,
  },
  {
    name: '.insert() into guarded/audit table (Drizzle)',
    regex:
      /\.insert\(\s*(?:[A-Za-z_$][\w$]*\.)?(userRoleTransitions|permissionAudit|roleAppGrants|roleSectionPermissions|roleTrashActionGrants|roleMessageActionGrants|roleBulletinViewGrants|notifications|notificationOutbox|smartDriveState|mamGateState|libraryPreferences|userAccountMap|userMediaWatch|userBookProgress|posterGuardApplications|aiUsageChats|authentikUsers|pendingRoleAssignments|authentikGroupAudit|booksItems|mediaPlexMatches|plexCollections|plexCollectionMembers|booksCollections|booksCollectionMembers|gbQuotaState|booksFormatPairs|tickets|ticketEvents|ticketReplies|appSettings|trashBatches|trashBatchItems|trashBatchSaves|trashCandidates|trashCandidatesState|roles|appCatalog|mediaItems|mediaMetadata|ledgerEvents|fixRequests|restoreRuns|syncRuns|syncState|plexServers|plexLibraries|roleLibraryGrants|rolePlexServerAllGrants|plexShareAudit|userIntegrations|integrationShelfItems|bookRequests|roleCollectionActionGrants)\s*\)/,
  },
  {
    name: '.update() on guarded table (Drizzle)',
    regex:
      /\.update\(\s*(?:[A-Za-z_$][\w$]*\.)?(users|roles|roleSectionPermissions|roleTrashActionGrants|roleMessageActionGrants|notifications|notificationOutbox|smartDriveState|mamGateState|libraryPreferences|userAccountMap|userMediaWatch|userBookProgress|aiUsageChats|authentikUsers|pendingRoleAssignments|booksItems|mediaPlexMatches|plexCollections|plexCollectionMembers|booksCollections|booksCollectionMembers|gbQuotaState|booksFormatPairs|tickets|ticketEvents|ticketReplies|appSettings|trashBatches|trashBatchItems|trashBatchSaves|trashCandidates|trashCandidatesState|appCatalog|mediaItems|mediaMetadata|ledgerEvents|fixRequests|restoreRuns|syncRuns|syncState|plexServers|plexLibraries|roleLibraryGrants|rolePlexServerAllGrants|userIntegrations|integrationShelfItems|bookRequests)\s*\)/,
  },
  {
    name: '.delete() on guarded table (Drizzle)',
    regex:
      /\.delete\(\s*(?:[A-Za-z_$][\w$]*\.)?(roleAppGrants|roleSectionPermissions|roleTrashActionGrants|roleMessageActionGrants|roleBulletinViewGrants|notifications|notificationOutbox|smartDriveState|aiUsageChats|pendingRoleAssignments|tickets|ticketEvents|ticketReplies|appSettings|trashBatches|trashBatchItems|trashBatchSaves|trashCandidates|trashCandidatesState|roles|appCatalog|mediaItems|mediaMetadata|mediaPlexMatches|plexCollections|plexCollectionMembers|booksCollections|booksCollectionMembers|gbQuotaState|booksFormatPairs|ledgerEvents|fixRequests|restoreRuns|syncRuns|syncState|roleLibraryGrants|rolePlexServerAllGrants|roleCollectionActionGrants|plexLibraries|plexServers)\s*\)/,
  },
];

const IGNORE_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  'out',
  '.next',
  '.git',
  '.turbo',
  'coverage',
  'migrations', // raw SQL migrations in packages/db/migrations are the schema source of truth
  'docs',
  '.agents',
  '.claude', // agent worktrees/settings — may hold a full repo copy during parallel work
  'playwright-report',
  'test-results',
  'blob-report',
  '.pg-embedded',
]);

const SCANNED_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);

async function walk(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (IGNORE_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walk(full)));
    } else if (entry.isFile()) {
      const ext = entry.name.slice(entry.name.lastIndexOf('.'));
      if (SCANNED_EXTENSIONS.has(ext)) {
        files.push(full);
      }
    }
  }
  return files;
}

describe('static analysis — single-writer invariant for role/permission tables', () => {
  it('no direct guarded-table writes outside packages/domain/', async () => {
    // Sanity: REPO_ROOT must look like the repo root.
    const stats = await stat(join(REPO_ROOT, 'pnpm-workspace.yaml'));
    expect(stats.isFile()).toBe(true);

    const files = await walk(REPO_ROOT);
    const violations: Array<{ file: string; pattern: string; line: number }> = [];

    for (const absPath of files) {
      const relPath = relative(REPO_ROOT, absPath);
      if (relPath.startsWith(ALLOWED_DIR_PREFIX)) continue;
      const relWithSlashes = relPath.split(sep).join('/');
      if (ALLOWED_FILES.has(relWithSlashes)) continue;

      const content = await readFile(absPath, 'utf8');
      const lines = content.split('\n');
      for (const { name, regex } of FORBIDDEN_PATTERNS) {
        for (let i = 0; i < lines.length; i++) {
          if (regex.test(lines[i]!)) {
            violations.push({ file: relWithSlashes, pattern: name, line: i + 1 });
          }
        }
      }
    }

    if (violations.length > 0) {
      const detail = violations.map((v) => `  ${v.file}:${v.line}  →  ${v.pattern}`).join('\n');
      throw new Error(
        `Found ${violations.length} direct role/permission table write(s) outside packages/domain/.\n` +
          `These mutations must go through @hnet/domain (createRole/updateRole/deleteRole, ` +
          `assignRole, createApp/updateApp/deleteApp/reorderCatalog) so the audit row commits ` +
          `in the same transaction.\n` +
          detail,
      );
    }
  });
});
