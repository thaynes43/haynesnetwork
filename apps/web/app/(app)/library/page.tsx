// ADR-038 / DESIGN-017 D-05 (PLAN-022) + ADR-047 / DESIGN-025 (PLAN-028) — the /library route GATE
// (server-side). The (app) layout already bounced anonymous visitors to /login; here we resolve, server-
// side, which sub-tabs the caller may see and pass them down to the client shell:
//   • ytdlsub / books SECTION visibility (unchanged — the coarse section knob), and
//   • ADR-047 THE INVARIANT — the per-Plex-library access gate: which Movies/TV/Music kinds AND which
//     ytdl-sub libraries (Peloton/YouTube) the caller's ROLE can access (a withheld library's tab hides
//     entirely — the tRPC surface + the poster proxy reject a hidden caller server-side too). Admin ⇒ all.
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { getServerSession } from '@hnet/auth';
import {
  accessibleYtdlsubLibraries,
  effectiveSectionLevel,
  libraryEmptyReason,
  resolveLibraryAccessGate,
} from '@hnet/api';
import { LibraryClient } from './library-client';

export default async function LibraryPage() {
  const session = await getServerSession(await headers());
  if (!session) redirect('/login'); // defense in depth — the layout already gates
  const ytdlsubVisible = effectiveSectionLevel(session.user.role, 'ytdlsub') !== 'disabled';
  // ADR-046 C-04 (PLAN-023) — the Books/Audiobooks/Comics sub-tabs' visibility (the `books` section ships
  // `disabled` = Admin-only until the owner opens it per role after his screenshot review).
  const booksVisible = effectiveSectionLevel(session.user.role, 'books') !== 'disabled';
  // ADR-047 THE INVARIANT + ADR-081 C-05 — resolve the access gate ONCE: it drives both the Movies/TV/Music
  // tab visibility AND the honest cold-start signal (an empty Library because the match table is empty vs
  // because the role holds no grants).
  const gate = await resolveLibraryAccessGate(session.user.id);
  const mediaVisible = {
    movies: gate.unrestricted || gate.visibleArrKinds.has('radarr'),
    tv: gate.unrestricted || gate.visibleArrKinds.has('sonarr'),
    music: gate.unrestricted || gate.visibleArrKinds.has('lidarr'),
  };
  // ADR-081 C-05 — the cold-start banner, decided server-side (never inferred client-side): a MEMBER whose
  // Library resolved empty because the match table is empty (cold_start, not no_access) gets the "still
  // syncing" state; an ADMIN (always all tabs) gets a banner while the first sync populates. no_access keeps
  // the existing behavior (the withheld tabs are simply absent).
  const coldStart: 'member' | 'admin' | null = gate.unrestricted
    ? gate.matchTableEmpty
      ? 'admin'
      : null
    : libraryEmptyReason(gate) === 'cold_start'
      ? 'member'
      : null;
  // ADR-047 — per-library ytdl-sub visibility (only under the coarse section knob).
  const ytdlsubAllowed = ytdlsubVisible
    ? await accessibleYtdlsubLibraries(session.user.id, session.user.role.isAdmin)
    : new Set<'peloton' | 'youtube'>();
  const ytdlsubLibraries = {
    peloton: ytdlsubAllowed.has('peloton'),
    youtube: ytdlsubAllowed.has('youtube'),
  };
  return (
    <LibraryClient
      ytdlsubVisible={ytdlsubVisible}
      booksVisible={booksVisible}
      mediaVisible={mediaVisible}
      ytdlsubLibraries={ytdlsubLibraries}
      coldStart={coldStart}
    />
  );
}
