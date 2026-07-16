# PLAN-052: Collection-manager integration — Kometa knobs + provider-agnostic UI

- **Status:** Intake, research-gated (owner-ratified roadmap 2026-07-16; Kometa deep-research
  dispatched same day → `.agents/context/2026-07-16-kometa-integration-research.md` when filed).
- **Owner rulings (2026-07-16, normative):**
  - **R1 — KISS, absolutely.** Kometa configs are complex and take YAML breaking changes; the
    app exposes "limited, basic" control only.
  - **R2 — INTEGRATION PARITY.** "The integration from haynesnetwork should look the same for
    both our new book app and Kometa." One collection-manager integration surface, two (then N)
    providers behind it.
- **Depends on:** 037 (the mirror shows what the managers produce); the research doc (knob
  feasibility + where our Kometa config lives). Relates: 043 (the books app implements the same
  provider contract from day one), 051.

## Shape (to firm up from research)

1. **Never touch hand-written YAML.** The app owns ONE generated *managed include file* that
   Kometa merges (`collection_files` entry); every knob compiles into that file. Breaking-change
   exposure shrinks to a surface we generate against a pinned Kometa version.
2. **Read-only first:** per provider — collections produced (we already mirror those), config
   summary, last-run state/schedule.
3. **Knob candidates (allowlist, research-gated):** enable/disable a managed default collection
   (Kometa `template_variables` are the intended low-touch lever), add/remove a title in a
   static managed collection, schedule tweak, run-now trigger if the deployment shape allows.
4. **Provider contract:** the books app (PLAN-043) implements the same surface — managed config
   fragment + defaults/template-variables + schedule + run-state — so the hnet UI is genuinely
   provider-agnostic (R2).
5. Write path depends on where our Kometa config lives (haynes-ops git vs PVC — research):
   git ⇒ app edits become PRs (audited, reversible); PVC ⇒ a confined write surface in the
   arr-write-guard idiom.

## Out of scope

Full Kometa config editing, raw YAML passthrough, anything the allowlist can't validate.
