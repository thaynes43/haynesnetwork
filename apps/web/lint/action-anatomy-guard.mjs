// ADR-071 / DESIGN-004 D-24 — the ACTION-ANATOMY lint guard (the card-anatomy-guard idiom, applied
// to the media-action vocabulary). It makes the unified media-action doctrine STRUCTURAL, not
// conventional: a surface may only present a per-item media action (Fix / Force Search / Retry
// import / consume) through the sealed @hnet/ui family (`<MediaAction>` off `MEDIA_ACTIONS`,
// `<ConsumeLink>`), never a hand-rolled `<button className="btn">Fix</button>`. This module is the
// single source of the guard's patterns; it is consumed by
//   • apps/web/eslint.config.mjs — merged into the no-restricted-syntax override on every
//     app/components/lib file (runs in CI's lint-and-typecheck job via `pnpm lint`), and
//   • lib/__tests__/action-system-guard.test.ts — the executable proof: violating fixtures FAIL,
//     the sanctioned `<MediaAction>` / `<ConsumeLink>` forms pass, a repo walk shows zero live
//     violations, and a REGISTRY-PARITY assertion locks the label/key lists below to MEDIA_ACTIONS
//     (runs in CI's test job). Because the parity test fails the moment these lists diverge from the
//     registry, the labels/keys here are a locked MIRROR of @hnet/ui, not a hand-maintained parallel.
//
// WHY (the media-action UX audit, .agents/context/2026-07-17-media-action-ux-audit.md): five detail
// surfaces each hand-rolled Fix/Force-Search with divergent labels + looks ("Fix" vs "Fix this" vs
// "Fix season"; green vs outline). ADR-071 collapsed them onto ONE registry + shared components; the
// migration legs (#378/#381/#382/#383/#400/#385/#394) put every surface on-pattern. This guard is
// the LOCK (PR-6) so a regression — a raw action button, a retired label, an unknown registry key —
// fails CI instead of shipping.
//
// ── WHAT THIS GUARD DOES *NOT* DO (deliberate, so it stays clean on main) ─────────────────────────
//  • It does NOT ban the `.detail-head__play` / `.detail-head__actions` / `.action-slot` class
//    tokens. Those are shared `.detail-head` CSS SCAFFOLD, reused by NON-media detail surfaces —
//    the bulletin ticket detail (a support ticket is not media) and the ADR-065 books pairing-
//    backfill affordance ("the other format isn't in the library yet"), which is a collection/
//    backfill CONFIG control, not a per-item media action (the same class of non-goal as the
//    collections find-missing puck below). Banning the layout scaffold would false-fail on main.
//    Instead, cohesion is enforced where drift is USER-VISIBLE: the action LABEL vocabulary (R1/R2),
//    the registry KEY (R3), and the ConsumeLink ↗ anatomy (R4 — `.btn__ext` IS exclusive to the
//    sealed <ConsumeLink>, so it can be banned outright).
//  • It does NOT need a `no-restricted-imports` barrel rule: @hnet/ui's package `exports` map exposes
//    only the barrel (".") — deep imports of packages/ui/src/actions/* do not resolve, so the
//    package internals are already sealed by the module boundary (stronger than a lint rule).
//  • EXPLICIT NON-GOAL (coordinator UX ruling): the collections find-missing PUCK-TOGGLE is a
//    collection-scoped acquisition CONFIG control (the acq-puck idiom), NOT a media action. It is
//    not in MEDIA_ACTIONS and this guard must never flag it (it carries none of Fix/Force Search/
//    Retry import labels, no `action=` registry prop, and no `.btn__ext`).

// ── The registry MIRROR (locked to @hnet/ui MEDIA_ACTIONS by the parity test) ────────────────────
// The canonical labels the guard forbids in a hand-rolled button. Sourced from the registry verbs
// that render as ACTIVE fire buttons — `consume` (per-app label, owned by <ConsumeLink>) and
// `notOnDisk` (the inert `.btn--missing` pill, also rendered by the shared NotOnDiskButton) are
// intentionally excluded from LABEL matching; consume is covered structurally by R4.
export const CANONICAL_ACTION_LABELS = ['Fix', 'Force Search', 'Retry import'];

// The off-pattern label variants ADR-071 retired — a hand-rolled button using any of these is a
// regression to the pre-unification vocabulary. (Audit §2a/§2c inventory.)
export const RETIRED_ACTION_LABELS = [
  'Fix this',
  'Fix season',
  'Force re-search',
  'Force Search show',
  'Force Search artist',
  'Retry Import', // the mis-cased twin of the canonical "Retry import"
  // Owner ruling 2026-07-18 — the /collections Books/Audiobooks rows carried a hand-labeled "Run now"
  // (+ its "Run it?" armed twin) ConfirmButton that matched none of the estate's media-action nomenclature.
  // It is retired for the registry-standard Force Search (<MediaAction action="forceSearch">); banning both
  // strings keeps the off-vocabulary label from creeping back onto a row.
  'Run now',
  'Run it?',
];

// Every MEDIA_ACTIONS registry key — the valid `<MediaAction action="…">` values. Locked to
// MEDIA_ACTION_TYPES by the parity test; R3 flags any string literal outside this set.
export const MEDIA_ACTION_KEYS = ['fix', 'forceSearch', 'consume', 'retryImport', 'notOnDisk'];

// ── Selector construction ────────────────────────────────────────────────────────────────────────
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const alternation = (list) => list.map(escapeRe).join('|');

// A `btn`-family class token (`btn`, `btn primary`, `btn sm`, `btn btn--missing`, `btn__ext` is a
// separate token). Matches a whole-word `btn` in a className string or template.
const BTN_CLASS_RE = '(^|\\s)btn(\\s|$)';

// An interactive element (<button> / <a>) that carries a `btn`-family className. We anchor on
// `openingElement.name.name` (the tag) + a descendant className literal/template holding a `btn`
// token — the combination that identifies a hand-rolled action pill.
const BTN_ELEMENT =
  `JSXElement[openingElement.name.name=/^(button|a)$/]` +
  `:has(JSXAttribute[name.name='className'] ` +
  `:matches(Literal[value=/${BTN_CLASS_RE}/], TemplateElement[value.raw=/${BTN_CLASS_RE}/]))`;

// Anchored full-text match for a label set: the button's own direct text (`> JSXText`) or its
// `aria-label`, trimmed, equals one of the labels. Anchoring (`^…$`) keeps "Fix" from matching the
// heading "Fixes on this item" and keeps the words in prose (`<strong>Fix</strong>`) — which are not
// btn-classed buttons — out of scope, per the audit's "anchor on interactive elements, not copy".
const labelPattern = (list) => `^\\s*(${alternation(list)})\\s*$`;

/** The two ways a label reaches the user on a button: visible text and the accessible name. */
const labelSelectors = (list, message) => [
  { selector: `${BTN_ELEMENT}:has(> JSXText[value=/${labelPattern(list)}/])`, message },
  {
    selector: `${BTN_ELEMENT}:has(JSXAttribute[name.name='aria-label'] > Literal[value=/${labelPattern(list)}/])`,
    message,
  },
];

const R1_MESSAGE =
  'Hand-rolled media-action button (ADR-071). A raw <button>/<a class="btn"> labelled like a ' +
  'registry action must not exist — render every media action through the @hnet/ui <MediaAction ' +
  'action="…"> component (label + look come from MEDIA_ACTIONS), so a movie Fix, a book Fix and a ' +
  'wanted Force Search are the same control by construction.';

const R2_MESSAGE =
  'Retired media-action label variant (ADR-071 normalized "Fix this"/"Fix season"/"Force ' +
  're-search"/"Force Search show|artist"/"Retry Import" to ONE canonical label). Render through the ' +
  '@hnet/ui <MediaAction> component so the label comes from MEDIA_ACTIONS ("Fix", "Force Search", ' +
  '"Retry import"); use the `scopeLabel` prop for a grain qualifier, never a forked string.';

// R3 — an unknown key on <MediaAction action="literal">. The negative-lookahead is built from the
// registry-key MIRROR, so adding a real MEDIA_ACTIONS entry is all it takes (TS also type-checks the
// prop; this catches a loosened type / a stray literal and gives the actionable message).
const R3_MESSAGE =
  'Unknown media-action key on <MediaAction action="…"> (ADR-071). The value must be a MEDIA_ACTIONS ' +
  'registry key (fix | forceSearch | consume | retryImport | notOnDisk); add a registry entry rather ' +
  'than passing an off-registry literal.';
const unknownKeyPattern = `^(?!(${alternation(MEDIA_ACTION_KEYS)})$).+$`;

// R4 — the ConsumeLink ↗ anatomy. `.btn__ext` (the external-jump chevron) is owned solely by
// <ConsumeLink>; a hand-rolled `.btn__ext` means a bespoke consume link that can drift on ↗ /
// target / rel. (Within apps/web there is no legitimate `.btn__ext` — it lives only in packages/ui.)
const R4_MESSAGE =
  'Hand-rolled external-consume anatomy — the .btn__ext ↗ chevron is owned by the @hnet/ui ' +
  '<ConsumeLink> component (ADR-071). Render consume links (Watch on Plex / Read in Kavita / Listen ' +
  'on Audiobookshelf) through <ConsumeLink> so the ↗ + target=_blank + rel=noopener are identical.';

/**
 * The `no-restricted-syntax` entries for the media-action anatomy guard. Spread into the shared
 * override in apps/web/eslint.config.mjs (alongside the card-anatomy entries) and asserted by
 * lib/__tests__/action-system-guard.test.ts.
 */
export const actionAnatomyRestrictedSyntax = [
  ...labelSelectors(CANONICAL_ACTION_LABELS, R1_MESSAGE),
  ...labelSelectors(RETIRED_ACTION_LABELS, R2_MESSAGE),
  {
    selector: `JSXOpeningElement[name.name='MediaAction'] > JSXAttribute[name.name='action'] > Literal[value=/${unknownKeyPattern}/]`,
    message: R3_MESSAGE,
  },
  { selector: `Literal[value=/\\bbtn__ext\\b/]`, message: R4_MESSAGE },
  { selector: `TemplateElement[value.raw=/\\bbtn__ext\\b/]`, message: R4_MESSAGE },
];

/** Messages exported so the guard's executable proof can assert each fixture is caught by name. */
export const ACTION_ANATOMY_MESSAGES = {
  R1: R1_MESSAGE,
  R2: R2_MESSAGE,
  R3: R3_MESSAGE,
  R4: R4_MESSAGE,
};
