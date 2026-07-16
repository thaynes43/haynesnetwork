// ADR-063 / DESIGN-034 D-05..D-08 — the About/Help page body: intro + haynes-ops info pane,
// then one collapsed <details> section per topic. Copy contract (D-07): every claim, label,
// and route comes from the verified fact sheets; in-app destinations are <Link>s, external
// ones open in a new tab. The ONE dynamic value is the live Trash save-window default (D-06),
// passed in by the server page. Owner-unvalidated instructions carry the .about-flag note
// (D-08: iOS Panels steps, Plex language recipe). Haynestower play totals slot in by PR when
// the owner supplies them (PLAN-049 Q-06).
//
// Tone rules (owner review 2026-07-16): semi-professional but friendly; no personal names;
// no em-dashes in user-visible copy; say "cluster", never Kubernetes; no time-grounding the
// migration; frame as capabilities, not favors; link every destination that has a URL.
import Link from 'next/link';
import { AboutSection } from './about-section';
import { HashOpener } from './hash-opener';
import {
  AudiobooksGlyph,
  FixGlyph,
  GoodreadsGlyph,
  MusicGlyph,
  ReadingGlyph,
  RequestGlyph,
  ServersGlyph,
  TicketGlyph,
  TrashGlyph,
  WatchingGlyph,
} from './glyphs';

/** External-link boilerplate (D-07): plex.tv, GitHub, and friends never reuse our tab. */
const EXT = { target: '_blank', rel: 'noopener noreferrer' } as const;

const GLYPH = { width: 18, height: 18 } as const;

export function AboutContent({ trashWindowDays }: { trashWindowDays: number }) {
  return (
    <div className="about">
      <h1 className="page-title">About haynesnetwork.com</h1>

      <div className="about__intro">
        <p>
          Welcome! Everything behind this site now runs on a single cluster, and that migration
          made it possible to open up tools that were previously reachable only from the home
          network. One login gets you a dashboard of the apps available to you, plus self-service
          for the media library.
        </p>
        <p>Everything below is collapsed on purpose. Open the section you need and skip the rest.</p>
      </div>

      <aside className="card about-pane">
        <p>
          <strong>
            <a href="https://github.com/thaynes43/haynes-ops" {...EXT}>
              haynes-ops
            </a>
          </strong>{' '}
          is the repository that runs the cluster. Every app on this site is deployed from it, and
          it&rsquo;s public if you want to see how everything works.
        </p>
      </aside>

      <HashOpener />

      <AboutSection id="plex-servers" title="Plex Servers" glyph={<ServersGlyph {...GLYPH} />}>
        <p>
          The one thing to know: <strong>user menu (your avatar, top right) &rarr;</strong>{' '}
          <strong>
            <Link href="/library/plex">My Plex</Link>
          </strong>{' '}
          is where you pick which of our libraries show up when you log into{' '}
          <a href="https://plex.tv" {...EXT}>
            plex.tv
          </a>
          . If a library you want is missing from your Plex apps, start there.
        </p>
        <p>There are three servers:</p>
        <h3>Haynestower</h3>
        <p>
          The original server, online since September 2023, and the last piece of software still
          running on the NAS. It stays exactly as it is until that hardware retires.
          {/* TODO: play totals by Movie/TV/Music — owner supplying from NAS Tautulli (PLAN-049 Q-06) */}
        </p>
        <h3>k8splex</h3>
        <p>
          The server for smaller files: Music, Peloton, and YouTube. Anything that isn&rsquo;t TV
          and Movies lives here.
        </p>
        <h3>HOps Plex</h3>
        <p>
          The next generation. It runs on the cluster, tolerates hardware failure, and will be
          maintained indefinitely. The tooling that used to integrate with Haynestower now
          integrates here, against a shared media library, and collections and poster overlays are
          maintained here as well. k8splex and HOps Plex run on identical servers, so if one
          breaks, everything can roll onto the other.
        </p>
      </AboutSection>

      <AboutSection
        id="fix"
        title="Fix broken media & find missing"
        glyph={<FixGlyph {...GLYPH} />}
      >
        <p>
          Something won&rsquo;t play? Wrong language, bad quality, or the wrong content entirely?
          Open the title in the <Link href="/library">Library</Link> and hit <strong>Fix</strong>.
          It blocklists the bad release (or removes the file when there is no download history to
          blame) and then automatically searches for a fresh copy.
        </p>
        <p>Two special cases:</p>
        <ul>
          <li>
            <strong>Missing subtitles:</strong> pick that reason in the Fix form and only subtitles
            are fetched. Bazarr grabs just the subs and leaves the video file untouched. If that
            doesn&rsquo;t resolve it, run a plain Fix.
          </li>
          <li>
            <strong>Force Search:</strong> an on-demand hunt for something that is missing
            entirely. The backend occasionally misses a release, and this kicks off a manual
            search for it.
          </li>
        </ul>
        <p>
          Fix and Force Search share a budget of 25 per hour per person, which is plenty for real
          problems.
        </p>
        <p>
          Want to watch your fix land?{' '}
          <strong>
            <Link href="/library?tab=activity">Library &rarr; Activity</Link>
          </strong>{' '}
          shows everything in flight. The badges: <strong>Searching</strong> (hunting for a
          release), a <strong>percentage</strong> (downloading), <strong>Importing</strong>{' '}
          (landing in the library), <strong>Stuck</strong> (something went wrong), and{' '}
          <strong>Just added</strong> (done). Stuck comes in four flavors:
        </p>
        <ul>
          <li>
            <strong>Stranded:</strong> the download finished but never made it into the library.
          </li>
          <li>
            <strong>Import failed:</strong> the importer ran but couldn&rsquo;t place the file.
          </li>
          <li>
            <strong>Download failed:</strong> the download itself died; there is nothing to
            import.
          </li>
          <li>
            <strong>Blocked:</strong> the importer refused the file.
          </li>
        </ul>
        <p>
          Most stuck items clear on the next automatic rescan (roughly every 15 minutes), so give
          it a few. If one stays stuck, an admin has Retry and Re-search tools for it. Mention it
          in a <Link href="/bulletin">Ticket</Link> if it&rsquo;s holding you up.
        </p>
        <p>
          Books have their own Fix: the <strong>Fix this</strong> button on a book&rsquo;s page. It
          works the same way but never deletes the old file. The current copy stays on your shelf.
        </p>
      </AboutSection>

      <AboutSection id="tickets" title="Still have an issue?" glyph={<TicketGlyph {...GLYPH} />}>
        <p>
          When Fix didn&rsquo;t do it, or something is wrong that a button can&rsquo;t express,
          file a ticket: top nav &rarr; <Link href="/bulletin">Tickets</Link> &rarr;{' '}
          <strong>New ticket</strong>.
        </p>
        <ul>
          <li>Give it a short title and pick a category.</li>
          <li>
            <strong>Link the title.</strong> The picker searches the library, and for TV or Music
            you can pick the exact season, episode, album, or track (or &ldquo;Entire
            show&rdquo;). The poster becomes your ticket&rsquo;s tile, and whoever picks it up
            knows exactly what to look at.
          </li>
        </ul>
        <p>Tickets move Open &rarr; In progress &rarr; Complete (or Rejected).</p>
        <p>
          Bugs in this site and feature ideas go somewhere else:{' '}
          <a href="https://github.com/thaynes43/haynesnetwork/issues" {...EXT}>
            github.com/thaynes43/haynesnetwork/issues
          </a>
          .
        </p>
      </AboutSection>

      <AboutSection id="trash" title="Trash" glyph={<TrashGlyph {...GLYPH} />}>
        <p>
          Disk space isn&rsquo;t infinite, so a rule engine keeps a bucket of low-quality and
          never-watched media flagged for cleanup. Admins batch it up for deletion, and every batch
          gets a save window (currently{' '}
          <strong>
            {trashWindowDays} {trashWindowDays === 1 ? 'day' : 'days'}
          </strong>{' '}
          by default) before anything is actually removed.
        </p>
        <p>
          See something on the <Link href="/trash">Trash</Link> page you want to keep?{' '}
          <strong>Tap its poster&rsquo;s shield to save it.</strong> A saved item is excluded from
          ever becoming a Trash candidate again (until someone un-saves it), and it drops off the
          Trash page after the next backend sync, which takes a few minutes.
        </p>
        <p>
          You can also dig past the current batch: the &ldquo;Potential in future batches&rdquo;
          wall shows what is eligible next time, and the shield works there just the same.
        </p>
      </AboutSection>

      <AboutSection id="requests" title="Request media" glyph={<RequestGlyph {...GLYPH} />}>
        <p>
          TV and Movies go through{' '}
          <strong>
            <a href="https://overseerr.haynesnetwork.com" {...EXT}>
              Seerr
            </a>
          </strong>
          , which also lives on your dashboard. Search for what you want and hit request. Anything
          you add to your Plex Watchlist gets picked up by Seerr as well.
        </p>
        <p>
          Books work differently: there is no request form. Your Goodreads shelf is the request
          form. Head over to the{' '}
          <Link href="/integrations/goodreads">Goodreads integration</Link> to get started, and
          see the Goodreads section below for how it works.
        </p>
      </AboutSection>

      <AboutSection
        id="goodreads"
        title="Goodreads integration"
        glyph={<GoodreadsGlyph {...GLYPH} />}
      >
        <p>
          Head to <strong>user menu &rarr; Integrations &rarr;</strong>{' '}
          <strong>
            <Link href="/integrations/goodreads">Goodreads</Link>
          </strong>{' '}
          and paste your public Goodreads profile URL. One per person, and your shelves must be
          public (Goodreads <strong>Settings &rarr; Privacy</strong>).
        </p>
        <p>
          From there the backend works to fill the library with everything on your shelves. The
          sync runs hourly and retries automatically. Popular titles land fast; obscure ones can
          take days to track down.
        </p>
        <p>
          There is no need to worry about which format to ask for: we always search for{' '}
          <strong>both the ebook and the audiobook</strong> of everything you shelve.
        </p>
      </AboutSection>

      <AboutSection
        id="reading"
        title="Reading ebooks & comics"
        glyph={<ReadingGlyph {...GLYPH} />}
      >
        <p>
          Ebooks and comics live in <strong>Kavita</strong>:{' '}
          <a href="https://kavita.haynesnetwork.com" {...EXT}>
            kavita.haynesnetwork.com
          </a>{' '}
          (same login as everything else). Comics sit in the same library and open in the same
          reader.
        </p>
        <p>
          One web-reader tip worth knowing: on a phone, open the epub reader&rsquo;s settings and
          set <strong>Layout Mode</strong> to single-column scroll. It reads much better, and it
          remembers your spot.
        </p>
        <p>
          On iOS, get <strong>Panels</strong>:
        </p>
        <ol>
          <li>
            In Kavita on the web: <strong>Settings</strong> &rarr; your account &rarr; enable{' '}
            <strong>OPDS</strong> &rarr; copy your personal OPDS URL.
          </li>
          <li>
            In Panels: add a source &rarr; <strong>OPDS</strong> &rarr; paste the URL as Host
            &rarr; Save.
          </li>
        </ol>
        <p>Reading progress syncs back to Kavita.</p>
        <p className="about-flag">
          These steps haven&rsquo;t been verified on a real device yet. If they don&rsquo;t work
          as written, file a ticket.
        </p>
        <p>
          On Android, any OPDS reader works (Moon+ Reader, Librera, KOReader) pointed at the same
          OPDS URL.
        </p>
      </AboutSection>

      <AboutSection
        id="audiobooks"
        title="Listening to audiobooks"
        glyph={<AudiobooksGlyph {...GLYPH} />}
      >
        <p>
          Audiobooks live in <strong>Audiobookshelf</strong>:{' '}
          <a href="https://audiobookshelf.haynesnetwork.com" {...EXT}>
            audiobookshelf.haynesnetwork.com
          </a>{' '}
          (same login).
        </p>
        <ul>
          <li>
            <strong>iOS:</strong> get <strong>AudioBooth</strong> from the App Store. Add a server
            &rarr; enter the URL above &rarr; choose <strong>OIDC Login</strong> &rarr;{' '}
            <strong>Log in with SSO</strong> &rarr; the same Plex login as everything else.
          </li>
          <li>
            <strong>Android:</strong> the official <strong>Audiobookshelf</strong> app from the
            Play Store. Enter the server URL &rarr; <strong>Login with SSO</strong>.
          </li>
        </ul>
        <p>
          One tip: the <strong>web</strong> player only saves your place when you press Pause (or
          when its periodic sync fires). If you close the tab mid-chapter you can lose your spot.
          Use the apps, or press Pause before closing.
        </p>
      </AboutSection>

      <AboutSection id="watching" title="Watching Movies & TV" glyph={<WatchingGlyph {...GLYPH} />}>
        <p>
          Plex has apps for practically every screen: phones, tablets, smart TVs, streaming boxes,
          consoles, and the browser. Install it wherever you watch.
        </p>
        <p>
          First thing: clean up the home screen. Plex ships full of its own streaming filler. Go
          to <strong>Settings &rarr; Online Media Sources</strong> and disable Live TV, Movies
          &amp; Shows, and Discover (or just unpin them). Then pin <em>our</em> libraries to your
          sidebar and put them in the order you like.
        </p>
        <p>
          Your Watchlist works here too: anything you Watchlist gets picked up by{' '}
          <a href="https://overseerr.haynesnetwork.com" {...EXT}>
            Seerr
          </a>
          .
        </p>
        <p>
          Recommended settings, under{' '}
          <strong>Account Settings &rarr; Audio &amp; Subtitle Settings</strong>:
        </p>
        <ul>
          <li>
            Turn ON <strong>&ldquo;Automatically select audio and subtitle tracks&rdquo;</strong>.
          </li>
          <li>
            <strong>Preferred audio language:</strong> English.
          </li>
          <li>
            <strong>Subtitle Mode:</strong> &ldquo;Shown with foreign audio&rdquo;.
          </li>
        </ul>
        <p>
          The result: an English movie with a stray German track picks English, and a foreign film
          keeps its original language with subtitles. Plex has no &ldquo;prefer original
          language&rdquo; toggle, so for a foreign film, pick the original track once and Plex
          will remember that choice for the title.
        </p>
        <p className="about-flag">
          These setting names are still being double-checked. If your menus disagree, file a
          ticket.
        </p>
        <p>Two gotchas:</p>
        <ul>
          <li>
            When choosing subtitles, prefer <strong>SRT</strong>. Image-based subs (PGS/VOBSUB)
            force the server to transcode the whole video and can stutter.
          </li>
          <li>
            Some TV apps keep their <em>own</em> audio settings that override the account ones. If
            a TV keeps picking the wrong track, check the app&rsquo;s local settings.
          </li>
        </ul>
      </AboutSection>

      <AboutSection id="music" title="Listening to music" glyph={<MusicGlyph {...GLYPH} />}>
        <p>
          Music through Plex doesn&rsquo;t get much use here, but if you&rsquo;re interested,{' '}
          <strong>
            <a href="https://www.plex.tv/plexamp/" {...EXT}>
              Plexamp
            </a>
          </strong>{' '}
          (free, available on every platform) is an excellent player.
        </p>
        <p>
          The music library lives on the k8splex server, so if you don&rsquo;t see it, add it via{' '}
          <strong>
            <Link href="/library/plex">My Plex</Link>
          </strong>{' '}
          first.
        </p>
      </AboutSection>
    </div>
  );
}
