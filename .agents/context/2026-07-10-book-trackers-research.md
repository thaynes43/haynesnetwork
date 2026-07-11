# Book / audiobook private trackers on the Prowlarr + Mullvad-qBittorrent stack — research

- **Date:** 2026-07-10
- **Author:** research subagent (web research, current as of 2026-07; read-only cluster inspection)
- **Owner ruling (2026-07-10):** torrents + special book trackers are wanted for the books pipeline —
  LazyLibrarian via Prowlarr; qBittorrent behind Mullvad. This doc is research only.
  **No cluster changes and no deployments were made.**
- **Scope:** which private trackers matter for ebooks/audiobooks/comics, their signup + rules
  that bite our specific topology, exact Prowlarr/qBittorrent integration mechanics, seeding
  strategy, and a safe order-of-operations checklist.

> ⚠️ Nothing here is a config change. Anything touching `haynes-ops` (a mam-update sidecar,
> pinning the Mullvad server at the VLAN gateway, etc.) is called out as a **future planned
> change**, to go through the normal GATE-A branch → PR flow, not applied here.

---

## 0. What this cluster actually does (grounding — read from `haynes-ops`, read-only)

These facts change the advice materially, so they come first. Sources: files under
`/home/thaynes/workspace/haynes-ops/kubernetes/main/apps/downloads/`.

| Fact | Where | Why it matters |
|---|---|---|
| **qBittorrent egresses over a VPN *VLAN*, not gluetun.** The pod attaches a Multus **macvlan** NAD (`static-vpn-qbittorrent`) on `eth1`, static IP `192.168.30.249/24`, and routes *all public space* to gateway `192.168.30.1`; RFC1918 stays on the cluster net. | `qbittorrent/app/multus-vpn.yaml`, `helmrelease.yaml` (pod annotation `k8s.v1.cni.cncf.io/networks: static-vpn-qbittorrent`, nodeSelector `network.haynesops.com/vpn: "true"`) | There is **no per-pod VPN client to reconfigure**. The Mullvad tunnel lives at the VLAN gateway (`.1`). The **public exit IP is decided upstream and is shared by every VLAN-30 pod** (qBittorrent *and* slskd both share it — `slskd/app/multus-vpn.yaml`, static `.248`). |
| **Readiness = Mullvad-egress check.** Readiness probe runs `wget … https://am.i.mullvad.net/connected \| grep "You are connected"`; VPN dead/leaking → NotReady → traefik 503 → Gatus pages. | `qbittorrent/app/helmrelease.yaml` L46–61 | Good news: the stack already **fails closed** — qBittorrent cannot announce out the bare WAN. That protects us from the single worst MAM mistake (seeding from an unexpected IP). |
| **Prowlarr has NO VPN** (explicit user call), just kept off control-plane nodes. | `prowlarr/app/helmrelease.yaml` L26–34 | Prowlarr's tracker *searches* egress the **home WAN IP / residential ASN**, while qBittorrent's *announces* egress the **Mullvad IP**. This two-IP split is the crux of the MAM setup (see §3). |
| **Mullvad blocks inbound** (no port-forwarding — confirmed in comments and by Mullvad policy). | `slskd/app/helmrelease.yaml` (“Mullvad blocks inbound, so distributed children can never…”), `soularr/app/externalsecret.yaml` | qBittorrent will be **"not connectable"** on every tracker. This is survivable on MAM specifically (its economy rewards seed *time*, not just bytes) — see §2/§4 — but it is the single biggest constraint. |
| **Seeding storage is available on gasha01.** qBittorrent mounts NFS `gasha01.haynesnetwork:/hdd-nfs-repl` → `/data/cephfs-hdd` (replicated HDD), plus `haynestower:/mnt/user/data` → `/data/haynestower`. | `qbittorrent/app/helmrelease.yaml` L168–192 | Books/audiobooks are tiny, so seeding thousands is a non-issue. Put the book-torrent save path on **`/data/cephfs-hdd`** (gasha01) as the task intends. |
| qBittorrent already stays up 24/7 with a fixed torrenting port `50469`. | `helmrelease.yaml` L38 | Satisfies MAM/32P seed-*time* rules without any new infra — the client just needs to keep seeding and never delete early. |

**Bottom line from grounding:** the hard part is not "add an indexer." It is reconciling MAM's
IP model with (a) Prowlarr on the home WAN, (b) qBittorrent on a **shared, inbound-blocked
Mullvad exit IP**, and (c) that exit IP possibly changing when the gateway reconnects.

---

## 1. Which trackers matter (per-tracker table)

Realistic 2026 landscape for ebooks/audiobooks/comics for a newcomer with no existing private-tracker
pedigree:

| Tracker | Content | Access difficulty | Prowlarr support | VPN / seedbox policy | Risk notes |
|---|---|---|---|---|---|
| **MyAnonaMouse (MAM)** | Ebooks, **audiobooks** (160k+), magazines, radio, musicology, some comics | **Realistic / first-class.** Open **application + IRC interview**; interviews currently done **Wed & Sat**. No upload pedigree required. | ✅ Built-in private indexer ("large ebook and audiobook tracker"). Auth = **`mam_id` session cookie**. | ✅ **VPN explicitly allowed** but you must **declare shared-IP VPN to staff** and/or run a **dynamic-seedbox session**. This is the tracker to build around. | Shared Mullvad IP ⇒ "multiple users per IP" is the ban risk if not declared. Small files ⇒ brutal byte-ratio, but points economy covers it. |
| **Bibliotik (BiB)** | **Ebooks** (best ebook library), some audiobooks/comics/mags | **Very hard.** Strictly invite-only, **no open signups**, invites rationed 1–4/period, staff vet your upload history elsewhere. Buying invites = instant ban. | ✅ Built-in private indexer ("Private Torrent Tracker for EBOOKS and AUDIOBOOKS"). | No published VPN-friendliness comparable to MAM's; treat like a standard IP-locked private tracker. | **Not attainable now.** Path in: build MAM ratio → MAM invite forums → recruit. Park it. |
| **32Pages / ComicBT (32P)** | **Comics**, graphic novels, some manga (Gazelle-based) | **Hard-ish.** Applications open **the 1st of each month** at `32pag.es/application.php` (comic-knowledge questions); also invite/recruitment. Some historical uptime wobble — verify it's live before relying on it. | ⚠️ Gazelle tracker; a Prowlarr/Cardigann **32Pages definition has existed** but was *not* clearly in the current supported-indexers snapshot I pulled — **confirm it appears in your Prowlarr "Add Indexer" list** before planning around it. Otherwise Gazelle ≠ generic Torznab, so no easy fallback. | Standard private-tracker IP handling; no special VPN allowance documented. | Only pursue **if comics are actually wanted**. Otherwise skip — it adds ratio obligations for a niche. |
| **AudiobookBay (ABB)** | Audiobooks | **Easy** (public/semi). Not a ratio tracker. | ⚠️ In Prowlarr but **ABB blocks Prowlarr's User-Agent**; needs the LinuxServer UA-patched image or the "AudioBookBay Automated (ABBA)" front-end. | Public — VPN just for privacy; no seedbox rules. | Good **zero-obligation fallback** for audiobooks you can't find on MAM. Quality/metadata inconsistent. |
| Redacted / Orpheus | Music (audiobooks *not* their remit) | — | — | — | **Not book trackers** — don't confuse audiobooks with audio. Ignore for this pipeline. |

**Tooling note (LazyLibrarian was the right call):** **Readarr is effectively retired/archived**
as of 2025; LazyLibrarian is the actively-maintained "*arr for books" and speaks **Torznab**, so
it consumes Prowlarr indexers directly. Wire indexers in **Prowlarr**, not inside LazyLibrarian;
LazyLibrarian just adds the Prowlarr Torznab feed(s) as `torznab` providers and points its
download client at qBittorrent. (LazyLibrarian also has a *native* MAM provider, but keeping
everything behind Prowlarr is cleaner for one session/one audit surface.)

**Recommendation:** Stand up **MAM only** first. It is simultaneously the best audiobook library,
the most VPN-tolerant, and the *gateway* (its invite forums, unlocked at ~1 TiB upload / ~6 months)
to Bibliotik and 32P later. Add ABB (UA-patched) as an easy audiobook fallback. Treat Bibliotik/32P
as future, invite-gated adds.

---

## 2. Signup reality + the rules that bite *our* setup

### MAM signup
1. Watch for open applications (currently open per opentrackers). Apply at `myanonamouse.net/inviteapp.php`.
2. Join their **IRC help channel**; queue for an interview (historically `!inv` in `#help`).
   **Interviews run Wed & Saturday.** Expect questions on ratio discipline, private-tracker
   etiquette, and your client knowledge. Passing may still have a short wait.
3. There is **no upload-pedigree requirement** — unlike Bibliotik/32P — which is exactly why MAM
   is the correct entry point.

### The rules that BITE with our topology

- **VPN is allowed, but shared IPs must be declared.** MAM's own rule: *if you know/suspect your
  VPN/proxy/seedbox provider puts multiple users on one IP, message staff* with the provider, the
  IP/domain, and ask them to flag your account. **Mullvad exit IPs are shared among many customers**,
  some of whom are also MAM members → without declaring, you risk a **"multiple users on one IP"**
  disable. **This is a mandatory pre-seed step for us.**
- **Don't browse from public/work networks.** Even with a seedbox IP set, browsing from
  hotel/work/Starbucks can trip the multi-user-per-IP tripwire.
- **Seed-time / hit-and-run:** minimum seed obligation (ebooks documented at **72 hours**). Bonus
  points also unlock **after 72h** of seeding a torrent. **You satisfy this by keeping qBittorrent
  up and never deleting early — which our stack already does.** Being "not connectable" (Mullvad,
  no inbound) does **not** stop seed-*time* accruing; MAM counts it from announces.
- **Ratio math on tiny files is brutal — but MAM's economy is the escape hatch.** A 200 MB
  audiobook at ratio 0 "owes" 200 MB of upload, and with no inbound + few peers you may never push
  it. MAM sidesteps this:
  - **Bonus points** accrue by *seed time × how few seeders a torrent has* (roughly 0.25–4 pts/hr).
    "Seed the largest quantity of the smallest torrents" is the documented strategy — perfect for
    a books library.
  - **Convert points → upload credit:** ~**5,000 pts ≈ 25 GB upload credit** (this also grants
    **Power User**). Points → ratio, without ever uploading to a peer.
  - **VIP** (≈**5,000 pts**, requires Power User first) makes **all your downloads freeleech** →
    downloads stop costing ratio entirely, and raises the concurrent-seed cap to ~150.
  - New members also get **starting upload credit + freeleech grace** and can be gifted **FL wedges**
    (scarce — hoard them for genuinely large grabs; rely on VIP/site-wide-FL for the rest).
  - Net: keep 24/7 seeding → earn points → buy 25 GB (Power User) → buy VIP → downloads are free →
    ratio is a non-problem. ~**1 TiB uploaded / ~6 months** unlocks the **invite forums** (the door
    to Bibliotik/32P).

### Bibliotik / 32Pages signup reality
- **Bibliotik:** invite-only, no interviews-for-strangers, vetted on prior upload history. **Do not
  buy invites** (instant, permanent ban and it burns the inviter). Only realistic via MAM-earned
  standing later.
- **32Pages:** monthly applications on the **1st** with comic-knowledge questions, plus member
  recruitment. Verify the site is live at application time.

---

## 3. Prowlarr + Mullvad integration mechanics (the hard part)

### The two-IP model (why our split works with MAM)
MAM authenticates **two different things two different ways**:
- **Site/search/API** (what **Prowlarr** does) → the **`mam_id` session cookie**, which is
  **IP-locked or ASN-locked**.
- **Torrent announces** (what **qBittorrent** does) → the **passkey embedded in each `.torrent`**,
  and MAM checks the **announce source IP** against your allowed IPs. **qBittorrent uses NO
  `mam_id`.**

MAM explicitly supports **"browse from home IP, seed from a separate seedbox IP."** Map that to us:

| MAM concept | Our component | Egress IP MAM sees |
|---|---|---|
| "Home / browsing IP" (session cookie) | **Prowlarr** (off-VPN) | home **WAN / residential ASN** |
| "Seedbox IP" (announce) | **qBittorrent** (VLAN-30) | **Mullvad exit IP** (shared, inbound-blocked) |

So the topology is *natively compatible* with MAM — provided we register both sides correctly.

### Session cookie mechanics — exact steps
1. On `myanonamouse.net` → click your username → **Preferences → Security**.
2. **For Prowlarr (search session):** create a session **while browsing from the home WAN** (same
   egress Prowlarr uses). If the home WAN IP is static, take the **IP-locked** cookie; if it's a
   dynamic residential IP, use **"Switch to ASN locked session"** so a changing IP within your ISP's
   ASN doesn't break searches. Copy the `mam_id` value ("View IP locked session cookie").
3. In Prowlarr → **Add Indexer → MyAnonaMouse** → paste the value into the **MAM ID** field. Done —
   that's Prowlarr's only MAM credential.
4. **For the seedbox (announce) IP:** create a **separate** session and enable **"Allow session to
   set dynamic seedbox IP."** This yields a second `mam_id` used only by the updater below.

> **Give every app its own `mam_id`.** MAM **rotates the `mam_id` on each request**; if Prowlarr and
> the seedbox-updater share one cookie they invalidate each other and auth breaks intermittently.
> ⇒ **Session A = Prowlarr (home WAN). Session B = dynamic-seedbox updater (Mullvad).** qBittorrent
> holds no cookie.

### How the session interacts with the Mullvad exit — and what breaks on rotation
- The **Mullvad exit IP is set at the VLAN gateway (`192.168.30.1`)**, not per-pod. Every VLAN-30
  pod shares it. When the gateway's Mullvad tunnel reconnects/rotates server, **the exit IP (and
  possibly its ASN) changes**, even though the pod's static `.249` never does.
- **What breaks:** MAM will start rejecting announces from the new, unregistered exit IP, and an
  **ASN-locked** seedbox session will throw **"ASN mismatch"** if the new exit is on a different
  Mullvad-adjacent ASN (Mullvad rents servers across ASNs — its own AS39351 plus providers like
  M247, etc.).
- **How to register/keep the seedbox IP current (dynamic-seedbox updater):**
  - Endpoint: **`https://t.myanonamouse.net/json/dynamicSeedbox.php`**, called with the Session-B
    cookie: `curl -b 'mam_id=<SESSION_B>' https://t.myanonamouse.net/json/dynamicSeedbox.php`
    → returns `Completed` / `No Change` (or `No Session Cookie` / `Incorrect session type` on error).
  - **Rate limit: at most once per hour** — calling more often returns "Last Change Too Recent."
    Ready-made tools (`gellen89/mam-update`, `t-mart/mousehole`) self-throttle to hourly and only
    call when the detected IP actually changed.
  - **CRITICAL:** the updater **must egress the SAME Mullvad exit as qBittorrent**, because
    `dynamicSeedbox.php` registers *the caller's* source IP. Running it off-VPN would register the
    home WAN as the seedbox IP and break seeding.
- **Two ways to handle rotation (choose per owner appetite — both are future changes, not applied):**
  1. **Pin the exit + declare it (simplest ops).** Configure the Mullvad connection **at the VLAN
     gateway** to a **single fixed WireGuard server** so the exit IP/ASN is stable, then **message
     MAM staff to set that static seedbox IP** (and flag the shared-VPN usage). No updater needed
     while pinned. Downside: gateway-side change, and if Mullvad ever renumbers that server you
     re-declare. *(Gateway config is outside k8s and outside this repo — note only.)*
  2. **Run the dynamic-seedbox updater behind Mullvad (robust to rotation).** Deploy a tiny
     `mam-update` container that shares the Mullvad egress. Cleanest placement mirrors the existing
     **exporter sidecar pattern**: add it as a **sidecar in the qBittorrent pod** (same macvlan
     netns ⇒ identical exit IP), or as a small separate Deployment/CronJob carrying the
     `static-vpn-*` attachment (still the same gateway exit). It hits `dynamicSeedbox.php` hourly.
     **Still message staff once to declare shared-VPN usage** — the updater keeps the *IP* current
     but doesn't excuse an undeclared shared IP.
  - **Recommended:** do **both** — pin the gateway server for stability *and* run the updater as a
    safety net for the occasional renumber. Either way, **declare shared-VPN to staff first.**
- **Our fail-closed readiness probe is an asset here:** if the VPN drops/leaks, the pod goes
  NotReady rather than announcing from the bare WAN, so a rotation can never silently leak your
  home IP to the tracker.

### Prowlarr per-tracker notes
- MAM and Bibliotik are **built-in private indexers** — add via **Add Indexer**, paste credentials,
  Test. MAM needs only the `mam_id`; Bibliotik uses username/password (moot until you have access).
- 32Pages: **confirm the Gazelle definition exists in your Prowlarr build** before planning on it.
- AudiobookBay: needs the **UA-patched image** (LinuxServer fork) or the ABBA front-end, else
  Prowlarr requests are blocked.
- Prowlarr → LazyLibrarian is a **Torznab** feed; add each enabled indexer's Torznab URL + API key
  as a `torznab` provider in LazyLibrarian (don't double-configure indexers there).

---

## 4. Seeding infrastructure — can we satisfy the rules, and exact settings

**Can we meet seed-time / HnR?** **Yes.** MAM's obligations are **time-based** (≥72h) and its
points are **time-based**, and qBittorrent already runs 24/7. Being **"not connectable" (no inbound
via Mullvad) does not block seed-time or points** — it only reduces raw upload throughput, which the
points→upload-credit path compensates for. The only failure mode is **deleting/stopping a torrent
before its obligation** — so lock the client against early removal.

**Storage:** put the book-torrent save path on the **gasha01-backed replicated volume**
(`/data/cephfs-hdd`, from `gasha01.haynesnetwork:/hdd-nfs-repl`). Books are KB–MB scale; thousands
of seeds cost almost nothing.

**qBittorrent settings (future config, not applied):**
- **Categories per tracker:** e.g. `books-mam`, `books-32p`, `books-abb`, each with a **save path
  under `/data/cephfs-hdd/torrents/books/<cat>`**. Categories let LazyLibrarian route and let you
  apply different seed rules.
- **Seeding limits for MAM/32P categories: never auto-stop.** Set ratio limit and seed-time limit
  to **unlimited (-1)** / "when limit reached: **Do nothing**." MAM wants indefinite seeding for
  points; auto-pausing kills point accrual and risks HnR.
- **Never enable "delete files after ratio/seeding limit"** on these categories.
- **Import must keep seeding.** Configure LazyLibrarian/*arr to **hardlink + keep the torrent
  seeding**, not move/delete. Put the **download dir and the library dir on the same NFS filesystem**
  so hardlinks work (otherwise it's a copy — tolerable for tiny books, wasteful at scale).
- **Private-torrent hygiene:** qBittorrent auto-disables **DHT/PEX/LSD per-torrent** for the private
  flag — leave that behavior on; do **not** force-enable DHT/PEX globally in a way that overrides it,
  and **don't enable "anonymous mode"** (can interfere with announces). Keep the fixed torrent port
  `50469` even though inbound is blocked.
- **Concurrent-seed cap:** MAM caps torrents under seed (raised to ~150 with VIP). Raise
  qBittorrent's max active torrents/uploads accordingly once VIP is in hand.
- **Bandwidth:** no special limits needed; upload is opportunistic given no inbound.

**Prowlarr settings:** default sync; ensure the MAM indexer's **seed-ratio/seed-time defaults it
pushes to the client** (Prowlarr can set per-indexer seed criteria) are **not** stricter than "seed
forever" — i.e., don't let Prowlarr inject a low ratio/time that makes qBittorrent stop early.

---

## 5. Safe order-of-operations checklist (owner-facing)

**Phase A — account first, no downloads yet**
1. Apply to **MAM** (`inviteapp.php`), join IRC, pass the **Wed/Sat interview**. (Bibliotik/32P: park
   for later — invite-gated.)
2. **Decide the Mullvad exit handling** (owner input needed — see open questions): pin gateway server,
   run updater, or both.
3. **Before any seeding, message MAM staff** from the internal mail: state you seed from **Mullvad
   (shared IP)**, give the **current exit IP/ASN**, and ask them to flag the account for VPN/seedbox
   use. This is the single most important anti-ban step.
4. In **Preferences → Security**, create **two** sessions: **Session A (IP- or ASN-locked, from the
   home WAN)** for Prowlarr; **Session B ("Allow dynamic seedbox IP")** for the updater.

**Phase B — configure before the first download**
5. Add **MyAnonaMouse** in **Prowlarr** with Session A's `mam_id`; **Test** green.
6. Stand up the **seedbox-IP registration** path (pin and/or updater behind Mullvad using Session B),
   and confirm MAM shows the **Mullvad exit** as your seedbox IP. (Sanity-check via
   `myanonamouse.net/headers.php` proxy/seedbox diagnostics that MAM sees the Mullvad IP, not the WAN.)
7. In **qBittorrent**, create the **`books-mam` category** on **`/data/cephfs-hdd`** with
   **seed-forever** limits; verify the **Mullvad readiness/egress** is green (it already gates the pod).
8. Wire **Prowlarr → LazyLibrarian** (Torznab) and LazyLibrarian → qBittorrent; verify LazyLibrarian
   can reach Prowlarr and vice-versa.

**Phase C — build ratio deliberately**
9. Grab **small, few-seeder freeleech** ebooks/audiobooks in **batches (start ~20)**; **keep every
   one seeding ≥72h**, then scale batches up.
10. Accrue points → **buy 25 GB upload credit (→ Power User)** → **buy VIP** (all downloads freeleech).
    Reserve **FL wedges** for genuinely large grabs.
11. At ~**1 TiB up / ~6 months**, the **invite forums** open → that is the realistic route to
    **Bibliotik** and **32Pages** later.

### NEVER do (these get people banned / break the setup)
- ❌ **Never let qBittorrent announce from the bare WAN or a leaking IP.** (Our readiness probe
  already fails closed — don't disable it.)
- ❌ **Never seed on MAM from the shared Mullvad IP without declaring it to staff.**
- ❌ **Never share one `mam_id` across apps** (rotation invalidates both).
- ❌ **Never run `dynamicSeedbox.php` more than once/hour** ("Last Change Too Recent").
- ❌ **Never delete/stop a torrent before its ≥72h obligation** (hit-and-run).
- ❌ **Never browse MAM from public/work Wi-Fi** (multi-user-per-IP disable).
- ❌ **Never buy/sell/trade invites or accounts** (MAM, Bibliotik, 32P all permaban — and it burns
  your inviter).
- ❌ **Don't waste scarce FL wedges** on small files — use VIP/site-wide freeleech instead.
- ❌ **Don't run the seedbox updater off-VPN** (would register the wrong IP).

---

## 6. Open questions / decisions for the owner (before any cluster change)

- **Q1 — Mullvad exit:** Is the gateway's Mullvad tunnel **pinned to one WireGuard server** (stable
  exit IP/ASN) or does it rotate? Determines whether the `mam-update` updater is *mandatory* or a
  *safety net*.
- **Q2 — Updater placement:** If we run it, prefer a **sidecar in the qBittorrent pod** (mirrors the
  existing exporter sidecar) vs. a standalone `static-vpn` CronJob? (Sidecar = simplest, guaranteed
  identical egress.) — future PLAN item, GATE-A flow.
- **Q3 — Home WAN IP:** static or dynamic? Determines **IP-lock vs ASN-lock** for Prowlarr's
  Session A.
- **Q4 — Comics scope:** Do we actually want comics (⇒ pursue 32Pages and confirm its Prowlarr
  definition), or is books/audiobooks enough (⇒ skip 32P entirely)?
- **Q5 — ABB:** Worth the UA-patched Prowlarr image / ABBA front-end for an easy audiobook fallback,
  or keep the indexer set to MAM-only for simplicity?

---

## Sources

- MAM signup / interview: https://opentrackers.org/myanonamouse/ · https://www.myanonamouse.net/inviteapp.php
- MAM session / seedbox / dynamic IP mechanics: https://grimore.org/linux/automating_myanonamouse_private_tracker · https://github.com/gellen89/mam-update · https://github.com/t-mart/mousehole · https://www.myanonamouse.net/headers.php · Jackett dynamic-IP request: https://github.com/Jackett/Jackett/issues/8265
- MAM VPN / shared-IP / seedbox rules: https://www.myanonamouse.net/rules.php (per search excerpts) · https://www.myanonamouse.net/faq.php
- MAM ratio / points / VIP / freeleech strategy: https://mampointsguide.neocities.org/ · https://www.invitehawk.com/topic/159801-myanonamouse-freeleech-help/ · Prowlarr FL-wedge behavior: https://github.com/Prowlarr/Prowlarr/issues/2536 · autobrr VIP vs FL: https://github.com/autobrr/autobrr/discussions/1666
- Prowlarr MAM setup: https://github.com/Prowlarr/Prowlarr/issues/125 · MouseSearch context: https://github.com/sevenlayercookie/MouseSearch
- Mullvad port-forwarding removal (no inbound): https://mullvad.net/en/blog/removing-the-support-for-forwarded-ports
- Bibliotik access: https://torrends.to/site/bibliotik · https://grokipedia.com/page/Bibliotik · https://github.com/PredictablePirate/TrackerInviteThreads
- 32Pages / ComicBT: https://opentrackers.org/32pages/ · https://torrends.to/site/32pages
- AudiobookBay in Prowlarr (UA block / workaround): https://szmer.info/post/3760653/5961390 · https://store.elfhosted.com/product/audiobookbay-automated/
- LazyLibrarian + Prowlarr/Torznab: https://lazylibrarian.gitlab.io/config_providers/ · https://www.bigiron.cc/guides/lazylibrarian-the-book-acquisition-automation-pattern
- Prowlarr supported indexers (MAM, Bibliotik confirmed): https://github.com/Servarr/Wiki/blob/master/prowlarr/supported-indexers.md
- Cluster grounding (read-only): `haynes-ops/kubernetes/main/apps/downloads/{qbittorrent,slskd,prowlarr}/…`
</content>
</invoke>
