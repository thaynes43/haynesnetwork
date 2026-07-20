# 2026-07-20 (late) — ytdrivarr day 1: vision → accepted design → M1 + console SHIPPED, deploy staged

The whole arc ran in one evening, owner present throughout. Chain of record: PLAN-025 rulings
(#453/#455/#456) → research notes (#454: [[2026-07-20-ytdrivarr-q02-source-matrix]] +
[[2026-07-20-ytdrivarr-q03-donor-audit]]) → **ADR-074 + DESIGN-045 + T-214..T-224** (#457,
Fable-reviewed per the new division-of-labor ruling — review caught tool-syntax artifacts + a
glossary cross-ref defect) → **ACCEPTED** (#458; all four forks ratified; **Q-03 OVERRIDDEN:
music FIRST-CLASS from M2** — "let's move away from audio as video right away"; AGPL-3.0; own
CNPG Postgres in `downloads`; podcasts/RSS non-goal) → **the build**.

## Shipped in the ytdrivarr repo (github.com/thaynes43/ytdrivarr)

- **M1 walking skeleton (PR #1, Opus, merged):** the full C1–C8 provider contract seam +
  `validateProvider` capability-negation enforcement (both directions) · typed registry
  (failed load = startup error) · 8-table Postgres domain (`mediaKind` on sources from day one)
  · audited single-writer source mutations (audit-in-same-tx enforced by a trigger test) ·
  Hono REST API (11 routes, X-Api-Key, OpenAPI 3.1 from zod) · emitter with BOTH preset
  families (video + music) · atomic write-temp-rename projection · the trivial `in_core`
  URL-list provider proven e2e over embedded PG · CI + docker publish + release-please
  scaffolding. 44 tests. Image `ghcr.io/thaynes43/ytdrivarr:sha-a343e7d`.
- **Operator console shell (PR #2, FABLE-built per the ruling, merged):** vanilla-TS hash-routed
  SPA served by the service (zero new runtime deps, esbuild-bundled) — Sources (add/edit/remove
  with the estate's two-step armed-remove idiom, pixel-verified zero-reflow) · Libraries · Runs
  (+ run-discovery trigger) · Health (probe table w/ credential-age + selector-drift columns,
  honestly empty) · Providers (capability cards; `[]` renders "trivial by design") · key-entry
  gate (localStorage, LAN-only per D-21; 401 → re-entry). Live headless-verified desktop + 390px;
  screenshots in the repo. 58 tests total. Image **`sha-68df68e`** (the deploy target).

## Deploy: STAGED, two gates (both owner)

**haynes-ops #2178 (DRAFT, bumped to sha-68df68e):** core Deployment + own single-instance CNPG
PG16 + internal `traefik-internal` ingress `ytdrivarr.haynesops.com` (never public) + NFS
projection volume + ESO from 1Password item `ytdrivarr`. Gates:
1. **Owner creates 1P item `ytdrivarr`** (HaynesKube) with field `YTDRIVARR_API_KEYS` = a
   generated strong key (comma-separated for rotation headroom).
2. **Owner flips the ytdrivarr repo toggle** Settings → Actions → General → "Allow GitHub
   Actions to create and approve pull requests" (release-please fails on every main push until
   then; sha-tag publishing is unaffected; bot lacks admin to flip it).
Then: mark #2178 ready → merge → flux reconcile → verify `/health` + the console on LAN.

## Next: M2 — YouTube YAML takeover + FIRST-CLASS MUSIC (the Q-03 override)

Real `in_core` YouTube provider (both preset families) · import the ~80 channels as Sources
with their `mediaKind` (the `= Music` chip → music Sources) · stand up the music-kind Library —
**ONE owner nod: the music target (media root + which Plex music library); M2 proposes a
default from the estate layout** · cut `ytdl-sub-youtube` from git YAML to projection ·
non-destructive (existing video files stay; new discovery lands as audio). Then M3 Peloton
(hardened port), M4 app Edit surfaces, M5 Fix parity (PLAN-025 has the file-level scope).

## Division-of-labor note (first full exercise)

Opus built the service internals; **Fable built the console AND did the pre-merge architecture
review of the design docs** — both new-ruling firsts, both clean. The console agent's Dockerfile
fix (`COPY scripts`) was caught by its own CI docker job — the lane earns its keep.
