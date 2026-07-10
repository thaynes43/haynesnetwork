// ADR-037 / DESIGN-016 D-05 — the /metrics route GATE (server-side, like /bulletin). The (app)
// layout already bounced anonymous visitors to /login; here the caller's Metrics section LEVEL
// (session-carried, ADR-021) decides what renders: Disabled gets a clean "not available" state
// (the metrics.* tRPC surface rejects them server-side too — ships Admin-only), Read-Only/Edit get
// the client. The caller's metrics ACCESS LEVEL (full|limited) is resolved HERE and passed down so
// the client can label the view; the payload itself is shaped server-side by the same level (C-03).
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { getServerSession } from '@hnet/auth';
import { effectiveMetricsLevel, effectiveSectionLevel } from '@hnet/api';
import { MetricsClient } from './metrics-client';

export default async function MetricsPage() {
  const session = await getServerSession(await headers());
  if (!session) redirect('/login'); // defense in depth — the layout already gates
  const role = session.user.role;
  const level = effectiveSectionLevel(role, 'metrics');

  if (level === 'disabled') {
    return (
      <section className="card empty-state" data-testid="metrics-unavailable">
        <h1 className="page-title">Metrics</h1>
        <p>Metrics isn’t available on your account.</p>
        <p className="muted">
          Your role doesn’t include this section. If you think it should, ask an admin to update
          your role’s section access.
        </p>
        <p>
          <Link className="btn" href="/">
            Back to the dashboard
          </Link>
        </p>
      </section>
    );
  }

  // DESIGN-016 D-08 — the admin flag is resolved server-side (like every other admin-only affordance,
  // ADR-012) and threaded to the client so the Overview can render the inline WAN-capacity editor for an
  // admin only. The mutation it calls is itself adminProcedure-gated + audited — this is UI convenience,
  // not the security boundary.
  return <MetricsClient metricsLevel={effectiveMetricsLevel(role)} viewerIsAdmin={role.isAdmin} />;
}
