// ADR-109 / DESIGN-055 D-01, D-07 (PLAN-077 P2) — the prefilled Helpdesk ticket. A guide step that ends with staff links
// to `/bulletin?tab=helpdesk&compose=1&about=<media item id>&episode=<episode id>&subject=<text>&note=<text>&category=…`,
// and the Helpdesk opens its "New ticket" composer with the title (and episode) chosen and the text filled in. Nothing
// is filed until the person presses "File ticket". The parameters are validated and capped here, the one place both
// ends share; the media id is re-checked by the server (the ticket create and the library access gate).
//
// The parameter names avoid the Feed tab's own `media` and `src` refinements, so a link never filters the Feed.
import { TICKET_CATEGORY_NAMES, type TicketCategoryName } from './bulletin';

/** The composer's own limits (the "What's wrong?" input and the Details textarea are capped lower than the server). */
export const COMPOSE_SUBJECT_MAX = 200;
export const COMPOSE_NOTE_MAX = 2000;

/** Every parameter a compose link carries; the Helpdesk drops them from the URL once it has opened the composer. */
export const COMPOSE_LINK_PARAMS = ['compose', 'about', 'episode', 'subject', 'note', 'category'] as const;

export interface ComposePrefill {
  mediaItemId: string | null;
  /** A Sonarr episode id within that title (the composer's leaf target). */
  episodeId: number | null;
  subject: string;
  note: string;
  category: TicketCategoryName;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Control characters other than tab and newline never belong in a ticket.
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/g;

function clean(text: string | null | undefined, max: number, multiline: boolean): string {
  if (!text) return '';
  let t = text.replace(/\r\n?/g, '\n').replace(CONTROL, '');
  if (!multiline) t = t.replace(/\s+/g, ' ');
  return t.trim().slice(0, max).trim();
}

function episodeOf(raw: string | null | undefined): number | null {
  if (!raw || !/^\d{1,9}$/.test(raw)) return null;
  const n = Number(raw);
  return n > 0 ? n : null;
}

/** The Helpdesk link that opens the composer prefilled. */
export function ticketComposeHref(input: {
  mediaItemId?: string | null;
  episodeId?: number | null;
  subject: string;
  note: string;
  category?: TicketCategoryName;
}): string {
  const params = new URLSearchParams({ tab: 'helpdesk', compose: '1' });
  if (input.mediaItemId && UUID.test(input.mediaItemId)) {
    params.set('about', input.mediaItemId.toLowerCase());
    const episode = episodeOf(input.episodeId != null ? String(input.episodeId) : null);
    if (episode !== null) params.set('episode', String(episode));
  }
  const subject = clean(input.subject, COMPOSE_SUBJECT_MAX, false);
  if (subject) params.set('subject', subject);
  const note = clean(input.note, COMPOSE_NOTE_MAX, true);
  if (note) params.set('note', note);
  if (input.category) params.set('category', input.category);
  return `/bulletin?${params.toString()}`;
}

/** Read a compose link back (null when the URL is not one). Anything malformed is dropped, never trusted. */
export function parseComposeLink(params: { get(name: string): string | null }): ComposePrefill | null {
  if (params.get('compose') !== '1') return null;
  const about = params.get('about');
  const mediaItemId = about && UUID.test(about) ? about.toLowerCase() : null;
  const category = params.get('category');
  return {
    mediaItemId,
    episodeId: mediaItemId !== null ? episodeOf(params.get('episode')) : null,
    subject: clean(params.get('subject'), COMPOSE_SUBJECT_MAX, false),
    note: clean(params.get('note'), COMPOSE_NOTE_MAX, true),
    category: (TICKET_CATEGORY_NAMES as readonly string[]).includes(category ?? '')
      ? (category as TicketCategoryName)
      : 'other',
  };
}
