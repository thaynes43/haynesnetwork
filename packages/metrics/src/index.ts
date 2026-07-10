// @hnet/metrics — the read-only Prometheus client + Prometheus-derived Overview read models for the
// Metrics section (ADR-037 / DESIGN-016, PLAN-017). No write surface ⇒ no import-confinement.
export * from './client';
export * from './overview';
export * from './apps';
export * from './network';
// ADR-040 / DESIGN-020 (PLAN-019) — the Hardware sub-tab read model + the SMART-alert readings.
export * from './hardware';
// DESIGN-016 D-07 — the admin-only Grafana deep-link URLs (single source of truth; attached to a
// payload only for admin callers, so a non-admin response never carries a Grafana URL).
export * from './grafana';
