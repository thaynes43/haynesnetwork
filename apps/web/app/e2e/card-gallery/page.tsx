// PLAN-047 / ADR-058 — the card-gallery HARNESS route. Development-only: the e2e stack runs
// `next dev`, so the drift-gate spec (e2e/card-gallery.spec.ts) can reach it; a production build
// bakes a 404 here (no auth surface, no data — it renders pure fixtures). Deliberately OUTSIDE the
// (app) group: no session gate, no top bar — the gallery is a clean-room reference sheet.
import { notFound } from 'next/navigation';
import { CardGallery } from './gallery';

export const metadata = { title: 'Card gallery (e2e harness)', robots: { index: false } };

export default function CardGalleryPage() {
  // Issue #812: the e2e stack's production build (`next build` with HNET_E2E_HARNESS=1) keeps this harness page;
  // every other production build, the release image included, still bakes the 404.
  if (process.env.NODE_ENV === 'production' && process.env.HNET_E2E_HARNESS !== '1') notFound();
  return <CardGallery />;
}
