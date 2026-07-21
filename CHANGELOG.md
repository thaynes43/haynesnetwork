# Changelog

## [0.88.6](https://github.com/thaynes43/haynesnetwork/compare/v0.88.5...v0.88.6) (2026-07-21)


### Bug Fixes

* widen Libretto builder.ref to its real shape (mixed id/slug arrays, numeric ids) ([#462](https://github.com/thaynes43/haynesnetwork/issues/462)) ([9d871cc](https://github.com/thaynes43/haynesnetwork/commit/9d871cce556bb6c748db1595a939089d07332d71))

## [0.88.5](https://github.com/thaynes43/haynesnetwork/compare/v0.88.4...v0.88.5) (2026-07-21)


### Bug Fixes

* accept array builder.ref from Libretto comics recipes (unblocks MAM injector) ([#461](https://github.com/thaynes43/haynesnetwork/issues/461)) ([fa2e75d](https://github.com/thaynes43/haynesnetwork/commit/fa2e75da0720ab2e8d0df27044cead67601ab68d))


### Documentation

* ADR-074 + DESIGN-045 ACCEPTED — all forks ratified; Q-03 overridden (music first-class from M2) ([#458](https://github.com/thaynes43/haynesnetwork/issues/458)) ([71e8e2a](https://github.com/thaynes43/haynesnetwork/commit/71e8e2a7a0278d515e9ec6a6eec7a9b49ce57f79))
* ADR-075 + ADR-076 — unified Books wall + format-agnostic collections (owner-ratified) ([#460](https://github.com/thaynes43/haynesnetwork/issues/460)) ([686f682](https://github.com/thaynes43/haynesnetwork/commit/686f6822daeb960dda85565dc54d13cf35ae0f4e))
* **agents:** PLAN-025 — ytdrivarr follows the full *arr deployment pattern (LAN-only, API-key, app-fronted) ([#456](https://github.com/thaynes43/haynesnetwork/issues/456)) ([be5390d](https://github.com/thaynes43/haynesnetwork/commit/be5390d97130b3b60ddef3506f0064b934107f67))
* **agents:** PLAN-025 correction — ytdrivarr is NOT headless (owner: 'arrs are not headless'); own admin UI, app stays member-facing ([#455](https://github.com/thaynes43/haynesnetwork/issues/455)) ([b070798](https://github.com/thaynes43/haynesnetwork/commit/b07079844c70b93c4c04fca7376cedd56b9e9caf))
* **agents:** PLAN-025 scoped — ytdl platform rulings ratified ([#453](https://github.com/thaynes43/haynesnetwork/issues/453)) ([cf79c58](https://github.com/thaynes43/haynesnetwork/commit/cf79c582e2afae7267692057deb36c1a1e860e37))
* **agents:** ytdrivarr day-1 wrap — M1 + Fable console shipped, deploy staged on two owner gates ([#459](https://github.com/thaynes43/haynesnetwork/issues/459)) ([b428b8a](https://github.com/thaynes43/haynesnetwork/commit/b428b8a1295748b33c261c94db67cbf3a4adb41a))
* **agents:** ytdrivarr research landed — Q-02 source matrix + Q-03 donor audit (plugin contracts C1-C8) ([#454](https://github.com/thaynes43/haynesnetwork/issues/454)) ([dcb7915](https://github.com/thaynes43/haynesnetwork/commit/dcb7915d9bcd3e3bf13e1d6cbe8e7cdb06e4515c))
* **sso:** LAN Tautulli doors ARMED — in-cluster enforcement verified, only the LAN click-test remains ([#452](https://github.com/thaynes43/haynesnetwork/issues/452)) ([470f5f8](https://github.com/thaynes43/haynesnetwork/commit/470f5f8017692e27723e35dee55e915cae52ed97))
* **sso:** record owner SSO rulings (2026-07-20); DESIGN-041 Accepted ([#449](https://github.com/thaynes43/haynesnetwork/issues/449)) ([9b347bd](https://github.com/thaynes43/haynesnetwork/commit/9b347bd5a1f55af62c3317ad4323586ef462e579))
* **sso:** wave 1 as-executed — Immich+OWUI zero-click live, LAN Tautulli doors staged, Authentik-only posture codified ([#451](https://github.com/thaynes43/haynesnetwork/issues/451)) ([64bce4e](https://github.com/thaynes43/haynesnetwork/commit/64bce4e43083fe10c4b2f24533e22cfb5b9db04b))
* ytdrivarr ADR-074 + DESIGN-045 (the *arr-shaped ytdl-content suite service) ([#457](https://github.com/thaynes43/haynesnetwork/issues/457)) ([d04b101](https://github.com/thaynes43/haynesnetwork/commit/d04b1015944a9bb974d4efeffe1eecb645593000))

## [0.88.4](https://github.com/thaynes43/haynesnetwork/compare/v0.88.3...v0.88.4) (2026-07-20)


### Bug Fixes

* remove the Collection filter chip from the Music wall ([#448](https://github.com/thaynes43/haynesnetwork/issues/448)) ([e328d7d](https://github.com/thaynes43/haynesnetwork/commit/e328d7dc6266419af5fb39ddca20aced00695b49))


### Documentation

* day wrap 2026-07-20 — collections across all library types, MAM armed, GB accounting fixed; DESIGN-037 comics-grain amendment ([#446](https://github.com/thaynes43/haynesnetwork/issues/446)) ([7f5d0cc](https://github.com/thaynes43/haynesnetwork/commit/7f5d0ccc19905dfe0e2133730d9f7e0ab6170f33))

## [0.88.3](https://github.com/thaynes43/haynesnetwork/compare/v0.88.2...v0.88.3) (2026-07-20)


### Bug Fixes

* count PHYSICAL GB requests (retries incl.), not logical queries ([#444](https://github.com/thaynes43/haynesnetwork/issues/444)) ([e264eec](https://github.com/thaynes43/haynesnetwork/commit/e264eec88a9d50ca06f2079f32c80332040a3522))
* Kometa collection auto-merge gate — scope to the named validate check + defer out of the request path ([#445](https://github.com/thaynes43/haynesnetwork/issues/445)) ([968312f](https://github.com/thaynes43/haynesnetwork/commit/968312f53d037ed72b3208e6b76d5b05be8509a3))


### Documentation

* **agents:** GB first budgeted day VERIFIED — breaker held, budgets working, saga effectively closed ([#442](https://github.com/thaynes43/haynesnetwork/issues/442)) ([bf99e29](https://github.com/thaynes43/haynesnetwork/commit/bf99e291ca76867e6d12ee2f440bc544bfe4b34c))

## [0.88.2](https://github.com/thaynes43/haynesnetwork/compare/v0.88.1...v0.88.2) (2026-07-20)


### Bug Fixes

* Goodreads integration survives transient upstream blips + self-heals ([#441](https://github.com/thaynes43/haynesnetwork/issues/441)) ([99de607](https://github.com/thaynes43/haynesnetwork/commit/99de607401a2cca8de368decb91204edd2e9fb1f))


### Documentation

* **agents:** MAM demand plan — GB-free pool exhausted, expansion is tomorrow's lever ([#438](https://github.com/thaynes43/haynesnetwork/issues/438)) ([dc792b7](https://github.com/thaynes43/haynesnetwork/commit/dc792b7d5271fabf86271bec724edc9c358f8ad6))
* **gb:** correct the '~100/day' cap — it was genuine 1,000/day shared across 3 keys ([#440](https://github.com/thaynes43/haynesnetwork/issues/440)) ([24ca02e](https://github.com/thaynes43/haynesnetwork/commit/24ca02ee51a1eabf9e0d4b0f49142a6d44c37bfb))

## [0.88.1](https://github.com/thaynes43/haynesnetwork/compare/v0.88.0...v0.88.1) (2026-07-19)


### Bug Fixes

* **collections:** collection-UX parity — card badge z-order, books head Fix/Force-Search packing, books drill magnifier ([#437](https://github.com/thaynes43/haynesnetwork/issues/437)) ([290ce8c](https://github.com/thaynes43/haynesnetwork/commit/290ce8c02fc1a4391141aa81b56efd0d4cdde9a1))


### Documentation

* **agents:** GB quota watch note — monitoring the first budgeted day (Mon 07-20 reset) ([#435](https://github.com/thaynes43/haynesnetwork/issues/435)) ([aba2879](https://github.com/thaynes43/haynesnetwork/commit/aba28792f0810e97cd8a3c57be88201bcf20595d))

## [0.88.0](https://github.com/thaynes43/haynesnetwork/compare/v0.87.1...v0.88.0) (2026-07-19)


### Features

* daily Google Books CALL BUDGET — keep our own consumers inside the ~100/day cap ([#433](https://github.com/thaynes43/haynesnetwork/issues/433)) ([f1ccd1e](https://github.com/thaynes43/haynesnetwork/commit/f1ccd1e612826380bc862b6de14c1fc3d52b7778))

## [0.87.1](https://github.com/thaynes43/haynesnetwork/compare/v0.87.0...v0.87.1) (2026-07-19)


### Bug Fixes

* drill Wanted tiles share the held tile's poster column (uniform width) ([#431](https://github.com/thaynes43/haynesnetwork/issues/431)) ([95f8904](https://github.com/thaynes43/haynesnetwork/commit/95f8904180262d3d0e02b9ff95a6c562ffc5bd8d))

## [0.87.0](https://github.com/thaynes43/haynesnetwork/compare/v0.86.0...v0.87.0) (2026-07-19)


### Features

* collection Search Missing badges + drill-header primary pills (ADR-071) ([#429](https://github.com/thaynes43/haynesnetwork/issues/429)) ([772f03c](https://github.com/thaynes43/haynesnetwork/commit/772f03c4adbe0b7c2fbeacb19c45c4632cbede2d))

## [0.86.0](https://github.com/thaynes43/haynesnetwork/compare/v0.85.0...v0.86.0) (2026-07-19)


### Features

* **collections:** distinct "Locked" tag + source filter on Movies/TV lists ([#426](https://github.com/thaynes43/haynesnetwork/issues/426)) ([bbf73e9](https://github.com/thaynes43/haynesnetwork/commit/bbf73e960b70387e4b1b671e63f5d117b0e1128f))


### Bug Fixes

* unify the wanted-filter rails across all media walls ([#428](https://github.com/thaynes43/haynesnetwork/issues/428)) ([39f2d27](https://github.com/thaynes43/haynesnetwork/commit/39f2d271576921911a46e2b722c257308678344f))

## [0.85.0](https://github.com/thaynes43/haynesnetwork/compare/v0.84.0...v0.85.0) (2026-07-19)


### Features

* **collections:** gamified builder — caught-em-all states, wall-flow layout, no cap chrome ([#425](https://github.com/thaynes43/haynesnetwork/issues/425)) ([3d8a696](https://github.com/thaynes43/haynesnetwork/commit/3d8a6964181344c6c51b8c33449bcbadfee88156))


### Documentation

* **agents:** evening wrap — owner-driven iteration day, v0.81.0 → v0.84.0 ([#423](https://github.com/thaynes43/haynesnetwork/issues/423)) ([595ae4e](https://github.com/thaynes43/haynesnetwork/commit/595ae4e28737f18c076b7ae035e8f3a430b6270b))

## [0.84.0](https://github.com/thaynes43/haynesnetwork/compare/v0.83.0...v0.84.0) (2026-07-18)


### Features

* **collections:** full-page search-first collection builder (DESIGN-044) ([#421](https://github.com/thaynes43/haynesnetwork/issues/421)) ([390325e](https://github.com/thaynes43/haynesnetwork/commit/390325e688bcd9c930cfab8ac4b477145f3ce4c2))

## [0.83.0](https://github.com/thaynes43/haynesnetwork/compare/v0.82.0...v0.83.0) (2026-07-18)


### Features

* **libretto:** client for the builder-page search + draft preview endpoints ([#417](https://github.com/thaynes43/haynesnetwork/issues/417)) ([d94bbf2](https://github.com/thaynes43/haynesnetwork/commit/d94bbf22148601a1eb48f49c6c06c0bcaa7fb4b4))


### Bug Fixes

* collections row action is the registry Force Search, Run now retired (owner ruling) ([#418](https://github.com/thaynes43/haynesnetwork/issues/418)) ([fa8fa81](https://github.com/thaynes43/haynesnetwork/commit/fa8fa8144fe964b93573a331ffeed67882d58fd2))


### Documentation

* **design:** DESIGN-044 the collection builder page (search-first, live preview) ([#419](https://github.com/thaynes43/haynesnetwork/issues/419)) ([4667568](https://github.com/thaynes43/haynesnetwork/commit/4667568ecdce10dd74929ee373b6f54d8f96c53f))

## [0.82.0](https://github.com/thaynes43/haynesnetwork/compare/v0.81.2...v0.82.0) (2026-07-18)


### Features

* edit the estate's Kometa collections in place (owner ruling 2026-07-18) ([#415](https://github.com/thaynes43/haynesnetwork/issues/415)) ([6176fcd](https://github.com/thaynes43/haynesnetwork/commit/6176fcd01761c183465f54e488853a98c2335d8a))

## [0.81.2](https://github.com/thaynes43/haynesnetwork/compare/v0.81.1...v0.81.2) (2026-07-18)


### Bug Fixes

* **collections:** list config + hand-made collections as read-only rows on every tab ([#414](https://github.com/thaynes43/haynesnetwork/issues/414)) ([8699f70](https://github.com/thaynes43/haynesnetwork/commit/8699f7073b74966a778846af72827e8c300b3e77))
* relocate Collections tab to user menu "Collection settings" + wall drill nav-out ([#412](https://github.com/thaynes43/haynesnetwork/issues/412)) ([b279884](https://github.com/thaynes43/haynesnetwork/commit/b279884c6088fea379cc68748b6fbbc01a568e58))

## [0.81.1](https://github.com/thaynes43/haynesnetwork/compare/v0.81.0...v0.81.1) (2026-07-18)


### Bug Fixes

* **pairing:** skip redundant LazyLibrarian addBook when the volume is already seated (GB call-budget) ([#409](https://github.com/thaynes43/haynesnetwork/issues/409)) ([d0c3224](https://github.com/thaynes43/haynesnetwork/commit/d0c3224c26fe89ba31d6cac6d321155b55c2fe27))


### Documentation

* **agents:** verified UTC timeline for the trash-cycle stall — correct the recovery claim ([#410](https://github.com/thaynes43/haynesnetwork/issues/410)) ([c7b367f](https://github.com/thaynes43/haynesnetwork/commit/c7b367f64c9f0815684a4a9b32a3f563587db9ab))

## [0.81.0](https://github.com/thaynes43/haynesnetwork/compare/v0.80.0...v0.81.0) (2026-07-18)


### ⚠ BREAKING CHANGES

* space policy promotes its own batches — autonomous Trash cycle, no cooldown (ADR-073) ([#408](https://github.com/thaynes43/haynesnetwork/issues/408))

### Bug Fixes

* **collections:** full-width page + mirror-authoritative media-type split (owner live findings) ([#407](https://github.com/thaynes43/haynesnetwork/issues/407)) ([6f38261](https://github.com/thaynes43/haynesnetwork/commit/6f38261c17e4767dfdb4f81002bad45356216031))
* **pairing:** reuse prior pairing-want llBookId to survive GB quota drain; document the real drain (LazyLibrarian) ([#406](https://github.com/thaynes43/haynesnetwork/issues/406)) ([72e2b99](https://github.com/thaynes43/haynesnetwork/commit/72e2b99f5af19ec601bd29de782d01e1fdd19902))
* space policy promotes its own batches — autonomous Trash cycle, no cooldown (ADR-073) ([#408](https://github.com/thaynes43/haynesnetwork/issues/408)) ([d008de4](https://github.com/thaynes43/haynesnetwork/commit/d008de4e800a3b923aba55ca57bbc3931efd5e98))


### Documentation

* **agents:** overnight wrap — Collections saga complete, v0.77.0 → v0.80.0 ([#404](https://github.com/thaynes43/haynesnetwork/issues/404)) ([350991c](https://github.com/thaynes43/haynesnetwork/commit/350991c87473cd1b54abdee7cde8493f8a8c1e1d))

## [0.80.0](https://github.com/thaynes43/haynesnetwork/compare/v0.79.0...v0.80.0) (2026-07-18)


### ⚠ BREAKING CHANGES

* Kometa (Movies/TV) collections write path + auto-merge (ADR-072 PR4b) ([#397](https://github.com/thaynes43/haynesnetwork/issues/397))

### Features

* action-anatomy drift guard — lock the unified media-action doctrine (ADR-071 PR-6) ([#403](https://github.com/thaynes43/haynesnetwork/issues/403)) ([4afdf43](https://github.com/thaynes43/haynesnetwork/commit/4afdf43e5253f6ce346c72709dea2e506f7ee553))
* find-missing grant grid + per-collection knob + cron force-search (ADR-072 PR4c) ([#401](https://github.com/thaynes43/haynesnetwork/issues/401)) ([739ba19](https://github.com/thaynes43/haynesnetwork/commit/739ba196d4f2a4f11622c023604b1620cc173306))
* Kometa (Movies/TV) collections write path + auto-merge (ADR-072 PR4b) ([#397](https://github.com/thaynes43/haynesnetwork/issues/397)) ([259e3f1](https://github.com/thaynes43/haynesnetwork/commit/259e3f104423d7c87702e3d540c64096b1526070))


### Bug Fixes

* **gb-quota:** classify 429s from response body only, never the URL-bearing error message ([#402](https://github.com/thaynes43/haynesnetwork/issues/402)) ([654fd32](https://github.com/thaynes43/haynesnetwork/commit/654fd3249fc4e93b1c969d500ef2140f9d18327d))


### Refactors

* wanted-detail + activity-failure onto shared media-action components (ADR-071, PR-4) ([#400](https://github.com/thaynes43/haynesnetwork/issues/400)) ([f5d3177](https://github.com/thaynes43/haynesnetwork/commit/f5d3177fa66a0baa5884d60a56c563bf4d29c5af))


### Documentation

* DESIGN-043 D-14 realized note, PLAN-052 PR4c completion, PR4c handoff note. ([739ba19](https://github.com/thaynes43/haynesnetwork/commit/739ba196d4f2a4f11622c023604b1620cc173306))
* **ops:** OPS-004 live object names + .sig Accept-header gotcha (v0.79.0 driver findings) ([#399](https://github.com/thaynes43/haynesnetwork/issues/399)) ([81d339f](https://github.com/thaynes43/haynesnetwork/commit/81d339f4223b46acd232aa6237bec13684903a7d))

## [0.79.0](https://github.com/thaynes43/haynesnetwork/compare/v0.78.1...v0.79.0) (2026-07-18)


### ⚠ BREAKING CHANGES

* the collections tRPC surface is reshaped (save/suggest/ reviewSuggestion/mySuggestions removed; overview now takes { mediaType }) and the /integrations/collections manager moved to /collections.

### Features

* **collections:** books + audiobooks collection Wanted tiles (DESIGN-038 D-13) ([#394](https://github.com/thaynes43/haynesnetwork/issues/394)) ([0a81b63](https://github.com/thaynes43/haynesnetwork/commit/0a81b63d4315aec0c5e0a1a9410fd7f04adc23b5))
* first-class /collections page + direct-add keystone (ADR-072 PR4a) ([#393](https://github.com/thaynes43/haynesnetwork/issues/393)) ([d439194](https://github.com/thaynes43/haynesnetwork/commit/d439194665fc8ba3a1edf17dfa575764184579ba))


### Bug Fixes

* **collections:** UX polish pass — nav scroll fade, delete Modal, puck copy, uniform rows, ticket attribution ([#396](https://github.com/thaynes43/haynesnetwork/issues/396)) ([7fb7044](https://github.com/thaynes43/haynesnetwork/commit/7fb7044d80d31fd7c52cb1ff3e1c9524679ab9af))

## [0.78.1](https://github.com/thaynes43/haynesnetwork/compare/v0.78.0...v0.78.1) (2026-07-18)


### Bug Fixes

* **db:** bump 0067 journal timestamp so it applies incrementally ([#391](https://github.com/thaynes43/haynesnetwork/issues/391)) ([06b47ce](https://github.com/thaynes43/haynesnetwork/commit/06b47ce73e6b28f9e1a40476449fce74139489d4))
* remove the in-wall suggest-a-collection affordance (owner ruling) ([#388](https://github.com/thaynes43/haynesnetwork/issues/388)) ([6fb15ac](https://github.com/thaynes43/haynesnetwork/commit/6fb15ac8a74195a7dfb01d50a344ac8011c0b553))


### Documentation

* **agents:** rule — backlog/saga state must reach main; commit the 07-17/07-18 context notes ([#387](https://github.com/thaynes43/haynesnetwork/issues/387)) ([dd12225](https://github.com/thaynes43/haynesnetwork/commit/dd12225a974f4945688d90d0af1cbff236f0de68))
* **collections:** direct-add supersedes suggest→approve (ADR-071) ([#389](https://github.com/thaynes43/haynesnetwork/issues/389)) ([7527939](https://github.com/thaynes43/haynesnetwork/commit/75279390e6ad64d25e07caa0826496cbfdd66df9))
* **collections:** renumber direct-add ADR 071 → 072 (collision fix) ([#392](https://github.com/thaynes43/haynesnetwork/issues/392)) ([e60c474](https://github.com/thaynes43/haynesnetwork/commit/e60c47499c429bc501879a2e4df315427bcac89d))

## [0.78.0](https://github.com/thaynes43/haynesnetwork/compare/v0.77.0...v0.78.0) (2026-07-18)


### Features

* **collections:** size cap + admin override tickets + movies wanted force-search seam ([#385](https://github.com/thaynes43/haynesnetwork/issues/385)) ([7261327](https://github.com/thaynes43/haynesnetwork/commit/72613279da980643e3ba1dc34cee43d9c6435d30))

## [0.77.0](https://github.com/thaynes43/haynesnetwork/compare/v0.76.0...v0.77.0) (2026-07-18)


### Features

* books gain Force Search + unified grant gating; refactor onto shared media-action components (ADR-071, PR-3) ([#383](https://github.com/thaynes43/haynesnetwork/issues/383)) ([089b399](https://github.com/thaynes43/haynesnetwork/commit/089b39906546df35505268f125fcc3831046dd32))

## [0.76.0](https://github.com/thaynes43/haynesnetwork/compare/v0.75.0...v0.76.0) (2026-07-18)


### Features

* **libretto:** consume member-missing endpoint + resolve broker; suite-repo rule ([#376](https://github.com/thaynes43/haynesnetwork/issues/376)) ([292330c](https://github.com/thaynes43/haynesnetwork/commit/292330c8b004793c282e57385c00118ed886c05e))
* MEDIA_ACTIONS registry + shared media-action component set (ADR-071 / DESIGN-004 D-24) ([#378](https://github.com/thaynes43/haynesnetwork/issues/378)) ([3514961](https://github.com/thaynes43/haynesnetwork/commit/3514961cd76e4f6c17ab45bccec3be7cfa1cc4f2))


### Bug Fixes

* pass anchor ISBN to the pairing GB resolve + normalize library file-titles (PLAN-059) ([#373](https://github.com/thaynes43/haynesnetwork/issues/373)) ([3213658](https://github.com/thaynes43/haynesnetwork/commit/321365895b4b5e31a20a6fd810f95741d03683a0))


### Refactors

* item-detail onto the shared media-action components (ADR-071, PR-2) ([#381](https://github.com/thaynes43/haynesnetwork/issues/381)) ([64018ce](https://github.com/thaynes43/haynesnetwork/commit/64018cea41e42772e900e3699b590688f2e6ca39))
* ytdl-sub detail hero onto &lt;MediaHero&gt; / &lt;ConsumeLink&gt; (ADR-071, PR-5) ([#382](https://github.com/thaynes43/haynesnetwork/issues/382)) ([9adb7e0](https://github.com/thaynes43/haynesnetwork/commit/9adb7e0a9f8845672c236b49549b86f3551b9d24))

## [0.75.0](https://github.com/thaynes43/haynesnetwork/compare/v0.74.0...v0.75.0) (2026-07-18)


### Features

* movies collection Wanted-tiles — full held+wanted membership (DESIGN-035 D-16) ([#374](https://github.com/thaynes43/haynesnetwork/issues/374)) ([89e0544](https://github.com/thaynes43/haynesnetwork/commit/89e054471dd8346f6dc8f7a37875f4472dae76d2))


### Bug Fixes

* admins can force-search ANY user's book want (DESIGN-029 D-08 amendment) ([#375](https://github.com/thaynes43/haynesnetwork/issues/375)) ([01f530a](https://github.com/thaynes43/haynesnetwork/commit/01f530a397bb34004f534aed8f2c806fd8aaa26f))

## [0.74.0](https://github.com/thaynes43/haynesnetwork/compare/v0.73.1...v0.74.0) (2026-07-18)


### Features

* books collection category — dynamic chips across all three walls (DESIGN-038 D-12) ([#372](https://github.com/thaynes43/haynesnetwork/issues/372)) ([6c18b2a](https://github.com/thaynes43/haynesnetwork/commit/6c18b2a3f6eb955600814199f9b064f1c7be1143))


### Documentation

* **ops:** OPS-013 tier table — Elite VIP unsatisfied cap = 200 ([#370](https://github.com/thaynes43/haynesnetwork/issues/370)) ([c47d505](https://github.com/thaynes43/haynesnetwork/commit/c47d50578f8c1b877c820836731f1b090d04fe5b))

## [0.73.1](https://github.com/thaynes43/haynesnetwork/compare/v0.73.0...v0.73.1) (2026-07-17)


### Bug Fixes

* clear legacy collection-category values migration 0062 left behind ([#368](https://github.com/thaynes43/haynesnetwork/issues/368)) ([1e6b1c6](https://github.com/thaynes43/haynesnetwork/commit/1e6b1c68d4a5aed1141a566083789a827c851e90))

## [0.73.0](https://github.com/thaynes43/haynesnetwork/compare/v0.72.1...v0.73.0) (2026-07-17)


### ⚠ BREAKING CHANGES

* label-driven, open collection categories (supersede title classifier) ([#367](https://github.com/thaynes43/haynesnetwork/issues/367))

### Features

* label-driven, open collection categories (supersede title classifier) ([#367](https://github.com/thaynes43/haynesnetwork/issues/367)) ([22c7171](https://github.com/thaynes43/haynesnetwork/commit/22c7171e85cab08d87afe4745a1a3f677364d47f))


### Bug Fixes

* delete the three dormant direct Plex server catalog rows (DESIGN-004 Q-04) ([#365](https://github.com/thaynes43/haynesnetwork/issues/365)) ([7fbbf4d](https://github.com/thaynes43/haynesnetwork/commit/7fbbf4dee218b4c57b0985f2d0f3e2badc204a27))

## [0.72.1](https://github.com/thaynes43/haynesnetwork/compare/v0.72.0...v0.72.1) (2026-07-17)


### Bug Fixes

* clamp the books About summary with a Show more/less toggle (DESIGN-025 D-08) ([#364](https://github.com/thaynes43/haynesnetwork/issues/364)) ([d994e4d](https://github.com/thaynes43/haynesnetwork/commit/d994e4d9a0a0a0497fd89f95ccd77063a366cc87))


### Documentation

* final board note — all PRs wrapped, v0.72.0 live, board clean for the bounce ([#362](https://github.com/thaynes43/haynesnetwork/issues/362)) ([b72fddb](https://github.com/thaynes43/haynesnetwork/commit/b72fddb1899b93ad8122586040b3231385259516))

## [0.72.0](https://github.com/thaynes43/haynesnetwork/compare/v0.71.0...v0.72.0) (2026-07-17)


### Features

* books/audiobooks/comics detail-page parity with the movie anatomy (R-221) ([#355](https://github.com/thaynes43/haynesnetwork/issues/355)) ([bcb830d](https://github.com/thaynes43/haynesnetwork/commit/bcb830deed2c0315f76802e44790f4134e331625))


### Bug Fixes

* Home rule between the glances and the About tile ([#361](https://github.com/thaynes43/haynesnetwork/issues/361)) ([582781c](https://github.com/thaynes43/haynesnetwork/commit/582781cbc3d4979f3d5d17fec685eb822f31d0c4))


### Documentation

* pre-bounce handoff — v0.71.0, comic route live-proven, the owner UI-verification ruling ([#359](https://github.com/thaynes43/haynesnetwork/issues/359)) ([56443c2](https://github.com/thaynes43/haynesnetwork/commit/56443c28f506142e8375941cb79b4f4f06e195c7))

## [0.71.0](https://github.com/thaynes43/haynesnetwork/compare/v0.70.1...v0.71.0) (2026-07-17)


### Features

* HOME/PORTAL split — logo links to a calm Home, the launcher grid moves to /portal (DESIGN-004 D-23) ([#356](https://github.com/thaynes43/haynesnetwork/issues/356)) ([f47fc65](https://github.com/thaynes43/haynesnetwork/commit/f47fc65ba27a5444ccfc62ac81e9dd1aa851c18a))


### Bug Fixes

* kapowarr auto_search response schema rejected the real success payload ([#358](https://github.com/thaynes43/haynesnetwork/issues/358)) ([e9346d0](https://github.com/thaynes43/haynesnetwork/commit/e9346d01ddba4f67d7bf764e11255414b9f8ef7f))

## [0.70.1](https://github.com/thaynes43/haynesnetwork/compare/v0.70.0...v0.70.1) (2026-07-17)


### Bug Fixes

* book-fix GB resolve hardening — item author, author guard, series-prefix strip, pre-colon fallback ([#354](https://github.com/thaynes43/haynesnetwork/issues/354)) ([ddf8361](https://github.com/thaynes43/haynesnetwork/commit/ddf83615ef5212ea29126557bbef1fa95f797951))


### Documentation

* fold Kometa section into PLAN-052 + PLAN-059 resolution-gap addendum ([#351](https://github.com/thaynes43/haynesnetwork/issues/351)) ([28a9ab8](https://github.com/thaynes43/haynesnetwork/commit/28a9ab8004b362ee33bc697a9c83bf67c7dffe50))
* Friday-dawn wrap — v0.70.0, Tautulli SSO pilot live, collections program closed, M3 resolution gap ([#353](https://github.com/thaynes43/haynesnetwork/issues/353)) ([718f337](https://github.com/thaynes43/haynesnetwork/commit/718f337193c6b42e787dfc51e66702f4a3416835))

## [0.70.0](https://github.com/thaynes43/haynesnetwork/compare/v0.69.0...v0.70.0) (2026-07-17)


### Features

* collection manager + member contributions (PLAN-052 Libretto leg — ADR-069/DESIGN-042) ([#350](https://github.com/thaynes43/haynesnetwork/issues/350)) ([406fd46](https://github.com/thaynes43/haynesnetwork/commit/406fd46ad82ffd4cd63fcc79286f56c30579d271))


### Documentation

* DESIGN-042 + ADR-069 (Proposed) — Kometa collections manage & contribute ([#348](https://github.com/thaynes43/haynesnetwork/issues/348)) ([293a720](https://github.com/thaynes43/haynesnetwork/commit/293a720905d7a6846f697d685cae19125e5e5e56))

## [0.69.0](https://github.com/thaynes43/haynesnetwork/compare/v0.68.1...v0.69.0) (2026-07-17)


### Features

* collection provenance tags — "what created this collection" badge (DESIGN-035 D-12 / DESIGN-038 D-11) ([#347](https://github.com/thaynes43/haynesnetwork/issues/347)) ([fd1fae9](https://github.com/thaynes43/haynesnetwork/commit/fd1fae9c1dd280581b67766cbba384a57357ca20))


### Bug Fixes

* Collection Type chips mobile polish (PLAN-053 owner amendment) ([#346](https://github.com/thaynes43/haynesnetwork/issues/346)) ([dd5ceb3](https://github.com/thaynes43/haynesnetwork/commit/dd5ceb3e7dd8ddc3e34fa1c5d78208f447759285))


### Documentation

* DESIGN-041 — Q-02/Q-09 owner rulings + the role-governed app login amendment ([#345](https://github.com/thaynes43/haynesnetwork/issues/345)) ([87e8279](https://github.com/thaynes43/haynesnetwork/commit/87e8279eafc9ebb63a5ce6a9212d2db40b0930f4))
* DESIGN-041 Q-09 — Authentik Plex source allowed servers (HOps must join before HOps-only invites) ([#344](https://github.com/thaynes43/haynesnetwork/issues/344)) ([638320b](https://github.com/thaynes43/haynesnetwork/commit/638320b164dae10da5ee363c0a0240aa5f12bedf))
* MAM VIP research (PLAN-040 input) + PLAN-052 live-contract notes ([#342](https://github.com/thaynes43/haynesnetwork/issues/342)) ([9ab8864](https://github.com/thaynes43/haynesnetwork/commit/9ab8864d6e83786f70c2c9f95f3c366e5e028b8f))

## [0.68.1](https://github.com/thaynes43/haynesnetwork/compare/v0.68.0...v0.68.1) (2026-07-17)


### Bug Fixes

* wrong-work GB resolve guard + ComicVine overlap floor (the Wings misroute) ([#341](https://github.com/thaynes43/haynesnetwork/issues/341)) ([8c7e364](https://github.com/thaynes43/haynesnetwork/commit/8c7e3647d38a1d0f2df249b206d7dfd520552f0b))


### Documentation

* cold-start handoff — 8 plans completed/, Libretto deployed + D-04 fallback next, comics repair steps, owner directives (Opus wave, MAM VIP research, Fable SSO planning), release-train tooling in-repo ([#339](https://github.com/thaynes43/haynesnetwork/issues/339)) ([1c9184b](https://github.com/thaynes43/haynesnetwork/commit/1c9184baf7872d627a117c3d880781631eaf1ea1))
* PLAN-058 intake — SSO immersion (auto-login everywhere, retire per-app Plex logins) ([#337](https://github.com/thaynes43/haynesnetwork/issues/337)) ([ec3920f](https://github.com/thaynes43/haynesnetwork/commit/ec3920f7fb183d689f79aa55ed82bdb6f214880b))
* PLAN-058 planned — DESIGN-041 SSO immersion (estate auto-login inventory + per-app remediation, Q-01..Q-08 for owner review) ([#340](https://github.com/thaynes43/haynesnetwork/issues/340)) ([7413d16](https://github.com/thaynes43/haynesnetwork/commit/7413d16aada203d20af9f847ba58753d7bc45f19))

## [0.68.0](https://github.com/thaynes43/haynesnetwork/compare/v0.67.0...v0.68.0) (2026-07-17)


### Features

* Google Books quota resilience — shared circuit breaker + retryable book fixes (PLAN-055) ([#333](https://github.com/thaynes43/haynesnetwork/issues/333)) ([be6c2c6](https://github.com/thaynes43/haynesnetwork/commit/be6c2c655476998476dee4d3c1c99138df8bf984))


### Bug Fixes

* Wanted rows join the books walls' real sort + All/Only/Hide selector (PLAN-056) ([#334](https://github.com/thaynes43/haynesnetwork/issues/334)) ([9300fe5](https://github.com/thaynes43/haynesnetwork/commit/9300fe551670425946998c85dfead972b1e64a92))


### Documentation

* Thursday late-evening wrap — 051/055/056/057 shipped or merged, Libretto M2 + deploy staged, GitHub-partial doctrine (nudge-commit recovery) ([#335](https://github.com/thaynes43/haynesnetwork/issues/335)) ([a8623c0](https://github.com/thaynes43/haynesnetwork/commit/a8623c0d47b0e09c89f25881a60d44fe8eb10888))

## [0.67.0](https://github.com/thaynes43/haynesnetwork/compare/v0.66.0...v0.67.0) (2026-07-16)


### Features

* books collections mirror — Kavita/ABS collections and reading lists on the Library walls (PLAN-051) ([#332](https://github.com/thaynes43/haynesnetwork/issues/332)) ([9d48d93](https://github.com/thaynes43/haynesnetwork/commit/9d48d938eeb7103776df3173fca19ee8b21032ac))


### Bug Fixes

* scoreboard labels read as play totals, not item counts (owner review) ([#330](https://github.com/thaynes43/haynesnetwork/issues/330)) ([49cabb3](https://github.com/thaynes43/haynesnetwork/commit/49cabb373e9d87be4b65aa95ae3feff08b0b586d))

## [0.66.0](https://github.com/thaynes43/haynesnetwork/compare/v0.65.0...v0.66.0) (2026-07-16)


### Features

* estate play scoreboard — semi-live Tautulli badges on the dashboard (PLAN-057) ([#329](https://github.com/thaynes43/haynesnetwork/issues/329)) ([9caeb8d](https://github.com/thaynes43/haynesnetwork/commit/9caeb8dd4825db57642bbd4db64a5db369ba921c))


### Bug Fixes

* Haynestower lifetime play totals on the About page (PLAN-049 Q-06 resolved via NAS Tautulli) ([#327](https://github.com/thaynes43/haynesnetwork/issues/327)) ([9b9d580](https://github.com/thaynes43/haynesnetwork/commit/9b9d58049934da19753ce67bf33f131b189cfb5a))


### Documentation

* evening wrap — PLAN-053 completed (v0.65.0 live), Libretto M1 merged + stateless ruling recorded ([#325](https://github.com/thaynes43/haynesnetwork/issues/325)) ([b93049c](https://github.com/thaynes43/haynesnetwork/commit/b93049cb4d19593a36f268085ad7b56afb8698b7))

## [0.65.0](https://github.com/thaynes43/haynesnetwork/compare/v0.64.0...v0.65.0) (2026-07-16)


### Features

* Collection Type facet — six-bucket classifier + Type chips on the Collections view (PLAN-053) ([#323](https://github.com/thaynes43/haynesnetwork/issues/323)) ([3cd052f](https://github.com/thaynes43/haynesnetwork/commit/3cd052f14d9a1a846dd6ddff36e6e9204e041d0d))


### Documentation

* DESIGN-037 amended — Libretto is stateless (owner ruling 2026-07-16) ([#324](https://github.com/thaynes43/haynesnetwork/issues/324)) ([0fe0c0c](https://github.com/thaynes43/haynesnetwork/commit/0fe0c0c95885269a0dbbbbc6d73dd947e086a50c))
* PLAN-053 queued — Collection Type facet on the Collections view ([#319](https://github.com/thaynes43/haynesnetwork/issues/319)) ([1a553de](https://github.com/thaynes43/haynesnetwork/commit/1a553de3488061862ffa8e7d869e7043be860e5c))
* PLAN-054 + DESIGN-037 — Libretto architecture (design phase, owner review = M0 gate) ([#322](https://github.com/thaynes43/haynesnetwork/issues/322)) ([b256843](https://github.com/thaynes43/haynesnetwork/commit/b2568438d9bde1958e36af129709e81079ce858e))
* Thursday wrap — PLAN-037 (v0.63.0) + PLAN-050 (v0.64.0) completed + live-validated; Libretto named + design open; PLAN-053 ready; train doctrine hardened ([#320](https://github.com/thaynes43/haynesnetwork/issues/320)) ([5ce98f5](https://github.com/thaynes43/haynesnetwork/commit/5ce98f5f0d3d7d831b3f788ebd9ad9d0b37bfe59))

## [0.64.0](https://github.com/thaynes43/haynesnetwork/compare/v0.63.0...v0.64.0) (2026-07-16)


### Features

* book ⇄ audiobook format pairing — dual buttons, coverage badges, paced estate-wide auto-mint (PLAN-050) ([#317](https://github.com/thaynes43/haynesnetwork/issues/317)) ([7bdceb4](https://github.com/thaynes43/haynesnetwork/commit/7bdceb42978bb508aa374c82c4ce288c23ea2b5b))

## [0.63.0](https://github.com/thaynes43/haynesnetwork/compare/v0.62.1...v0.63.0) (2026-07-16)


### Features

* mirrored Plex collections — Collections group-by view for Movies/TV (PLAN-037) ([#316](https://github.com/thaynes43/haynesnetwork/issues/316)) ([e7becec](https://github.com/thaynes43/haynesnetwork/commit/e7becec5aad1d738c6b466b48c45010937f893de))


### Documentation

* collections roadmap ratified — PLAN-051 (books collections mirror) + PLAN-052 (collection-manager integration parity) + saga books-app phase (owner rulings 2026-07-16) ([#313](https://github.com/thaynes43/haynesnetwork/issues/313)) ([489eef9](https://github.com/thaynes43/haynesnetwork/commit/489eef9d1fa76d2c6dac7446d802b4a25eebc6de))
* Kometa deep-research filed — PLAN-052 verdicts (git-PR write path, validate-file gate, run-files run-now) + PLAN-051 ordering input ([#315](https://github.com/thaynes43/haynesnetwork/issues/315)) ([f3580e6](https://github.com/thaynes43/haynesnetwork/commit/f3580e68fad431df2af83008775165240b48905f))

## [0.62.1](https://github.com/thaynes43/haynesnetwork/compare/v0.62.0...v0.62.1) (2026-07-16)


### Bug Fixes

* About page copy tone pass (owner review round 1) ([#312](https://github.com/thaynes43/haynesnetwork/issues/312)) ([6df5211](https://github.com/thaynes43/haynesnetwork/commit/6df521105e40e7ffa0a847aa9616df33ca0c4573))


### Documentation

* overnight wrap — v0.62.0 About/Help page live (PLAN-049 → completed/) + release-train dance lessons + owner morning queue ([#309](https://github.com/thaynes43/haynesnetwork/issues/309)) ([72f9ab2](https://github.com/thaynes43/haynesnetwork/commit/72f9ab2dfcf4f3664ea081d760d8cb64b8233004))

## [0.62.0](https://github.com/thaynes43/haynesnetwork/compare/v0.61.0...v0.62.0) (2026-07-16)


### Features

* About/Help page — dashboard entry card + /about accordion (PLAN-049 / ADR-063 / DESIGN-034) ([#307](https://github.com/thaynes43/haynesnetwork/issues/307)) ([59e0630](https://github.com/thaynes43/haynesnetwork/commit/59e06304785dbb10878091a6c00aeb8c351c7011))


### Documentation

* Wednesday-night wrap — v0.61.0 books Fix live (Q-01 FLIP = [#1](https://github.com/thaynes43/haynesnetwork/issues/1) open item) + overnight cold-start block ([#305](https://github.com/thaynes43/haynesnetwork/issues/305)) ([8878758](https://github.com/thaynes43/haynesnetwork/commit/887875894b74fcc180744642ef524a6b71be9dd9))

## [0.61.0](https://github.com/thaynes43/haynesnetwork/compare/v0.60.0...v0.61.0) (2026-07-16)


### Features

* books/audiobooks/comics Fix — audited acquisition-layer re-grab (PLAN-041 / ADR-062) ([#304](https://github.com/thaynes43/haynesnetwork/issues/304)) ([1ef367f](https://github.com/thaynes43/haynesnetwork/commit/1ef367fcd74502554493e70e98c46c5357755af4))
* raise the Fix hourly budget 5 → 25 per user (owner ruling) ([#303](https://github.com/thaynes43/haynesnetwork/issues/303)) ([6daf42a](https://github.com/thaynes43/haynesnetwork/commit/6daf42afb6a17cdd5df8be793a2cf996b52fb86c))


### Documentation

* OPS-012 addendum — AudioBooth SSO + the ABS progress-loss incident (root-caused, closed) ([#301](https://github.com/thaynes43/haynesnetwork/issues/301)) ([ab8e8b7](https://github.com/thaynes43/haynesnetwork/commit/ab8e8b75b0cb5c898d5ce02f185753c36700c294))
* PLAN-038 -&gt; completed/ (v0.60.0 shipped + prod-validated) + afternoon cleanup-run handoff ([#299](https://github.com/thaynes43/haynesnetwork/issues/299)) ([4f527f6](https://github.com/thaynes43/haynesnetwork/commit/4f527f6ad5259b08deb374ff42020b463e02d8aa))
* PLAN-041 Part 1 planned — ADR-062 (Proposed) + DESIGN-033 + actionable plan (two-Opus planning pass) ([#302](https://github.com/thaynes43/haynesnetwork/issues/302)) ([c77a8fa](https://github.com/thaynes43/haynesnetwork/commit/c77a8fa723c547afcdf1aa836c549db04485dff2))

## [0.60.0](https://github.com/thaynes43/haynesnetwork/compare/v0.59.0...v0.60.0) (2026-07-15)


### Features

* ticket media precision — the compose drill + the ticket locator (PLAN-038 / ADR-061) ([#297](https://github.com/thaynes43/haynesnetwork/issues/297)) ([eeb3a5b](https://github.com/thaynes43/haynesnetwork/commit/eeb3a5b5d9e5a8c8c48f429394ab256d92a06574))

## [0.59.0](https://github.com/thaynes43/haynesnetwork/compare/v0.58.0...v0.59.0) (2026-07-15)


### Features

* nightly admin failure digest — the email channel's second consumer (PLAN-048 tail) ([#296](https://github.com/thaynes43/haynesnetwork/issues/296)) ([6402b52](https://github.com/thaynes43/haynesnetwork/commit/6402b525a70313075568d16af52886c1900df6f3))


### Bug Fixes

* comic classification survives a GB enrichment outage (durable comic_status) ([#295](https://github.com/thaynes43/haynesnetwork/issues/295)) ([63c729a](https://github.com/thaynes43/haynesnetwork/commit/63c729a809fd6d20e12eda7cfb43139bbc91cafb))


### Documentation

* PLAN-035 -&gt; completed/ (v0.58.0 shipped + prod-validated; admin mailbox confirmed) ([#293](https://github.com/thaynes43/haynesnetwork/issues/293)) ([9e834b0](https://github.com/thaynes43/haynesnetwork/commit/9e834b07f617bc50efc00744bf7277d090034230))

## [0.58.0](https://github.com/thaynes43/haynesnetwork/compare/v0.57.0...v0.58.0) (2026-07-15)


### Features

* ticket email notifications — email outbox channel + author opt-in (PLAN-035 / ADR-060) ([#292](https://github.com/thaynes43/haynesnetwork/issues/292)) ([3b0b6c2](https://github.com/thaynes43/haynesnetwork/commit/3b0b6c245893f32977faee064b495c827700b720))


### Documentation

* ratify PLAN-044..048 -&gt; completed/ + Wednesday midday handoff (v0.57.0, SMTP unblocked, Orwell DROP) ([#290](https://github.com/thaynes43/haynesnetwork/issues/290)) ([936ddfc](https://github.com/thaynes43/haynesnetwork/commit/936ddfc04c79e454ba9b2067079a4cc67ad4beb2))

## [0.57.0](https://github.com/thaynes43/haynesnetwork/compare/v0.56.0...v0.57.0) (2026-07-15)


### Features

* goodreads-sync usenet-first re-search sweep + fix the silent LL status reconcile ([#289](https://github.com/thaynes43/haynesnetwork/issues/289)) ([bd94090](https://github.com/thaynes43/haynesnetwork/commit/bd940901805844a2d324e5b55b42c728fe974e82))


### Documentation

* late-night addendum — v0.56.0 nav restructure (Tickets ratified), MAM gate OPEN Tue night, integrations all-roles ([#285](https://github.com/thaynes43/haynesnetwork/issues/285)) ([ef03ba4](https://github.com/thaynes43/haynesnetwork/commit/ef03ba42d3ca142ed0ee196320b8b751715341fa))
* RUN 5 owner-directed MAM batch — 8 grabs (Goodreads test + F-10 poisoned), gate auto-closed at unsat 16 ([#288](https://github.com/thaynes43/haynesnetwork/issues/288)) ([62ef61c](https://github.com/thaynes43/haynesnetwork/commit/62ef61c5cecce7503a596835818d7d77472a52b6))
* Wednesday cold-start handoff — consolidated top block (11-release map, queue, rules); plan rows 044-046 → built+live pending ratification ([#287](https://github.com/thaynes43/haynesnetwork/issues/287)) ([c2c96bc](https://github.com/thaynes43/haynesnetwork/commit/c2c96bce82f9f7ffd472f0e61e2d597de2b416bc))

## [0.56.0](https://github.com/thaynes43/haynesnetwork/compare/v0.55.1...v0.56.0) (2026-07-14)


### Features

* nav restructure — four-tab bar + Metrics/Integrations to the user menu; ratify "Tickets" ([#284](https://github.com/thaynes43/haynesnetwork/issues/284)) ([3760833](https://github.com/thaynes43/haynesnetwork/commit/376083383dcff3420476b1d30fa9b664e3a077e5))


### Documentation

* Tuesday evening addendum — v0.55.0/v0.55.1 (Activity reactive + live precedence), integrations opened to all roles, kyverno alert retuned, MAM maturation Wed ([#282](https://github.com/thaynes43/haynesnetwork/issues/282)) ([9cc8f7f](https://github.com/thaynes43/haynesnetwork/commit/9cc8f7f2d1f7ba86ae5ba6c6665d9d6b9711d984))

## [0.55.1](https://github.com/thaynes43/haynesnetwork/compare/v0.55.0...v0.55.1) (2026-07-14)


### Bug Fixes

* live-status precedence — a downloading comic no longer reads "Missing" (v0.55.0) ([#280](https://github.com/thaynes43/haynesnetwork/issues/280)) ([56da9d4](https://github.com/thaynes43/haynesnetwork/commit/56da9d4bb8563922ffafd97fe23ee8ca969477e3))

## [0.55.0](https://github.com/thaynes43/haynesnetwork/compare/v0.54.0...v0.55.0) (2026-07-14)


### Features

* Activity clickability + live-progress — the Fix feel everywhere (PLAN-048 D-09/D-10) ([#279](https://github.com/thaynes43/haynesnetwork/issues/279)) ([c4e667b](https://github.com/thaynes43/haynesnetwork/commit/c4e667b2ea9236444f283069a71a0508c3c4e3c5))


### Bug Fixes

* Activity tab robustness — per-source isolation, honest states, single active tab ([#278](https://github.com/thaynes43/haynesnetwork/issues/278)) ([f4c5434](https://github.com/thaynes43/haynesnetwork/commit/f4c5434b776584cf43449e6d68302d03977b5c10))


### Documentation

* Tuesday-daytime wrap — v0.50.1..v0.54.0 (anatomy fix, detail parity, card system, Activity complete), import-pipeline rescue, kyverno hardening, model-watch notes ([#276](https://github.com/thaynes43/haynesnetwork/issues/276)) ([5d21177](https://github.com/thaynes43/haynesnetwork/commit/5d21177db49b34fa0c9bd37ced36508a54a4c21a))

## [0.54.0](https://github.com/thaynes43/haynesnetwork/compare/v0.53.0...v0.54.0) (2026-07-14)


### Features

* Activity *arr adapter — Radarr/Sonarr/Lidarr queue + import visibility (PLAN-048, DESIGN-030 D-08) ([#273](https://github.com/thaynes43/haynesnetwork/issues/273)) ([a802743](https://github.com/thaynes43/haynesnetwork/commit/a802743e57c6fe17c3e679c618c670fc87d0e426))
* Activity Kapowarr adapter — comics queue/import visibility (PLAN-048, DESIGN-030 D-08) ([#275](https://github.com/thaynes43/haynesnetwork/issues/275)) ([a4acc76](https://github.com/thaynes43/haynesnetwork/commit/a4acc76d85b70fbb62fcdee66fd32e12e0d20601))

## [0.53.0](https://github.com/thaynes43/haynesnetwork/compare/v0.52.0...v0.53.0) (2026-07-14)


### Features

* Activity / In-Flight — the pipeline made visible (PLAN-048 SLICE 1) ([#272](https://github.com/thaynes43/haynesnetwork/issues/272)) ([79f6d4a](https://github.com/thaynes43/haynesnetwork/commit/79f6d4ac77882292a80cca4600cb48d28174723c))


### Documentation

* **ops:** deploy gate = release workflow completion (kyverno sig race) ([#263](https://github.com/thaynes43/haynesnetwork/issues/263)) ([510f0cb](https://github.com/thaynes43/haynesnetwork/commit/510f0cbc393294d06c50f85820a734022b3bb7f7))

## [0.52.0](https://github.com/thaynes43/haynesnetwork/compare/v0.51.0...v0.52.0) (2026-07-14)


### Features

* the shared card system — one typed card family, drift-proof by code (PLAN-047, ADR-058, DESIGN-004 D-21) ([#269](https://github.com/thaynes43/haynesnetwork/issues/269)) ([9ba1f6f](https://github.com/thaynes43/haynesnetwork/commit/9ba1f6fc2c1bf1b49c20a7d237cb053242caca8d))


### Documentation

* books usenet import contract + stranded-import RCA (OPS-013 §11, F-10 RUN 4) ([#267](https://github.com/thaynes43/haynesnetwork/issues/267)) ([490e774](https://github.com/thaynes43/haynesnetwork/commit/490e7747a676a2e3b39578b811d3578fcdeb0d3a))

## [0.51.0](https://github.com/thaynes43/haynesnetwork/compare/v0.50.1...v0.51.0) (2026-07-14)


### Features

* Wanted-parity detail page for book requests — poster→detail→per-format Force-Search (PLAN-047) ([#264](https://github.com/thaynes43/haynesnetwork/issues/264)) ([dd638d4](https://github.com/thaynes43/haynesnetwork/commit/dd638d4461fb3cb3133a6f20434daabc3ecdcfc5))


### Documentation

* PLAN-047 shared card system + PLAN-048 Activity/In-Flight (owner rulings; motivated by the stranded-imports incident) ([#266](https://github.com/thaynes43/haynesnetwork/issues/266)) ([395e01a](https://github.com/thaynes43/haynesnetwork/commit/395e01a2b420fc3041ee30288407d84db1820395))

## [0.50.1](https://github.com/thaynes43/haynesnetwork/compare/v0.50.0...v0.50.1) (2026-07-14)


### Bug Fixes

* unify Library-Wanted + Goodreads items into the Movies poster-card anatomy (PLAN-045) ([#261](https://github.com/thaynes43/haynesnetwork/issues/261)) ([28d069d](https://github.com/thaynes43/haynesnetwork/commit/28d069d452c2d6dbe0850b2421c08d43b8079ac5))

## [0.50.0](https://github.com/thaynes43/haynesnetwork/compare/v0.49.0...v0.50.0) (2026-07-14)


### Features

* Integrations hub + Goodreads library-idiom sub-section + composed Library-Wanted (PLAN-045) ([#260](https://github.com/thaynes43/haynesnetwork/issues/260)) ([9d0e2ce](https://github.com/thaynes43/haynesnetwork/commit/9d0e2cefa409bf259d94322359c7cccecbb24f62))
* Kapowarr comics acquisition — confined client + comic request routing (PLAN-046) ([#259](https://github.com/thaynes43/haynesnetwork/issues/259)) ([c8d66b5](https://github.com/thaynes43/haynesnetwork/commit/c8d66b54ff39833a51b26ecb33205415b19375bb))


### Bug Fixes

* Integrations link-card UX + comic classification (PLAN-044 live acceptance) ([#258](https://github.com/thaynes43/haynesnetwork/issues/258)) ([c439f04](https://github.com/thaynes43/haynesnetwork/commit/c439f04275f2e615463b277feebe54951556db0e))


### Documentation

* ADR-056; DDD T-166 (+ T-165 revised); PRD R-185..R-187; DESIGN-028 amendment. ([c8d66b5](https://github.com/thaynes43/haynesnetwork/commit/c8d66b54ff39833a51b26ecb33205415b19375bb))
* PLAN-045 — Integrations hub + Goodreads library-idiom redesign (owner spec + assumptions A1-A3); 044 status → shipped/acceptance-tail ([#256](https://github.com/thaynes43/haynesnetwork/issues/256)) ([43a3a8f](https://github.com/thaynes43/haynesnetwork/commit/43a3a8fe390b1ded37c9356439d1c6fa6b609b72))
* PLAN-045 rulings locked (A1 overruled: all shelves acquire; Wanted force-search parity) + PLAN-046 Kapowarr comics acquisition (owner-ruled, Opus tonight) ([#257](https://github.com/thaynes43/haynesnetwork/issues/257)) ([ddf743c](https://github.com/thaynes43/haynesnetwork/commit/ddf743cdf4acffdfb2483e3f065e999bf6d1ffd3))
* session-6 wrap — v0.47.0/v0.48.0/v0.49.0 shipped; PLAN-042 closed (Option A live, compat reverted); F-10 executed; Integration Tab Saga founded, PLAN-044 pending live acceptance ([#254](https://github.com/thaynes43/haynesnetwork/issues/254)) ([4d0d417](https://github.com/thaynes43/haynesnetwork/commit/4d0d417ffdc01be210b4a698d583ff58521fa626))

## [0.49.0](https://github.com/thaynes43/haynesnetwork/compare/v0.48.0...v0.49.0) (2026-07-14)


### Features

* Goodreads requests MVP — Integrations tab, shelf sync, Missing + manual search (PLAN-044) ([#253](https://github.com/thaynes43/haynesnetwork/issues/253)) ([96ead3f](https://github.com/thaynes43/haynesnetwork/commit/96ead3f3f160a2e42d9aa17edfa9d7c16beb3618))


### Documentation

* **f10:** RUN 3 English re-grab wave — 57 wants queued via LL usenet-first ([#251](https://github.com/thaynes43/haynesnetwork/issues/251)) ([a3d944f](https://github.com/thaynes43/haynesnetwork/commit/a3d944fa8312e269d8050b440abaa638269b3e6d))

## [0.48.0](https://github.com/thaynes43/haynesnetwork/compare/v0.47.0...v0.48.0) (2026-07-14)


### Features

* group-card ART — ABS author portraits, genre glyph tiles, per-dimension art sources (DESIGN-026 D-04 amendment) ([#249](https://github.com/thaynes43/haynesnetwork/issues/249)) ([67b1679](https://github.com/thaynes43/haynesnetwork/commit/67b167996a1c9d255d35fd3e033bd9a348c074b5))


### Documentation

* F-10 English audit RUN 2 — 58 foreign items quarantined, libraries rescanned, F-09 corrupt re-grabs queued ([#246](https://github.com/thaynes43/haynesnetwork/issues/246)) ([c5ed2ab](https://github.com/thaynes43/haynesnetwork/commit/c5ed2ab0159437e0c61f22936e54cc2d9f135fc2))
* Integration Tab Saga (PLAN-043 master) + Goodreads requests MVP (PLAN-044, rulings locked) — queue updates (029/042 completed, 033 subsumed) ([#250](https://github.com/thaynes43/haynesnetwork/issues/250)) ([d705d69](https://github.com/thaynes43/haynesnetwork/commit/d705d6955ebcf1f30df2ea76af290ac3e98420b3))
* PLAN-042 COMPLETE — old-WebKit login crash fixed by CSS-nesting lowering; compat mode reverted (haynes-ops 1b11dc69..dafdea79) ([#247](https://github.com/thaynes43/haynesnetwork/issues/247)) ([10d3c13](https://github.com/thaynes43/haynesnetwork/commit/10d3c1306e3a33c680cc255a9f0b60cef9bd7193))

## [0.47.0](https://github.com/thaynes43/haynesnetwork/compare/v0.46.3...v0.47.0) (2026-07-14)


### Features

* PLAN-029 data/domain — released_at, per-user prefs + watch/read seam (steps 1/4/5) ([#243](https://github.com/thaynes43/haynesnetwork/issues/243)) ([259c951](https://github.com/thaynes43/haynesnetwork/commit/259c9515984166779d98faec564454137f4480c3))
* PLAN-029 UX — per-view sort/filter registries, view+grouping shells, facet UI + A–Z jump (steps 2/3/6/7) ([#245](https://github.com/thaynes43/haynesnetwork/issues/245)) ([610a7c7](https://github.com/thaynes43/haynesnetwork/commit/610a7c7e46681583a9be783ffd78c211e95b1104))


### Documentation

* F-10 English audit — run blocked on kubectl/Omni auth outage (run log + reachability) ([#244](https://github.com/thaynes43/haynesnetwork/issues/244)) ([df89720](https://github.com/thaynes43/haynesnetwork/commit/df897207dc64ee51ca2fce5095d8d6a79567badc))
* PLAN-042 Authentik-fix watch → compat revert; F-10 language audit backlog; F-09 resolved ([#239](https://github.com/thaynes43/haynesnetwork/issues/239)) ([2c36a43](https://github.com/thaynes43/haynesnetwork/commit/2c36a43a97bb45459334a60dd10db3dfea347737))
* PLAN-042 late findings — laptop variant closed (current WebKit healthy), iPad Option C overnight, %(theme)s bg polish folded in ([#242](https://github.com/thaynes43/haynesnetwork/issues/242)) ([550e1eb](https://github.com/thaynes43/haynesnetwork/commit/550e1eb570141db75045d3a7f4cf71cef33b3653))
* session-5 final wrap — v0.46.1-3 shipped; WebKit crash RCA (CSS nesting + WebKit[#290102](https://github.com/thaynes43/haynesnetwork/issues/290102)), PLAN-042 escalated to A/B/C ruling; OPS-009 compat-mode amendment ([#241](https://github.com/thaynes43/haynesnetwork/issues/241)) ([3d656aa](https://github.com/thaynes43/haynesnetwork/commit/3d656aab1f58c23077a472af4355ebe92033fe67))

## [0.46.3](https://github.com/thaynes43/haynesnetwork/compare/v0.46.2...v0.46.3) (2026-07-13)


### Bug Fixes

* book-wall cover latency — ABS sized WebP variant + in-process LRU (F-06, ADR-041 idiom) ([#237](https://github.com/thaynes43/haynesnetwork/issues/237)) ([4e811b4](https://github.com/thaynes43/haynesnetwork/commit/4e811b406acb96fc04a355ddacfec2aceea227f7))
* top-nav tabs overlap the theme toggle on narrow phones ([#238](https://github.com/thaynes43/haynesnetwork/issues/238)) ([f42c351](https://github.com/thaynes43/haynesnetwork/commit/f42c351964f8888b770ab275c5c9d53664bb09a5))


### Documentation

* session-5 wrap — Matilda root cause closed, v0.46.1/v0.46.2 live, HANDOFF current ([#235](https://github.com/thaynes43/haynesnetwork/issues/235)) ([43cd894](https://github.com/thaynes43/haynesnetwork/commit/43cd894722d52eafebb11f3ae463081fe75c857c))

## [0.46.2](https://github.com/thaynes43/haynesnetwork/compare/v0.46.1...v0.46.2) (2026-07-12)


### Bug Fixes

* trim link-preview copy — end at "members only" (owner embed review) ([#233](https://github.com/thaynes43/haynesnetwork/issues/233)) ([c9b3317](https://github.com/thaynes43/haynesnetwork/commit/c9b3317c81a83970758b86ce1e7d15e1847011e2))

## [0.46.1](https://github.com/thaynes43/haynesnetwork/compare/v0.46.0...v0.46.1) (2026-07-12)


### Bug Fixes

* link-preview OG tags resolved to localhost in prod (metadataBase origin) ([#231](https://github.com/thaynes43/haynesnetwork/issues/231)) ([b92d43e](https://github.com/thaynes43/haynesnetwork/commit/b92d43ebf95517de5459906cf23d2ecdbb6a77af))


### Documentation

* PLAN-041 — Matilda root cause closed manually (stale German epub + Kavita folder-merge); quarantine pattern proven ([#232](https://github.com/thaynes43/haynesnetwork/issues/232)) ([f845a38](https://github.com/thaynes43/haynesnetwork/commit/f845a3815c563b11b125a2cf2575203c24dca4d3))
* session-4 wrap — PLAN-039 completed, Monday plan, chronicle ([#229](https://github.com/thaynes43/haynesnetwork/issues/229)) ([628e9f4](https://github.com/thaynes43/haynesnetwork/commit/628e9f4528523f5bb6d3e63ca35ee4433eab6ac1))

## [0.46.0](https://github.com/thaynes43/haynesnetwork/compare/v0.45.0...v0.46.0) (2026-07-12)


### Features

* branded link previews — Open Graph metadata, banner image, embed color ([#228](https://github.com/thaynes43/haynesnetwork/issues/228)) ([44992d4](https://github.com/thaynes43/haynesnetwork/commit/44992d430a4cc3da24a752c249e4af2bdc642a40))


### Documentation

* books late-eve rulings — 032 escalated to Books Automation Saga; 033 survey authorized ([#226](https://github.com/thaynes43/haynesnetwork/issues/226)) ([9effabb](https://github.com/thaynes43/haynesnetwork/commit/9effabb306a5b3cd0da9861a261cec22b13a8170))
* PLAN-033 Seerr-for-books survey + adopt-vs-build verdict ([#227](https://github.com/thaynes43/haynesnetwork/issues/227)) ([e60f752](https://github.com/thaynes43/haynesnetwork/commit/e60f752d778be6c9d8306806f0be9cca37c3948f))
* PLAN-041 — Library Fix for books + Fix-everywhere parity goal; queue refresh ([#224](https://github.com/thaynes43/haynesnetwork/issues/224)) ([9800dd8](https://github.com/thaynes43/haynesnetwork/commit/9800dd8477cb0830e436c2a65a7869578101ab30))

## [0.45.0](https://github.com/thaynes43/haynesnetwork/compare/v0.44.1...v0.45.0) (2026-07-11)


### Features

* MAM compliance governor — cap-aware torrent-fallback pacing (PLAN-039) ([#223](https://github.com/thaynes43/haynesnetwork/issues/223)) ([8799a20](https://github.com/thaynes43/haynesnetwork/commit/8799a20564e1f355e3ebf267258b1477a10fa36d))


### Documentation

* MAM books acquisition as-built runbook (OPS-013); mark PLAN-031 complete ([#215](https://github.com/thaynes43/haynesnetwork/issues/215)) ([bcc47ac](https://github.com/thaynes43/haynesnetwork/commit/bcc47ac447bbcb03ad57ba7320ee22346cdd9fbf))
* OPS-013 corrections — LL dlpriority direction was backwards; qB queueing trap ([#218](https://github.com/thaynes43/haynesnetwork/issues/218)) ([89b7af2](https://github.com/thaynes43/haynesnetwork/commit/89b7af23ed6903aa4c18f54bb2c6ebfc637b09f0))
* OPS-013 second correction — Prowlarr fullSync owns LL provider config ([#222](https://github.com/thaynes43/haynesnetwork/issues/222)) ([97009bf](https://github.com/thaynes43/haynesnetwork/commit/97009bf4430b5047fa7bde99ce5fe752784906d9))
* PLAN-032 list-sources research + proposed v1 shape ([#221](https://github.com/thaynes43/haynesnetwork/issues/221)) ([9a68e34](https://github.com/thaynes43/haynesnetwork/commit/9a68e34fa88df09b464700655ed09405233eea04))
* PLAN-040 placeholder — MAM governor admin tool; refresh queue rows for tonight's rulings ([#220](https://github.com/thaynes43/haynesnetwork/issues/220)) ([5a37092](https://github.com/thaynes43/haynesnetwork/commit/5a370921dab3b31f8d0b8617a9c7bb0384680e4b))
* record owner rulings — 039 to BUILD, 032 to research+design, 033 parked ([#219](https://github.com/thaynes43/haynesnetwork/issues/219)) ([c7ff447](https://github.com/thaynes43/haynesnetwork/commit/c7ff4470d19f61b71328421aa44ba43c12d9acce))
* session-3 board audit bookkeeping — plan queue, context notes, OPS-012 ([#217](https://github.com/thaynes43/haynesnetwork/issues/217)) ([c99cd4d](https://github.com/thaynes43/haynesnetwork/commit/c99cd4d177ae0b31204151cbec3e3f0a61d31bf3))

## [0.44.1](https://github.com/thaynes43/haynesnetwork/compare/v0.44.0...v0.44.1) (2026-07-11)


### Bug Fixes

* Helpdesk wall state chips become multi-select toggles (HP-01) ([#214](https://github.com/thaynes43/haynesnetwork/issues/214)) ([fada111](https://github.com/thaynes43/haynesnetwork/commit/fada111187a9bdf7b6333293c058ef464cdcbeb4))


### Documentation

* mark PLAN-034 completed — Helpdesk tickets live (v0.44.0) ([#212](https://github.com/thaynes43/haynesnetwork/issues/212)) ([dd222d0](https://github.com/thaynes43/haynesnetwork/commit/dd222d070ed26702ca38172ab01de47ce0882a95))
* PLAN-029 design — Library views/grouping + per-view sort/filter registries (ADR-051/052/053, DESIGN-026) ([#211](https://github.com/thaynes43/haynesnetwork/issues/211)) ([5ebe4c1](https://github.com/thaynes43/haynesnetwork/commit/5ebe4c1208bf9e9b78eb088f30a69d18d7eb5dd0))

## [0.44.0](https://github.com/thaynes43/haynesnetwork/compare/v0.43.1...v0.44.0) (2026-07-11)


### Features

* Helpdesk tickets — the Bulletin Messages board becomes a media-issue ticket system (PLAN-034) ([#210](https://github.com/thaynes43/haynesnetwork/issues/210)) ([d926e5f](https://github.com/thaynes43/haynesnetwork/commit/d926e5f72120ad0996bd1c450d2a7872bc6db6ae))


### Documentation

* mark PLAN-036 completed — history-navigation contract live (v0.43.1) ([#208](https://github.com/thaynes43/haynesnetwork/issues/208)) ([dd3e36f](https://github.com/thaynes43/haynesnetwork/commit/dd3e36f418a1a53197abd107b8a43a410efd99e7))

## [0.43.1](https://github.com/thaynes43/haynesnetwork/compare/v0.43.0...v0.43.1) (2026-07-11)


### Bug Fixes

* browser Back/Forward navigate between tabs (history contract, PLAN-036) ([#206](https://github.com/thaynes43/haynesnetwork/issues/206)) ([541ad5b](https://github.com/thaynes43/haynesnetwork/commit/541ad5bf6dc946189b96b9a162d07b56435ea423))

## [0.43.0](https://github.com/thaynes43/haynesnetwork/compare/v0.42.0...v0.43.0) (2026-07-11)


### Features

* MOTD markdown + themed SVG severity glyph + aligned banner redesign (DESIGN-004 D-17) ([#202](https://github.com/thaynes43/haynesnetwork/issues/202)) ([f3f26d6](https://github.com/thaynes43/haynesnetwork/commit/f3f26d648dc391b4cc084f6ed913e8ecd42812a1))
* roles-grid clarity + Bulletin Feed/Messages view grants (PLAN-027) ([#204](https://github.com/thaynes43/haynesnetwork/issues/204)) ([4a73d44](https://github.com/thaynes43/haynesnetwork/commit/4a73d44872712824a73399a1654cc16db75d3212))


### Documentation

* mark PLAN-030 completed — season posters + TV episode thumbnails live (v0.41.0) ([#200](https://github.com/thaynes43/haynesnetwork/issues/200)) ([4c1c6d0](https://github.com/thaynes43/haynesnetwork/commit/4c1c6d03e026aa0909ac5d0e94a1c104da69ef2b))

## [0.42.0](https://github.com/thaynes43/haynesnetwork/compare/v0.41.0...v0.42.0) (2026-07-11)


### Features

* detail-page "Not on Disk" affordance mirrors the "Watch on Plex" slot (DESIGN-025 D-07) ([#199](https://github.com/thaynes43/haynesnetwork/issues/199)) ([a24232c](https://github.com/thaynes43/haynesnetwork/commit/a24232c1f0352d06413eefd96ce85e2eacc0b714))


### Documentation

* DESIGN-025 amended with D-07. ([a24232c](https://github.com/thaynes43/haynesnetwork/commit/a24232c1f0352d06413eefd96ce85e2eacc0b714))

## [0.41.0](https://github.com/thaynes43/haynesnetwork/compare/v0.40.1...v0.41.0) (2026-07-11)


### Features

* season poster icons in season rows + episode-thumbnail parity for TV (PLAN-030) ([#198](https://github.com/thaynes43/haynesnetwork/issues/198)) ([eab45b3](https://github.com/thaynes43/haynesnetwork/commit/eab45b3045c6d265b58864abe288586319d1e26d))


### Documentation

* mark PLAN-028 completed — access-aware Library deep links live (v0.40.0/v0.40.1) ([#196](https://github.com/thaynes43/haynesnetwork/issues/196)) ([fe9e571](https://github.com/thaynes43/haynesnetwork/commit/fe9e57118fc223c0dffa154f168b3566c4c1ae9a))

## [0.40.1](https://github.com/thaynes43/haynesnetwork/compare/v0.40.0...v0.40.1) (2026-07-11)


### Bug Fixes

* plex-match reads section pages with includeGuids=1 — Plex omits the external Guid array without it ([#194](https://github.com/thaynes43/haynesnetwork/issues/194)) ([61e18dd](https://github.com/thaynes43/haynesnetwork/commit/61e18dd05b87c82596d61647928d3ebfdc1f306e))

## [0.40.0](https://github.com/thaynes43/haynesnetwork/compare/v0.39.1...v0.40.0) (2026-07-11)


### Features

* access-aware "Watch/Listen/Read here" deep links — *arr→Plex match + library-access invariant (PLAN-028) ([#192](https://github.com/thaynes43/haynesnetwork/issues/192)) ([7f9957c](https://github.com/thaynes43/haynesnetwork/commit/7f9957c03100f91fd2e9caea3920c914de934254))

## [0.39.1](https://github.com/thaynes43/haynesnetwork/compare/v0.39.0...v0.39.1) (2026-07-11)


### Bug Fixes

* Books/Audiobooks/Comics walls scroll-paginate like the rest of the Library (drop Load more) ([#191](https://github.com/thaynes43/haynesnetwork/issues/191)) ([8f8edb2](https://github.com/thaynes43/haynesnetwork/commit/8f8edb28f84034deca00c362a87a74414b9a0a77))


### Documentation

* HANDOFF — PLAN-023 Phase 4 Books & Audiobooks Library ledger complete (v0.39.0) ([#188](https://github.com/thaynes43/haynesnetwork/issues/188)) ([44329bc](https://github.com/thaynes43/haynesnetwork/commit/44329bce4134440bc32d51934e85ac22567edae3))
* mark PLAN-023 completed — Books & Audiobooks Library ledger live (v0.39.0) ([#190](https://github.com/thaynes43/haynesnetwork/issues/190)) ([ac71496](https://github.com/thaynes43/haynesnetwork/commit/ac714963dbc12d0ee3c8949b746f1fe54fac83bd))

## [0.39.0](https://github.com/thaynes43/haynesnetwork/compare/v0.38.0...v0.39.0) (2026-07-10)


### Features

* Books & Audiobooks in the Library — Kavita/ABS ledger sync + poster walls + catalog cards (PLAN-023 Phase 4) ([#187](https://github.com/thaynes43/haynesnetwork/issues/187)) ([f3a76f6](https://github.com/thaynes43/haynesnetwork/commit/f3a76f68be6c84239ae1f330cad7f50a51943e38))


### Documentation

* mark PLAN-026 completed + OPS-011 as-executed (Authentik role portal live, v0.38.0) ([#185](https://github.com/thaynes43/haynesnetwork/issues/185)) ([31fbaf7](https://github.com/thaynes43/haynesnetwork/commit/31fbaf763cf3904812aec4d60122a4c121608f3e))

## [0.38.0](https://github.com/thaynes43/haynesnetwork/compare/v0.37.0...v0.38.0) (2026-07-10)


### Features

* haynesnetwork as the Authentik user/role portal — write-back group membership + synced tiers (PLAN-026) ([#183](https://github.com/thaynes43/haynesnetwork/issues/183)) ([4a47518](https://github.com/thaynes43/haynesnetwork/commit/4a47518f20c41c0e97e22555d9a145850cd75474))

## [0.37.0](https://github.com/thaynes43/haynesnetwork/compare/v0.36.2...v0.37.0) (2026-07-10)


### Features

* AI usage metrics — Open WebUI admin-API ingestion + level-gated attribution (PLAN-021) ([#181](https://github.com/thaynes43/haynesnetwork/issues/181)) ([70ef94a](https://github.com/thaynes43/haynesnetwork/commit/70ef94a2feee6e2973c084f3afbf748f068e92ba))


### Documentation

* ADR-044, DESIGN-022, PRD R-141..R-143, glossary T-126..T-128. ([70ef94a](https://github.com/thaynes43/haynesnetwork/commit/70ef94a2feee6e2973c084f3afbf748f068e92ba))

## [0.36.2](https://github.com/thaynes43/haynesnetwork/compare/v0.36.1...v0.36.2) (2026-07-10)


### Bug Fixes

* Metrics Overview admin can edit WAN upload/download capacity (PLAN-017 gap) ([#179](https://github.com/thaynes43/haynesnetwork/issues/179)) ([827ecbb](https://github.com/thaynes43/haynesnetwork/commit/827ecbb61f749114050c55a1339b87e0df4c1f31))

## [0.36.1](https://github.com/thaynes43/haynesnetwork/compare/v0.36.0...v0.36.1) (2026-07-10)


### Bug Fixes

* Metrics Grafana deep-links are admin-only (LAN-only URLs) ([#176](https://github.com/thaynes43/haynesnetwork/issues/176)) ([2e33c4b](https://github.com/thaynes43/haynesnetwork/commit/2e33c4b2a35234f7862715592371af9ee3829465))

## [0.36.0](https://github.com/thaynes43/haynesnetwork/compare/v0.35.0...v0.36.0) (2026-07-10)


### Features

* Peloton poster guard — durable override art + drift-restore sync mode (PLAN-024) ([#175](https://github.com/thaynes43/haynesnetwork/issues/175)) ([61ec730](https://github.com/thaynes43/haynesnetwork/commit/61ec73055df52b17fb42de687760ecfaaebb1527))


### Documentation

* PLAN-011 Authentik hardening completed — blueprints + native MFA (as-executed record) ([#173](https://github.com/thaynes43/haynesnetwork/issues/173)) ([030d8fd](https://github.com/thaynes43/haynesnetwork/commit/030d8fd209ed0466c121fe1c2b25552b22b76ec9))

## [0.35.0](https://github.com/thaynes43/haynesnetwork/compare/v0.34.0...v0.35.0) (2026-07-10)


### Features

* ytdl-sub UX package — grid-size cached posters (ADR-041), tab order, read-only series drill-in ([#168](https://github.com/thaynes43/haynesnetwork/issues/168)) ([067586f](https://github.com/thaynes43/haynesnetwork/commit/067586fd68c89ac1c78bef9c5fb6e5b1be3ef13f))

## [0.34.0](https://github.com/thaynes43/haynesnetwork/compare/v0.33.0...v0.34.0) (2026-07-10)


### Features

* Metrics — Hardware sub-tab (SMART health + NVMe endurance, node load/temps, Proxmox showcase) + critical-only SMART alerting (PLAN-019) ([#169](https://github.com/thaynes43/haynesnetwork/issues/169)) ([ba44432](https://github.com/thaynes43/haynesnetwork/commit/ba4443289a650b340f047eed24f0a88ac890c645))

## [0.33.0](https://github.com/thaynes43/haynesnetwork/compare/v0.32.0...v0.33.0) (2026-07-10)


### Features

* Metrics — Network sub-tab (WAN usage-vs-capacity + privacy-scoped infra grain, allow-list-proven) (PLAN-020) ([#165](https://github.com/thaynes43/haynesnetwork/issues/165)) ([b5a24cb](https://github.com/thaynes43/haynesnetwork/commit/b5a24cbdba47b750ffa36776f89c11055ac874ac))

## [0.32.0](https://github.com/thaynes43/haynesnetwork/compare/v0.31.0...v0.32.0) (2026-07-10)


### Features

* Metrics — Apps sub-tab (*arr + downloaders + indexers), curated + Grafana deep-linked (PLAN-018) ([#162](https://github.com/thaynes43/haynesnetwork/issues/162)) ([f21d2a6](https://github.com/thaynes43/haynesnetwork/commit/f21d2a6e5c4581085a4cec48820e4d2a2dc1b443))

## [0.31.0](https://github.com/thaynes43/haynesnetwork/compare/v0.30.0...v0.31.0) (2026-07-10)


### Features

* ytdl-sub Library sub-tabs — Peloton + YouTube read direct from k8plex Plex, admin-gated (PLAN-022) ([#159](https://github.com/thaynes43/haynesnetwork/issues/159)) ([f2739a2](https://github.com/thaynes43/haynesnetwork/commit/f2739a2a4a7aa7c41f6f47441e0a5149cf4d3e0a))

## [0.30.0](https://github.com/thaynes43/haynesnetwork/compare/v0.29.0...v0.30.0) (2026-07-10)


### Features

* Metrics section foundation — Overview + per-role Full/Limited access + Prometheus read path (PLAN-017) ([#157](https://github.com/thaynes43/haynesnetwork/issues/157)) ([f3f6f23](https://github.com/thaynes43/haynesnetwork/commit/f3f6f23030054d9f987c877d61460fd9dd94f340))


### Documentation

* preserve Authentik apply/rollback seed for the blueprints migration ([#156](https://github.com/thaynes43/haynesnetwork/issues/156)) ([81f0ee2](https://github.com/thaynes43/haynesnetwork/commit/81f0ee21c5421eea2e913503d247fcbfd57ec715))
* session-2 cold-start handoff — v0.29.0, trash automation proven, next: features + authentik blueprints ([#154](https://github.com/thaynes43/haynesnetwork/issues/154)) ([2e998ca](https://github.com/thaynes43/haynesnetwork/commit/2e998ca47296bac9d898cf0869bbae29a1028881))

## [0.29.0](https://github.com/thaynes43/haynesnetwork/compare/v0.28.0...v0.29.0) (2026-07-10)


### Features

* final-warning push (configurable) + honest next-sweep times ([#152](https://github.com/thaynes43/haynesnetwork/issues/152)) ([5a3205e](https://github.com/thaynes43/haynesnetwork/commit/5a3205e48b09324b9a8e041a3e3f92d65369aaa7))

## [0.28.0](https://github.com/thaynes43/haynesnetwork/compare/v0.27.0...v0.28.0) (2026-07-10)


### Features

* requested items are informational only — rules promote, humans decide, the app schedules ([#151](https://github.com/thaynes43/haynesnetwork/issues/151)) ([d706992](https://github.com/thaynes43/haynesnetwork/commit/d706992db528c48bd6760d4c7b497ab0266636b9))


### Bug Fixes

* future-batch strip visible to trash users; role editor works on phones ([#149](https://github.com/thaynes43/haynesnetwork/issues/149)) ([754ba2b](https://github.com/thaynes43/haynesnetwork/commit/754ba2bce80edf91b994b2397712bb864338e724))

## [0.27.0](https://github.com/thaynes43/haynesnetwork/compare/v0.26.0...v0.27.0) (2026-07-09)


### Features

* strategy-mirrored wall order + debounced pool refresh after saves ([#148](https://github.com/thaynes43/haynesnetwork/issues/148)) ([f60b521](https://github.com/thaynes43/haynesnetwork/commit/f60b521aeb7d3b2c929856d96d8c189639a130e0))


### Bug Fixes

* SAFE audit enforces Maintainerr aging invariants (rule pools never self-delete) ([#146](https://github.com/thaynes43/haynesnetwork/issues/146)) ([72c0b58](https://github.com/thaynes43/haynesnetwork/commit/72c0b58c457c00779f41c42eb72372663e943366))
* watch indicators never occupy the action corner — every tile stays saveable ([#145](https://github.com/thaynes43/haynesnetwork/issues/145)) ([f4718f0](https://github.com/thaynes43/haynesnetwork/commit/f4718f065e1d6a83e70d26857f59d80b470085ac))

## [0.26.0](https://github.com/thaynes43/haynesnetwork/compare/v0.25.1...v0.26.0) (2026-07-09)


### Features

* cross-server watch visibility on trash walls (info, not protection) ([#142](https://github.com/thaynes43/haynesnetwork/issues/142)) ([0677ca0](https://github.com/thaynes43/haynesnetwork/commit/0677ca0c0ee71a2c3dbfea5611c3485396a0d9f5))
* native free-space trend chart (replaces LAN-only Grafana link) ([#144](https://github.com/thaynes43/haynesnetwork/issues/144)) ([ef1c859](https://github.com/thaynes43/haynesnetwork/commit/ef1c85983c3c6aeecc954685888eae44cf048d12))

## [0.25.1](https://github.com/thaynes43/haynesnetwork/compare/v0.25.0...v0.25.1) (2026-07-09)


### Performance

* trash candidates read-model — instant walls (ADR-035) ([#140](https://github.com/thaynes43/haynesnetwork/issues/140)) ([78ee442](https://github.com/thaynes43/haynesnetwork/commit/78ee442f4eebc8913a924562f908f9f5ce771de0))

## [0.25.0](https://github.com/thaynes43/haynesnetwork/compare/v0.24.0...v0.25.0) (2026-07-09)


### Features

* paginated trash walls + interactive future-batch candidates ([#139](https://github.com/thaynes43/haynesnetwork/issues/139)) ([a3f14f9](https://github.com/thaynes43/haynesnetwork/commit/a3f14f9efba277b742122897411e656ec7900348))


### Bug Fixes

* batch-wall exclusion unprotect + legacy requested reclassification ([#136](https://github.com/thaynes43/haynesnetwork/issues/136)) ([91aba71](https://github.com/thaynes43/haynesnetwork/commit/91aba7126285815ed53eaa234ac774a0bab64be9))
* themed settings inputs + Batch policy under General ([#138](https://github.com/thaynes43/haynesnetwork/issues/138)) ([129521c](https://github.com/thaynes43/haynesnetwork/commit/129521cf6b51d279e4174da985ead50cbefac8f7))

## [0.24.0](https://github.com/thaynes43/haynesnetwork/compare/v0.23.0...v0.24.0) (2026-07-09)


### Features

* continuous batch mode + per-kind caps, all-day notify default, countdown fix, label cleanup ([#134](https://github.com/thaynes43/haynesnetwork/issues/134)) ([2a38a8b](https://github.com/thaynes43/haynesnetwork/commit/2a38a8b053851f167cd33d73f4f14050c8573e07))
* tabbed Trash Settings hub + requested items start saved (overridable) ([#135](https://github.com/thaynes43/haynesnetwork/issues/135)) ([eeca4f9](https://github.com/thaynes43/haynesnetwork/commit/eeca4f9927299926317bffd5c2c0a7e3191ddd3e))


### Bug Fixes

* fix-request timeouts, close-on-import, human history copy ([#132](https://github.com/thaynes43/haynesnetwork/issues/132)) ([38d92f1](https://github.com/thaynes43/haynesnetwork/commit/38d92f1c6b8605934bea30a74416259c8862f4e6))

## [0.23.0](https://github.com/thaynes43/haynesnetwork/compare/v0.22.0...v0.23.0) (2026-07-09)


### Features

* mid-window expire override (typed confirm, audited) + reclaim-targeted batch creation ([#131](https://github.com/thaynes43/haynesnetwork/issues/131)) ([40ece7a](https://github.com/thaynes43/haynesnetwork/commit/40ece7a442e8d18546313002b101392c9f79c833))


### Bug Fixes

* 'Delete all now' naming + requester-protected glyphs on trash walls ([#130](https://github.com/thaynes43/haynesnetwork/issues/130)) ([19a79de](https://github.com/thaynes43/haynesnetwork/commit/19a79de7922d7204ba155c8784db990d4162ce96))


### Documentation

* complete plan 016 (Pushover) — trash automation loop closed ([#128](https://github.com/thaynes43/haynesnetwork/issues/128)) ([0e9a506](https://github.com/thaynes43/haynesnetwork/commit/0e9a506196c214d02c2ad43eb43c72c925387a00))

## [0.22.0](https://github.com/thaynes43/haynesnetwork/compare/v0.21.0...v0.22.0) (2026-07-09)


### Features

* Pushover batch notifications with delivery window (PLAN-016) ([#126](https://github.com/thaynes43/haynesnetwork/issues/126)) ([9b408dd](https://github.com/thaynes43/haynesnetwork/commit/9b408ddce1f12b188dc99326922deb1289ce33b9))

## [0.21.0](https://github.com/thaynes43/haynesnetwork/compare/v0.20.1...v0.21.0) (2026-07-08)


### Features

* trash Overview landing + kind tab count badges ([#124](https://github.com/thaynes43/haynesnetwork/issues/124)) ([86edd82](https://github.com/thaynes43/haynesnetwork/commit/86edd825f8c4fb25fcfe7b93660825968ce9b114))

## [0.20.1](https://github.com/thaynes43/haynesnetwork/compare/v0.20.0...v0.20.1) (2026-07-08)


### Bug Fixes

* global Save implies Leaving-Soon rescue (UI + server); roles table inline action badges ([#122](https://github.com/thaynes43/haynesnetwork/issues/122)) ([620ee6c](https://github.com/thaynes43/haynesnetwork/commit/620ee6cf0458eb5191e36de78155f6bf842439bd))

## [0.20.0](https://github.com/thaynes43/haynesnetwork/compare/v0.19.0...v0.20.0) (2026-07-08)


### Features

* per-kind trash lifecycle (Batches folded in) + context-aware item back-links ([#121](https://github.com/thaynes43/haynesnetwork/issues/121)) ([86a43c5](https://github.com/thaynes43/haynesnetwork/commit/86a43c5d94f20fdf3733325a45ac6bbad4ea8d41))


### Bug Fixes

* ledger rows become stacked cards on portrait mobile ([#117](https://github.com/thaynes43/haynesnetwork/issues/117)) ([49519bf](https://github.com/thaynes43/haynesnetwork/commit/49519bfa2a10a5c888228982f8b5d1077d1b7309))
* match Plex identity by plex.tv numeric id (automatic owner/friend recognition) ([#120](https://github.com/thaynes43/haynesnetwork/issues/120)) ([4aa2faf](https://github.com/thaynes43/haynesnetwork/commit/4aa2faf122ed7177f2cc67688ed828bebd0c18e0))
* My Plex resolves the real Plex identity (source claim + admin override), not the OIDC email ([#118](https://github.com/thaynes43/haynesnetwork/issues/118)) ([72d6a03](https://github.com/thaynes43/haynesnetwork/commit/72d6a0308a3fce9b307e3407a2a0eddedfd01c86))

## [0.19.0](https://github.com/thaynes43/haynesnetwork/compare/v0.18.1...v0.19.0) (2026-07-07)


### Features

* trash pending views become poster walls (phone-first) ([#116](https://github.com/thaynes43/haynesnetwork/issues/116)) ([18d3751](https://github.com/thaynes43/haynesnetwork/commit/18d3751adbfc1e3a47b83bfd69c30e7d6f6abf18))
* universal top nav + role-gated user menu (My Plex, Ledger, Trash settings) ([#115](https://github.com/thaynes43/haynesnetwork/issues/115)) ([9737d26](https://github.com/thaynes43/haynesnetwork/commit/9737d261482ed44db32456c281df63f366a45a2b))


### Bug Fixes

* save-stats and rescue rates count net outcomes, not raw save events ([#113](https://github.com/thaynes43/haynesnetwork/issues/113)) ([cc841bb](https://github.com/thaynes43/haynesnetwork/commit/cc841bb8c39283e0ffdb1b48652cb6b724c6367e))

## [0.18.1](https://github.com/thaynes43/haynesnetwork/compare/v0.18.0...v0.18.1) (2026-07-07)


### Bug Fixes

* **auth:** local logout when the id_token is stale/absent (no SSO login-loop) ([#112](https://github.com/thaynes43/haynesnetwork/issues/112)) ([77def0d](https://github.com/thaynes43/haynesnetwork/commit/77def0d60e07665abc04e4d0f32dbb683e412af3))


### Documentation

* complete plan 014 — board complete at v0.18.0 ([#110](https://github.com/thaynes43/haynesnetwork/issues/110)) ([5df4a89](https://github.com/thaynes43/haynesnetwork/commit/5df4a8916981364e688ecbe03557f18c985554cf))

## [0.18.0](https://github.com/thaynes43/haynesnetwork/compare/v0.17.0...v0.18.0) (2026-07-07)


### Features

* bulletin messages deep-link referenced titles with repair-status hints ([#107](https://github.com/thaynes43/haynesnetwork/issues/107)) ([be198c3](https://github.com/thaynes43/haynesnetwork/commit/be198c39e95409180c9ea2d143763bcbabc97c1c))
* space-driven batch proposals + rules-tuning report (ADR-031) ([#108](https://github.com/thaynes43/haynesnetwork/issues/108)) ([c92fc15](https://github.com/thaynes43/haynesnetwork/commit/c92fc15b8fba7b2877f6ed298ebba72eee3ec99e))


### Bug Fixes

* deleted items fall back to TMDB posters (Recently Deleted art) ([#106](https://github.com/thaynes43/haynesnetwork/issues/106)) ([87a076c](https://github.com/thaynes43/haynesnetwork/commit/87a076c57b23728ed22535f168891580c2bc4559))
* sign-out ends the Authentik SSO session (RP-initiated logout) ([#109](https://github.com/thaynes43/haynesnetwork/issues/109)) ([c374aca](https://github.com/thaynes43/haynesnetwork/commit/c374aca18d41583c5f23184df22790c321718c79))


### Documentation

* complete plan 013 (storage metrics) — v0.17.0 live on public origin ([#104](https://github.com/thaynes43/haynesnetwork/issues/104)) ([7427c25](https://github.com/thaynes43/haynesnetwork/commit/7427c257b1383eb921f0496d3132f75c312ca011))

## [0.17.0](https://github.com/thaynes43/haynesnetwork/compare/v0.16.1...v0.17.0) (2026-07-07)


### Features

* storage metrics — utilization vs space target + reclaim attribution (ADR-030) ([#103](https://github.com/thaynes43/haynesnetwork/issues/103)) ([dccb082](https://github.com/thaynes43/haynesnetwork/commit/dccb08296bdbdc7d9cfb2aa4f2ec6e91096adb22))


### Documentation

* HANDOFF refresh — v0.16.1 + owner fixes shipped ([#100](https://github.com/thaynes43/haynesnetwork/issues/100)) ([c3403fc](https://github.com/thaynes43/haynesnetwork/commit/c3403fcdd2ffc7afb9bbaf98ba03ef290070f033))
* plan 008 executed — haynesnetwork.com publicly live (OPS-005 log) ([#102](https://github.com/thaynes43/haynesnetwork/issues/102)) ([8c6cb3c](https://github.com/thaynes43/haynesnetwork/commit/8c6cb3c4971693ae5d550f11bf5a712d156d0aca))

## [0.16.1](https://github.com/thaynes43/haynesnetwork/compare/v0.16.0...v0.16.1) (2026-07-07)


### Bug Fixes

* track expedited deletions in Recently Deleted + Activity; match Expedite/Save button weight ([#97](https://github.com/thaynes43/haynesnetwork/issues/97)) ([5b2933d](https://github.com/thaynes43/haynesnetwork/commit/5b2933d33f213f576d2f3b72ac4dcec09b546173))

## [0.16.0](https://github.com/thaynes43/haynesnetwork/compare/v0.15.0...v0.16.0) (2026-07-07)


### Features

* Ledger Runs tab — promote run history out from under the spreadsheet ([#95](https://github.com/thaynes43/haynesnetwork/issues/95)) ([2445955](https://github.com/thaynes43/haynesnetwork/commit/2445955be4e2ee75b47c2b677f2ed1ad23061beb))


### Bug Fixes

* cutover auth hardening — trustedOrigins for apex/www + real client IP behind tunnel ([#94](https://github.com/thaynes43/haynesnetwork/issues/94)) ([692a14d](https://github.com/thaynes43/haynesnetwork/commit/692a14d300b4a0bd2516431ec244522f5cb9975d))
* My Plex recognizes the server owner + clearer unlinked-account copy ([#96](https://github.com/thaynes43/haynesnetwork/issues/96)) ([971ab90](https://github.com/thaynes43/haynesnetwork/commit/971ab900599171a983c1f64d1895a7746a0c4b5f))
* themed dark-mode backgrounds for Bulletin composer + shared inputs ([#93](https://github.com/thaynes43/haynesnetwork/issues/93)) ([8ebf3e1](https://github.com/thaynes43/haynesnetwork/commit/8ebf3e1ce6ff6ae4e52c05856796cdb7dbe351ef))


### Documentation

* ADR-029 (amends ADR-017 C-06), DESIGN-007 D-14, glossary T-94. ([971ab90](https://github.com/thaynes43/haynesnetwork/commit/971ab900599171a983c1f64d1895a7746a0c4b5f))
* complete plan 015 (arr action feedback) — v0.15.0 live-validated ([#91](https://github.com/thaynes43/haynesnetwork/issues/91)) ([bab4538](https://github.com/thaynes43/haynesnetwork/commit/bab4538c09bfba1d3e965ba7ef4633fb73599a8c))

## [0.15.0](https://github.com/thaynes43/haynesnetwork/compare/v0.14.1...v0.15.0) (2026-07-07)


### Features

* downstream *arr action feedback — live Fix/Force-Search progress (ADR-028) ([#90](https://github.com/thaynes43/haynesnetwork/issues/90)) ([1b3e589](https://github.com/thaynes43/haynesnetwork/commit/1b3e589f3e2ecd11f48c1a45c04981ba947c4eda))


### Documentation

* note ledger UX polish shipped (v0.14.1) ([#88](https://github.com/thaynes43/haynesnetwork/issues/88)) ([dddfbb5](https://github.com/thaynes43/haynesnetwork/commit/dddfbb564a636678d93a10d60eb715cea9ba69d0))

## [0.14.1](https://github.com/thaynes43/haynesnetwork/compare/v0.14.0...v0.14.1) (2026-07-07)


### Bug Fixes

* ledger/library sort affordance + true filtered export count ([#87](https://github.com/thaynes43/haynesnetwork/issues/87)) ([d2b933c](https://github.com/thaynes43/haynesnetwork/commit/d2b933c57b442c7d82fcc1fa257bc476a3466acf))


### Documentation

* complete plan 010 (MOTD banner) — v0.14.0 live-validated ([#85](https://github.com/thaynes43/haynesnetwork/issues/85)) ([a51f780](https://github.com/thaynes43/haynesnetwork/commit/a51f78063196b2568e9c804eab01dacc3d8a0609))

## [0.14.0](https://github.com/thaynes43/haynesnetwork/compare/v0.13.0...v0.14.0) (2026-07-07)


### Features

* MOTD dashboard banner (ADR-027) ([#84](https://github.com/thaynes43/haynesnetwork/issues/84)) ([77ab5fc](https://github.com/thaynes43/haynesnetwork/commit/77ab5fce45f9fe781691355c78ddd91ec3781d12))


### Documentation

* complete plan 009 (Bulletin) — v0.13.0 live-validated ([#82](https://github.com/thaynes43/haynesnetwork/issues/82)) ([cc7ac4b](https://github.com/thaynes43/haynesnetwork/commit/cc7ac4b6d4e693421383a771690f8e3c576c268d))

## [0.13.0](https://github.com/thaynes43/haynesnetwork/compare/v0.12.0...v0.13.0) (2026-07-07)


### Features

* Bulletin — activity Feed + Messages board (ADR-026) ([#81](https://github.com/thaynes43/haynesnetwork/issues/81)) ([886d70a](https://github.com/thaynes43/haynesnetwork/commit/886d70a547559f025927e6dc5f135ad57a3b680d))


### Documentation

* complete plan 012 (trash curation pipeline) — v0.12.0 live-validated ([#79](https://github.com/thaynes43/haynesnetwork/issues/79)) ([30d0b57](https://github.com/thaynes43/haynesnetwork/commit/30d0b57d5a88566796f27d1518ae1e89ab979da2))

## [0.12.0](https://github.com/thaynes43/haynesnetwork/compare/v0.11.2...v0.12.0) (2026-07-07)


### Features

* Trash curation pipeline — poster-wall review, Leaving Soon batches, timed deletion (ADR-025) ([#78](https://github.com/thaynes43/haynesnetwork/issues/78)) ([206541d](https://github.com/thaynes43/haynesnetwork/commit/206541d6da216dde6d103010f085df1dd7f0f995))


### Documentation

* complete plan 006 (Trash section) — v0.11.0-2 live-validated ([#76](https://github.com/thaynes43/haynesnetwork/issues/76)) ([a1149ae](https://github.com/thaynes43/haynesnetwork/commit/a1149ae591b1c4ee9f114040fa80895976a4bb2f))

## [0.11.2](https://github.com/thaynes43/haynesnetwork/compare/v0.11.1...v0.11.2) (2026-07-07)


### Bug Fixes

* trash rules PUT carries server selection; dataType normalized (no crucial-change wipes) ([#75](https://github.com/thaynes43/haynesnetwork/issues/75)) ([62eb887](https://github.com/thaynes43/haynesnetwork/commit/62eb8875b3970c6cdda30a3c1a12c7fb5f29f3ae))


### Documentation

* plan 015 — downstream *arr action feedback (owner backlog 2026-07-07) ([#73](https://github.com/thaynes43/haynesnetwork/issues/73)) ([14f8d81](https://github.com/thaynes43/haynesnetwork/commit/14f8d818cee0d22929430a00fc76fa9b3a67c83b))

## [0.11.1](https://github.com/thaynes43/haynesnetwork/compare/v0.11.0...v0.11.1) (2026-07-07)


### Bug Fixes

* trash rule arm/disarm round-trip; pending list reflects live exclusions ([#71](https://github.com/thaynes43/haynesnetwork/issues/71)) ([1dc4af3](https://github.com/thaynes43/haynesnetwork/commit/1dc4af386c5edea0cb290c2d02f84d51d5166f0b))

## [0.11.0](https://github.com/thaynes43/haynesnetwork/compare/v0.10.0...v0.11.0) (2026-07-07)


### Features

* Trash section — Maintainerr integration, per-action grants, curated deletion surface (ADR-023) ([#70](https://github.com/thaynes43/haynesnetwork/issues/70)) ([8c5f2dc](https://github.com/thaynes43/haynesnetwork/commit/8c5f2dcba8d957f35f1be22c5a6f78a13c3fedda))


### Documentation

* HANDOFF — ADR-024 shipped (v0.10.0); note inferred enter-All live-validation ([#67](https://github.com/thaynes43/haynesnetwork/issues/67)) ([7b857bd](https://github.com/thaynes43/haynesnetwork/commit/7b857bdcc654cd8125e0084fa21df3a2c7383aa7))
* plans 011-014 (Authentik hardening, trash curation pipeline, metrics, rules tuning) + 006 test-rules amendment ([#69](https://github.com/thaynes43/haynesnetwork/issues/69)) ([3fc732f](https://github.com/thaynes43/haynesnetwork/commit/3fc732f6dc79ae0f18528a0dd3dd3125fcf0ce3b))

## [0.10.0](https://github.com/thaynes43/haynesnetwork/compare/v0.9.0...v0.10.0) (2026-07-06)


### Features

* role-scoped all-libraries Plex self-service (ADR-024) ([#66](https://github.com/thaynes43/haynesnetwork/issues/66)) ([0e11f56](https://github.com/thaynes43/haynesnetwork/commit/0e11f56f6b7a72fb70dac4543e0cdef8dd9ccd82))


### Documentation

* complete plan 003 (Plex library self-service) — fully live-validated incl. real share cycle ([#65](https://github.com/thaynes43/haynesnetwork/issues/65)) ([ee56df5](https://github.com/thaynes43/haynesnetwork/commit/ee56df57a86a4bfe00f19fe16c07d8678c55599d))
* complete plan 005 (Ledger section) — v0.9.0 live-validated ([#63](https://github.com/thaynes43/haynesnetwork/issues/63)) ([70e52b3](https://github.com/thaynes43/haynesnetwork/commit/70e52b376a8ba62dcac4748afaf73c449c0eff8d))

## [0.9.0](https://github.com/thaynes43/haynesnetwork/compare/v0.8.1...v0.9.0) (2026-07-06)


### Features

* Ledger section — section permissions, monitor-and-search, export (ADR-021/022) ([#62](https://github.com/thaynes43/haynesnetwork/issues/62)) ([3064a1f](https://github.com/thaynes43/haynesnetwork/commit/3064a1f5bbfbce99bffda51ae28133b800584037))


### Documentation

* complete plan 004 (library metadata + posters + filter engine) — v0.8.0/v0.8.1 live-validated ([#60](https://github.com/thaynes43/haynesnetwork/issues/60)) ([59fdb9d](https://github.com/thaynes43/haynesnetwork/commit/59fdb9df71840d3e4da078f92d2c72213d463543))

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
