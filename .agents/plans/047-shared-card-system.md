# PLAN-047: The shared card system — one base card, extended per media type, drift-proof by code

- **Status:** ACTIONABLE — owner-ruled 2026-07-14 morning (the In-Flight question round). His
  words: "different Opus subagents dispatched after Fable does the UX work in a way that forces
  a cohesive look and feel across the entire site. We should refactor so our base library card
  is shared everywhere, even Helpdesk tickets, and then is extended for different types of media
  and extended further for advanced use cases. **I want the code to guarantee the UX doesn't
  drift as we build.**"
- **Agent:** FABLE (the owner's explicit sequencing — Fable lays the system, Opus agents build
  on it). Dispatch AFTER v0.50.2 (PR #264) ships.
- **Context:** the PLAN-045 "Wanted strip" miss happened because card anatomy lived in
  per-surface markup an agent could re-invent. #261/#264 started the consolidation
  (`PosterCardBody` shared by Movies/Books/Goodreads). This plan finishes it as a SYSTEM.

## Shape

1. **Base card component family in `@hnet/ui`** (or apps/web shared — follow where MediaPoster
   lives): `BaseCard` = reserved poster/tile box (2:3 or type-specific ratio) + caption block
   (title · subtitle · ONE badge row) + optional corner puck slot — the ONLY way a wall card is
   built. Variants by composition, never by copy: `MediaCard` (movies/tv/music/peloton/youtube),
   `BookCard` (books/audiobooks/comics + wanted), `TicketCard` (Helpdesk — the poster-wall
   ticket tiles refit onto the base), `GroupCard` (author/genre aggregates), `RequestCard`
   (Goodreads items). Advanced extensions (activity/in-flight states, PLAN-048) extend these,
   never fork.
2. **Drift guarantees in CODE:** (a) the badge row, caption, and puck slots are typed props —
   no children escape hatch that lets a surface bolt on stacks/buttons; (b) an ESLint guard
   (the no-direct-state-writes idiom) forbidding raw `.media-card`/poster markup outside the
   card package; (c) a visual regression spec — one hermetic page rendering every card variant
   side-by-side (the "card gallery"), screenshot-compared in e2e so structural drift FAILS CI;
   (d) the gallery capture is the standing reference artifact for future agent briefs.
3. **Refit pass:** migrate every existing wall (Library kinds, Trash walls, Helpdesk twall,
   Goodreads, group cards) onto the family — behavior-neutral, screenshot-diffed per wall
   before/after (the reviewer's bar: pixel-equivalent or better).
4. **Docs:** ADR (the card system + code-enforced cohesion), DESIGN amendment(s), next-free
   numbers at authoring. Tests per (2c) + per-wall parity captures.

## Constraints

Tokens-only; ADR-015 (reserved slots, reflow-free); 320/390 portrait-safe; no behavior changes
(pure refactor + guards); merge gate; hermetic only. Side-by-side proof per the
`ux-reference-anatomy-gate` rule — coordinator visually diffs the gallery before deploy.
