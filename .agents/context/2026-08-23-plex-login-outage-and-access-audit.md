# 2026-08-23 — Plex login outage (fixed) + estate access-control audit (ADR-085 opened)

Two things happened in one session. The first was an outage and is **closed**. The second is a
standing exposure the outage investigation surfaced, and is **open** as ADR-085.

## 1. "Log in with Plex" was fully down — FIXED, live and codified

**Symptom:** every login attempt hung at "Authenticating with Plex…" then showed *"Response returned
an error code"*. Owner and all users affected.

**Root cause:** Plex **retired `GET https://plex.tv/api/v2/friends`** — it now returns **410 Gone**.
Authentik's Plex source calls it unconditionally during token redemption when `allow_friends` is true:

```
POST /api/v3/sources/plex/redeem_token/  -> 500
  redeem_token()           sources/plex/api/source.py:110
    check_friends_overlap()  sources/plex/plex.py:101
      get_friends()          sources/plex/plex.py:66  -> 410 -> raise_for_status() -> HTTPError
```

`get_friends()` does a bare `raise_for_status()` with **no error handling**, unlike
`check_server_overlap()` which catches. The friends check runs **first**, so the request 500'd before
the server-overlap check that would otherwise have admitted the user. Not a haynesnetwork bug and not
a config change on our side — Plex sunset the endpoint underneath us.

**Fix:** `allow_friends: false` on the `haynestower` source. Admission now rides on `allowed_servers`
(server-overlap), which uses `/api/v2/resources` + `/api/v2/user` — both verified healthy (200).
Strictly **tighter** than before: was "friend OR server-share", now server-share only. The only cohort
it cannot admit is "Plex friend sharing no server", which is nobody here and was 100% broken anyway.

Live-flipped via `ak shell` to restore service immediately, verified (`ADMIT: True`, and a real login
returning `status: 200` with zero 500s). Codified in `haynes-ops` **PR #2586**.

**Trap worth remembering:** the blueprint `30-hnet-sources.yaml` pinned `allowed_servers` to **one**
machine ID while the live DB had **three** (UI drift). Authentik re-applies a blueprint only when its
file hash changes, so editing the file to fix `allow_friends` would ALSO have reset `allowed_servers`
and dropped two servers. All three IDs were carried forward in the same edit. Codifying is
zero-downtime: the blueprints ConfigMap is a plain mounted volume with a stable name and is **not** in
the Reloader trigger list (only `authentik-web-lowering` is), so Authentik re-applies in place with no
pod restart.

## 2. Estate access-control audit — the real finding

Checking whether the fix widened access revealed that it never needed to, because **eleven Authentik
applications had no policy bindings at all**. In Authentik that admits **any authenticated identity**,
and `default-source-enrollment` auto-creates accounts with no approval step.

**Correct the instinct here:** dev-env, headlamp, grafana and omni are **LAN-only** — `traefik-internal`,
`*.haynesops.com`, published by `external-dns-unifi` to the UDM only, and the Cloudflare Tunnel forwards
*only* `haynesnetwork.com` + `*.haynesnetwork.com`, 404-ing everything else. They were never
internet-reachable. The genuinely public unbound apps were **paperless** (personal documents,
forward-auth, so Authentik is the only gate — the sharpest one), immich, open-webui, kavita and
audiobookshelf.

**Second finding — the groups have drifted from the Roles.** ADR-045's projection is purely
event-driven (`assignRolePortal` only), so Roles set by `bootstrapAdminOnSignin`,
`consumePendingRoleForUser`, or before synced-tier existed never projected. **Five users would be
locked out** the moment bindings are enforced: `miaellen25@gmail.com` (Family, not in `family`),
`jbadessa@gmail.com` + `seeaych@gmail.com` (Friends, not in `friends`), `aringan0323@gmail.com` +
`danweaver8@gmail.com` (Default, which projects to no group because `synced_tier=false`). A further
five Authentik identities hold no Role at all. **Repair membership before enforcing anything.**

## Owner rulings (2026-08-23, AskUserQuestion, one at a time)

1. **Fix rollout** → restore live first, then codify in GitOps, *provided* codifying is zero-downtime
   (it is — see above).
2. **LAN-only infra apps** → stay **out** of the haynesnetwork catalog/Portal; gated to
   `authentik Admins` in the `haynes-ops` blueprint. Admins are assumed to reach them over LAN or VPN.
   Precedent already in-app: Grafana deep-links in Metrics are `isAdmin`-gated for exactly this reason
   (`packages/metrics/src/grafana.ts`).
3. **Execution scope** → infra gate now (zero-risk), public apps only **after** a reconciler exists, so
   the sync is automatic and cannot drift. Owner requirement, verbatim: *"when I change a user's group
   in haynesnetwork admin settings the Portal links exposed to their group are what they have access
   to. I do not want to manage two sets of apps."*

## State

- `haynes-ops` **PR #2586** — Plex `allow_friends: false` + all three `allowed_servers`. Service already
  restored live; the PR codifies it.
- `haynes-ops` **PR #2587** — `80-infra-admin-gate.yaml`, binding dev-env/headlamp/grafana to
  `authentik Admins`. Verified zero-risk: `authentik Admins` and `grafana_admin` hold the same two
  accounts. `kustomize build` verified.
- **ADR-085 (Proposed)** — derived Authentik application bindings. Amends ADR-045 C-02 narrowly to
  allow **application bindings only**, guarded by a positive owned-applications allowlist, failing
  CLOSED on an empty derived set (zero bindings means open in Authentik — the most dangerous property
  of the mechanism), census-first per ADR-083, with a membership reconcile pass that must run first.

## Next

DESIGN-047 → PLAN-066 → build, then walk the census ladder before enforcing. ADR-085 carries three open
questions for the owner: **Q-01** whether `paperless` should stay granted to the whole Family role;
**Q-02** whether the membership reconcile runs as a `@hnet/sync` CronJob mode or inline after each Role
write; **Q-03** whether the five Role-less Authentik identities should lose all access by construction
or be assigned Default.
