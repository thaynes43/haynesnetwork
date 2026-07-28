// ADR-081 C-01 + C-04 — the app-boot tasks, run once per server process from the instrumentation hook:
//   1. The from-scratch Default all-grant SEED (C-01): on a fresh deploy (zero users) the Default role is
//      granted all-libraries on every registered server, so "Default sees everything" survives a rebuild
//      with no configuration. A clean no-op on the live estate (C-02 — no widening, no re-assert).
//   2. The COLD-START first plex-match TRIGGER (C-04): when media_plex_matches is empty, one plex-match sync
//      runs in-process, advisory-locked (replica-safe) and non-blocking, closing the window before which
//      non-admins would see an empty Library even with grants. The recurring CronJob stays the steady owner.
//
// Both are PRODUCTION-ONLY (the deployed app) and fully ISOLATED — a failure is logged and swallowed so
// serving and /api/health are never blocked. dev:local, the e2e harness (next dev), and unit tests never run
// these (they exercise the domain/sync helpers directly).
import { db, getPool } from '@hnet/db';
import { seedDefaultServerAllGrantsIfBootstrap } from '@hnet/domain';

export async function runBootTasks(): Promise<void> {
  if (process.env.NODE_ENV !== 'production') return;
  if (!process.env.DATABASE_URL) return;
  await seedDefaultGrants();
  await triggerColdStartPlexMatch();
}

/** ADR-081 C-01 — seed the Default all-grants on a fresh bootstrap (idempotent; no-op on a populated DB). */
async function seedDefaultGrants(): Promise<void> {
  try {
    const result = await seedDefaultServerAllGrantsIfBootstrap({ db });
    if (result.seeded) {
      console.info(
        `[boot] bootstrap seed — Default granted all-libraries on ${result.granted}/${result.servers} server(s) (ADR-081 C-01)`,
      );
    }
  } catch (error) {
    console.error('[boot] bootstrap seed failed (isolated — boot continues)', error);
  }
}

/** ADR-081 C-04 — trigger the first plex-match sync when the match table is empty (advisory-locked). */
async function triggerColdStartPlexMatch(): Promise<void> {
  try {
    const { maybeRunFirstPlexMatch, fetchPlexMatchSnapshot } = await import('@hnet/sync');
    const { plexClientBundleFromEnv, syncPlexMatches } = await import('@hnet/domain');
    const result = await maybeRunFirstPlexMatch({
      pool: getPool(),
      db,
      // Built lazily: only when the table is empty AND this replica won the lock — so a steady-state boot
      // never constructs a Plex client, and a missing PLEX_*_TOKEN degrades (caught) instead of crashing.
      run: async () => {
        const plex = plexClientBundleFromEnv();
        const snapshot = await fetchPlexMatchSnapshot({ db, plex });
        await syncPlexMatches({
          db,
          matches: snapshot.matches,
          scopedLibraryIds: snapshot.scopedLibraryIds,
        });
      },
    });
    if (result.ran) {
      console.info('[boot] cold-start plex-match — first sync complete (ADR-081 C-04)');
    }
  } catch (error) {
    console.error('[boot] cold-start plex-match failed (isolated — boot continues)', error);
  }
}
