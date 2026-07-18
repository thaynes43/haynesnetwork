// ADR-062 / ADR-071 — the client mirror of @hnet/db BOOK_ACTIONS (the fine-grained books
// media-action grants), kept React-free and local so the /admin roles grid can render the toggle
// without importing server code. The owner opens these per role (THE FLIP): a role with the grant
// gets the matching action on the books detail page. Labels use owner tone (plain, friendly).
export const BOOK_ACTION_NAMES = ['fix_book', 'force_search_book'] as const;
export type BookActionName = (typeof BOOK_ACTION_NAMES)[number];

export const BOOK_ACTION_LABELS: Record<BookActionName, string> = {
  fix_book: 'Fix (report a bad copy and re-acquire)',
  force_search_book: 'Force Search (one-click re-search for a better copy)',
};
