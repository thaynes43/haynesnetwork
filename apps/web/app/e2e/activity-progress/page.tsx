// PLAN-048 / ADR-059 / DESIGN-030 D-10 — the live-progress PARITY harness route (the card-gallery idiom):
// development-only so the capture spec can reach it under `next dev`; a production build 404s here (no auth
// surface, no data — pure fixtures). Outside the (app) group: no session gate, a clean-room reference sheet.
import { notFound } from 'next/navigation';
import { ActivityProgressParity } from './parity';

export const metadata = { title: 'Activity live-progress parity (e2e harness)', robots: { index: false } };

export default function ActivityProgressParityPage() {
  if (process.env.NODE_ENV === 'production') notFound();
  return <ActivityProgressParity />;
}
