# Changelog

## [0.8.1](https://github.com/thaynes43/haynesnetwork/compare/v0.8.0...v0.8.1) (2026-07-06)


### Bug Fixes

* derive real per-item resolution in metadata harvest; hide zero/absent rating badges ([#58](https://github.com/thaynes43/haynesnetwork/issues/58)) ([a207374](https://github.com/thaynes43/haynesnetwork/commit/a2073743c7613e5853f822538b1cfc518107e687))

## [0.8.0](https://github.com/thaynes43/haynesnetwork/compare/v0.7.0...v0.8.0) (2026-07-06)


### Features

* library metadata enrichment, poster proxy, shared filter engine (ADR-018/019) ([#57](https://github.com/thaynes43/haynesnetwork/issues/57)) ([6932e53](https://github.com/thaynes43/haynesnetwork/commit/6932e53a87361a0e09a5eb5a8f6d4a4c6141c018))


### Documentation

* complete plan 007 (cosign signing) — v0.7.0 signed + Kyverno Enforce live-validated ([#55](https://github.com/thaynes43/haynesnetwork/issues/55)) ([3caf031](https://github.com/thaynes43/haynesnetwork/commit/3caf03114912a3d96c6d0dad54ef0e8c2fd35781))

## [0.7.0](https://github.com/thaynes43/haynesnetwork/compare/v0.6.1...v0.7.0) (2026-07-06)


### Features

* cosign keyless image signing on release (ADR-020) ([#53](https://github.com/thaynes43/haynesnetwork/issues/53)) ([25e0ca4](https://github.com/thaynes43/haynesnetwork/commit/25e0ca44627e8d80e7b0131bd061d0e47df919a9))

## [0.6.1](https://github.com/thaynes43/haynesnetwork/compare/v0.6.0...v0.6.1) (2026-07-06)


### Bug Fixes

* plex registry refresh — haynestower reachability + per-server degradation ([#51](https://github.com/thaynes43/haynesnetwork/issues/51)) ([592d767](https://github.com/thaynes43/haynesnetwork/commit/592d767007e8803810a9c91508fd9a7f3c975653))

## [0.6.0](https://github.com/thaynes43/haynesnetwork/compare/v0.5.0...v0.6.0) (2026-07-06)


### Features

* Plex library self-service per role (ADR-017) ([#50](https://github.com/thaynes43/haynesnetwork/issues/50)) ([52f0321](https://github.com/thaynes43/haynesnetwork/commit/52f03219d11d3be5b3479b79f6bb19b7e4259a57))


### Documentation

* complete plan 002 (Bazarr subtitle Fix) — v0.5.0 live-validated ([#48](https://github.com/thaynes43/haynesnetwork/issues/48)) ([7ab49d7](https://github.com/thaynes43/haynesnetwork/commit/7ab49d7809fa6ab126c8144866f31e52df6ad812))

## [0.5.0](https://github.com/thaynes43/haynesnetwork/compare/v0.4.0...v0.5.0) (2026-07-06)


### Features

* route missing-subtitles Fix to Bazarr; drop the reason for Music (ADR-016) ([#47](https://github.com/thaynes43/haynesnetwork/issues/47)) ([4f96aef](https://github.com/thaynes43/haynesnetwork/commit/4f96aef261d38b70126552fc470434bdf5537cb2))


### Documentation

* Fable 5 plan queue + KICKOFF for the overnight autonomous build ([#38](https://github.com/thaynes43/haynesnetwork/issues/38)) ([4e4961a](https://github.com/thaynes43/haynesnetwork/commit/4e4961a0cf6527e7cb149c665c7d09696f6ded3a))
* fix stale deploy flow + completed *arr migration (game-day audit) ([#44](https://github.com/thaynes43/haynesnetwork/issues/44)) ([a79c312](https://github.com/thaynes43/haynesnetwork/commit/a79c31280ab94d14b8759da015457f59ca123545))
* note the catalog keyboard-reorder e2e flake (KICKOFF + backlog T-8) ([#45](https://github.com/thaynes43/haynesnetwork/issues/45)) ([28cbc76](https://github.com/thaynes43/haynesnetwork/commit/28cbc76f4d1be3dd7bf0be77ae6a398b64ec33a7))
* **plan-003:** pin Plex owner-token location (verified against 1Password) ([#46](https://github.com/thaynes43/haynesnetwork/issues/46)) ([258c20f](https://github.com/thaynes43/haynesnetwork/commit/258c20fcfc5b7e3b276b3aea65985740ef9bed98))
* **plans:** *arr tag semantics (requester / collection) for filters + Trash rules ([#43](https://github.com/thaynes43/haynesnetwork/issues/43)) ([1bbc7cd](https://github.com/thaynes43/haynesnetwork/commit/1bbc7cdfaf010e5a2297398b8024445883774b48))
* **plans:** add 009 Bulletin + 010 MOTD (stretch); 004 TMDB/TVDB fallback ([#42](https://github.com/thaynes43/haynesnetwork/issues/42)) ([3a7cfc8](https://github.com/thaynes43/haynesnetwork/commit/3a7cfc8dcc8d23a231216df5936e2b7b2380d004))
* **plans:** cross-server Tautulli watch-history protection (Trash + metadata) ([#40](https://github.com/thaynes43/haynesnetwork/issues/40)) ([951a91a](https://github.com/thaynes43/haynesnetwork/commit/951a91aeb2eeccbbbd3ae627c3dba522496749fb))
* **plans:** Maintainerr exclusion-tag + notification-webhook design ([#41](https://github.com/thaynes43/haynesnetwork/issues/41)) ([bb5cc3f](https://github.com/thaynes43/haynesnetwork/commit/bb5cc3fdf50a45dc8fb9083e17d2d16992d9167b))

## [0.4.0](https://github.com/thaynes43/haynesnetwork/compare/v0.3.1...v0.4.0) (2026-07-05)


### Features

* unified roles, arbitrary catalog URLs, inline confirm + drag-drop reorder, library sub-tabs ([#36](https://github.com/thaynes43/haynesnetwork/issues/36)) ([5cc7493](https://github.com/thaynes43/haynesnetwork/commit/5cc749338e65d2027690966db8a27340c28fa9f2))


### Bug Fixes

* **web:** admin catalog — edit-in-place rows + add-entry modal ([#35](https://github.com/thaynes43/haynesnetwork/issues/35)) ([40b43ee](https://github.com/thaynes43/haynesnetwork/commit/40b43ee49a84cf0d11fdc405f72460c7e38d65cb))


### Documentation

* retroactive documentation build-out + drift reconciliation ([#33](https://github.com/thaynes43/haynesnetwork/issues/33)) ([70105e9](https://github.com/thaynes43/haynesnetwork/commit/70105e97f661fa7ebafb492dca7c3c4358d6043f))

## [0.3.1](https://github.com/thaynes43/haynesnetwork/compare/v0.3.0...v0.3.1) (2026-07-04)


### Bug Fixes

* **web:** uniform fix/force-search availability; action-free library tiles ([#31](https://github.com/thaynes43/haynesnetwork/issues/31)) ([eeab374](https://github.com/thaynes43/haynesnetwork/commit/eeab37465cbfe04aa1e5f0f8746a690f93057074))

## [0.3.0](https://github.com/thaynes43/haynesnetwork/compare/v0.2.2...v0.3.0) (2026-07-04)


### Features

* **web:** season grouping with roll-up force-search and scoped fixes ([#30](https://github.com/thaynes43/haynesnetwork/issues/30)) ([fb7eba0](https://github.com/thaynes43/haynesnetwork/commit/fb7eba047ac21828d18837a82e692880e8159ac7))


### Bug Fixes

* **arr:** integer eventType filter for paged history; stable fix-dialog layout ([#28](https://github.com/thaynes43/haynesnetwork/issues/28)) ([17f6cc8](https://github.com/thaynes43/haynesnetwork/commit/17f6cc8c28748cbc370ebda16acc9bbb6f43f58f))

## [0.2.2](https://github.com/thaynes43/haynesnetwork/compare/v0.2.1...v0.2.2) (2026-07-04)


### Bug Fixes

* **web:** accent-insensitive library search; raster favicons ([#25](https://github.com/thaynes43/haynesnetwork/issues/25)) ([795f3bb](https://github.com/thaynes43/haynesnetwork/commit/795f3bb63321e4e5696ad211e4b15e9aeb568300))
* **web:** episode-level fixes, force-search for missing content, Other-reason focus bug ([#27](https://github.com/thaynes43/haynesnetwork/issues/27)) ([cba02d1](https://github.com/thaynes43/haynesnetwork/commit/cba02d1e6d5319ab08dac1bbebdbef55d270ea63))

## [0.2.1](https://github.com/thaynes43/haynesnetwork/compare/v0.2.0...v0.2.1) (2026-07-04)


### Bug Fixes

* **arr:** tolerate absent Lidarr artist statistics (never-refreshed artists) ([#23](https://github.com/thaynes43/haynesnetwork/issues/23)) ([f7936de](https://github.com/thaynes43/haynesnetwork/commit/f7936de8d42ce8519121e960c6a7206d39d960e4))

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
