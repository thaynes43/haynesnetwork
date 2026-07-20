# 2026-07-20 — ytdrivarr research: the Q-02 source sweep (built-in source matrix)

Opus research deliverable for PLAN-025 Q-02 (dispatched the night the owner scoped the saga;
the repo name **ytdrivarr** was owner-chosen the same evening — owner creates the repo).
Companion: the Q-03 donor audit note. Feeds the ADR + design doc. Preserved as delivered
(lightly reflowed); sources cited at bottom.

**The most important finding:** the estate ALREADY runs a bespoke config-generating service
(`ytdl-sub-config-manager`, the Peloton scraper→subscriptions.yaml→GitOps-PR loop) — ytdrivarr
is a GENERALIZATION of a proven pattern. And ytdl-sub's NATIVE first-class surface is narrower
than the plan's ambition (real prebuilt presets: YouTube + SoundCloud + Bandcamp only) — which
drives the matrix tiering.

## 1. ytdl-sub's native model (ground truth)

CLI wrapper over yt-dlp; three layers: two files per library (`config.yaml` = working dir;
`subscriptions.yaml` = what to fetch, with `__preset__` file-wide overrides) · prebuilt PRESETS
composed by name (inheritance chains; `|` pipes; `= X` genre chips; `~name` override mode) ·
22 PLUGINS doing the work (download, format/audio_extract, output_options + download-archive +
retention, nfo/music/video tags, chapters/split_by_chapters, date_range, filters, subtitles,
embed_thumbnail, throttle_protection).

First-class use cases = the prebuilt preset families: **TV Show by Date** (channel→show,
seasons/episodes off upload date; per-player Plex/Jellyfin/Emby/Kodi variants) · **TV Show
Collection** (URL=season, 40×11 ceiling, s00 specials) · **Music** (Singles, SoundCloud
Discography, YouTube Releases, YouTube Full Albums via split_by_chapters, Bandcamp) · **Music
Videos (WIP upstream)** · **Media Quality** selectors · helpers (Only Recent [Archive], Chunk
Downloads, Throttle Protection + a resolution-assert ban detector). Scheduling is EXTERNAL
(cron; docs warn over-running causes bans); the download-archive is the incremental-sync
primitive.

## 2. yt-dlp extractor reality → tiering

1,731 extractors; only a handful merit first-class subscribe support:
- **Tier 1 (subscribe-able + native preset):** YouTube (channel/playlist/tab/releases),
  SoundCloud (discography), Bandcamp (user/album).
- **Tier 2 (subscribe-able extractor, NO native preset — generic presets drive them):** Twitch
  VODs, Vimeo, Patreon campaign, Nebula, Floatplane, PeerTube, Bilibili, Niconico, Dailymotion,
  Mixcloud, Instagram (flagged broken), Reddit. Plus the **authenticated Peloton class**
  (estate-proven, bespoke).
- **Tier 3:** the `generic` extractor + one-off pasted URLs. **Podcast/RSS is NOT supported**
  (no extractor; generic best-effort only) — an explicit open question, not a promise.

## 3. Proposed built-in source matrix (condensed)

Verbs → mechanisms uniformly: **subscribe** = URL enumeration + download-archive + scope
(Only Recent/Chunk) + throttle · **download** = format/media-quality + audio_extract +
ytdl_options (cookies/headers) · **organize** = output_options + season/episode or
artist/album pathing + retention · **present** = NFO/music_tags/thumbnails per player.

| Source | Mechanism | Tier |
|---|---|---|
| YouTube channel/playlist → video library | `{player} TV Show by Date` / `Collection` | 1 (estate-proven) |
| YouTube music (Releases / Full Albums) | `YouTube Releases` / `Full Albums` | 1 |
| SoundCloud artist | `SoundCloud Discography` | 1 |
| Bandcamp artist/label | `Bandcamp` | 1 |
| Music videos | `music_videos` (WIP upstream) | 1-partial |
| Twitch VODs + other channel-shaped | generic TV-Show/music presets | 2 |
| Authenticated non-YT (Peloton-class) | TV Show by Date + per-entry overrides + bearer headers; entries produced by an external scraper | 2 (estate-proven bespoke) |
| Podcast/RSS | none | 3 / open Q |
| One-off URL | bare subscription | 3 |

Recommendation: core natively owns Tier 1; Tier 2 = "generic channel" + "authenticated
scraper" source plugins (the Peloton pattern generalized); Tier 3 + podcasts stay honest
open questions.

## 4. Estate current-usage inventory

`kubernetes/main/apps/downloads/ytdl-sub/` = three Kustomizations: `ytdl-sub-youtube`,
`ytdl-sub-peloton`, `ytdl-sub-peloton-config-manager`. Both ytdl-sub jobs: bjw-s app-template
CronJobs `*/15`, Forbid, image `ghcr.io/jmbannon/ytdl-sub:2026.07.16` (calendar-pinned),
read-only rootfs, 6Gi, NFS media (`gasha01:/hdd-nfs-repl` → youtube/peloton subpaths), configs
as kustomize configMapGenerator.

- **YouTube library:** single preset `Plex TV Show by Date`; ~80 channels in `= Genre` chips
  (incl. "Jackson's Favorites", "Penelope's Favorites"); Only Recent 24months/300; heavy
  throttle (sleeps, per-sub caps, `subscription_download_probability: 0.5`); cookies.txt on
  the media volume. NOTE: music artists (Taylor Swift, Daft Punk) filed as VIDEO TV-shows.
- **Peloton library:** TV Show by Date + custom S{s}E{e} naming; per-class one-off `download:`
  URLs with per-item season/episode + per-instructor dirs; `Authorization: ${PELOTON_BEARER}`
  http_headers, bearer injected at runtime from `/media/peloton/bearer.txt` via inline python
  (read-only-rootfs workaround).
- **Peloton config-manager (THE precedent):** own image `thaynes43/ytdl-sub-config-manager:0.7.0`,
  daily cron 22:00, env `PELOTON_MAX_SCROLLS=250`, `GITHUB_AUTO_MERGE=true`; 1P secret
  `peloton-scraper` (PELOTON_USERNAME/PASSWORD + GITHUB_REPO_URL/TOKEN). Logs into Peloton,
  scroll-scrapes new classes, regenerates subscriptions.yaml, PRs it to haynes-ops with
  auto-merge. Discover → emit config → GitOps write-back, working today.

## 5. Config-generation recommendations

- **Generation unit = the LIBRARY** (one config+subscriptions+CronJob tuple per
  library×player×media-root); sources are service state ROWS rendered into per-library files.
  Cross-library source identity has no ytdl-sub representation — the service owns it.
- **Emit by preset composition** (named prebuilt presets + few overrides — the estate's exact
  altitude), never hand-written plugin config.
- **Control/data-plane split (the *arr split):** service = state + emit + scheduling;
  **ytdl-sub stays the execution engine as short-lived Job/CronJob pods** (throttle machinery
  + memory profile already proven there). Config delivery: git-PR round-trip vs service-owned
  projection to configMap/PVC = design tension #6.
- **Pin + Renovate ytdl-sub's calendar image; never vendor yt-dlp** (weekly extractor-break
  treadmill). Extractor breakage becomes a per-source HEALTH signal the service surfaces.

## 6. Open design tensions (for the design doc)

1. Music-vs-video is a subscribe-time CLASSIFICATION the service owns (disjoint preset
   families/dirs/library types; estate currently files music artists as video).
2. Dedup exists only WITHIN a subscription — cross-subscription/library identity is the
   service's job.
3. Retention × episode-ordering interactions (download-index unsafe under deletion).
4. Throttle/ban is shared-fate — central rate governance across libraries; careful with one
   cookie/account identity.
5. Per-source secret material + read-only-rootfs injection (cookies.txt, runtime bearer) via
   ESO + runtime substitution — never git.
6. Service-owned state vs the GitOps audit trail the current PR write-back provides — needs an
   explicit design answer (the app's audit-rows-same-tx doctrine is the likely shape).
7. Grain: source rows (cross-library) vs library-file emit unit.
8. Season/episode numbers immutable once published (Plex/Jellyfin matching breaks on re-key)
   — mirrors the repo's IDs-never-renumbered doctrine.
9. **The crux:** "subscribe" isn't always a yt-dlp URL — Peloton's entries come from an
   external scraper. **The plugin contract is "PRODUCE SUBSCRIPTION ENTRIES"** (backend = a
   yt-dlp playlist URL or a bespoke authenticated scraper) — exactly the owner's *arr
   extension-point ruling.

## Sources

Estate: `kubernetes/main/apps/downloads/ytdl-sub/` (ks.yaml; youtube/{config,helmrelease,
kustomization}; peloton/{config,helmrelease,externalsecret}; peloton-config-manager/
{helmrelease,externalsecret}). ytdl-sub (jmbannon/ytdl-sub): README; getting_started +
automating_downloads guides; prebuilt_presets docs + sources; subscription_yaml + plugins
reference. yt-dlp: supportedsites.md (1,731 extractors; presence checks).
