import { FailsafeRestore } from './restore-client';

// The parent admin layout enforces Admin. ADR-121 / DESIGN-052 D-32.
export default function AdminRestorePage() {
  return <FailsafeRestore />;
}
