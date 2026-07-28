// ADR-081 — the Next.js instrumentation boot hook. `register()` runs ONCE per server process (per replica)
// at startup. It fires the app-boot tasks (the from-scratch Default all-grant seed + the cold-start
// plex-match trigger) WITHOUT blocking startup: the tasks self-gate to production, self-isolate on failure,
// and the trigger's sync is advisory-locked so 3 replicas never race (ADR-081 C-01/C-04).
export async function register(): Promise<void> {
  // Node.js runtime only — never the edge/client bundle (the boot tasks need pg + the sync stack).
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { runBootTasks } = await import('./lib/boot');
  // Fire-and-forget: register() must not block serving or /api/health (ADR-081 C-04). Errors are handled
  // and swallowed inside runBootTasks; the catch here is a final belt so a stray rejection is never unhandled.
  void runBootTasks().catch((error: unknown) => {
    console.error('[instrumentation] boot tasks failed (isolated)', error);
  });
}
