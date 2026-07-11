# MAM rules scrape (2026-07-11, rules.php) — compliance contract for PLAN-031

Scraped the day the owner interviewed. The wiring in PLAN-031 must satisfy every row here.
Research companion: `2026-07-10-book-trackers-research.md` (topology + economy strategy).

## Rules that bind our wiring (with the compliance answer)

| Rule (verbatim-in-substance) | Our compliance |
|---|---|
| One account per person/IP; VPN/proxy/seedbox users MUST register provider via Staff Contact System | Post-join staff message: Mullvad, shared exit IP (87.249.134.9 at scrape time, AS212238) — BEFORE first seed |
| Global ratio ≥ 1.0 at all times; new members get ~10GB upload credit | Points→credit economy (research §2); grab small freeleech first; never outrun the buffer |
| Every torrent: seed 72h within 30 days of completion (hit-and-run otherwise) | qBittorrent seed limits unlimited / "Do nothing"; never auto-delete; LL imports hardlink-and-keep-seeding |
| **Unsatisfied-torrent caps by rank: New Member 20 → User 50 → PU 100 → VIP 150** (exceed ⇒ downloads blocked 24h) | Cap concurrent not-yet-72h grabs < 20 until rank rises; batch size starts well under 20 |
| No partial downloads | Never use qBittorrent file-selection on MAM torrents |
| Only clients on the Approved Clients page; **auto-update disabled**; no alpha/beta/dev builds; no mobile clients | qBittorrent 5.2.1 stable — verify against the approved list on join; image pin = no auto-update (bumps are deliberate Renovate PRs) |
| "You may not automate any site functions except those specifically listed in the API Documentation"; no scraping | Automation limited to: Prowlarr's standard mam_id search auth + `dynamicSeedbox.php` (documented, ≤1/hr). NO other site automation, no scraping |
| Regular login required or account disables; "park" before absences | Owner habit note; Prowlarr searches alone are not a substitute for logging in |
| Don't reuse original .torrent files when sharing elsewhere | N/A (no cross-posting planned) |
| Content requests (site feature): monthly limits by rank (User 1, PU 2, VIP 4); books only, released only | Distinct from our in-app user requests (PLAN-033) — those never touch MAM's request system |
| No invite selling/trading; inviter liable for invitees | N/A / owner awareness |
| Forums/IRC etiquette: no begging (karma/invites/torrents), no swearing, English only, no offsite recruiting | Owner awareness |

## Interview-day facts used
Client qBittorrent 5.2.1 (verified from the running binary) · VPN provider Mullvad ·
exit 87.249.134.9 · home WAN 73.249.157.197 (Comcast AS7922, dynamic ⇒ ASN-locked Session A).
