# 2026-07-21 evening — pairing gap shepherded (+11 pairs) + the NZB duplicate-download incident

Owner: "Do it, and see if you can Shepherd in a few pairs" (ratifying the pairing-gap
diagnosis recommendations), then mid-flight: an NZB Finder account WARNING (31 duplicate
downloads of 4 releases via SABnzbd — account-termination threat).

## Pairing: diagnosis → fix → +11 pairs (382 → 392)

The live diagnosis (in-cluster SQL Jobs over the ledger) had shown the matcher blocks only
~14 works; the real constraint is funnel pacing. All three unblocks executed:

1. **Mint cap 25 → 100/run** (haynes-ops #2204; owner ruling revisiting R1a). Live: the
   heal run attempted 100 (44 minted, 85 pushed, 0 quota-skips).
2. **Matcher author tolerances** (hnet #474 → v0.89.2, deployed via haynes-ops #2207):
   `authorsAgree` gains ordered token alignment (equality-or-prefix, one real-word anchor
   ≥ 3 chars both sides) and the substring rule now needs a real word on the shorter side.
   Catches initials spacing (JRR/J.R.R.), initials-to-full (L.M./Lucy Maud), middle names
   (Dean [Ray] Koontz), leading co-author credits (Geo. R.R. Martin, …). Title equality
   stays the gate — Homer's "Odyssey" still refuses Walter Mosley's.
3. **Kavita metadata-writers author fallback** (same PR): Kavita mirror authors were
   folder-derived ONLY; 54 flat-layout ebooks sat null while their writers were in Kavita
   all along (found when the Kavita fill Job SKIPPED all 8 targets — "already has
   writers"). Enrichment now carries `writers[]`, `normalizeKavitaSeries` falls back to
   `writers[0]` when the folder derive is null, and the change-gate treats null-author
   book rows as never-enriched (one run heals, then re-gates). **Post-heal: null-author
   unpaired ebooks 54 → 0.**

Result: **+11 pairs, exactly the recoverable near-miss set** (Outlander, ACOTAR, Camino
Island, The Confession, Skyward, Romancing Mister Bridgerton, Anne of Green Gables, The
Silmarillion, Demon Seed, Hunter's Run, +1); every correct refusal held (Odyssey
Homer/Mosley; "Inheritance" is Jemisin's, not Paolini's — the null-author fill from the
audio side would have MISPAIRED it; the skip-if-writers-present guard earned its keep).
Pipeline after: 527 pairing wants (200 unmintable await GB quota; retried nightly at the
new cap). Residual matcher tail = edition-variant titles → DESIGN-036 Q-02 identifiers.

## NZB Finder duplicate-download incident (guardrails)

**Root cause:** LL post-processing failed with `Duplicate part 1 found` (bookrename.py)
for 4 books (Earthfall, And Sometimes I Wonder About You, Deadlocked, A Court of Mist and
Fury — exactly the indexer's "4 releases"); each failure flips the book back to Wanted,
the next search re-snatches the SAME release, SAB re-fetches the same NZB (~8×/release).

**Applied (in-cluster Jobs, downloads ns — keys never enter the dev pod):**
- **SAB duplicate detection was OFF on BOTH instances** (`no_dupes: 0` on sabnzbd AND
  sabnzbd-fast) → now **1 (Discard)**. Caveat recorded honestly: for URL-adds SAB may
  still fetch the NZB before deduping, so this dampens but does not fully shield the
  indexer — the LL-side fix is primary.
- The one still-active looper ("And Sometimes I Wonder About You", GB id `EJ_cCwAAQBAJ`)
  **unqueued** via LL `cmd=unqueueBook`; the other three had already self-resolved.

**Follow-ups (next session / Opus dispatch):**
- LL failed-download handling audit: a postprocess-failed release must be BLACKLISTED so
  the next search picks a DIFFERENT release (today it re-picks the same top result); also
  clear stale part files in the LL processing dir for the 4 titles.
- hnet want-cooldown guardrail: a want that oscillates Wanted↔Snatched N times should back
  off (failure-aware cooldown in the force-search sweeps + wants passes) — design-worthy.
- STILL STAGED from the morning: re-apply the 21 author recipes after the 07:00 UTC GB
  reset (the quota-skipped canon acquisitions).

## Gotchas recorded

- ESO-rendered secret key names differ from the ExternalSecret `secretKey` listing —
  probe with an env-names Job first (`ABS_TOKEN` not ABS_API_TOKEN; `SABNZBD__API_KEY`
  double-underscore in BOTH sab secrets — envFrom collides, use explicit secretKeyRef).
- LL API: BookIDs are Google Books volume ids (may contain `_`); `cmd=unqueueBook` is the
  status-to-Skipped lever; `cmd=getWanted`/`getSnatched` list the active sets.
- Release-PR branches run no CI on release-please's own push — an empty-commit push from
  the dev bot (`git commit-tree`) triggers checks without disturbing the changelog.
