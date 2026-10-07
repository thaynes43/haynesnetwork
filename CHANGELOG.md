# Changelog

## [0.110.1](https://github.com/thaynes43/haynesnetwork/compare/v0.110.0...v0.110.1) (2026-10-07)


### Bug Fixes

* **books:** guard pairing during Kavita series splits ([#833](https://github.com/thaynes43/haynesnetwork/issues/833)) ([1f9d6e0](https://github.com/thaynes43/haynesnetwork/commit/1f9d6e07e0f8a021d8db5b554cc31f68e9c3eccc))

## [0.110.0](https://github.com/thaynes43/haynesnetwork/compare/v0.109.5...v0.110.0) (2026-10-07)


### Features

* **books:** admins read a want's Request Event history on its Wanted detail ([#792](https://github.com/thaynes43/haynesnetwork/issues/792)) ([#826](https://github.com/thaynes43/haynesnetwork/issues/826)) ([64524c7](https://github.com/thaynes43/haynesnetwork/commit/64524c7746b88a1bf6b29ce137422d0c0a171962))

## [0.109.5](https://github.com/thaynes43/haynesnetwork/compare/v0.109.4...v0.109.5) (2026-10-07)


### Bug Fixes

* **books:** pace Google Books requests under the per-minute quota and wait out one minute trip ([#827](https://github.com/thaynes43/haynesnetwork/issues/827)) ([9bed1ff](https://github.com/thaynes43/haynesnetwork/commit/9bed1ffe3f05448abba7c8f243cfaec6d54b53fb))
* the e2e suite serves a production build (ADR-103), and the Goodreads cards stop flashing "Not linked" ([#824](https://github.com/thaynes43/haynesnetwork/issues/824)) ([5854dd2](https://github.com/thaynes43/haynesnetwork/commit/5854dd299f2bbbb20eb0e3f15f4205d4695346b3))

## [0.109.4](https://github.com/thaynes43/haynesnetwork/compare/v0.109.3...v0.109.4) (2026-10-07)


### Bug Fixes

* **books:** the wants pass never resolves a member a pairing want covers, and counts its misses ([#819](https://github.com/thaynes43/haynesnetwork/issues/819)) ([71ac0c1](https://github.com/thaynes43/haynesnetwork/commit/71ac0c15eb7037fc91991b441a97e1fc37409dd5))


### Documentation

* agents run the suite on main by label, not workflow_dispatch ([#814](https://github.com/thaynes43/haynesnetwork/issues/814)) ([c6d5fa1](https://github.com/thaynes43/haynesnetwork/commit/c6d5fa1e1a2416bc6a424b0b21b3aaf894abe4e7))

## [0.109.3](https://github.com/thaynes43/haynesnetwork/compare/v0.109.2...v0.109.3) (2026-10-07)


### Bug Fixes

* **books:** the Held File Check reads two titles as one string without a leading article ([#799](https://github.com/thaynes43/haynesnetwork/issues/799) repair) ([#806](https://github.com/thaynes43/haynesnetwork/issues/806)) ([42a5e46](https://github.com/thaynes43/haynesnetwork/commit/42a5e46327a4c50f1cfb65cb45911af8bc048f0b))

## [0.109.2](https://github.com/thaynes43/haynesnetwork/compare/v0.109.1...v0.109.2) (2026-10-07)


### Bug Fixes

* **books:** the Books Census catches a file whose title is the record's with words cut ([#799](https://github.com/thaynes43/haynesnetwork/issues/799)) ([#805](https://github.com/thaynes43/haynesnetwork/issues/805)) ([a30e50b](https://github.com/thaynes43/haynesnetwork/commit/a30e50bd9829b0304d27f5d2752f6b0e131ebfcf))


### Documentation

* **agents:** Books Census [#795](https://github.com/thaynes43/haynesnetwork/issues/795) repaired: 14 re-points, 4 re-downloads, 6 Census Holds ([#800](https://github.com/thaynes43/haynesnetwork/issues/800)) ([89afa4c](https://github.com/thaynes43/haynesnetwork/commit/89afa4c9b7f551ad29ff20adeef014ba08581034))
* **agents:** Census Hold for Magnus Chase 3, whose title the Held File Check misreads ([#795](https://github.com/thaynes43/haynesnetwork/issues/795)) ([#802](https://github.com/thaynes43/haynesnetwork/issues/802)) ([7c2e76b](https://github.com/thaynes43/haynesnetwork/commit/7c2e76b646e77646af407a087f548ef21c56e8d3))
* **agents:** coordinator wave 2026-10-07 (Libretto guards, Books Census, Request Events) ([#803](https://github.com/thaynes43/haynesnetwork/issues/803)) ([dc60c93](https://github.com/thaynes43/haynesnetwork/commit/dc60c93ed6fd7b440c87328f3809371a1ca02a35))
* **libretto:** unnumbered series books are members, never fetched (libretto[#30](https://github.com/thaynes43/haynesnetwork/issues/30)) ([#804](https://github.com/thaynes43/haynesnetwork/issues/804)) ([a56df32](https://github.com/thaynes43/haynesnetwork/commit/a56df3231fe560411d04a6b29c21151b7edfa25b))

## [0.109.1](https://github.com/thaynes43/haynesnetwork/compare/v0.109.0...v0.109.1) (2026-10-07)


### Bug Fixes

* **books:** read the language again after the force-search's and the re-request's own addBook ([#794](https://github.com/thaynes43/haynesnetwork/issues/794)) ([#798](https://github.com/thaynes43/haynesnetwork/issues/798)) ([b0be879](https://github.com/thaynes43/haynesnetwork/commit/b0be87991c91369bcaa764ad301deae6a58b885f))


### Documentation

* **books:** the Books Census's first live run, Divergent repaired, OC-031 ([#795](https://github.com/thaynes43/haynesnetwork/issues/795), [#794](https://github.com/thaynes43/haynesnetwork/issues/794)) ([#796](https://github.com/thaynes43/haynesnetwork/issues/796)) ([c1951e4](https://github.com/thaynes43/haynesnetwork/commit/c1951e4c540b46de8b02cea115ab0a2e87579ea1))

## [0.109.0](https://github.com/thaynes43/haynesnetwork/compare/v0.108.2...v0.109.0) (2026-10-06)


### Features

* **books:** every book_requests write records a Request Event ([#741](https://github.com/thaynes43/haynesnetwork/issues/741)) ([#793](https://github.com/thaynes43/haynesnetwork/issues/793)) ([6695233](https://github.com/thaynes43/haynesnetwork/commit/66952331b8f6ec16845df827ffe7968f18081a73))
* **books:** the Books Census, a daily observe-only census of wrong files and F10 ([#744](https://github.com/thaynes43/haynesnetwork/issues/744), [#781](https://github.com/thaynes43/haynesnetwork/issues/781)) ([#791](https://github.com/thaynes43/haynesnetwork/issues/791)) ([d26ddec](https://github.com/thaynes43/haynesnetwork/commit/d26ddec8a1317788a686be3f2c14bbeafc6a4baa))


### Documentation

* **agents:** coordinator handoff 2026-10-06 (repair wave done, [#742](https://github.com/thaynes43/haynesnetwork/issues/742) in flight, queued safeguards) ([#788](https://github.com/thaynes43/haynesnetwork/issues/788)) ([653722e](https://github.com/thaynes43/haynesnetwork/commit/653722e1538b85245dc37d3a9374c24208fad5df))
* **agents:** name the purge check by its OC id (review follow-up on [#788](https://github.com/thaynes43/haynesnetwork/issues/788)) ([#789](https://github.com/thaynes43/haynesnetwork/issues/789)) ([2a169ff](https://github.com/thaynes43/haynesnetwork/commit/2a169ffd6c03e3023f36d00ae06ead0d1fc92a79))
* **agents:** OC-025 passed, the other authors' books are unqueued ([#786](https://github.com/thaynes43/haynesnetwork/issues/786)) ([9433c83](https://github.com/thaynes43/haynesnetwork/commit/9433c83e11793508c860402d948959b40d80083e))
* **agents:** v0.108.2 + Libretto sha-2e77f28 deploy record, [#771](https://github.com/thaynes43/haynesnetwork/issues/771) and [#777](https://github.com/thaynes43/haynesnetwork/issues/777) closed ([#784](https://github.com/thaynes43/haynesnetwork/issues/784)) ([fe0c819](https://github.com/thaynes43/haynesnetwork/commit/fe0c819af10d3242149e01fc973b3de67f953dfd))
* **design-037:** Libretto's language and held checks, and same-day Kavita metadata ([#790](https://github.com/thaynes43/haynesnetwork/issues/790)) ([fcc4d0f](https://github.com/thaynes43/haynesnetwork/commit/fcc4d0fabf922a1a665faee3957d418fbcf7baeb))
* LazyLibrarian's mobi/azw3 books are converted to EPUB ([#770](https://github.com/thaynes43/haynesnetwork/issues/770)) ([#783](https://github.com/thaynes43/haynesnetwork/issues/783)) ([d39c66b](https://github.com/thaynes43/haynesnetwork/commit/d39c66b61536968c47655ee7bf84f12324ce5f83))
* the four books the EPUB converter held are fixed ([#782](https://github.com/thaynes43/haynesnetwork/issues/782)) ([#787](https://github.com/thaynes43/haynesnetwork/issues/787)) ([0e916e5](https://github.com/thaynes43/haynesnetwork/commit/0e916e5368cea74cd524200977ba0acdcdcb2ed7))

## [0.108.2](https://github.com/thaynes43/haynesnetwork/compare/v0.108.1...v0.108.2) (2026-10-06)


### Bug Fixes

* **books:** a collection want on another author's book is resolved again ([#771](https://github.com/thaynes43/haynesnetwork/issues/771)) ([#780](https://github.com/thaynes43/haynesnetwork/issues/780)) ([97fc458](https://github.com/thaynes43/haynesnetwork/commit/97fc4582b5b72f1967260feb933cc05ae622742e))


### Documentation

* **agents:** v0.108.0 deploy record, owed-check tracker live ([#743](https://github.com/thaynes43/haynesnetwork/issues/743)) ([#775](https://github.com/thaynes43/haynesnetwork/issues/775)) ([2db4e01](https://github.com/thaynes43/haynesnetwork/commit/2db4e012db1273113329173793f28a32a7e3cf40))
* **agents:** v0.108.1 + Libretto sha-080237f deploy record, [#759](https://github.com/thaynes43/haynesnetwork/issues/759) closed ([#778](https://github.com/thaynes43/haynesnetwork/issues/778)) ([d01f6e8](https://github.com/thaynes43/haynesnetwork/commit/d01f6e892cb3b8bf063ba90ea5fa04d55d7c827a))

## [0.108.1](https://github.com/thaynes43/haynesnetwork/compare/v0.108.0...v0.108.1) (2026-10-06)


### Bug Fixes

* **books:** a collection want LazyLibrarian downloaded reads Downloaded, not Wanted ([#759](https://github.com/thaynes43/haynesnetwork/issues/759)) ([#773](https://github.com/thaynes43/haynesnetwork/issues/773)) ([f0e748f](https://github.com/thaynes43/haynesnetwork/commit/f0e748f95fe4467595fa00fd14b7be78bcf80c0e))
* **books:** each collection reads its own target's missing list ([#759](https://github.com/thaynes43/haynesnetwork/issues/759)) ([#769](https://github.com/thaynes43/haynesnetwork/issues/769)) ([2c3f58b](https://github.com/thaynes43/haynesnetwork/commit/2c3f58b925c79a5c75cc2f3d39926c762652fbfb))

## [0.108.0](https://github.com/thaynes43/haynesnetwork/compare/v0.107.11...v0.108.0) (2026-10-06)


### Features

* **agents:** owed-check tracker, read-only runner and overdue alert ([#743](https://github.com/thaynes43/haynesnetwork/issues/743)) ([#768](https://github.com/thaynes43/haynesnetwork/issues/768)) ([d5c210d](https://github.com/thaynes43/haynesnetwork/commit/d5c210d3639a81fb7529d477cbf6684da50233f8))


### Documentation

* **agents:** v0.107.10 + v0.107.11 deploy record, [#739](https://github.com/thaynes43/haynesnetwork/issues/739) [#740](https://github.com/thaynes43/haynesnetwork/issues/740) [#752](https://github.com/thaynes43/haynesnetwork/issues/752) [#761](https://github.com/thaynes43/haynesnetwork/issues/761) closed ([#766](https://github.com/thaynes43/haynesnetwork/issues/766)) ([e27594b](https://github.com/thaynes43/haynesnetwork/commit/e27594b1db7d6417e8e14ddebd2392afb3746773))

## [0.107.11](https://github.com/thaynes43/haynesnetwork/compare/v0.107.10...v0.107.11) (2026-10-06)


### Bug Fixes

* **books:** the Mint Backoff tries new and changed wants before retries ([#740](https://github.com/thaynes43/haynesnetwork/issues/740)) ([#765](https://github.com/thaynes43/haynesnetwork/issues/765)) ([76cc0c9](https://github.com/thaynes43/haynesnetwork/commit/76cc0c97c009938dc9f3506dbe937fca73b50700))


### Documentation

* **agents:** [#755](https://github.com/thaynes43/haynesnetwork/issues/755) follow-up, the Divergent trilogy grab and one more German edition ([#763](https://github.com/thaynes43/haynesnetwork/issues/763)) ([76a1e0c](https://github.com/thaynes43/haynesnetwork/commit/76a1e0cd7496b5a0c36203cd87e9fc1280dca63f))

## [0.107.10](https://github.com/thaynes43/haynesnetwork/compare/v0.107.9...v0.107.10) (2026-10-06)


### Bug Fixes

* **books:** a flat-layout Kavita series keeps its author between syncs, so format pairs stop flapping ([#761](https://github.com/thaynes43/haynesnetwork/issues/761)) ([#762](https://github.com/thaynes43/haynesnetwork/issues/762)) ([7d33be8](https://github.com/thaynes43/haynesnetwork/commit/7d33be86d871d19290ac7de157222c8588f27622))
* **books:** the Volume Check covers the title, unmintable wants back off, a held Skipped format lands ([#739](https://github.com/thaynes43/haynesnetwork/issues/739)) ([#740](https://github.com/thaynes43/haynesnetwork/issues/740)) ([#752](https://github.com/thaynes43/haynesnetwork/issues/752)) ([#760](https://github.com/thaynes43/haynesnetwork/issues/760)) ([218c069](https://github.com/thaynes43/haynesnetwork/commit/218c06984615cda21e85f4e34df988794e047318))


### Documentation

* **agents:** [#755](https://github.com/thaynes43/haynesnetwork/issues/755) closed, LazyLibrarian block and language fix live (haynes-ops [#3432](https://github.com/thaynes43/haynesnetwork/issues/3432)) ([#758](https://github.com/thaynes43/haynesnetwork/issues/758)) ([51f99fb](https://github.com/thaynes43/haynesnetwork/commit/51f99fb82fd2a7b6e86d34754b20f2f2af8b4f0f))
* **agents:** owed checks (k) (l) (n) (o) passed, (p) failed, (j) waiting ([#754](https://github.com/thaynes43/haynesnetwork/issues/754)) ([f4973f3](https://github.com/thaynes43/haynesnetwork/commit/f4973f383e28e6c104b03aa917f7dae377430582))
* **agents:** v0.107.9 deploy record, [#734](https://github.com/thaynes43/haynesnetwork/issues/734) and [#735](https://github.com/thaynes43/haynesnetwork/issues/735) closed ([#757](https://github.com/thaynes43/haynesnetwork/issues/757)) ([183743d](https://github.com/thaynes43/haynesnetwork/commit/183743d12b2d46523200b11ea76cd3179fa7df10))

## [0.107.9](https://github.com/thaynes43/haynesnetwork/compare/v0.107.8...v0.107.9) (2026-10-06)


### Bug Fixes

* **books:** a failed grab stops reading grabbed, and LazyLibrarian unqueues what the app gives up ([#734](https://github.com/thaynes43/haynesnetwork/issues/734)) ([#735](https://github.com/thaynes43/haynesnetwork/issues/735)) ([#751](https://github.com/thaynes43/haynesnetwork/issues/751)) ([494c42d](https://github.com/thaynes43/haynesnetwork/commit/494c42dc6f7a30c02686ffd738bd1c96e1819c1f))


### Documentation

* **agents:** LazyLibrarian overlay harness live, [#738](https://github.com/thaynes43/haynesnetwork/issues/738) and [#736](https://github.com/thaynes43/haynesnetwork/issues/736) closed ([#753](https://github.com/thaynes43/haynesnetwork/issues/753)) ([27bd034](https://github.com/thaynes43/haynesnetwork/commit/27bd034a097c0b5073ff8f20bef6699f6fd4fa17))
* **agents:** v0.107.7 + v0.107.8 deploy record, [#719](https://github.com/thaynes43/haynesnetwork/issues/719) and [#737](https://github.com/thaynes43/haynesnetwork/issues/737) closed ([#749](https://github.com/thaynes43/haynesnetwork/issues/749)) ([98b6716](https://github.com/thaynes43/haynesnetwork/commit/98b671662da1112900e7bea87eb89857ce5e022d))

## [0.107.8](https://github.com/thaynes43/haynesnetwork/compare/v0.107.7...v0.107.8) (2026-10-06)


### Bug Fixes

* **agents:** hold the two corrupt azw3/mobi files ([#728](https://github.com/thaynes43/haynesnetwork/issues/728)) ([efacdde](https://github.com/thaynes43/haynesnetwork/commit/efacddee5d297cf77214538e7a3394133bb44ee5))
* **books:** the English-edition lookup also tries the plain words ([#719](https://github.com/thaynes43/haynesnetwork/issues/719)) ([#748](https://github.com/thaynes43/haynesnetwork/issues/748)) ([4896c62](https://github.com/thaynes43/haynesnetwork/commit/4896c62ef124c7e8c5f68122906a8254e2a7f412))


### Documentation

* **agents:** adversarial review of the books rollout ([#731](https://github.com/thaynes43/haynesnetwork/issues/731)) ([#746](https://github.com/thaynes43/haynesnetwork/issues/746)) ([3bc4777](https://github.com/thaynes43/haynesnetwork/commit/3bc4777f4bf83c1b812f469c675fdb3483eb4af0))
* **ops:** record Moses and Rose Red unmonitored in OPS-018 ([#747](https://github.com/thaynes43/haynesnetwork/issues/747)) ([25f095e](https://github.com/thaynes43/haynesnetwork/commit/25f095e6b34a5834a74f950066b53dd451cd05c9))
* **ops:** record Radarr TMDB naming hint and Carlos unmonitor in OPS-018 ([#745](https://github.com/thaynes43/haynesnetwork/issues/745)) ([7665a9e](https://github.com/thaynes43/haynesnetwork/commit/7665a9ef9cff6d1cc32ed6d3bd295e9674b996f2))

## [0.107.7](https://github.com/thaynes43/haynesnetwork/compare/v0.107.6...v0.107.7) (2026-10-05)


### Bug Fixes

* **books:** a want on a non-English LazyLibrarian book asks for the English edition ([#719](https://github.com/thaynes43/haynesnetwork/issues/719)) ([#726](https://github.com/thaynes43/haynesnetwork/issues/726)) ([6be60d4](https://github.com/thaynes43/haynesnetwork/commit/6be60d426f2a2dc470475df7d77fc09dcd83abdf))


### Documentation

* **agents:** F10 azw3/mobi coverage sweep ([#727](https://github.com/thaynes43/haynesnetwork/issues/727)) ([74b8290](https://github.com/thaynes43/haynesnetwork/commit/74b82908bb1793f510a977b52a72e51f98fd0c0a))
* **agents:** F10 leftovers closed, no foreign-language LL want left ([#721](https://github.com/thaynes43/haynesnetwork/issues/721)) ([76f3abb](https://github.com/thaynes43/haynesnetwork/commit/76f3abb844080404341ed50fdcf0642cbb027ae1))
* **agents:** final F10 sweep of Audiobookshelf and Kavita recorded ([#725](https://github.com/thaynes43/haynesnetwork/issues/725)) ([f94ccbe](https://github.com/thaynes43/haynesnetwork/commit/f94ccbe3f2070bb5c54429776df2ce4fc63366d5))
* **agents:** v0.107.5 deploy record, [#712](https://github.com/thaynes43/haynesnetwork/issues/712) closed ([#723](https://github.com/thaynes43/haynesnetwork/issues/723)) ([3d0ad45](https://github.com/thaynes43/haynesnetwork/commit/3d0ad45bdc935082205ea8d687751fe3c3322eef))
* **agents:** v0.107.6 deploy record, [#715](https://github.com/thaynes43/haynesnetwork/issues/715) closed ([#724](https://github.com/thaynes43/haynesnetwork/issues/724)) ([11b3a4b](https://github.com/thaynes43/haynesnetwork/commit/11b3a4be435c6cdebde2f4aeb3d7fc5f2281b01c))

## [0.107.6](https://github.com/thaynes43/haynesnetwork/compare/v0.107.5...v0.107.6) (2026-10-05)


### Bug Fixes

* **books:** a landed format leaves landed when nothing holds it ([#715](https://github.com/thaynes43/haynesnetwork/issues/715)) ([#720](https://github.com/thaynes43/haynesnetwork/issues/720)) ([113943d](https://github.com/thaynes43/haynesnetwork/commit/113943da9045fe1f1480c92d53e07ca6b4432278))


### Documentation

* **agents:** F10 follow-up, the five out-of-list items fixed ([#718](https://github.com/thaynes43/haynesnetwork/issues/718)) ([9e10b41](https://github.com/thaynes43/haynesnetwork/commit/9e10b4159682c7cc98ff4d3dec1356e99040a061))
* **agents:** F10 foreign editions moved to the holding folder, LL fixed ([#716](https://github.com/thaynes43/haynesnetwork/issues/716)) ([d44e116](https://github.com/thaynes43/haynesnetwork/commit/d44e1167f068e86c6c5d68a2e6044593caf7cf51))

## [0.107.5](https://github.com/thaynes43/haynesnetwork/compare/v0.107.4...v0.107.5) (2026-10-05)


### Bug Fixes

* **books:** re-read edited Kavita metadata and lift foreign_language parks ([#712](https://github.com/thaynes43/haynesnetwork/issues/712)) ([#714](https://github.com/thaynes43/haynesnetwork/issues/714)) ([aa098c4](https://github.com/thaynes43/haynesnetwork/commit/aa098c4ec5f857ab538d03c920b2eee278b88d9d))


### Documentation

* **agents:** library language audit, Kavita corrections not yet visible to the app ([#713](https://github.com/thaynes43/haynesnetwork/issues/713)) ([5db9704](https://github.com/thaynes43/haynesnetwork/commit/5db9704e8517bdd5b11470369f800c497fccdfdd))
* **agents:** v0.107.3 + v0.107.4 deploy record, [#700](https://github.com/thaynes43/haynesnetwork/issues/700) closed ([#710](https://github.com/thaynes43/haynesnetwork/issues/710)) ([425d0c1](https://github.com/thaynes43/haynesnetwork/commit/425d0c19b3ca8a3bb5bdb9022e958a84493b40f9))

## [0.107.4](https://github.com/thaynes43/haynesnetwork/compare/v0.107.3...v0.107.4) (2026-10-05)


### Bug Fixes

* **books:** park every open want on a foreign-language anchor ([#700](https://github.com/thaynes43/haynesnetwork/issues/700)) ([#708](https://github.com/thaynes43/haynesnetwork/issues/708)) ([711ebfe](https://github.com/thaynes43/haynesnetwork/commit/711ebfec65aff0576d33b3977e6c0f8d44216e66))

## [0.107.3](https://github.com/thaynes43/haynesnetwork/compare/v0.107.2...v0.107.3) (2026-10-05)


### Bug Fixes

* **books:** pairing never asks for the other format of a foreign-language item ([#700](https://github.com/thaynes43/haynesnetwork/issues/700)) ([#707](https://github.com/thaynes43/haynesnetwork/issues/707)) ([038a949](https://github.com/thaynes43/haynesnetwork/commit/038a949fdaf994605b26f592a404ed860f6a0cbc))


### Documentation

* **agents:** The Runaway Jury audiobook title restored; stale in-folder metadata held ([#704](https://github.com/thaynes43/haynesnetwork/issues/704)) ([de7f06a](https://github.com/thaynes43/haynesnetwork/commit/de7f06a4e0a818a66d7003ceed78642638b2fd0f))
* **agents:** v0.107.1 + v0.107.2 deploy record, [#693](https://github.com/thaynes43/haynesnetwork/issues/693) repaired and closed ([#703](https://github.com/thaynes43/haynesnetwork/issues/703)) ([8575654](https://github.com/thaynes43/haynesnetwork/commit/857565491b8081c3380b2ed2ce8aea3c261f60e9))

## [0.107.2](https://github.com/thaynes43/haynesnetwork/compare/v0.107.1...v0.107.2) (2026-10-05)


### Bug Fixes

* **books:** conform the wants a repair parked by hand ([#693](https://github.com/thaynes43/haynesnetwork/issues/693)) ([#701](https://github.com/thaynes43/haynesnetwork/issues/701)) ([ceeed88](https://github.com/thaynes43/haynesnetwork/commit/ceeed88eee463f66c43e20e42b1a3f36ab555b1d))


### Documentation

* **agents:** German Chroniken books out under F10; holding folder sorted, owed check (m) ([#696](https://github.com/thaynes43/haynesnetwork/issues/696)) ([9a991a0](https://github.com/thaynes43/haynesnetwork/commit/9a991a0f44bb6bbd31552fdc8919e970cb57b2c8))

## [0.107.1](https://github.com/thaynes43/haynesnetwork/compare/v0.107.0...v0.107.1) (2026-10-05)


### Bug Fixes

* **books:** a request is never satisfied by another volume ([#693](https://github.com/thaynes43/haynesnetwork/issues/693)) ([#698](https://github.com/thaynes43/haynesnetwork/issues/698)) ([771ac08](https://github.com/thaynes43/haynesnetwork/commit/771ac080093607b405122cb0b385e168902673cc))


### Documentation

* **agents:** [#668](https://github.com/thaynes43/haynesnetwork/issues/668) search check — 1,059 Prowlarr queries for 352 items, nothing searched twice ([#684](https://github.com/thaynes43/haynesnetwork/issues/684)) ([f136b09](https://github.com/thaynes43/haynesnetwork/commit/f136b09601b202fc9583163681724fb2b7a7ff34))
* **agents:** [#688](https://github.com/thaynes43/haynesnetwork/issues/688) fault 1 live (haynes-ops [#3367](https://github.com/thaynes43/haynesnetwork/issues/3367)), fault 2 needs a volume source ([#690](https://github.com/thaynes43/haynesnetwork/issues/690)) ([5465beb](https://github.com/thaynes43/haynesnetwork/commit/5465beb697ff47f812ca92d127e3a49b7401e832))
* **agents:** [#688](https://github.com/thaynes43/haynesnetwork/issues/688) fault 2 live (haynes-ops [#3368](https://github.com/thaynes43/haynesnetwork/issues/3368)), issue closed ([#691](https://github.com/thaynes43/haynesnetwork/issues/691)) ([bdbdfad](https://github.com/thaynes43/haynesnetwork/commit/bdbdfad6f28c97870a1e5a45fc50b152daaa76a2))
* **agents:** [#694](https://github.com/thaynes43/haynesnetwork/issues/694) live (haynes-ops [#3369](https://github.com/thaynes43/haynesnetwork/issues/3369)), issue closed ([#697](https://github.com/thaynes43/haynesnetwork/issues/697)) ([f1f2d69](https://github.com/thaynes43/haynesnetwork/commit/f1f2d691d78bd658e0eec80a295cc91820fae4cb))
* **agents:** Assistant to the Villain wrong grab repaired ([#686](https://github.com/thaynes43/haynesnetwork/issues/686)), LL defects filed ([#688](https://github.com/thaynes43/haynesnetwork/issues/688)) ([#689](https://github.com/thaynes43/haynesnetwork/issues/689)) ([eff2095](https://github.com/thaynes43/haynesnetwork/commit/eff2095c75edc6c74e072277f0a7dda57316ffd6))
* **agents:** cross-volume repair of the 19 LL records behind [#688](https://github.com/thaynes43/haynesnetwork/issues/688)'s 153 rows ([#695](https://github.com/thaynes43/haynesnetwork/issues/695)) ([e9d0bd9](https://github.com/thaynes43/haynesnetwork/commit/e9d0bd9f1418d68cd090300265280cdb5035e8d9))
* **agents:** owed check (c) passed; rename older check (g) to (j) ([#685](https://github.com/thaynes43/haynesnetwork/issues/685)) ([fbba1ae](https://github.com/thaynes43/haynesnetwork/commit/fbba1aed47921f54a73553b829dc093fecb7a350))
* **agents:** post-07:00Z checks (g) pass, (h) trip project_number, (d) and (e) no violation (2026-10-05) ([#687](https://github.com/thaynes43/haynesnetwork/issues/687)) ([f88c439](https://github.com/thaynes43/haynesnetwork/commit/f88c439248ec32842312606ba884a50f098909d7))
* **agents:** say what happens to the [#688](https://github.com/thaynes43/haynesnetwork/issues/688) per-title block rows ([#692](https://github.com/thaynes43/haynesnetwork/issues/692)) ([bf9001d](https://github.com/thaynes43/haynesnetwork/commit/bf9001d3a13dae1396dc1d46f8f47484a78744f0))
* **agents:** v0.107.0 deploy record, GB quota instrumentation ([#674](https://github.com/thaynes43/haynesnetwork/issues/674) benched) ([#682](https://github.com/thaynes43/haynesnetwork/issues/682)) ([97c9f3c](https://github.com/thaynes43/haynesnetwork/commit/97c9f3cd697495b40350044d796632ca4beb5fc6))

## [0.107.0](https://github.com/thaynes43/haynesnetwork/compare/v0.106.1...v0.107.0) (2026-10-05)


### Features

* **books:** log each Google Books quota-day's usage and every quota trip ([#674](https://github.com/thaynes43/haynesnetwork/issues/674)) ([#681](https://github.com/thaynes43/haynesnetwork/issues/681)) ([07c6415](https://github.com/thaynes43/haynesnetwork/commit/07c64159613aa909d9bf793026f488a383a9f1a4))


### Documentation

* **agents:** owed checks (a) passed, (b) still waiting, (d) no violation, (e) no box set (2026-10-04) ([#680](https://github.com/thaynes43/haynesnetwork/issues/680)) ([b8717e0](https://github.com/thaynes43/haynesnetwork/commit/b8717e04f3334e7fdf053cc32683c0de496d1a9f))
* **agents:** v0.106.0 + v0.106.1 deploy record ([#668](https://github.com/thaynes43/haynesnetwork/issues/668) re-request), owed check (f) ([#678](https://github.com/thaynes43/haynesnetwork/issues/678)) ([3c3c59d](https://github.com/thaynes43/haynesnetwork/commit/3c3c59db9af54948d176228799f4e58d4a88f515))

## [0.106.1](https://github.com/thaynes43/haynesnetwork/compare/v0.106.0...v0.106.1) (2026-10-04)


### Bug Fixes

* **books:** a quota-wall refusal is not counted, and a refused re-request retries next quota-day ([#676](https://github.com/thaynes43/haynesnetwork/issues/676)) ([ac19dca](https://github.com/thaynes43/haynesnetwork/commit/ac19dca2e8e35cc4c988f2baec1600d51a9bada5))

## [0.106.0](https://github.com/thaynes43/haynesnetwork/compare/v0.105.5...v0.106.0) (2026-10-04)


### Features

* **books:** hand every settled want back to LazyLibrarian once, add and queue only ([#675](https://github.com/thaynes43/haynesnetwork/issues/675)) ([88f47d8](https://github.com/thaynes43/haynesnetwork/commit/88f47d83f889930338072533e7f0ba84c86d1acd))


### Documentation

* **agents:** v0.105.4 + v0.105.5 deploy record, [#665](https://github.com/thaynes43/haynesnetwork/issues/665) requests settled ([#672](https://github.com/thaynes43/haynesnetwork/issues/672)) ([8709c96](https://github.com/thaynes43/haynesnetwork/commit/8709c96a241722c51e756eb5125772680fa031e3))

## [0.105.5](https://github.com/thaynes43/haynesnetwork/compare/v0.105.4...v0.105.5) (2026-10-04)


### Bug Fixes

* **pairing:** read a want's format from its anchor and land the held format ([#670](https://github.com/thaynes43/haynesnetwork/issues/670)) ([78f8382](https://github.com/thaynes43/haynesnetwork/commit/78f8382d315fdd5251691ddc97ec7b90fb78cd3c))

## [0.105.4](https://github.com/thaynes43/haynesnetwork/compare/v0.105.3...v0.105.4) (2026-10-04)


### Bug Fixes

* **books:** a want whose LazyLibrarian book is gone re-keys or settles instead of hanging ([#669](https://github.com/thaynes43/haynesnetwork/issues/669)) ([90ccfc5](https://github.com/thaynes43/haynesnetwork/commit/90ccfc5025a26af1eadf8b4c64c756e86ef81584))


### Documentation

* **agents:** v0.105.3 deploy record, [#661](https://github.com/thaynes43/haynesnetwork/issues/661) pairing repair, owed check ([#666](https://github.com/thaynes43/haynesnetwork/issues/666)) ([23f4e30](https://github.com/thaynes43/haynesnetwork/commit/23f4e30067e8b806064981fba495872de64e4703))

## [0.105.3](https://github.com/thaynes43/haynesnetwork/compare/v0.105.2...v0.105.3) (2026-10-04)


### Bug Fixes

* **pairing:** a Kavita anchor pairs and is wanted as the book it holds, not its series name ([#664](https://github.com/thaynes43/haynesnetwork/issues/664)) ([4e14659](https://github.com/thaynes43/haynesnetwork/commit/4e1465930a753344ccb7d742d12db0a537a37a5f))


### Documentation

* **agents:** v0.105.2 deploy record, LL bundle audit, owed checks ([#662](https://github.com/thaynes43/haynesnetwork/issues/662)) ([fc3fb54](https://github.com/thaynes43/haynesnetwork/commit/fc3fb54ef6fbd408b3408d131d143002e5138c7d))

## [0.105.2](https://github.com/thaynes43/haynesnetwork/compare/v0.105.1...v0.105.2) (2026-10-03)


### Bug Fixes

* **goodreads:** GB title resolve rejects omnibus/bundle volumes the query did not ask for ([#658](https://github.com/thaynes43/haynesnetwork/issues/658)) ([46806e9](https://github.com/thaynes43/haynesnetwork/commit/46806e94c01fabcdaf6227ed0f7977717fb05866))
* **janitor:** a release held on the delay profile is waiting, not unknown ([#657](https://github.com/thaynes43/haynesnetwork/issues/657)) ([f5b883c](https://github.com/thaynes43/haynesnetwork/commit/f5b883c23b8544abc6bed0d35b7c464d149761cc))
* **pairing:** a parked pairing want is never re-resolved or re-queued ([#660](https://github.com/thaynes43/haynesnetwork/issues/660)) ([26baac9](https://github.com/thaynes43/haynesnetwork/commit/26baac9dec3f17fbccca4cadce5e804bd4fbda25))
* **trash:** a fast green-light no longer leaves the tab on a stale Admin review (closes [#654](https://github.com/thaynes43/haynesnetwork/issues/654)) ([#659](https://github.com/thaynes43/haynesnetwork/issues/659)) ([cd03d76](https://github.com/thaynes43/haynesnetwork/commit/cd03d76081b798d52075e80caa5d880c68c67230))


### Documentation

* **agents:** v0.105.0 + v0.105.1 deploy record, backfill totals, Redownload off ([#655](https://github.com/thaynes43/haynesnetwork/issues/655)) ([3f85411](https://github.com/thaynes43/haynesnetwork/commit/3f85411b27b2ea47a4391c56b46ab997cd9c2c63))

## [0.105.1](https://github.com/thaynes43/haynesnetwork/compare/v0.105.0...v0.105.1) (2026-10-03)


### Bug Fixes

* **fix:** a Fix makes exactly one search (skip its own when the *arr's Redownload Failed will search) ([#651](https://github.com/thaynes43/haynesnetwork/issues/651)) ([181f26d](https://github.com/thaynes43/haynesnetwork/commit/181f26df407be2969778636a0cf42b66a2ed9464)), closes [#646](https://github.com/thaynes43/haynesnetwork/issues/646)
* **trash:** a Save is recorded first and the Maintainerr exclusion follows it (ADR-099) ([#652](https://github.com/thaynes43/haynesnetwork/issues/652)) ([1e75f3e](https://github.com/thaynes43/haynesnetwork/commit/1e75f3ee93dfcb2d71477c1957542ef49981ae8e))
* **trash:** Expedite and the pending walls honor the Age Guard (Q-14) ([#650](https://github.com/thaynes43/haynesnetwork/issues/650)) ([77e875a](https://github.com/thaynes43/haynesnetwork/commit/77e875a784363814e3bab0d4f3d322e66efa568c))

## [0.105.0](https://github.com/thaynes43/haynesnetwork/compare/v0.104.1...v0.105.0) (2026-10-03)


### Features

* exclude Trash-deleted titles from automation (ADR-097) ([#643](https://github.com/thaynes43/haynesnetwork/issues/643)) ([440634a](https://github.com/thaynes43/haynesnetwork/commit/440634a14c24f1148611d350c185b6a880a70ff1))


### Bug Fixes

* format-pairing searches once per book, and jobs share search coverage ([#649](https://github.com/thaynes43/haynesnetwork/issues/649)) ([b638205](https://github.com/thaynes43/haynesnetwork/commit/b63820596fb6459a429a0439fb0225cbb655ccec))
* **janitor:** one search budget per title (two tries in any 30 days); the janitor retries failed Sonarr/Radarr downloads once (ADR-098) ([#647](https://github.com/thaynes43/haynesnetwork/issues/647)) ([8df6f8d](https://github.com/thaynes43/haynesnetwork/commit/8df6f8d90d64273cfe43e958f4157009eba9cd9c))
* one LazyLibrarian searchBook per book per run (searchBook ignores type) ([#648](https://github.com/thaynes43/haynesnetwork/issues/648)) ([8e09dcc](https://github.com/thaynes43/haynesnetwork/commit/8e09dcc025984493244a86152bb3a832d848af99)), closes [#644](https://github.com/thaynes43/haynesnetwork/issues/644)
* **sync:** attach *arr history that was ingested before its title row ([#640](https://github.com/thaynes43/haynesnetwork/issues/640)) ([c363e67](https://github.com/thaynes43/haynesnetwork/commit/c363e67218a3f4f3a0850e5b35474631f663de6e))
* **test:** startPostgres no longer hangs when a boot loses the port race ([#634](https://github.com/thaynes43/haynesnetwork/issues/634)) ([272a9a7](https://github.com/thaynes43/haynesnetwork/commit/272a9a7ac22fd8ae2078a3f7f0945ce3d812c0c7))
* **trash:** Age Guard keeps anything downloaded, upgraded or added in 180 days ([#641](https://github.com/thaynes43/haynesnetwork/issues/641)) ([2878e5b](https://github.com/thaynes43/haynesnetwork/commit/2878e5b4fb70d6b04207ecbc7d60e70d8b10a915))
* **trash:** show a wall save only after the server confirms it ([#645](https://github.com/thaynes43/haynesnetwork/issues/645)) ([c19263c](https://github.com/thaynes43/haynesnetwork/commit/c19263cdc10021e5e64c5b537fbf5026a09e6558))


### Documentation

* **agents:** [#631](https://github.com/thaynes43/haynesnetwork/issues/631) close-out record (LL eBook rows, multi-release audiobooks, Midnight Sun) ([#638](https://github.com/thaynes43/haynesnetwork/issues/638)) ([103a892](https://github.com/thaynes43/haynesnetwork/commit/103a892d0d927f79c89601fe1ba16109608c4ab2))
* **agents:** HANDOFF — janitor L2 + suite-wide, LazyLibrarian repair ([#636](https://github.com/thaynes43/haynesnetwork/issues/636)) ([59423f4](https://github.com/thaynes43/haynesnetwork/commit/59423f40e9dc4717bccb1a54f8026c1256bf6229))
* **agents:** LazyLibrarian scan bug fixed at the source, [#631](https://github.com/thaynes43/haynesnetwork/issues/631) damage repaired ([#635](https://github.com/thaynes43/haynesnetwork/issues/635)) ([075d7f0](https://github.com/thaynes43/haynesnetwork/commit/075d7f0a066b660e7cfbdec31e374b59d67b1d98))
* **agents:** LL library audit, wrong-book files across every held book ([#632](https://github.com/thaynes43/haynesnetwork/issues/632)) ([a12884c](https://github.com/thaynes43/haynesnetwork/commit/a12884ce1a2b0751c572fd07bb54b61c92a22683))

## [0.104.1](https://github.com/thaynes43/haynesnetwork/compare/v0.104.0...v0.104.1) (2026-09-29)


### Bug Fixes

* **janitor:** a leftover folder must hold the same book files as its library copy (D-22) ([#628](https://github.com/thaynes43/haynesnetwork/issues/628)) ([fe51f75](https://github.com/thaynes43/haynesnetwork/commit/fe51f7585010353610f97ed8f58e0736a1481d06)), closes [#621](https://github.com/thaynes43/haynesnetwork/issues/621)
* **janitor:** loop_detected logs a new loop once; LazyLibrarian fail loops characterized and cleared (D-21) ([#622](https://github.com/thaynes43/haynesnetwork/issues/622)) ([7759692](https://github.com/thaynes43/haynesnetwork/commit/77596928f51bbf380364712f1d144412f87f65c3))
* **lazylibrarian:** addBook waits for LL to finish before queueBook ([#626](https://github.com/thaynes43/haynesnetwork/issues/626)) ([831089e](https://github.com/thaynes43/haynesnetwork/commit/831089e0fa4ead12a155c56905a05982b5d849cd))


### Documentation

* **agents:** LL fail-loops follow-up, the Wild Cards I and Last Olympian eBooks fixed ([#625](https://github.com/thaynes43/haynesnetwork/issues/625)) ([efd21df](https://github.com/thaynes43/haynesnetwork/commit/efd21df45c2d3b8b8d0cda2c34a44c6d15ba3dff))
* **agents:** LL wrong-volumes follow-up, what was cleaned afterwards ([#629](https://github.com/thaynes43/haynesnetwork/issues/629)) ([0471f38](https://github.com/thaynes43/haynesnetwork/commit/0471f385c18746dab51f597a5bad8b446bb48422))
* **janitor:** books/comics family spot-check and promotion ([#624](https://github.com/thaynes43/haynesnetwork/issues/624)) ([2b025c3](https://github.com/thaynes43/haynesnetwork/commit/2b025c395bd15cf9f5bd260b597efea1b8f60221))

## [0.104.0](https://github.com/thaynes43/haynesnetwork/compare/v0.103.0...v0.104.0) (2026-09-29)


### Features

* **janitor:** cover the download suite: LazyLibrarian and Kapowarr through a source adapter, a ladder per family ([#620](https://github.com/thaynes43/haynesnetwork/issues/620)) ([84d9c9b](https://github.com/thaynes43/haynesnetwork/commit/84d9c9ba06ebe4a8d3fa3cb517e84d72819933fc))


### Documentation

* **janitor:** PLAN-065 — promoted to L2 (owner ruling, no calendar wait) ([#618](https://github.com/thaynes43/haynesnetwork/issues/618)) ([6178f81](https://github.com/thaynes43/haynesnetwork/commit/6178f81a2cb70cdc240f3ebe2535a680f3f68a13))

## [0.103.0](https://github.com/thaynes43/haynesnetwork/compare/v0.102.0...v0.103.0) (2026-09-29)


### Features

* **janitor:** Lidarr manual_match acts, blocking the failing release name first, behind a loop guard ([#617](https://github.com/thaynes43/haynesnetwork/issues/617)) ([2084e0a](https://github.com/thaynes43/haynesnetwork/commit/2084e0a5cb3d2f7b5f8ca318098e9c16f48a0544))


### Bug Fixes

* **activity:** read LazyLibrarian getHistory (the grab log), not getWanted (the book list) ([#616](https://github.com/thaynes43/haynesnetwork/issues/616)) ([49d946e](https://github.com/thaynes43/haynesnetwork/commit/49d946e5efbb4315a555908ec2974e1d71f7234c)), closes [#615](https://github.com/thaynes43/haynesnetwork/issues/615) [#562](https://github.com/thaynes43/haynesnetwork/issues/562)


### Documentation

* **agents:** HANDOFF — v0.101.3/v0.102.0 live, janitor Q-01 answered, Lidarr cleanup ([#613](https://github.com/thaynes43/haynesnetwork/issues/613)) ([f989ab5](https://github.com/thaynes43/haynesnetwork/commit/f989ab566ea07a691d96dc6dcb2e294acc162c98))

## [0.102.0](https://github.com/thaynes43/haynesnetwork/compare/v0.101.3...v0.102.0) (2026-09-29)


### Features

* **janitor:** answer Q-01, Lidarr match rejections become the report-only class manual_match ([#611](https://github.com/thaynes43/haynesnetwork/issues/611)) ([7907a19](https://github.com/thaynes43/haynesnetwork/commit/7907a19fa0fe29ba90ceb155f29fcf69fd7b94e6))

## [0.101.3](https://github.com/thaynes43/haynesnetwork/compare/v0.101.2...v0.101.3) (2026-09-29)


### Bug Fixes

* **janitor:** act once per download, so a season pack is removed once, not once per episode ([#608](https://github.com/thaynes43/haynesnetwork/issues/608)) ([6446de4](https://github.com/thaynes43/haynesnetwork/commit/6446de448b6c4f5e801e1d37fa4e19c057c2cd8f))


### Documentation

* **agents:** update subagent delegation to the pod's two-tier policy ([#606](https://github.com/thaynes43/haynesnetwork/issues/606)) ([087d900](https://github.com/thaynes43/haynesnetwork/commit/087d9008dd4fd5f3b41c9ea97f6b34be823230ab))
* **trash:** owner ruling on the Release Block term life (keep 365 days); HANDOFF ([#609](https://github.com/thaynes43/haynesnetwork/issues/609)) ([b8c1518](https://github.com/thaynes43/haynesnetwork/commit/b8c1518e6791a8d2737410600deb5f93f03b787c))
* **trash:** PLAN-072 — the owner's ruling on the interim Saves, applied ([#604](https://github.com/thaynes43/haynesnetwork/issues/604)) ([fd9989e](https://github.com/thaynes43/haynesnetwork/commit/fd9989e94ffad5b56f4879639eab7299d82df78f))
* **trash:** PLAN-072 close-out residuals (S5, Q-04, Q-09, Q-10, Q-11) ([#607](https://github.com/thaynes43/haynesnetwork/issues/607)) ([13fb30f](https://github.com/thaynes43/haynesnetwork/commit/13fb30fc41abff31479e0ede00a07b1d73fca272))

## [0.101.2](https://github.com/thaynes43/haynesnetwork/compare/v0.101.1...v0.101.2) (2026-09-28)


### Bug Fixes

* **trash:** Seerr's Sonarr settings PUT omits the read-only id; PLAN-072 S8–S11 close-out (ADR-093 / DESIGN-052 Accepted) ([#603](https://github.com/thaynes43/haynesnetwork/issues/603)) ([20e3baa](https://github.com/thaynes43/haynesnetwork/commit/20e3baab0bdfe5fdbd8f129733d4c042e2e39b40))


### Documentation

* **trash:** PLAN-072 S6(h) passed, S0 final check, the sweep resumed (haynes-ops [#3227](https://github.com/thaynes43/haynesnetwork/issues/3227)) ([#600](https://github.com/thaynes43/haynesnetwork/issues/600)) ([0b4686a](https://github.com/thaynes43/haynesnetwork/commit/0b4686ac9a13603debb886064c0c4d25bb679b92))
* **trash:** PLAN-072 S7 passed, the first guarded sweep ([#602](https://github.com/thaynes43/haynesnetwork/issues/602)) ([16f0a21](https://github.com/thaynes43/haynesnetwork/commit/16f0a21d79488ff107148a8885965e97a3bcd90a))

## [0.101.1](https://github.com/thaynes43/haynesnetwork/compare/v0.101.0...v0.101.1) (2026-09-27)


### Bug Fixes

* **trash:** release-block terms match apostrophes and accents; PLAN-072 S6 results ([#599](https://github.com/thaynes43/haynesnetwork/issues/599)) ([18586f0](https://github.com/thaynes43/haynesnetwork/commit/18586f07620bd4e048d3853bddb01512d7a2d938))


### Documentation

* **trash:** PLAN-072 rollout suspends and resumes CronJobs only in haynes-ops git; registry CronJob backoffLimit 0; OPS-017 Active ([#596](https://github.com/thaynes43/haynesnetwork/issues/596)) ([b14fbc0](https://github.com/thaynes43/haynesnetwork/commit/b14fbc0081e70b887840d4d5b07fa4789c47849f))

## [0.101.0](https://github.com/thaynes43/haynesnetwork/compare/v0.100.0...v0.101.0) (2026-09-27)


### Features

* **trash:** watchlists protect titles from Trash; a re-request never re-fetches the deleted release (PLAN-072 S2) ([#595](https://github.com/thaynes43/haynesnetwork/issues/595)) ([8791bfa](https://github.com/thaynes43/haynesnetwork/commit/8791bfa33aabf59f9d8dcc217e4ea09a2f12f94b))


### Documentation

* **mcp:** PLAN-069 S8 evidence — ChatGPT and Codex connected; OPS-016 runbook fixes ([#586](https://github.com/thaynes43/haynesnetwork/issues/586)) ([a2750b2](https://github.com/thaynes43/haynesnetwork/commit/a2750b21a2776763cebd00173bdb44c764ff3eab))
* **mcp:** PLAN-071 S3–S6 — watchlist tools live; ADR-092 / DESIGN-051 Accepted ([#588](https://github.com/thaynes43/haynesnetwork/issues/588)) ([baba734](https://github.com/thaynes43/haynesnetwork/commit/baba7341e1dd1d1e0d25a4b87acbc99ea70d7e10))
* **trash:** ADR-093 / DESIGN-052 / PLAN-072 — watchlists protect titles from Trash; a re-request never re-fetches the deleted release ([#594](https://github.com/thaynes43/haynesnetwork/issues/594)) ([738161f](https://github.com/thaynes43/haynesnetwork/commit/738161f0e9be3f949e21a9819965cf639e87de5b))

## [0.100.0](https://github.com/thaynes43/haynesnetwork/compare/v0.99.0...v0.100.0) (2026-09-26)


### Features

* **mcp:** the owner's Plex watchlist through the watch tools (watchlist, set_watchlist, "on your watchlist", undoable changes) ([#580](https://github.com/thaynes43/haynesnetwork/issues/580)) ([c5491ab](https://github.com/thaynes43/haynesnetwork/commit/c5491ab2a3410d0623555f4fef65269dd5897ffc))


### Documentation

* **handoff:** Haynes Quest portal card live in v0.99.0 (PRD R-254) ([#581](https://github.com/thaynes43/haynesnetwork/issues/581)) ([6d02ca5](https://github.com/thaynes43/haynesnetwork/commit/6d02ca5e3c73945f254a55a7c3f78ff531f947da))
* **janitor:** PLAN-065 ladder log — promoted to L1; the L1 audit and its follow-ups ([#583](https://github.com/thaynes43/haynesnetwork/issues/583)) ([#584](https://github.com/thaynes43/haynesnetwork/issues/584)) ([0e15153](https://github.com/thaynes43/haynesnetwork/commit/0e15153cabfabeeed1994e6dc0b06f93b350d33b))

## [0.99.0](https://github.com/thaynes43/haynesnetwork/compare/v0.98.0...v0.99.0) (2026-09-25)


### Features

* **portal:** seed the Haynes Quest card for Family (PRD R-254, migration 0079) ([#578](https://github.com/thaynes43/haynesnetwork/issues/578)) ([451e9eb](https://github.com/thaynes43/haynesnetwork/commit/451e9eb36c406b49aebe3133c6916b8e170db576))


### Bug Fixes

* **janitor:** no re-search on removal, identity-mismatch guard, message-only reasons, release-level sample ([#579](https://github.com/thaynes43/haynesnetwork/issues/579)) ([daa4633](https://github.com/thaynes43/haynesnetwork/commit/daa4633ee26664fdf91f60259c292561204e31a6))


### Documentation

* **mcp:** ADR-092 / DESIGN-051 / PLAN-071 — the owner's Plex watchlist through the watch tools ([#577](https://github.com/thaynes43/haynesnetwork/issues/577)) ([a0b5c74](https://github.com/thaynes43/haynesnetwork/commit/a0b5c74078e51191f9a416da977c049555e803b5))
* **mcp:** PLAN-069 S1–S7 done — v0.98.0 live; the owner's ChatGPT connect is the last gate ([#574](https://github.com/thaynes43/haynesnetwork/issues/574)) ([abe3806](https://github.com/thaynes43/haynesnetwork/commit/abe38062e860865c6930d21912054d875878acf6))

## [0.98.0](https://github.com/thaynes43/haynesnetwork/compare/v0.97.1...v0.98.0) (2026-09-24)


### Features

* **mcp:** public OAuth connectors for the MCP surface — the in-app authorization server, POST /mcp, Connected apps (PLAN-069 S2–S6) ([#572](https://github.com/thaynes43/haynesnetwork/issues/572)) ([93d76a9](https://github.com/thaynes43/haynesnetwork/commit/93d76a9b88e40e37023ee60d4d6877d1e28f743f))


### Documentation

* **mcp:** ADR-091 / DESIGN-050 / PLAN-069 — public OAuth connectors for the MCP surface ([#571](https://github.com/thaynes43/haynesnetwork/issues/571)) ([e4d6bc1](https://github.com/thaynes43/haynesnetwork/commit/e4d6bc13697270e8025fc05237fbffb7995af742))
* **mcp:** DESIGN-050 D-15 — the build and review rulings from PR [#572](https://github.com/thaynes43/haynesnetwork/issues/572) ([#573](https://github.com/thaynes43/haynesnetwork/issues/573)) ([0e8568a](https://github.com/thaynes43/haynesnetwork/commit/0e8568a18a17787221f2710bb3f1f485c1178334))
* **watch:** PLAN-068 completed — v0.97.1 live, AC-24 passed; ADR-087/088/089 Accepted ([#568](https://github.com/thaynes43/haynesnetwork/issues/568)) ([c443de9](https://github.com/thaynes43/haynesnetwork/commit/c443de91a4267eef1b6ba5d473ace53586b7f6d9))

## [0.97.1](https://github.com/thaynes43/haynesnetwork/compare/v0.97.0...v0.97.1) (2026-09-23)


### Bug Fixes

* **watch:** marks never write the show key; specials never take part; counters re-read after a mark or undo ([#567](https://github.com/thaynes43/haynesnetwork/issues/567)) ([18bde65](https://github.com/thaynes43/haynesnetwork/commit/18bde65c231ad9e715c3a02eb57b844ed444f8f4))

## [0.97.0](https://github.com/thaynes43/haynesnetwork/compare/v0.96.5...v0.97.0) (2026-09-23)


### Features

* **mcp:** the in-cluster Watch history MCP endpoint (PLAN-068 S7–S8) ([#566](https://github.com/thaynes43/haynesnetwork/issues/566)) ([de4b2fc](https://github.com/thaynes43/haynesnetwork/commit/de4b2fcd0fc2a7b4f5b53b287cc939f23c4ef320))
* **watch:** domain writers, mark flows and the watch sync mode (PLAN-068 S5–S6) ([#563](https://github.com/thaynes43/haynesnetwork/issues/563)) ([8f16eb0](https://github.com/thaynes43/haynesnetwork/commit/8f16eb088e1fc3d89179c2916ae4448cfce65f6f))
* **watch:** foundation — schema, clients, key redaction, stubs (PLAN-068 S1–S3) ([#559](https://github.com/thaynes43/haynesnetwork/issues/559)) ([ec90cf1](https://github.com/thaynes43/haynesnetwork/commit/ec90cf1ce0b48063b35595852194ebb082c36d8a))
* **watch:** pure progress, resolver, recommendation and spoken-text math (PLAN-068 S4) ([#558](https://github.com/thaynes43/haynesnetwork/issues/558)) ([d79c19e](https://github.com/thaynes43/haynesnetwork/commit/d79c19e630b98600eac2a294a7a3eea6c078c3dd))


### Bug Fixes

* **activity:** retire the per-failure push and read each *arr queue whole (prepares [#556](https://github.com/thaynes43/haynesnetwork/issues/556)) ([#561](https://github.com/thaynes43/haynesnetwork/issues/561)) ([e2a0920](https://github.com/thaynes43/haynesnetwork/commit/e2a0920358e22c987717cef399ad16c54ce737d0))

## [0.96.5](https://github.com/thaynes43/haynesnetwork/compare/v0.96.4...v0.96.5) (2026-09-23)


### Bug Fixes

* **library:** wire the ADR-053 Plex Account Map so per-user watch state fills ([#557](https://github.com/thaynes43/haynesnetwork/issues/557)) ([72cdbca](https://github.com/thaynes43/haynesnetwork/commit/72cdbca9f747e99fcb632df44c5c5058ff3cd689))


### Documentation

* **agents:** v0.96.4 rolled out and verified (3/3, health 200) — and KICKOFF's reconcile namespace was wrong ([#550](https://github.com/thaynes43/haynesnetwork/issues/550)) ([1231f51](https://github.com/thaynes43/haynesnetwork/commit/1231f5192a5315ab2cabea2b85c532f18e6c5e14))
* Watch Companion design — ADR-087/088/089, DESIGN-049, PLAN-068 ([#552](https://github.com/thaynes43/haynesnetwork/issues/552)) ([05c5242](https://github.com/thaynes43/haynesnetwork/commit/05c52422036691abf0817a790981ca7d7aef0176))

## [0.96.4](https://github.com/thaynes43/haynesnetwork/compare/v0.96.3...v0.96.4) (2026-09-22)


### Bug Fixes

* **books:** Force Search declines a copy LazyLibrarian already has (the fifth LL site) ([#549](https://github.com/thaynes43/haynesnetwork/issues/549)) ([353f201](https://github.com/thaynes43/haynesnetwork/commit/353f2019ac0dc450946a502756ef7f9265ab1f01))


### Documentation

* **agents:** v0.96.3 rolled out and verified — the guard stopped 30 clobbers in its first hour ([#547](https://github.com/thaynes43/haynesnetwork/issues/547)) ([81343ed](https://github.com/thaynes43/haynesnetwork/commit/81343ed95309a49c955e13d3322fa860daecdaf5))

## [0.96.3](https://github.com/thaynes43/haynesnetwork/compare/v0.96.2...v0.96.3) (2026-09-22)


### Bug Fixes

* **books:** never push LazyLibrarian a format it already holds ([#546](https://github.com/thaynes43/haynesnetwork/issues/546)) ([7d32f0e](https://github.com/thaynes43/haynesnetwork/commit/7d32f0ed7734aa6f3954ab9b97e5df887f766178))


### Documentation

* **agents:** v0.96.2 rolled out and verified (3/3, health 200; wall projection 29/15/6) ([#544](https://github.com/thaynes43/haynesnetwork/issues/544)) ([1d553d4](https://github.com/thaynes43/haynesnetwork/commit/1d553d4732695f46c1970be3f5620c7fead2c8d1))

## [0.96.2](https://github.com/thaynes43/haynesnetwork/compare/v0.96.1...v0.96.2) (2026-09-20)


### Bug Fixes

* **trash:** section the open batch wall (Rescued / Kept) and make its numbers follow the live pool ([#543](https://github.com/thaynes43/haynesnetwork/issues/543)) ([2136865](https://github.com/thaynes43/haynesnetwork/commit/21368650c3a1a451da2b82fc8dd2b8bd7c705a4a))


### Documentation

* **agents:** trash wall 2026-09-14 — 180 d age guard + listExclusions applied live (owner rulings), phantom-save root cause, ADR-084 errata, parked dupe-fetch findings ([#540](https://github.com/thaynes43/haynesnetwork/issues/540)) ([01f4375](https://github.com/thaynes43/haynesnetwork/commit/01f4375e49b6f1cf7b8db22013a7aa3d7c2bdb10))
* **agents:** v0.96.1 rolled out and verified (3/3, health 200) ([#542](https://github.com/thaynes43/haynesnetwork/issues/542)) ([6773149](https://github.com/thaynes43/haynesnetwork/commit/6773149cbaa61e833011fe9563ab8680693bf1a5))

## [0.96.1](https://github.com/thaynes43/haynesnetwork/compare/v0.96.0...v0.96.1) (2026-09-15)


### Bug Fixes

* **trash:** releasing a save is a two-step tap on every surface (no more one-tap un-save) ([#539](https://github.com/thaynes43/haynesnetwork/issues/539)) ([4838f35](https://github.com/thaynes43/haynesnetwork/commit/4838f35017301b62d929ab5a802b728dba184982))


### Documentation

* **agents:** PLAN-067 shipped and verified live (v0.96.0) ([#536](https://github.com/thaynes43/haynesnetwork/issues/536)) ([627f7cf](https://github.com/thaynes43/haynesnetwork/commit/627f7cfe01e76886d918efbed83c63eb492dc0b2))
* correct the lapse trigger — an in-place quality upgrade, not a delete/re-add ([#537](https://github.com/thaynes43/haynesnetwork/issues/537)) ([9a59854](https://github.com/thaynes43/haynesnetwork/commit/9a59854c98dfa1f9f7f9173fde0406d848cd7430))

## [0.96.0](https://github.com/thaynes43/haynesnetwork/compare/v0.95.0...v0.96.0) (2026-08-29)


### Features

* **trash:** a Save survives a file replacement (ADR-086) ([#534](https://github.com/thaynes43/haynesnetwork/issues/534)) ([198054c](https://github.com/thaynes43/haynesnetwork/commit/198054c510aa871506b4984208a546235fcfa8c1))


### Documentation

* **adr:** ADR-084 trash-delete *arr write-back (Proposed, owner-ruled scope) + 08-20 rulings/execution record ([#529](https://github.com/thaynes43/haynesnetwork/issues/529)) ([8b3aa1d](https://github.com/thaynes43/haynesnetwork/commit/8b3aa1d0192c1334cdfb11e3f6aa00d199758438))
* **adr:** ADR-085 derived Authentik application bindings (Proposed) + 08-23 Plex outage / access-audit record ([#530](https://github.com/thaynes43/haynesnetwork/issues/530)) ([f2f17fa](https://github.com/thaynes43/haynesnetwork/commit/f2f17fac30100513effcc2335378027721760c98))
* **adr:** ADR-086 durable Trash save intent — a Save no longer lapses when a file is replaced ([#532](https://github.com/thaynes43/haynesnetwork/issues/532)) ([030b0ef](https://github.com/thaynes43/haynesnetwork/commit/030b0ef5884c0eb07813d1606732b3cb39dd97b0))
* **agents:** NZB Finder dupe warning [#2](https://github.com/thaynes43/haynesnetwork/issues/2) root-caused — SAB Discard-mode grab loop; fixed live (no_dupes 1→3 both instances, verified) ([#527](https://github.com/thaynes43/haynesnetwork/issues/527)) ([b2642a9](https://github.com/thaynes43/haynesnetwork/commit/b2642a91f86861026d4b88763789bceb0a2f09c7))
* **agents:** PLAN-065 census LIVE — v0.95.0 deployed, first census passed its contract (ladder log updated) ([#525](https://github.com/thaynes43/haynesnetwork/issues/525)) ([8bdc980](https://github.com/thaynes43/haynesnetwork/commit/8bdc980d6837286f534d58b813055630480f1233))
* **agents:** PLAN-067 built and merged ([#534](https://github.com/thaynes43/haynesnetwork/issues/534)) — deploy is the remaining owner call ([#535](https://github.com/thaynes43/haynesnetwork/issues/535)) ([a2c5518](https://github.com/thaynes43/haynesnetwork/commit/a2c55181f7473254002d5617d21868d9a7b69d64))
* **agents:** Q-01 attribution sweep — T.O.T.S. deleter unresolved, every automation exonerated with positive evidence; onSeriesDelete notification recommended ([#528](https://github.com/thaynes43/haynesnetwork/issues/528)) ([49769b5](https://github.com/thaynes43/haynesnetwork/commit/49769b541e894c2b663386d831726862096bacfa))
* **design:** DESIGN-047 + PLAN-066 derived Authentik bindings — reconciler gets an owner ([#531](https://github.com/thaynes43/haynesnetwork/issues/531)) ([165b9e6](https://github.com/thaynes43/haynesnetwork/commit/165b9e6d7fc91855c80e6c8ef3b70d2d52f362af))
* **design:** DESIGN-048 + PLAN-067 durable Trash save intent — the build contract ([#533](https://github.com/thaynes43/haynesnetwork/issues/533)) ([a889cfe](https://github.com/thaynes43/haynesnetwork/commit/a889cfeeea1b99dbe40aedbf2ab39d0879b0e706))

## [0.95.0](https://github.com/thaynes43/haynesnetwork/compare/v0.94.0...v0.95.0) (2026-08-01)


### Features

* **janitor:** arr queue janitor — census-first errored-grab cleanup (ADR-083) ([#524](https://github.com/thaynes43/haynesnetwork/issues/524)) ([bebff49](https://github.com/thaynes43/haynesnetwork/commit/bebff49c64b2a846df31a9fb41b6bb93f8b24c9e))


### Documentation

* **adr:** ADR-083 — arr queue janitor, census-first (DESIGN-046, PLAN-065) ([#523](https://github.com/thaynes43/haynesnetwork/issues/523)) ([28e8d0f](https://github.com/thaynes43/haynesnetwork/commit/28e8d0f1d75a8edd36a2492df6a14408bb5f83ef))
* **agents:** debt queue COMPLETE — ADR-082 live-verified (v0.94.0, two-tick evidence); PLAN-040 → completed/ ([#521](https://github.com/thaynes43/haynesnetwork/issues/521)) ([ff12c7d](https://github.com/thaynes43/haynesnetwork/commit/ff12c7d966d8c07553f06f1cc0a1e3ec844d68c9))

## [0.94.0](https://github.com/thaynes43/haynesnetwork/compare/v0.93.0...v0.94.0) (2026-07-28)


### Features

* **mam:** trend-aware dead band + DB-backed governor config (ADR-082) ([#520](https://github.com/thaynes43/haynesnetwork/issues/520)) ([e6dd541](https://github.com/thaynes43/haynesnetwork/commit/e6dd541daf1f6d8a9e04d8beca10362041eda020))


### Documentation

* **adr:** ADR-082 — MAM trend-aware dead band + DB-backed audited config ([#517](https://github.com/thaynes43/haynesnetwork/issues/517)) ([3a57e22](https://github.com/thaynes43/haynesnetwork/commit/3a57e22a8518f3571cc0840535ce8b1eae881dd6))
* **agents:** HANDOFF — ADR-081 executed (v0.93.0 live, no-op signature verified); ADR-082 build in flight ([#519](https://github.com/thaynes43/haynesnetwork/issues/519)) ([91bf4c0](https://github.com/thaynes43/haynesnetwork/commit/91bf4c0e4019a2c149d55798b843c793849322b0))

## [0.93.0](https://github.com/thaynes43/haynesnetwork/compare/v0.92.0...v0.93.0) (2026-07-28)


### Features

* **library:** ADR-081 bootstrap Default grants + cold-start sync and honest empty state ([#516](https://github.com/thaynes43/haynesnetwork/issues/516)) ([39c3f17](https://github.com/thaynes43/haynesnetwork/commit/39c3f17ea93b729d408e983420269b627ea400b4))


### Documentation

* **adr:** ADR-081 — library-access bootstrap seeding + cold-start contract ([#514](https://github.com/thaynes43/haynesnetwork/issues/514)) ([d84be32](https://github.com/thaynes43/haynesnetwork/commit/d84be3261a57b0bcdac81383c1b367f0cb025b1f))
* **agents:** HANDOFF — Gap B shipped v0.92.0 + Default budget 5/hr set; ytdrivarr double-scrape root-caused (fix in flight) ([#512](https://github.com/thaynes43/haynesnetwork/issues/512)) ([244c73c](https://github.com/thaynes43/haynesnetwork/commit/244c73c036bc964a51e31ec638d049164cd455d9))
* **agents:** HANDOFF — ytdrivarr v0.9.1 deployed (cron-scope fix live; verify next 08:30Z tick); two note corrections ([#515](https://github.com/thaynes43/haynesnetwork/issues/515)) ([32d310b](https://github.com/thaynes43/haynesnetwork/commit/32d310bfa932d5582a9bdc05dd252294747534c4))

## [0.92.0](https://github.com/thaynes43/haynesnetwork/compare/v0.91.0...v0.92.0) (2026-07-28)


### Features

* **roles:** per-role media-action rate budgets (ADR-080) ([#511](https://github.com/thaynes43/haynesnetwork/issues/511)) ([7e5eff8](https://github.com/thaynes43/haynesnetwork/commit/7e5eff8311defd81591897cc12f648549a44c60b))


### Documentation

* **adr:** ADR-080 — per-role media-action rate budgets (everyone can Fix, limits govern) ([#510](https://github.com/thaynes43/haynesnetwork/issues/510)) ([fcff38d](https://github.com/thaynes43/haynesnetwork/commit/fcff38dd5dc11cfed5c3e3432b3eb1e6146ce9b2))
* **agents:** complete plans 062-064 (HA saga app legs shipped v0.90.4-v0.91.0) + HANDOFF saga block ([#504](https://github.com/thaynes43/haynesnetwork/issues/504)) ([3f60b78](https://github.com/thaynes43/haynesnetwork/commit/3f60b78f4edabe8d3da08fe19514b96bc06e40b5))
* **agents:** PLAN-041 Gap B re-ruled — recovered lost ruling: no Fix gating, per-role rate limits (Default stricter, admin-editable) ([#509](https://github.com/thaynes43/haynesnetwork/issues/509)) ([7722d88](https://github.com/thaynes43/haynesnetwork/commit/7722d88fa35f0ecf59674d7c7c7f6a834ba2f60d))
* **agents:** PLAN-041 Part 2 recon — two real gaps (arr action gating, ytdl leg now unblocked); integrations residual verified shipped ([#508](https://github.com/thaynes43/haynesnetwork/issues/508)) ([97b7f7b](https://github.com/thaynes43/haynesnetwork/commit/97b7f7ba0b7d6f0a01d4fb05cdd9300d279dee4f))
* **agents:** record 07-28 owner rulings — library-access gate solidification + MAM harden-first (PLAN-040 activated) ([#506](https://github.com/thaynes43/haynesnetwork/issues/506)) ([ee8eb61](https://github.com/thaynes43/haynesnetwork/commit/ee8eb618822813cb9d6f695023af74b4e52dec91))
* **agents:** ytdrivarr validation day 8 — GREEN, 0 SEV (4 watch items incl. cadence question W3) ([#507](https://github.com/thaynes43/haynesnetwork/issues/507)) ([c23dd2e](https://github.com/thaynes43/haynesnetwork/commit/c23dd2e0e54b936c47a2762ff2f40f024df45f03))

## [0.91.0](https://github.com/thaynes43/haynesnetwork/compare/v0.90.5...v0.91.0) (2026-07-28)


### Features

* **dashboard:** front page uptime badge from the gatus SLI ([#502](https://github.com/thaynes43/haynesnetwork/issues/502)) ([294bdb0](https://github.com/thaynes43/haynesnetwork/commit/294bdb02c726367ff29f4e1c6a68938747cc5a99))

## [0.90.5](https://github.com/thaynes43/haynesnetwork/compare/v0.90.4...v0.90.5) (2026-07-28)


### Bug Fixes

* **auth:** back Better Auth rate limiting with shared Postgres storage ([#500](https://github.com/thaynes43/haynesnetwork/issues/500)) ([edf9a99](https://github.com/thaynes43/haynesnetwork/commit/edf9a99a0ecff0c556d0edb0998856c496f08e43))

## [0.90.4](https://github.com/thaynes43/haynesnetwork/compare/v0.90.3...v0.90.4) (2026-07-28)


### Bug Fixes

* **db:** serialize concurrent migrators with a Postgres advisory lock ([#499](https://github.com/thaynes43/haynesnetwork/issues/499)) ([fa754c7](https://github.com/thaynes43/haynesnetwork/commit/fa754c7fefde1700b1252af621c9fbd1aa73980d))


### Documentation

* **agents:** HANDOFF — Leaving Soon validation passed (record survived the 04:20 maintenance) ([#497](https://github.com/thaynes43/haynesnetwork/issues/497)) ([da3b8c6](https://github.com/thaynes43/haynesnetwork/commit/da3b8c6c2abb87d5034f7a6276c9fb5e2305de8c))

## [0.90.3](https://github.com/thaynes43/haynesnetwork/compare/v0.90.2...v0.90.3) (2026-07-28)


### Bug Fixes

* **e2e:** repair the advisory e2e lane — 29 failures → 0, and 3 real bugs it was hiding ([#493](https://github.com/thaynes43/haynesnetwork/issues/493)) ([d2a741c](https://github.com/thaynes43/haynesnetwork/commit/d2a741c8a322eeedd4d2e74ef26018e5a52776cc))
* **trash:** Leaving Soon as a Maintainerr rule-group shell with self-heal (ADR-078) ([#496](https://github.com/thaynes43/haynesnetwork/issues/496)) ([c6e21f4](https://github.com/thaynes43/haynesnetwork/commit/c6e21f496d2a067a3e1ee276b259d803c189cf89))


### Documentation

* **adr:** ADR-077 — the burst hypothesis was FALSE; measured +84, buffer 50 insufficient ([#494](https://github.com/thaynes43/haynesnetwork/issues/494)) ([542874e](https://github.com/thaynes43/haynesnetwork/commit/542874e7ac27dbe90c33ef381863fc00aedd54c7))
* **adr:** amend ADR-077 in place — the burst basis was wrong (+58 observed) ([#492](https://github.com/thaynes43/haynesnetwork/issues/492)) ([33985a1](https://github.com/thaynes43/haynesnetwork/commit/33985a134b4391f347391c77d634e254e924c870))
* **agents:** HANDOFF — all three armed watches discharged; Trash settings save fixed (v0.90.2) ([#489](https://github.com/thaynes43/haynesnetwork/issues/489)) ([6634cf4](https://github.com/thaynes43/haynesnetwork/commit/6634cf4e694c4f8cc89f525e5ce7ba0495f774e0))
* **agents:** HANDOFF — MAM +58 burst incident; gate closed, buffer 20 → 50 ([#491](https://github.com/thaynes43/haynesnetwork/issues/491)) ([e095316](https://github.com/thaynes43/haynesnetwork/commit/e095316e2830922c0824f483367ddc55abd56a24))
* **agents:** HANDOFF — MAM sized to the measured +84, e2e lane repaired, Trash fix confirmed ([#495](https://github.com/thaynes43/haynesnetwork/issues/495)) ([9283b3f](https://github.com/thaynes43/haynesnetwork/commit/9283b3fb728133be7c2f7895ff61a2bb1632f9a0))

## [0.90.2](https://github.com/thaynes43/haynesnetwork/compare/v0.90.1...v0.90.2) (2026-07-25)


### Bug Fixes

* **trash:** normalize stored space-policy shape so Trash settings can save ([#487](https://github.com/thaynes43/haynesnetwork/issues/487)) ([6f70cf2](https://github.com/thaynes43/haynesnetwork/commit/6f70cf2b550ee320052881867fa04fe8b50c619b))

## [0.90.1](https://github.com/thaynes43/haynesnetwork/compare/v0.90.0...v0.90.1) (2026-07-25)


### Documentation

* **adr:** accept ADR-077 (MAM governor resume hysteresis) ([#482](https://github.com/thaynes43/haynesnetwork/issues/482)) ([5b76ca4](https://github.com/thaynes43/haynesnetwork/commit/5b76ca4777af72e9d836594d4da3c98102afbb22))
* **agents:** HANDOFF — arm watches on MAM un-freeze + release-please mint; correct secrets source to github-dev-bot ([#486](https://github.com/thaynes43/haynesnetwork/issues/486)) ([6f89e9c](https://github.com/thaynes43/haynesnetwork/commit/6f89e9cfed7cd7195c46289f9cb3cb15506f810e))
* **agents:** HANDOFF — MAM hysteresis shipped/deployed; un-freeze timing + release-please mint residual ([#485](https://github.com/thaynes43/haynesnetwork/issues/485)) ([21d16a4](https://github.com/thaynes43/haynesnetwork/commit/21d16a41cacb24eda59acfbebf0986c9f8cc6039))

## [0.90.0](https://github.com/thaynes43/haynesnetwork/compare/v0.89.2...v0.90.0) (2026-07-24)


### Features

* **domain:** add resume-floor hysteresis to the MAM governor gate ([#481](https://github.com/thaynes43/haynesnetwork/issues/481)) ([992aa82](https://github.com/thaynes43/haynesnetwork/commit/992aa82cda448cab36aba4fd4132bb930d311b81))


### Documentation

* **agents:** 2026-07-21 overnight handoff — cold-start validation of the first unattended night ([#477](https://github.com/thaynes43/haynesnetwork/issues/477)) ([5354e47](https://github.com/thaynes43/haynesnetwork/commit/5354e47375937986af4e352e5ef2a7204acf1638))
* **agents:** Peloton green-nightly gate PASSED — donor config-manager retired ([#478](https://github.com/thaynes43/haynesnetwork/issues/478)) ([b5c47b2](https://github.com/thaynes43/haynesnetwork/commit/b5c47b2be5d81179b8c0aba2f52b5b86cb2a33df))
* **agents:** pod-shutdown handoff — clean worktrees, board state, cold-start routing ([#480](https://github.com/thaynes43/haynesnetwork/issues/480)) ([4d208d8](https://github.com/thaynes43/haynesnetwork/commit/4d208d88224101aee0c11355c04c6d9c37e3e99b))
* **agents:** ytdrivarr validation day-2 verdict — PASS (cutover); GB quota is the demand throttle ([#479](https://github.com/thaynes43/haynesnetwork/issues/479)) ([336c5a7](https://github.com/thaynes43/haynesnetwork/commit/336c5a7cb14d2eba9856ee456e78a029aebf8529))
* evening wrap — pairing gap shepherded (+11 pairs) + NZB dupe-guard incident ([#475](https://github.com/thaynes43/haynesnetwork/issues/475)) ([99b2637](https://github.com/thaynes43/haynesnetwork/commit/99b2637396d2995a69681c645b58408cc29e4a14))

## [0.89.2](https://github.com/thaynes43/haynesnetwork/compare/v0.89.1...v0.89.2) (2026-07-21)


### Bug Fixes

* pairing author-agreement tolerances + Kavita metadata-writers author fallback ([#474](https://github.com/thaynes43/haynesnetwork/issues/474)) ([2a52f65](https://github.com/thaynes43/haynesnetwork/commit/2a52f6567a6aaef48d24f81541fae506245c9354))


### Documentation

* **agents:** PLAN-025 post-MVP backlog — Prometheus/Grafana run metrics (owner-ruled) + the dispatched-downloader idea (unruled) ([#471](https://github.com/thaynes43/haynesnetwork/issues/471)) ([cdb8d17](https://github.com/thaynes43/haynesnetwork/commit/cdb8d176636c32d74eb4341a87be77c639d5743c))
* **agents:** the ytdrivarr two-week validation regime — standing order + protocol (owner-mandated) ([#473](https://github.com/thaynes43/haynesnetwork/issues/473)) ([2b5e6cd](https://github.com/thaynes43/haynesnetwork/commit/2b5e6cd2c6557e77bcc0dfafa27fa6b6a0e679ea))

## [0.89.1](https://github.com/thaynes43/haynesnetwork/compare/v0.89.0...v0.89.1) (2026-07-21)


### Bug Fixes

* **collections:** stop re-resolving already-resolved collection wants (quota thrift) ([#470](https://github.com/thaynes43/haynesnetwork/issues/470)) ([157c86d](https://github.com/thaynes43/haynesnetwork/commit/157c86d5e08f147343cbdbc4b33e9312ff9287f9))


### Documentation

* record the executed Libretto rollout (twins converted, Authors live, wants minted) ([#469](https://github.com/thaynes43/haynesnetwork/issues/469)) ([01beeab](https://github.com/thaynes43/haynesnetwork/commit/01beeab470ad7a516ce0508ccbe5c794c1d57889))
* record the v0.89.0 + libretto deploy completion (OPS-004 manual step done) ([#467](https://github.com/thaynes43/haynesnetwork/issues/467)) ([baf4a41](https://github.com/thaynes43/haynesnetwork/commit/baf4a41b1e694790a5b44b3b22a87d19cba6abd5))

## [0.89.0](https://github.com/thaynes43/haynesnetwork/compare/v0.88.6...v0.89.0) (2026-07-21)


### Features

* unified Books wall + merged collections (ADR-075/076) ([#464](https://github.com/thaynes43/haynesnetwork/issues/464)) ([18a0571](https://github.com/thaynes43/haynesnetwork/commit/18a05711fe1a6a89dc6cefa524fba185f5c7be65))


### Documentation

* books unification day wrap — both streams shipped, rollout staged ([#466](https://github.com/thaynes43/haynesnetwork/issues/466)) ([127115f](https://github.com/thaynes43/haynesnetwork/commit/127115fa9ae762ee86bbd279d2b28fcd7f6b8e3b))

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
