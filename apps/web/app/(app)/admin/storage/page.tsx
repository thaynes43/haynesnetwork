// IA reshuffle (2026-07-09, build B) — /admin/storage is RETIRED as a destination. Everything
// storage/target/policy moved into the tabbed Trash Settings hub (DESIGN-004 D-16 amendment); the
// storage.* routers/procedures are unchanged, only the UI moved. Any hit on /admin/storage now
// redirects to the Storage tab, keeping old deep links + bookmarks alive (mirrors /admin/restore →
// /trash and /my-fixes → /library?tab=my-fixes). The /admin nav link is removed (admin/layout.tsx).
import { redirect } from 'next/navigation';

export default function AdminStoragePage(): never {
  redirect('/settings/trash?tab=storage');
}
