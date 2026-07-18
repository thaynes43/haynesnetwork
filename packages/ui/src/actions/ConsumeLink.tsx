// ADR-071 / DESIGN-004 D-24 — the ONE primary external "consume" pill: Watch on Plex —
// <library> / Read in Kavita / Listen on Audiobookshelf. Before this, every detail page
// re-hand-rolled `<a class="btn primary">…<span class="btn__ext">↗</span></a>`, so the ↗, the
// target, and the rel could drift; here they are guaranteed identical everywhere. The label is the
// ONLY per-app string (correct — it names the serving app), so it is passed in; the look (primary
// vs a paired-second outline) and the external-jump wiring come from the registry/component.
//
// Structure only — classes (`.btn`, `.btn.primary`, `.btn__ext`) are themed by app.css; no color
// here (CLAUDE.md rule 2).
import { MEDIA_ACTIONS, type MediaActionVariant } from './action-registry';

export interface ConsumeLinkProps {
  /** Per-app label — the one place a consume label varies. e.g. "Watch on Plex — Movies",
   *  "Read in Kavita", "Listen on Audiobookshelf". */
  label: string;
  /** The external deep link (app.plex.tv / Kavita / ABS). Opens in a new tab. */
  url: string;
  /** `primary` (default) for the item's own consume; `outline` for a paired/secondary consume
   *  (e.g. the counterpart format's button beside the primary one). */
  variant?: MediaActionVariant;
  testId?: string;
}

export function ConsumeLink({ label, url, variant = 'primary', testId }: ConsumeLinkProps) {
  return (
    <a
      className={['btn', variant === 'primary' ? 'primary' : null].filter(Boolean).join(' ')}
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      data-testid={testId}
      data-action-type={MEDIA_ACTIONS.consume.type}
    >
      {label}
      <span className="btn__ext" aria-hidden="true"> ↗</span>
    </a>
  );
}
