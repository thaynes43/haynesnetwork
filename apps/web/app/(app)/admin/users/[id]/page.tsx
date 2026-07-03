// DESIGN-004 D-11 — /admin/users/[id] (Admin-gated by admin/layout.tsx). Server
// wrapper resolves the route param; the client component composes users.list +
// catalog.adminList + tags.list and recomputes provenance (DESIGN-003 D-09 — no
// getById endpoint at household scale).
import { UserDetail } from './user-detail';

export default async function AdminUserPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <UserDetail userId={id} />;
}
