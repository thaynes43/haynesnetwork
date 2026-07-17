# MAM bonus points / VIP research — spend strategy for the seed-forever books pipeline

Research-only. No action was taken against MyAnonaMouse (no login, no purchase, no API call).
Every spend is the owner's to make in-site. Public sources only; MAM's own wiki/FAQ/rules are
login-walled, so exact live prices are flagged VERIFY IN-SITE where they could have drifted.

## TL;DR (the one thing that matters)

The task's hypothesized mechanism is **wrong**, and it is the most important correction here:

> "Buy VIP so most grabs become freeleech, so unsatisfied-seed obligations stop accruing, so the
> governor cap effectively lifts."

**Freeleech does not touch seed obligations.** Freeleech (whether site-wide, VIP-only, or from a
wedge) zeroes only the *download* side (the `downloadvolumefactor`, i.e. what the grab costs your
ratio). The **72-hour seed obligation is independent of freeleech** and applies to freeleech
torrents exactly as it does to paid ones. The governor counts a torrent as "unsatisfied" until it
has seeded 72h regardless of freeleech status. So no amount of freeleech lifts the governor cap.

What **does** raise the cap is **user class**. The unsatisfied-torrent cap is a per-class limit:
**New Member 20 → User 50 → Power User 100 → VIP 150**. The optimal strategy is therefore about
*class progression* (mostly earned, partly points-accelerated), not about freeleech. VIP helps the
cap because VIP is a higher *class* (150), not because VIP grants freeleech.

---

## Q1 — What bonus points can be spent on

Points (earned mainly by seeding — MAM pays points for seeding even with zero leechers, which is
exactly what a seed-forever fleet does) are spendable on:

| Sink | Public price / mechanic | Confidence |
|---|---|---|
| **Upload credit** (GB added to your up-total → raises ratio) | **~500 points per 1 GB** (corroborated: the MAM-Spender script buys 100 GiB for 50,000 pts = 500 pts/GB) | Good, VERIFY current rate in-site |
| **VIP status** (the class) | Buyable with points **only after you are Power User**; sold/extended in weeks up to a rolling maximum window (community scripts renew when the remaining VIP window drops to ~83 days, implying a cap around ~90 days / ~13 weeks that you keep topping up) | Mechanic good; exact points-per-week is login-walled — VERIFY IN-SITE |
| **Freeleech wedge** (makes one torrent freeleech) | Buyable with points, but widely described as **overpriced vs just buying upload credit** | Good |
| **Ratio / "upload ratio status"** | Effectively the same lever as upload credit — points → GB → ratio | Good |
| **Millionaire's Vault** contribution | Points sink for a community pot / status; automation scripts top it to ~2,000. Not throughput-relevant | Low, VERIFY |

Sources: MAM-Spender and mam-script READMEs, InviteHawk/autobrr threads, MAM FAQ references (see
Sources). Exact live point prices should be confirmed on MAM's own points page before any spend.

## Q2 — What VIP actually changes

- **Access:** VIP-only forum and a large pool of **VIP freeleech torrents** (these announce/parse
  as freeleech).
- **Class cap:** VIP is the top of the unsatisfied-cap ladder — **150** unsatisfied torrents vs
  Power User's 100. This is the real, governor-relevant effect.
- **Credit:** VIP members are described as having "plenty of credit to download" (ratio pressure
  effectively removed while VIP).
- **What VIP does NOT change:**
  - It does **not** remove the **72h seed obligation** per torrent. Each grab still occupies an
    unsatisfied slot for its first 72h.
  - It does **not** exempt you from **hit-and-run** rules — you still must seed 72h within 30 days.
    (The estate seeds forever, so this is already satisfied by construction.)
- **Prerequisite:** buying VIP with points **requires Power User first**. You cannot points-buy
  your way from New Member straight to VIP.
- **Duration:** bought/extended in weeks, renewable up to a rolling max window (~90 days-ish);
  keep-topped-up is the normal pattern. Exact points-per-week: VERIFY IN-SITE.

## Q3 — Wedges (freeleech tokens)

- A wedge flips one specific torrent to freeleech (zeroes its download/ratio cost) for the user who
  applies it.
- It does **not** reduce seed time or the unsatisfied count.
- Community consensus: **wedges are a poor value** vs buying upload credit outright, and OPS-013 §3
  already sets `useFreeleechWedge = No` (hoard, do not auto-spend).
- **When a wedge would ever beat VIP/credit:** only for a *large, non-freeleech, must-have* single
  item when you are ratio-constrained and not VIP. For this estate — which filters to
  `downloadvolumefactor=0` freeleech items and seeds forever — that case essentially never arises.
  **Recommendation: keep hoarding wedges, do not spend.**

## Q4 — Upload credit and whether ratio even matters here

- **Cost:** ~500 points/GB (VERIFY current rate).
- **Effect:** raises your up-total, hence global ratio. MAM requires **global ratio ≥ 1.0 at all
  times**; dropping below can block downloads. Power User promotion needs **ratio 2.0**.
- **Does ratio matter for this estate's obligation model?** Two different constraints, do not
  conflate them:
  - **Ratio constraint** — governs whether MAM *lets you download at all*. With a seed-forever
    fleet plus freeleech-first grabbing, ratio only climbs (freeleech grabs cost 0 download; every
    seeding torrent earns credit). So ratio is unlikely to bind in steady state.
  - **Unsatisfied-cap constraint** — governs the *governor* (concurrent not-yet-72h grabs). This is
    what actually paces throughput here. Ratio does **not** affect it.
  - So upload credit's value to this estate is **not** day-to-day headroom (ratio isn't the
    binding constraint); its value is **accelerating promotion** (guaranteeing the ratio-2.0 gate
    for Power User the moment the time+upload gates are met), which raises the *cap*. Indirect but
    real.

## Q5 — Rank / class progression (what raises the cap)

The unsatisfied cap is a **class** attribute. Ladder and the levers that move it:

| Class | Unsatisfied cap | How you get there |
|---|---|---|
| New Member | 20 | join |
| User | 50 | early automatic promotion (time/activity based) — VERIFY exact thresholds in-site |
| **Power User** | **100** | **auto:** member ≥ 4 weeks **AND** uploaded > 25 GB **AND** ratio ≥ 2.0 |
| VIP | 150 | **buy with points (Power User required)** or donate; VIP is a class you maintain |
| Elite / Elite VIP etc. | higher (VERIFY) | staff discretion / €100 donation for Elite VIP |

Key points:
- Power User is the big earned unlock (cap 20/50 → 100). Its gates are **time (4 weeks)**,
  **volume (25 GB uploaded)**, and **ratio (2.0)** — all three. Seeding-for-points + seed-forever
  drives volume and ratio; the 4-week clock is just time.
- **Where points/VIP help progression:** points → upload credit → guarantees the **ratio 2.0** gate
  for Power User (and keeps ratio ≥ 1.0 so downloads never block). Points → VIP is the *only* way to
  push the cap past 100 (to 150) short of staff-granted classes, and it requires Power User first.
- **Where they do NOT help:** points cannot buy down the **4-week** membership clock or the
  **25 GB** uploaded gate, and VIP does not shorten per-torrent seed obligations.

VERIFY IN-SITE: the exact User-tier thresholds and whether MAM's current class names/caps still read
20/50/100/150 (these match the OPS-013 §6 and rules-scrape figures the owner captured on join, so
they are the account's own recorded numbers — but re-confirm on the account's stats page).

## Q6 — SYNTHESIS: optimal spend strategy for max safe grab throughput

**Throughput model.** With seed-forever, a torrent is "unsatisfied" only during its first 72h, then
frees its slot permanently. So sustained safe grab rate ≈ **(cap − buffer) / 72h**. With the
governor's buffer of 5:

| Class | Cap | Effective (cap−5) | Sustained grabs/day (÷72h) |
|---|---|---|---|
| New Member | 20 | 15 | ~5/day |
| User | 50 | 45 | ~15/day |
| Power User | 100 | 95 | ~32/day |
| VIP | 150 | 145 | ~48/day |

The lever is **cap (class)**, full stop. Freeleech changes none of these rows.

### Ranked options

**Option 1 — Earn Power User first; spend points to guarantee the ratio gate. (DO THIS FIRST.)**
- **Mechanism:** PU raises the cap 20→100 (a ~6x throughput unlock) for **zero VIP spend**. Its
  gates are 4 weeks + 25 GB up + ratio 2.0. Seeding-for-points already drives volume/ratio; if
  ratio is short of 2.0 as the 4-week/25 GB gates come due, buy just enough upload credit
  (~500 pts/GB) to cross 2.0. That is the single highest-value use of points.
- **Risk:** low. Only risk is over-spending on credit you did not need — buy the minimum to clear
  2.0, not a big slug.
- **Governor config after PU lands:** `MAM_UNSATISFIED_LIMIT` 20 → **100**, keep
  `MAM_UNSATISFIED_BUFFER` 5 (pauses at 95). Bump the intermediate `User` step to **50** if the
  account promotes to User before PU.

**Option 2 — Buy/maintain VIP once Power User. (DO SECOND, if you want the extra 50%.)**
- **Mechanism:** VIP raises the cap 100→150 (~1.5x over PU → ~48 grabs/day) and unlocks VIP
  freeleech (more zero-ratio-cost inventory, which keeps ratio climbing and keeps downloads
  unblocked). This is the only points-buyable cap increase.
- **Risk:** low, but VIP is a **recurring** points cost (renew before the window lapses; scripts
  renew at ~83 days remaining). If VIP lapses you fall back to PU cap 100 — the governor must track
  that. Do **not** let the governor sit at 150 if VIP has expired (it would over-grab into a 24h
  download block).
- **Governor config while VIP active:** `MAM_UNSATISFIED_LIMIT` = **150** (buffer 5 → pause 145).
  On VIP lapse, revert to 100. This is exactly why PLAN-040 should make the limit a DB-backed admin
  setting with rank presets rather than a redeploy.

**Option 3 — Spend on freeleech wedges. (DO NOT.)**
- **Mechanism:** none relevant — wedges do not touch cap or seed obligation, and the estate already
  grabs freeleech-first and seeds forever so ratio is not the binding constraint. Wedges are also
  poor value vs credit. Keep `useFreeleechWedge = No`; hoard.

**Option 4 — Dump points into upload credit beyond the promotion gates. (LOW VALUE.)**
- **Mechanism:** more ratio headroom, but ratio is not what the governor gates on, and a
  seed-forever fleet is not ratio-starved. Only worth it as an overflow sink once VIP is maxed and
  ratio-for-invites (PU + ratio 1.51 + 1yr) is a goal. Otherwise the points are better parked toward
  VIP renewal.

### Recommended sequence
1. Keep seeding forever (already the doctrine) — this earns points and drives the 25 GB + ratio 2.0
   PU gates for free.
2. When the 4-week / 25 GB gates come due, spend the **minimum** upload credit to clear **ratio 2.0**
   → Power User → cap 100. Bump governor limit 20 → 100 (via User 50 if it lands first).
3. Once Power User, buy VIP with points → cap 150, and **maintain it** (renew before lapse). Bump
   governor limit 100 → 150; drop back to 100 if VIP ever lapses.
4. Never spend on wedges; treat extra points as VIP-renewal reserve, not bulk upload credit.

### Governor knobs this maps to (real config)
From OPS-013 §10.2 and `packages/downloads/src/config.ts` — the governor gates on a **local**
unsatisfied count from qBittorrent (`books-mam` category, 72h = `MAM_SEED_OBLIGATION_SECONDS`) and
actuates by toggling **Prowlarr indexer 17 `enable`**; it never calls MAM. The tuning knobs are:

- `MAM_UNSATISFIED_LIMIT` (default **20**) — **this is the rank knob.** Set it to the *current
  class cap*: New Member 20 / User 50 / Power User 100 / VIP 150. This is precisely the value
  PLAN-040 wants to move into an audited DB-backed admin setting with those four rank presets. My
  research says the preset values are correct **and** that VIP 150 requires PU-first and ongoing
  renewal, so the admin UI should treat VIP as a *maintained* state (a lapse must drop the preset
  back to 100), and Q-02's "auto-read rank from MAM" should read the **class**, not freeleech state.
- `MAM_UNSATISFIED_BUFFER` (default **5**) — leave at 5. The count is conservative (over-counts on
  wire hiccups), so 5 slots of headroom is fine at every cap; no need to widen as the cap grows.
- `MAM_ZERO_HEADROOM_ALERT_HOURS` (default **48**) — the "headroom pinned at 0 > 48h" alert is
  effectively the "you are cap-bound, check promotion eligibility" signal PLAN-040 §Niceties wants.
  Wire that alert's copy to hint "check MAM class/VIP — the cap, not the pipeline, is the limit."

---

## What the owner must verify in-site before spending (nothing here logs in for him)

1. **Current points prices:** upload credit pts/GB (expected ~500), VIP points-per-week and the max
   VIP window, wedge price. These are login-walled and can drift.
2. **His current class and its cap** on the account stats page — confirm the 20/50/100/150 ladder
   still holds and where he sits now.
3. **Power User gate status:** weeks elapsed, GB uploaded (need >25), current ratio (need ≥2.0) —
   so he buys only the minimum credit needed to clear 2.0.
4. **That freeleech does not waive the 72h seed rule** — one glance at the rules/FAQ confirms it;
   this is the load-bearing assumption behind "VIP does not lift the governor cap."
5. **VIP prerequisite** (Power User required to points-buy VIP) and the renewal cadence.

## Sources (public; MAM's own pages are login-walled)
- MAM-Spender (README: 50,000 pts = 100 GiB upload credit; wedge price high; vault): https://github.com/Plungis/MAM-Spender
- mam-script (README: VIP renew at ~83 days remaining; vault top-up ~2,000): https://github.com/ahmed-mohamed01/mam-script
- MyAnonaMouse FAQ (referenced, login-walled): https://www.myanonamouse.net/faq.php
- InviteHawk — Private Trackers user classes & benefits: https://www.invitehawk.com/topic/147817-private-trackers-user-classes-benefits/
- InviteHawk — MAM freeleech help: https://www.invitehawk.com/topic/159801-myanonamouse-freeleech-help/
- autobrr — VIP vs Freeleech (VIP announces/parses as freeleech): https://github.com/autobrr/autobrr/discussions/1666
- Wizardry & Steamworks — automating MAM (points-for-seeding; economy): https://grimore.org/linux/automating_myanonamouse_private_tracker
- Repo doctrine cross-checked: OPS-013 §6/§10, `.agents/context/2026-07-11-mam-rules-scrape.md`,
  PLAN-040, `packages/downloads/src/{config,read}.ts`.
