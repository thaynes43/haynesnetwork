// PLAN-048 / ADR-059 / DESIGN-030 D-10 — the live-progress PARITY harness route (the card-gallery idiom):
// not for deployment: it renders under `next dev` and in the e2e stack's own production build (ADR-103, the guarded
// harness flag) so the spec can reach it; every other production build 404s here (no auth surface, no data — pure
// fixtures). Outside the (app) group: no session gate, a clean-room reference sheet.
import { notFound } from 'next/navigation';
import { e2eHarnessActive } from '@hnet/domain/e2e-harness';
import { ActivityProgressParity } from './parity';

export const metadata = { title: 'Activity live-progress parity (e2e harness)', robots: { index: false } };

export default function ActivityProgressParityPage() {
  // ADR-103: the e2e stack's own production build (the guarded harness flag) keeps this page; every other
  // production build, the release image included, still bakes the 404.
  if (process.env.NODE_ENV === 'production' && !e2eHarnessActive()) notFound();
  return <ActivityProgressParity />;
}
