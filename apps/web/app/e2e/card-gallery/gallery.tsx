'use client';

// PLAN-047 / ADR-058 / DESIGN-004 D-21 — the CARD GALLERY: one hermetic page rendering EVERY card
// variant of the shared card family in every state, over pure fixture data (inline data-URI art —
// no network, no tRPC, no auth). It exists for exactly two consumers:
//
//   • e2e/card-gallery.spec.ts — the DRIFT GATE: structural DOM assertions over every tile here
//     (one art box, one caption, ONE badge row ≤ MAX_CARD_BADGES, pucks only in reserved corners,
//     no buttons on card faces) + full-page screenshot artifacts in both themes/widths. A card
//     variant that drifts FAILS CI.
//   • humans/agents — the gallery captures are the standing reference for what a wall card looks
//     like (the REFERENCE-movies-wall anatomy); brief future work against them.
//
// Extending the family = adding the variant HERE and in the spec, in the same change (ADR-058).
// The route (page.tsx) 404s outside development — this never ships as a user-facing surface.
import {
  ActivityCard,
  BookCard,
  GroupCard,
  MediaCard,
  PosterGrid,
  PosterGridSkeleton,
  RequestCard,
  TicketCard,
  TicketWall,
  TicketWallSkeleton,
  TrashCard,
  TrashWall,
  TrashWallSkeleton,
} from '@/components/cards';

// Fixture art: inline SVG data URIs (hermetic — never a proxy route). The colors are image
// CONTENT (a fake poster's pixels), not UI theme — hard rule 2 governs stylesheets, not fixtures.
function svgPoster(bg: string, fg: string, text: string): string {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="300">` +
    `<rect width="200" height="300" fill="${bg}"/>` +
    `<circle cx="100" cy="118" r="58" fill="${fg}"/>` +
    `<text x="100" y="268" font-family="sans-serif" font-size="26" fill="${fg}" text-anchor="middle">${text}</text>` +
    `</svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}
const POSTER_A = svgPoster('#25313a', '#79d297', 'A');
const POSTER_B = svgPoster('#3a2531', '#d29779', 'B');
const PORTRAIT = svgPoster('#2a2a3a', '#97a9d2', 'AU');

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="gallery__section">
      <h2 className="gallery__heading">{title}</h2>
      {children}
    </section>
  );
}

export function CardGallery() {
  return (
    <div className="gallery" data-testid="card-gallery">
      <h1 className="page-title">Card gallery — the shared card family (PLAN-047 / ADR-058)</h1>
      <p className="muted gallery__note">
        Every variant, every state, fixture data only. The e2e drift gate asserts this page&apos;s
        DOM shape; its captures are the standing UX reference.
      </p>

      <Section title="MediaCard — ledger/Plex walls (Movies · TV · Music · Peloton · YouTube)">
        <PosterGrid testId="gallery-media">
          <MediaCard
            href="#"
            posterUrl={POSTER_A}
            kind="radarr"
            title="The Reference"
            year={2026}
            badges={[
              { label: '★ 8.1', tone: 'rating', title: 'IMDb rating' },
              { label: 'On disk', tone: 'ok' },
            ]}
          />
          <MediaCard
            href="#"
            posterUrl={null}
            kind="radarr"
            title="Wanted Movie"
            year={2026}
            badges={[{ label: 'Wanted', tone: 'warn' }]}
          />
          <MediaCard
            href="#"
            posterUrl={POSTER_B}
            kind="radarr"
            title="Tombstoned"
            year={2019}
            badges={[
              { label: '★ 5.5', tone: 'rating' },
              { label: 'On disk', tone: 'ok' },
              { label: 'Removed', tone: 'danger' },
            ]}
          />
          <MediaCard href="#" posterUrl={null} kind="lidarr" title="The Stub Band" />
          <MediaCard
            href="#"
            posterUrl={POSTER_A}
            kind="show"
            title="A Channel"
            year={2024}
            badges={[{ label: '3 seasons · 41 eps' }]}
          />
          {/* PLAN-048 / ADR-059 D-03 — the wall in-flight badge (a typed prop, leads the badge row). */}
          <MediaCard
            href="#"
            posterUrl={POSTER_B}
            kind="radarr"
            title="Grabbing Now"
            year={2026}
            inFlight={{ stage: 'downloading', progress: 42 }}
            badges={[{ label: '★ 7.4', tone: 'rating' }]}
          />
        </PosterGrid>
      </Section>

      <Section title="BookCard — Books · Audiobooks · Comics (on-disk + composed Wanted)">
        <PosterGrid testId="gallery-books">
          <BookCard
            href="#"
            posterUrl={POSTER_A}
            mediaKind="book"
            title="A Long Book Title That Ellipsizes"
            year={2021}
            author="An Author"
            badges={[{ label: '412 pp' }]}
          />
          <BookCard
            href="#"
            posterUrl={POSTER_B}
            mediaKind="audiobook"
            title="An Audiobook"
            author="A Narrated Author"
            badges={[{ label: '11h 20m' }]}
          />
          <BookCard href="#" posterUrl={null} mediaKind="comic" title="A Comic Series" />
          <BookCard
            href="#"
            posterUrl={null}
            mediaKind="audiobook"
            title="A Wanted Audiobook"
            author="An Author"
            badges={[{ label: 'Wanted', tone: 'warn' }]}
            testId="wanted-card"
            data={{ 'data-request-id': 'fixture-1' }}
          />
          <BookCard
            href="#"
            posterUrl={null}
            mediaKind="book"
            title="A Missing Book"
            author="An Author"
            badges={[{ label: 'Missing', tone: 'danger' }]}
            testId="wanted-card"
            data={{ 'data-request-id': 'fixture-2' }}
          />
          {/* PLAN-048 / ADR-059 D-03 — a book wall poster carrying the in-flight (importing) badge. */}
          <BookCard
            href="#"
            posterUrl={null}
            mediaKind="book"
            title="Importing Now"
            author="An Author"
            inFlight={{ stage: 'importing' }}
          />
        </PosterGrid>
      </Section>

      <Section title="ActivityCard — the Activity sub-tab grid (in-flight + failed states)">
        <PosterGrid testId="gallery-activity">
          <ActivityCard
            href="#"
            posterUrl={POSTER_A}
            kind="book"
            title="Searching For This"
            sourceApp="lazylibrarian"
            stage="searching"
          />
          <ActivityCard
            href="#"
            posterUrl={POSTER_B}
            kind="book"
            title="Downloading Now"
            sourceApp="sabnzbd"
            stage="downloading"
            progress={73}
          />
          <ActivityCard
            href="#"
            posterUrl={null}
            kind="audiobook"
            title="Importing An Audiobook"
            sourceApp="lazylibrarian"
            stage="importing"
          />
          <ActivityCard
            href="#"
            posterUrl={null}
            kind="book"
            title="Stranded Download"
            sourceApp="lazylibrarian"
            stage="failed"
            failureKind="stranded_import"
            testId="activity-failed"
          />
          <ActivityCard
            href="#"
            posterUrl={POSTER_A}
            kind="book"
            title="Just Landed"
            sourceApp="lazylibrarian"
            stage="completed"
          />
        </PosterGrid>
      </Section>

      <Section title="GroupCard — aggregate walls (portrait → cover fan → glyph)">
        <PosterGrid testId="gallery-groups">
          <GroupCard
            href="#"
            art="covers"
            label="Portrait Author"
            imageUrl={PORTRAIT}
            coverUrls={[]}
            kind="audiobook"
            count={7}
          />
          <GroupCard
            href="#"
            art="covers"
            label="Fanned Author"
            imageUrl={null}
            coverUrls={[POSTER_A, POSTER_B]}
            kind="book"
            count={2}
          />
          <GroupCard
            href="#"
            art="covers"
            label="Empty Group"
            imageUrl={null}
            coverUrls={[]}
            kind="book"
            count={1}
          />
          <GroupCard
            href="#"
            art="glyph"
            label="Science Fiction"
            imageUrl={null}
            coverUrls={[]}
            kind="audiobook"
            count={12}
          />
        </PosterGrid>
      </Section>

      <Section title="RequestCard — Goodreads items (phase badges; pre-mint = non-interactive)">
        <PosterGrid testId="gallery-requests">
          <RequestCard
            href="#"
            posterUrl={POSTER_A}
            isComic={false}
            title="Have It"
            author="An Author"
            shelfBadge={{ label: 'Read', tone: 'muted', title: 'Read · To read' }}
            statusBadge={{ label: 'Have it', tone: 'ok', title: 'In your library' }}
            phase="have"
            requestId="fixture-r1"
          />
          <RequestCard
            href="#"
            posterUrl={null}
            isComic={false}
            title="Searching"
            author="An Author"
            shelfBadge={{ label: 'To read', tone: 'muted' }}
            statusBadge={{ label: 'Wanted', tone: 'warn', title: 'Ebook: Wanted · Audio: Wanted' }}
            phase="searching"
            requestId="fixture-r2"
          />
          <RequestCard
            href="#"
            posterUrl={null}
            isComic={false}
            title="Missing"
            author="An Author"
            shelfBadge={{ label: 'To read', tone: 'muted' }}
            statusBadge={{ label: 'Missing', tone: 'danger' }}
            phase="missing"
            requestId="fixture-r3"
          />
          <RequestCard
            href="#"
            posterUrl={null}
            isComic
            title="Parked Comic"
            author="An Author"
            shelfBadge={{ label: 'To read', tone: 'muted' }}
            statusBadge={{ label: 'Comic · Parked', tone: 'muted', title: 'Waiting on a ComicVine match.' }}
            phase="parked"
            requestId="fixture-r4"
          />
          <RequestCard
            href="#"
            posterUrl={POSTER_B}
            isComic={false}
            title="Focused (deep-linked)"
            author="An Author"
            shelfBadge={{ label: 'Read', tone: 'muted' }}
            statusBadge={{ label: 'Have it', tone: 'ok' }}
            phase="have"
            requestId="fixture-r5"
            focused
          />
          <RequestCard
            href={null}
            posterUrl={null}
            isComic={false}
            title="Pre-mint Want"
            author="An Author"
            shelfBadge={{ label: 'To read', tone: 'muted' }}
            statusBadge={{ label: 'Wanted', tone: 'warn' }}
            phase="searching"
            requestId={null}
          />
        </PosterGrid>
      </Section>

      <Section title="TicketCard — Helpdesk wall (state puck; poster or category tile)">
        <TicketWall refreshing={false} testId="gallery-tickets">
          <TicketCard
            href="#"
            title="Buffering on everything"
            status="open"
            category="playback"
            media={{ posterUrl: POSTER_A, kind: 'radarr', title: 'The Reference', year: 2026 }}
            replyCount={3}
            whenLabel="Jul 14"
          />
          <TicketCard
            href="#"
            title="No sound from minute 3"
            status="in_progress"
            category="audio"
            media={null}
            replyCount={0}
            whenLabel="Jul 13"
          />
          <TicketCard
            href="#"
            title="Fixed last week"
            status="complete"
            category="quality"
            media={{ posterUrl: POSTER_B, kind: 'sonarr', title: 'A Show', year: 2020 }}
            replyCount={1}
            whenLabel="Jul 7"
          />
          <TicketCard
            href="#"
            title="Not something we host"
            status="rejected"
            category="other"
            media={null}
            replyCount={0}
            whenLabel="Jun 30"
          />
        </TicketWall>
      </Section>

      <Section title="TrashCard — pending + batch walls (corner toggle · lib-link · meta chips)">
        <TrashWall pwall refreshing={false} label="Gallery trash wall" testId="gallery-trash">
          <TrashCard
            pwall
            testId="trash-tile"
            glyph="trash"
            posterUrl={POSTER_A}
            kind="radarr"
            title="Slated Movie"
            year={2019}
            toggle={{
              tappable: true,
              pressed: false,
              label: 'Slated Movie is slated to delete — tap to save it',
              title: 'Deletes Jul 20 (6 days)',
              testId: 'trash-toggle',
              markInert: true,
            }}
            libraryLink={{ href: '#', title: 'Open Slated Movie (2019)', ariaLabel: 'Open Slated Movie (2019)' }}
            metaText="3.0 GB · ★ 6.4"
            requesters={[]}
            watchNote={null}
          />
          <TrashCard
            pwall
            testId="trash-tile"
            glyph="shield"
            posterUrl={POSTER_B}
            kind="radarr"
            title="Saved by You"
            year={2021}
            toggle={{
              tappable: true,
              pressed: true,
              label: 'Un-save Saved by You — remove its deletion protection',
              title: 'Saved by you — protected from deletion',
              testId: 'trash-toggle',
              markInert: true,
            }}
            libraryLink={null}
            metaText="1.2 GB"
            requesters={['Marge Member']}
            watchNote={{ label: 'Watched recently on k8plex', tone: 'info' }}
          />
          <TrashCard
            pwall
            testId="trash-tile"
            glyph="check"
            posterUrl={null}
            kind="sonarr"
            title="Protected Elsewhere"
            year={null}
            toggle={{
              tappable: false,
              pressed: false,
              label: 'Protected Elsewhere is protected from deletion',
              title: 'Protected — excluded in Maintainerr',
              testId: 'trash-toggle',
              markInert: true,
            }}
            libraryLink={null}
            metaText="—"
            requesters={[]}
            watchNote={{ label: 'Last watched on k8plex · Feb 2026', tone: 'muted' }}
          />
          <TrashCard
            testId="wall-tile"
            glyph="skip"
            posterUrl={POSTER_A}
            kind="radarr"
            title="Kept by the Sweep"
            year={2018}
            toggle={{
              tappable: false,
              pressed: false,
              label: 'Kept by the Sweep was skipped',
              title: 'Kept by the Sweep was skipped',
            }}
            libraryLink={null}
            metaText="2.1 GB · ★ 7.0"
            requesters={[]}
            watchNote={null}
          />
          <TrashCard
            testId="wall-tile"
            glyph="gone"
            posterUrl={POSTER_B}
            kind="radarr"
            title="Deleted"
            year={2015}
            toggle={{
              tappable: false,
              pressed: false,
              label: 'Deleted was removed by the sweep',
              title: 'Deleted was removed by the sweep',
            }}
            libraryLink={null}
            metaText="4.4 GB"
            requesters={[]}
            watchNote={null}
          />
        </TrashWall>
      </Section>

      <Section title="Skeletons — loading states hold the exact grid geometry (ADR-015)">
        <div data-testid="gallery-skeletons">
          <PosterGridSkeleton count={4} testId="gallery-poster-skeleton" />
          <TicketWallSkeleton count={4} />
          <TrashWallSkeleton count={4} testId="gallery-trash-skeleton" />
        </div>
      </Section>
    </div>
  );
}
