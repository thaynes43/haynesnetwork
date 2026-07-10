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
// messages (postMessage/editMessage/moderateMessage are the sole writers — the Bulletin board).
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
const FORBIDDEN_PATTERNS: Array<{ name: string; regex: RegExp }> = [
  {
    name: 'UPDATE users SET role_id (SQL)',
    regex: /UPDATE\s+users\s+SET\s+role_id\b/i,
  },
  {
    name: 'INSERT INTO guarded/audit table (SQL)',
    regex:
      /INSERT\s+INTO\s+(user_role_transitions|permission_audit|roles|role_app_grants|role_section_permissions|role_trash_action_grants|role_message_action_grants|notifications|notification_outbox|smart_drive_state|poster_guard_applications|ai_usage_chats|messages|app_settings|trash_batches|trash_batch_items|trash_batch_saves|trash_candidates|trash_candidates_state|app_catalog|media_items|media_metadata|ledger_events|fix_requests|restore_runs|sync_runs|sync_state|plex_servers|plex_libraries|role_library_grants|role_plex_server_all_grants|plex_share_audit)\b/i,
  },
  {
    name: 'UPDATE guarded table (SQL)',
    regex:
      /UPDATE\s+(roles|role_section_permissions|role_trash_action_grants|role_message_action_grants|notifications|notification_outbox|smart_drive_state|ai_usage_chats|messages|app_settings|trash_batches|trash_batch_items|trash_batch_saves|trash_candidates|trash_candidates_state|app_catalog|media_items|media_metadata|ledger_events|fix_requests|restore_runs|sync_runs|sync_state|plex_servers|plex_libraries|role_library_grants|role_plex_server_all_grants)\s+SET\b/i,
  },
  {
    name: 'DELETE FROM guarded table (SQL)',
    regex:
      /DELETE\s+FROM\s+(role_app_grants|role_section_permissions|role_trash_action_grants|role_message_action_grants|notifications|notification_outbox|smart_drive_state|ai_usage_chats|messages|app_settings|trash_batches|trash_batch_items|trash_batch_saves|trash_candidates|trash_candidates_state|roles|app_catalog|media_items|media_metadata|ledger_events|fix_requests|restore_runs|sync_runs|sync_state|plex_servers|plex_libraries|role_library_grants|role_plex_server_all_grants|plex_share_audit)\b/i,
  },
  {
    name: '.insert() into guarded/audit table (Drizzle)',
    regex:
      /\.insert\(\s*(?:[A-Za-z_$][\w$]*\.)?(userRoleTransitions|permissionAudit|roleAppGrants|roleSectionPermissions|roleTrashActionGrants|roleMessageActionGrants|notifications|notificationOutbox|smartDriveState|posterGuardApplications|aiUsageChats|messages|appSettings|trashBatches|trashBatchItems|trashBatchSaves|trashCandidates|trashCandidatesState|roles|appCatalog|mediaItems|mediaMetadata|ledgerEvents|fixRequests|restoreRuns|syncRuns|syncState|plexServers|plexLibraries|roleLibraryGrants|rolePlexServerAllGrants|plexShareAudit)\s*\)/,
  },
  {
    name: '.update() on guarded table (Drizzle)',
    regex:
      /\.update\(\s*(?:[A-Za-z_$][\w$]*\.)?(users|roles|roleSectionPermissions|roleTrashActionGrants|roleMessageActionGrants|notifications|notificationOutbox|smartDriveState|aiUsageChats|messages|appSettings|trashBatches|trashBatchItems|trashBatchSaves|trashCandidates|trashCandidatesState|appCatalog|mediaItems|mediaMetadata|ledgerEvents|fixRequests|restoreRuns|syncRuns|syncState|plexServers|plexLibraries|roleLibraryGrants|rolePlexServerAllGrants)\s*\)/,
  },
  {
    name: '.delete() on guarded table (Drizzle)',
    regex:
      /\.delete\(\s*(?:[A-Za-z_$][\w$]*\.)?(roleAppGrants|roleSectionPermissions|roleTrashActionGrants|roleMessageActionGrants|notifications|notificationOutbox|smartDriveState|aiUsageChats|messages|appSettings|trashBatches|trashBatchItems|trashBatchSaves|trashCandidates|trashCandidatesState|roles|appCatalog|mediaItems|mediaMetadata|ledgerEvents|fixRequests|restoreRuns|syncRuns|syncState|roleLibraryGrants|rolePlexServerAllGrants|plexLibraries|plexServers)\s*\)/,
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
