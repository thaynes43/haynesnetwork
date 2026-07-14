// PLAN-047 / ADR-058 — the card-gallery HARNESS route. Development-only: the e2e stack runs
// `next dev`, so the drift-gate spec (e2e/card-gallery.spec.ts) can reach it; a production build
// bakes a 404 here (no auth surface, no data — it renders pure fixtures). Deliberately OUTSIDE the
// (app) group: no session gate, no top bar — the gallery is a clean-room reference sheet.
import { notFound } from 'next/navigation';
import { CardGallery } from './gallery';

export const metadata = { title: 'Card gallery (e2e harness)', robots: { index: false } };

export default function CardGalleryPage() {
  if (process.env.NODE_ENV === 'production') notFound();
  return <CardGallery />;
}
