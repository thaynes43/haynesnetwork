# PLAN-073: A want's Request Event history on the Wanted detail (admins only)

- **Status:** PR open (issue [#792](https://github.com/thaynes43/haynesnetwork/issues/792)); the owner reviews the UI
  before merge. After merge it rides the next release; then the live check below, and this plan moves to `completed/`.
- **Owner ruling (2026-10-07):** admins only. Nobody else sees it, the requester included, and the API refuses them.
- **Design of record:** [DESIGN-028](../../docs/designs/028-integrations-tab-goodreads-requests.md) amendment
  2026-10-07 (Request Event history). Pointers: DESIGN-029 amendment 6 (the Wanted detail), DESIGN-025 D-08 (the book
  detail's History). Glossary: T-292 Request Event amended. Builds on ADR-101 (the record, issue #741); no new ADR (a read
  and a screen over an accepted decision).
- **Sizing input:** 749 events on 495 requests in the record's first day, at most 6 per request (replica read,
  2026-10-07). Hence 20 a page with an "Older changes" button.

## Tasks

| # | Task | Done when |
|---|------|-----------|
| T1 | Docs: the DESIGN-028 amendment (where it shows, the read, the words, the layout, the tests), the DESIGN-029 and DESIGN-025 pointers, glossary T-292, this plan. | In the PR. |
| T2 | Domain read `listRequestEvents` (`packages/domain/src/book-request-events.ts`): one want newest first on `book_request_events_request_created_idx`, keyset with a microsecond cursor, the person's name, `refs` (item and collection titles). No writes. | `book-request-history.test.ts` green. |
| T3 | API `books.requestEvents` (`adminProcedure`), opaque cursor, wire rows. | `books-request-events.test.ts` green: anonymous `UNAUTHORIZED`, requester and household reader `FORBIDDEN`, admin rows, paging, bad cursor, unknown want. |
| T4 | The words (`apps/web/lib/request-events.ts`): reason, field, value, detail, who and where; every recorded field and reason covered. | `request-events.test.ts` green. |
| T5 | The list (`apps/web/components/request-event-history.tsx`, the `.timeline` idiom) on the Wanted detail (History card, and the gone-want state) and the book detail (per linked request "Show changes" and "Open the want"); the page wrappers pass the session's `isAdmin`. Tokens-only CSS. | Typecheck, lint, hex guard green; the e2e admin journey (`integrations.spec.ts`) sees the mint in words at 390 and 1280 px with no sideways scroll. |
| T6 | Verify with `pnpm dev:local` (desktop and phone, light and dark) and screenshot for the owner's review. | Done 2026-10-07 on a local stack seeded through the domain writers: the Wanted detail's History, a gone want's page, the book detail's "Show changes"; no sideways scroll at 390 px. |

## Live check (after the release deploys)

As an admin, open a want on `haynesnetwork.haynesops.com` whose events SQL shows more than one row (for example a
pairing want with an `ll_rerequest`), and confirm the History lists the same rows newest first in words. As a non-admin
with books access, confirm the Wanted detail shows no History card.
