// DESIGN-025 D-07 (owner UX polish 2026-07-11) — the detail-page MISSING-state affordance.
// An ON-DISK item's detail head shows green `.btn.primary` "Watch on Plex — <library> ↗" pill(s) in
// `.detail-head__play`; a NOT-on-disk item shows this DISABLED, muted "Not on Disk" pill in the SAME
// slot so the missing state reads as clearly as the available one. It mirrors the play pill's shape /
// size (the shared `.btn` pill) but is INERT — `disabled` (not clickable), neutral surface + muted
// text, NO accent (green) and NO alarm-red — over the existing disabled/secondary tokens (no new hex;
// ADR-015 reflow-free — the on-disk vs missing state is fixed per item load, never a live toggle).
//
// ONE shared component so the control is identical everywhere it appears: *arr Movies/TV/Music (which
// pass a `hint` caption tying the state to the page's Force Search action) and any other media type
// that can present a missing item (books/ytdl-sub — no Force Search, so they pass no `hint`).
export function NotOnDiskButton({ hint }: { hint?: string }) {
  return (
    <div className="detail-head__missing">
      <button type="button" className="btn btn--missing" disabled data-testid="not-on-disk-button">
        Not on Disk
      </button>
      {hint !== undefined ? <p className="detail-head__missing-hint muted">{hint}</p> : null}
    </div>
  );
}
