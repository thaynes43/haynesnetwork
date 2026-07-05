// DESIGN-004 D-11 / ADR-012 — /admin/users/[id] (Admin-gated by admin/layout.tsx). Server
// wrapper resolves the route param; the client component composes users.list + roles.list
// + catalog.adminList to assign the user's single role (no getById endpoint — D-09).
import { UserDetail } from './user-detail';

export default async function AdminUserPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <UserDetail userId={id} />;
}
