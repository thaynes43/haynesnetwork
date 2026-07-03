// TODO(ADR-010): embedded Postgres 16 lifecycle wrapper (start/migrate/teardown, no Docker)
// lands here — the Testcontainers-free replacement for the donor's test-utils
// (docs/adrs/010-test-strategy.md).
export const TEST_UTILS_PACKAGE = '@hnet/test-utils';
