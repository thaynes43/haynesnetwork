// ADR-038 / DESIGN-017 D-05 (PLAN-022) — the /library route GATE (server-side). The (app) layout already
// bounced anonymous visitors to /login; here we resolve the caller's `ytdlsub` section level server-side
// and pass whether the ytdl-sub sub-tabs (Peloton, YouTube) are visible down to the client shell. The
// section ships `disabled` for non-admins (Admin-only), so members see the standard Library tabs only
// until the owner opens the section per role. The ytdlsub.* tRPC surface + the poster proxy reject a
// hidden caller server-side too — this is courtesy hiding on top of a server-authoritative gate.
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { getServerSession } from '@hnet/auth';
import { effectiveSectionLevel } from '@hnet/api';
import { LibraryClient } from './library-client';

export default async function LibraryPage() {
  const session = await getServerSession(await headers());
  if (!session) redirect('/login'); // defense in depth — the layout already gates
  const ytdlsubVisible = effectiveSectionLevel(session.user.role, 'ytdlsub') !== 'disabled';
  return <LibraryClient ytdlsubVisible={ytdlsubVisible} />;
}
