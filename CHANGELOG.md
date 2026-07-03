# Changelog

## [0.2.0](https://github.com/thaynes43/haynesnetwork/compare/v0.1.1...v0.2.0) (2026-07-03)


### Features

* **arr:** typed Sonarr/Radarr/Lidarr/Seerr clients with fixture tests ([#15](https://github.com/thaynes43/haynesnetwork/issues/15)) ([b68fb7a](https://github.com/thaynes43/haynesnetwork/commit/b68fb7a526fd161acb0583d68ec72d2fc870bd6f))
* **db:** media ledger schema, fix lifecycle, sync bookkeeping (DESIGN-005) ([#16](https://github.com/thaynes43/haynesnetwork/issues/16)) ([6dfa4d5](https://github.com/thaynes43/haynesnetwork/commit/6dfa4d5419c05116520c30fb88c4712dd0ad3dbe))
* **sync:** *arr→ledger sync runner with cursors, tombstone guard, Seerr attribution ([#20](https://github.com/thaynes43/haynesnetwork/issues/20)) ([dce9bb9](https://github.com/thaynes43/haynesnetwork/commit/dce9bb980f45ec95f850f307a4ebdc735cc68883))
* **web:** haynesnetwork visual identity — mark, type, shape language ([#19](https://github.com/thaynes43/haynesnetwork/issues/19)) ([9da21a8](https://github.com/thaynes43/haynesnetwork/commit/9da21a8681add6827869b6dd85f44c75e43339ea))
* **web:** media ledger browsing, fix flow with reasons, admin restore ([#21](https://github.com/thaynes43/haynesnetwork/issues/21)) ([5388eab](https://github.com/thaynes43/haynesnetwork/commit/5388eabd5582aa0913210f471f2fa0a7d04fb209))


### Documentation

* **ops:** record grant_types pitfall in Authentik provisioning runbook ([#18](https://github.com/thaynes43/haynesnetwork/issues/18)) ([f11cda6](https://github.com/thaynes43/haynesnetwork/commit/f11cda693de1386412b682baa0c3ab581c9b35e2))

## [0.1.1](https://github.com/thaynes43/haynesnetwork/compare/v0.1.0...v0.1.1) (2026-07-03)


### Bug Fixes

* **auth:** per-client rate limiting, callback error surfacing, sign-in error taxonomy ([#13](https://github.com/thaynes43/haynesnetwork/issues/13)) ([49de172](https://github.com/thaynes43/haynesnetwork/commit/49de172894a73c051d70950f8768b2d60bc493f1))


### Documentation

* **design:** DESIGN-005 — *arr ledger, fix, and restore ([#11](https://github.com/thaynes43/haynesnetwork/issues/11)) ([e0b0a62](https://github.com/thaynes43/haynesnetwork/commit/e0b0a6291ff0d6fe09e0f0890ebaab89f5f3817c))

## 0.1.0 (2026-07-03)


### Features

* **api:** tRPC surface with role-gated procedures ([#3](https://github.com/thaynes43/haynesnetwork/issues/3)) ([816550e](https://github.com/thaynes43/haynesnetwork/commit/816550ebb5cfd2536840594a2de573f774868a24))
* **auth:** Better Auth with Authentik OIDC and admin bootstrap ([#2](https://github.com/thaynes43/haynesnetwork/issues/2)) ([88595ed](https://github.com/thaynes43/haynesnetwork/commit/88595edd4a5a253823801a17aed461fd5e5474ba))
* **build:** production Dockerfile with migrator subtree + CI image validation ([#4](https://github.com/thaynes43/haynesnetwork/issues/4)) ([95a0d2d](https://github.com/thaynes43/haynesnetwork/commit/95a0d2de8d0f1dfd273b1af00cad1c3c2648fbf6))
* ported theme system (@hnet/ui) and database layer (@hnet/db, domain, test-utils) ([6daa023](https://github.com/thaynes43/haynesnetwork/commit/6daa02351f8d5d107f5e464adae60275bea7a216))
* scaffold pnpm monorepo — Next.js 16 app + @hnet/* package skeletons ([c653c98](https://github.com/thaynes43/haynesnetwork/commit/c653c9887619fcbc1502b21f3d0c331b3cfb01ac))
* **web:** dev:local test environment, health endpoint, harness reuse ([#7](https://github.com/thaynes43/haynesnetwork/issues/7)) ([7b0daa2](https://github.com/thaynes43/haynesnetwork/commit/7b0daa24692ffa815e4fcec96f85b97503dbb98a))
* **web:** Phase 1 UI — login, dashboard tiles, admin area ([#5](https://github.com/thaynes43/haynesnetwork/issues/5)) ([4bdc3f1](https://github.com/thaynes43/haynesnetwork/commit/4bdc3f1fdd2ac0a7abec1c33e032dc1cf066683e))


### Documentation

* ADR-001..010, DDD glossary + bounded contexts, DESIGN-001..004 ([5836f40](https://github.com/thaynes43/haynesnetwork/commit/5836f4042bd69d2283075a0c6bd0d1147701f93b))
* bootstrap documentation-first skeleton ([55a68ba](https://github.com/thaynes43/haynesnetwork/commit/55a68bae126fb0c01da4410c64e1e5d00df14bf1))
* GATE A cutover plan — last direct push to main ([ee771ea](https://github.com/thaynes43/haynesnetwork/commit/ee771eadb007943a44329e5351196130fdcb6a2c))
* **ops:** add admin@haynesnetwork.com to bootstrap admin allowlist ([#8](https://github.com/thaynes43/haynesnetwork/issues/8)) ([0107004](https://github.com/thaynes43/haynesnetwork/commit/0107004c70fd79751e6d2df959cba1cca30da6d4))
* **ops:** Authentik OIDC provisioning runbook (executed) ([5dccb7d](https://github.com/thaynes43/haynesnetwork/commit/5dccb7d92120884d19ee32da54752e07567de1c2))
* **ops:** HOps/HNet library naming convention; HAYNESOPS renames verified live ([#10](https://github.com/thaynes43/haynesnetwork/issues/10)) ([0705655](https://github.com/thaynes43/haynesnetwork/commit/07056555d8805b2e716a3b77a94291025000859f))
* **ops:** Plex/Tautulli topology of record (OPS-002) ([#9](https://github.com/thaynes43/haynesnetwork/issues/9)) ([a9ead67](https://github.com/thaynes43/haynesnetwork/commit/a9ead67388e6556cee91d524ea04c7b787a07f55))
* PRD-001 haynesnetwork requirements ([fad7a4b](https://github.com/thaynes43/haynesnetwork/commit/fad7a4bc9e6e9a4738c3c7dff694de657d2f3bd3))
