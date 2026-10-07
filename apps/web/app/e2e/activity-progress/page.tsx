// PLAN-048 / ADR-059 / DESIGN-030 D-10 — the live-progress PARITY harness route (the card-gallery idiom):
// development-only so the capture spec can reach it under `next dev`; a production build 404s here (no auth
// surface, no data — pure fixtures). Outside the (app) group: no session gate, a clean-room reference sheet.
import { notFound } from 'next/navigation';
import { ActivityProgressParity } from './parity';

export const metadata = { title: 'Activity live-progress parity (e2e harness)', robots: { index: false } };

export default function ActivityProgressParityPage() {
  // Issue #812: the e2e stack's production build (`next build` with HNET_E2E_HARNESS=1) keeps this harness page;
  // every other production build, the release image included, still bakes the 404.
  if (process.env.NODE_ENV === 'production' && process.env.HNET_E2E_HARNESS !== '1') notFound();
  return <ActivityProgressParity />;
}
