// DESIGN-017 D-09 (R-132) — the ytdl-sub drill-in GATE (server-side; the D-05 pattern). Anonymous is
// bounced by the (app) layout, but defense-in-depth redirects to /login; a caller whose `ytdlsub`
// section is disabled, a bogus library segment, or a non-numeric ratingKey all bounce to /library —
// the tRPC layer (`ytdlsubProcedure` + the section-confinement check) rejects them server-side too,
// so this is courtesy hiding on top of a server-authoritative gate (ADR-038 C-05).
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { getServerSession } from '@hnet/auth';
import { effectiveSectionLevel } from '@hnet/api';
import { YtdlsubItemDetail } from './ytdlsub-item-detail';

export default async function YtdlsubItemPage({
  params,
}: {
  params: Promise<{ library: string; ratingKey: string }>;
}) {
  const { library, ratingKey } = await params;
  const session = await getServerSession(await headers());
  if (!session) redirect('/login');
  if (effectiveSectionLevel(session.user.role, 'ytdlsub') === 'disabled') redirect('/library');
  if (library !== 'peloton' && library !== 'youtube') redirect('/library');
  if (!/^\d{1,12}$/.test(ratingKey)) redirect('/library');
  return <YtdlsubItemDetail library={library} ratingKey={ratingKey} />;
}
