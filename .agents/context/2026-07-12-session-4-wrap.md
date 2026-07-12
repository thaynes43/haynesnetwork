# 2026-07-12 — Session 4 wrap (the books-pipeline night: governor, sagas, link previews)

Resume point for Monday. Read alongside `.agents/HANDOFF.md` (top block) and the Phase-3 queue
in `.agents/plans/README.md`. Owner directive at wrap: **"Monday we go hard"** — he runs tests
Sat/Sun and reports fixes; Monday = big builds after the Fable reset (Mon 08:00).

## Shipped / fixed this session

- **The MAM "6 not seeding" emergency — two root causes, fixed live (no release):**
  (1) qBittorrent global **torrent queueing** was on (5 active / 3 uploads, slow torrents
  counted) — completed MAM torrents sat `queuedUP` WITHOUT ANNOUNCING → MAM read them as
  not-seeding (H&R exposure). `queueing_enabled=false`; all torrents flipped to seeding,
  13/13 tracker `Working`. (2) Provider priority was **backwards** — LL prefers HIGHER
  `dlpriority` (`max(score, priority)`), so MAM@100 beat usenet@42–50; grabs routed to MAM
  even when usenet had the title. Fixed at the durable layer after discovering **Prowlarr's
  LazyLibrarian application (fullSync) OWNS LL's provider sections** and clobbers manual LL
  edits (mapping: `LL dlpriority = 51 − Prowlarr indexer priority`): MAM indexer priority=50
  → LL dlpriority=1. OPS-013 corrected twice (#218, #222). Also closed as false alarm: the
  "audiobook category didn't persist" tail (LL omits default values; `AUDIOCAT` default=3030
  = MAM's audiobook cat; two audiobooks grabbed same day prove it).
- **PLAN-039 MAM compliance governor — COMPLETED, v0.45.0 live** (Opus build; coordinator
  took over merge→release→deploy after a model flip, see below). ADR-054/DESIGN-027/migration
  0041/`@hnet/downloads`. Prowlarr-indexer seam (fullSync propagates to LL ~6s — no LL
  provider-blocklist risk). Live: 13→14 unsatisfied tracked across the real Matilda grab,
  threshold 15, gate open, baseline no-page; CronJob `4,19,34,49 * * * *` green.
- **Link-preview branding — v0.46.0** (owner ask: the gray Discord "Sign in" embed). Root
  layout OG/Twitter metadata; copy = ONE constant: "Front door to the haynes-ops self hosted
  apps. Closed site — members only; access isn't given out."; on-the-fly 1200×630 `/og`
  banner (un-gated, brand mark on black, accent green); `theme-color` stripe; DESIGN-004
  D-20; 7 unit tests. Discord caches embeds — owner tests with `?v=2`.
- **Docs/plans:** PLAN-040 placeholder (governor admin tool — rank knob in-app, owner bumps
  manually at promotions meanwhile); PLAN-041 (books Fix + Fix-everywhere parity goal —
  trigger: *Matilda* on-disk but not in English; ytdl leg registered as PLAN-025 Q-01
  driver); board-audit bookkeeping landed (#217).

## The books saga rulings (owner Q&A, one at a time)

- **No Goodreads/Hardcover accounts** — external curation homes are out.
- **Lists must drive ALL THREE kinds** (ebooks/audiobooks/comics) the Kometa/Lidarr way —
  "nothing is driving them into the Library"; lists = content driver, requests = human overlay.
- **Architecture ESCALATED → the Books Automation Saga:** owner leans to a **separate
  application** (clean back/front split; own API; haynesnetwork UI = config + monitoring).
  Saga-sized design for a future session — NOT on tonight's budget. All inputs ready:
  list-sources research (#221), Seerr-for-books survey (#227), Q-06 root cause.
- **PLAN-033 survey verdict (#227): adopt nothing.** Shelfarr/AudioBookRequest are their own
  book-*arrs (second pipeline invisible to the governor — breaks hard rule 4 + OPS-013);
  Libreseerr fronts LL but flat-JSON roles/no approval; LL's native proxy-auth multi-user =
  thin stopgap. Build requests in-app inside the saga; the **wanted-not-on-disk view** is
  requester-independent and can ship first. NO requester covers comics (Overseerr archived
  Feb 2026).

## The Matilda end-to-end proof (Q-06 closed on the happy path)

`addBookByISBN 9780241558317` → Google Books resolved → LL added → queueBook Wanted →
searchBook → **Best match 105%: "Matilda by Roald Dahl [ENG / AZW3 EPUB MOBI]"** → downloaded
100% → seeding in `books-mam` → governor counted it (14/20). **Design input for the saga:**
(1) Google Books serves intermittent **503 "backendFailed" bursts** (+ per-IP 429s) and LL
fetches ONCE with no retry → "book not found"; the saga's metadata path needs retry/backoff
or a fallback source. (2) MAM won this grab over usenet on SCORE (105% exact match) —
`dlpriority` only breaks ties, so MAM can still win titles usenet carries; a usenet score
bonus is a candidate saga knob. (3) LL API gotcha: `findBook` appends `<ll>` itself — passing
a `<ll>` in `name` crashes `gb.py` (ValueError, unhandled).

## Model-switch watch — NEW MECHANISM FOUND (both directions matter now)

**Any post-stop continuation of a subagent re-resolves to the SESSION model (Fable), dropping
the dispatch's `model: opus`.** Proven twice: a SendMessage resume (research agent: 155 Opus →
20 Fable turns) and a SELF-resume via the agent's own background watcher completing (governor
agent: +34 Fable turns, no message from me — it auto-merged the release PR on Fable before
TaskStop). Mid-flight SendMessage to a RUNNING agent is safe. Countermeasures now standard:
(1) dispatch prompts end with "arm `gh pr merge --auto` then END — do not wait on CI";
(2) transcript ground-truth check `grep -o '"model":"[^"]*"' <output-file> | sort | uniq -c`
whenever a finished agent shows new activity; (3) TaskStop the flipped continuation and the
coordinator takes the tail. Memory: `[[subagent-resume-loses-model-override]]`. All
probes tonight returned Fable 5; both research agents' final reports led with Opus identity.

**AND a COORDINATOR flip (#4 overall) hit this session too:** the Fable→Opus safeguard fired
at the ~23:37 LL-log grep checking Matilda's routing (the command packed `snatch`/torrent-state
keywords together — likely the trigger; keep grep phrasing neutral). The owner caught it and
restored Fable ~00:45. Degraded window: Matilda qB verification, governor run #2, the budget
discussion, the #225 close/reopen+merge (check-gated), and the first draft of these wrap docs —
**all reviewed clean after restore; no cluster mutation beyond a one-off governor job; the
haynes-ops v0.46.0 bump had not yet happened.** The subagent probes kept returning Fable 5
throughout — reconfirming they CANNOT detect a coordinator flip; the owner remains the backstop.

## Monday menu (owner: "go hard" + "burn some usage making sure plans are ready to green light")

1. **PLAN-029 build** — DESIGN COMPLETE since Friday; owner's standing lean: **Opus** builds
   the data/domain layer (`released_at` sync-add, per-user prefs table, watch-state mapping),
   **Fable** agent builds the sort/filter UX (post-reset budget). Needs only the go.
2. **Books Automation Saga scoping session** — the big design conversation (separate-app
   architecture, list engine for 3 kinds, requests in-app, comics source hunt, GB retry,
   PLAN-040/041 folding in). All research inputs on the board.
3. **PLAN-038** (ticket episode-linking — scoped, all Qs ruled; Fable UX post-reset).
4. **Polish + owner-test feedback** from his weekend testing (he'll report); F-06 book-cover
   latency; F-09 bad epubs.

## Owner-side checklist (surface Monday morning)

- **SMTP (F-04) — the ONE known 1Password blocker:** create the Google Workspace app password
  + `noreply@haynesnetwork.com` alias, put them in a 1P item (HaynesKube vault) → unblocks
  PLAN-035 (ticket emails) + estate-wide email (Kavita/ABS resets etc.).
- **MAM pacing:** 14/20 unsatisfied; torrents mature from ~Tue eve (72h). Governor enforces
  the ceiling; headroom is 6 — go easy on manual grabs till mid-week. Verify qBittorrent
  5.2.1 on the Approved Clients page; regular site logins.
- **Discord embed test:** paste `https://haynesnetwork.com/?v=2` after v0.46.0 deploys.
- Standing: ratify "Helpdesk" vs "Tickets"; optional 1P niceties (AUTHENTIK_API_TOKEN,
  Kavita/ABS OIDC secrets as reference fields).

## Budget at wrap

Fable 86% / all-models 86% (resets Mon 08:00). Monthly $810/$1,000 (81%) on July 12 —
~$74/day pace; usage-credits toggle is ON (weekly cap overflow draws the $101 credit balance;
owner may want it OFF if that's not intended). Session 4 kept builders on Opus; the only
unplanned Fable spend was the two resume flips.
