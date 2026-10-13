// ADR-111 C-04 / DESIGN-055 D-11 (PLAN-077 P3) — what `/r/seerr/<id>` shows or where it sends the person. The page
// injects the lookups (the mirror, a fresh read-only Seerr read, and the ADR-047 access check), so the rules are
// unit-tested without a server:
//   • signed out: the onboarding card, whose "Sign in with Plex" comes back to this same link (Better Auth carries
//     the relative path through Authentik; the first sign-in creates the account in the Default role, R-03);
//   • signed in: the title page with the guide preselected (`/library/<id>?seerr=<issueId>`), or a card saying why
//     not (no such report, not in the library yet, removed in Seerr, a library the account cannot see).
// A missing row, a row with no title yet, or one with no app reporter yet is read fresh from Seerr first (read-only),
// so a report filed a minute ago, or a reporter who just created their account, still lands right.
import { seerrLinkPath } from './seerr-issues';

export type SeerrLinkTargetLike =
  | { kind: 'title'; mediaItemId: string; status: 'open' | 'resolved'; reporterUserId: string | null }
  | { kind: 'no_title'; status: 'open' | 'resolved'; mediaType: 'movie' | 'tv' | null }
  | { kind: 'removed' }
  | { kind: 'unknown' };

export type SeerrLinkView =
  | { kind: 'sign_in'; next: string; seerrIssueId: number | null }
  | { kind: 'redirect'; to: string }
  | { kind: 'not_found' }
  | { kind: 'no_title' }
  | { kind: 'removed' }
  | { kind: 'no_access' };

/** The issue id in the path: digits only, a positive int. */
export function seerrLinkIssueId(raw: string): number | null {
  if (!/^\d{1,9}$/.test(raw)) return null;
  const n = Number(raw);
  return n > 0 ? n : null;
}

export async function resolveSeerrLink(input: {
  rawId: string;
  userId: string | null;
  lookup: (seerrIssueId: number) => Promise<SeerrLinkTargetLike>;
  refresh: (seerrIssueId: number) => Promise<unknown>;
  canSee: (userId: string, mediaItemId: string) => Promise<boolean>;
}): Promise<SeerrLinkView> {
  const seerrIssueId = seerrLinkIssueId(input.rawId);
  if (input.userId === null) {
    // Nothing about the report is shown signed out: the card is the same for every id.
    return { kind: 'sign_in', next: seerrIssueId !== null ? seerrLinkPath(seerrIssueId) : '/', seerrIssueId };
  }
  if (seerrIssueId === null) return { kind: 'not_found' };

  let target = await input.lookup(seerrIssueId);
  const stale =
    target.kind === 'unknown' ||
    target.kind === 'no_title' ||
    (target.kind === 'title' && target.reporterUserId === null);
  if (stale) {
    try {
      await input.refresh(seerrIssueId);
    } catch {
      // Seerr unreachable: answer from the mirror as it is.
    }
    target = await input.lookup(seerrIssueId);
  }

  switch (target.kind) {
    case 'title':
      if (!(await input.canSee(input.userId, target.mediaItemId))) return { kind: 'no_access' };
      return { kind: 'redirect', to: `/library/${target.mediaItemId}?seerr=${seerrIssueId}` };
    case 'no_title':
      return { kind: 'no_title' };
    case 'removed':
      return { kind: 'removed' };
    default:
      return { kind: 'not_found' };
  }
}
