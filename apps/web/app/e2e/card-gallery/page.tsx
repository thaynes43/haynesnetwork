// PLAN-047 / ADR-058 — the card-gallery HARNESS route. Not for deployment: it renders under `next dev` and in the
// e2e stack's own production build (ADR-103, the guarded harness flag), so the drift-gate spec
// (e2e/card-gallery.spec.ts) can reach it; every other production build, the release image included, bakes a 404
// here (no auth surface, no data — it renders pure fixtures). Deliberately OUTSIDE the
// (app) group: no session gate, no top bar — the gallery is a clean-room reference sheet.
import { notFound } from 'next/navigation';
import { e2eHarnessActive } from '@hnet/domain/e2e-harness';
import { CardGallery } from './gallery';

export const metadata = { title: 'Card gallery (e2e harness)', robots: { index: false } };

export default function CardGalleryPage() {
  // ADR-103: the e2e stack's own production build (the guarded harness flag) keeps this page; every other
  // production build, the release image included, still bakes the 404.
  if (process.env.NODE_ENV === 'production' && !e2eHarnessActive()) notFound();
  return <CardGallery />;
}
