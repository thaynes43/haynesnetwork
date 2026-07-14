'use client';

// DESIGN-026 D-09 (PLAN-029 step 6) — the A–Z letter jump bar: a fixed-position vertical rail on
// the right viewport edge (the D-11 placement call — an edge rail, Plex/contacts-style) shown only
// when the active sort is an A–Z sort on a big wall (lib/library-views.ts showJumpBar). Tapping a
// letter PAGES the wall to the first item at that letter (a `letter` refinement — router.replace
// per D-10; '#' returns to the top). ADR-015: the rail is a fixed OVERLAY — appearing/disappearing
// never reflows the grid — and the armed letter deepens color only. Tokens-only styling (app.css
// `.letter-rail`).
const LETTERS = 'abcdefghijklmnopqrstuvwxyz'.split('');

export function LetterJumpBar({
  active,
  onJump,
}: {
  /** The armed letter (the `?at=` param), or null when browsing from the top. */
  active: string | null;
  /** null = clear the jump (the '#' / top affordance). */
  onJump: (letter: string | null) => void;
}) {
  return (
    <nav className="letter-rail" aria-label="Jump to letter" data-testid="letter-jump-bar">
      <button
        type="button"
        className={`letter-rail__btn${active === null ? ' is-active' : ''}`}
        aria-label="Jump to the top"
        aria-pressed={active === null}
        onClick={() => onJump(null)}
      >
        #
      </button>
      {LETTERS.map((letter) => (
        <button
          key={letter}
          type="button"
          className={`letter-rail__btn${active === letter ? ' is-active' : ''}`}
          aria-label={`Jump to ${letter.toUpperCase()}`}
          aria-pressed={active === letter}
          onClick={() => onJump(letter)}
        >
          {letter.toUpperCase()}
        </button>
      ))}
    </nav>
  );
}
