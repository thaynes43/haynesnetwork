// @hnet/haynesops — the confined haynes-ops GitOps write client (ADR-072 / DESIGN-042, PLAN-052 PR4b). This
// barrel is the "safe everywhere" surface: typed errors + env config. It does NOT export the clients — read
// via `@hnet/haynesops/read`, write (import-confined to packages/domain) via `@hnet/haynesops/write`.
// Mirrors the @hnet/libretto barrel discipline.
export * from './errors';
export * from './config';
export type { RepoFile, OpenManagedPr, ChecksConclusion, HaynesopsClientOptions } from './read';
export type { OpenedPr, CommitFilePrInput } from './write';
