# OPS-002: Plex & Tautulli topology of record

- **Status:** Accepted (owner-confirmed 2026-07-03)
- **Feeds:** Phase 3 library management design (PRD R-25..R-28), Phase 2 ledger enrichment

The three Plex servers, their roles in the owner's words, and where their credentials
live. Library naming convention (owner, 2026-07-03): **`HOps *` prefix = hosted on the
k8s cluster (HAYNESOPS, HAYNESKUBE); `HNet *` prefix = legacy Unraid (HAYNESTOWER).** Canonical server slugs in code should follow the owner's names: `haynestower`,
`haynesops`, `hayneskube`.

## Servers

| Canonical name | URL | Hosting | Role | Libraries (2026-07-03, token-verified) |
|---|---|---|---|---|
| **HAYNESTOWER** | `https://plex.haynesnetwork.com` | Unraid (legacy) | Most-used today; the primary user-facing server | `HNet Movies`, `HNet TV Shows`, `HNet Photos`†, `HNet Home Videos`† |
| **HAYNESOPS** | `https://plexops.haynesnetwork.com` | k8s, dedicated worker node w/ powerful iGPU | **Mirror of the shared Movies/TV library** on superior hardware — absorbs more users if needed | `HOps Movies`, `HOps TV Shows` |
| **HAYNESKUBE** | `https://k8plex.haynesnetwork.com` | k8s (same cluster as HAYNESOPS), own worker node w/ powerful iGPU | Non-standard content: exercise videos, YouTube-dl archives, music | `HOps Peloton`, `HOps YT`, `HOps Music` |

† Family-only libraries (PRD R-26) — these exist **only on HAYNESTOWER**.

## Token locations (1Password, HaynesKube vault)

| Server | Item → field |
|---|---|
| HAYNESTOWER | `homepage` → `HAYNESTOWER_PLEX_API_KEY` |
| HAYNESOPS | `homepage` → `HAYNESOPS_PLEX_API_KEY` (owner added 2026-07-03; an older copy exists in the `plexops` item under the colliding field name `HAYNESKUBE_PLEX_API_KEY` — prefer the homepage one) |
| HAYNESKUBE | `homepage` → `HAYNESKUBE_PLEX_API_KEY` |

All three tokens were validated against `GET /library/sections` on 2026-07-03.

## Tautulli (watch history — ledger enrichment, optional)

| Instance | Watches | Key location |
|---|---|---|
| `tautulli/plexops` (k8s) | HAYNESOPS | `TAUTULLI_API_KEY` (via homepage manifests) |
| `tautulli/k8plex` (k8s) | HAYNESKUBE | `TAUTULLI_K8PLEX_API_KEY` |
| Unraid Tautulli (`tautulli.haynesnetwork.com`) | HAYNESTOWER | `media-stack` → `TAUTULLI_HAYNESTOWER_API_KEY` (owner added 2026-07-03) |

## Design implications (for the Phase 3 design doc)

1. **Library names differ across servers** (PRD Q-03 partially resolved): HAYNESOPS
   mirrors HAYNESTOWER's Movies/TV under different names (`HOps Movies` vs `HNet Movies`).
   The library registry must treat (server, library key) as identity and model the
   mirror relationship explicitly rather than matching by name.
2. Family gating applies concretely to two HAYNESTOWER libraries today; the rule should
   still be modeled per-library (flag), not per-server.
3. HAYNESOPS as overflow capacity suggests a future "which server should this user
   watch on" feature — out of scope now, but don't preclude it in the schema.
4. Sonarr/Radarr manage the **shared** library content (fixing is server-agnostic —
   the *arrs write storage that HAYNESTOWER/HAYNESOPS serve); HAYNESKUBE's non-standard
   content is outside the *arr fix flow.
