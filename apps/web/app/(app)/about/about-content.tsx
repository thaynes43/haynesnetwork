// ADR-063 / DESIGN-034 D-05..D-08 — the About/Help page body: intro + haynes-ops info pane,
// then one collapsed <details> section per topic (all in the owner's voice — PLAN-049).
// Copy contract (D-07): every claim, label, and route comes from the verified fact sheets;
// in-app destinations are <Link>s, external ones open in a new tab. The ONE dynamic value is
// the live Trash save-window default (D-06), passed in by the server page. Owner-unvalidated
// instructions carry the .about-flag note (D-08: iOS Panels steps, Plex language recipe);
// Goodreads and books-Fix copy is written member-facing — their role flips are pending
// (PLAN-049 Q-07). Haynestower play totals slot in by PR when the owner supplies them (Q-06).
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
          Hey — Tom here. A while back I moved our whole media stack onto my Kubernetes cluster, and
          once everything lived in one place, wiring things together stopped being a weekend project
          and started being easy. This site is the result: one login for the household, a dashboard
          of the apps you can use, and self-service for the stuff you used to have to text me about.
        </p>
        <p>Everything below is collapsed on purpose. Tap the section you need; skip the rest.</p>
      </div>

      <aside className="card about-pane">
        <p>
          <strong>
            <a href="https://github.com/thaynes43/haynes-ops" {...EXT}>
              haynes-ops
            </a>
          </strong>{' '}
          is the GitOps repo that runs all of this — every app on this site is deployed from it.
          Curious how the sausage is made? It’s all public.
        </p>
      </aside>

      <HashOpener />

      <AboutSection id="plex-servers" title="Plex Servers" glyph={<ServersGlyph {...GLYPH} />}>
        <p>
          The one thing to know: <strong>user menu (your avatar, top right) →</strong>{' '}
          <strong>
            <Link href="/library/plex">My Plex</Link>
          </strong>{' '}
          is where you pick which of our libraries show up when you log into{' '}
          <a href="https://plex.tv" {...EXT}>
            plex.tv
          </a>
          . If a library you want is missing from your Plex apps, that’s the fix.
        </p>
        <p>We run three servers:</p>
        <h3>Haynestower</h3>
        <p>
          The original — online since September 2023, and the last piece of software still running
          on the NAS. It’s served the household a lot of plays in its day, and it stays exactly as
          it is until that hardware retires.
          {/* TODO: play totals by Movie/TV/Music — owner supplying from NAS Tautulli (PLAN-049 Q-06) */}
        </p>
        <h3>k8splex</h3>
        <p>
          The smaller-files server: Music, Peloton, and YouTube — basically everything that isn’t TV
          and Movies.
        </p>
        <h3>HOps Plex</h3>
        <p>
          The next generation. It runs on the cluster, shrugs off hardware failures, and it’s the
          one I’ll maintain indefinitely. The tooling that used to integrate with Haynestower
          integrates here now, on a shared media library — and collections and poster overlays are
          maintained here too. k8splex and HOps Plex run on identical servers, so if one box breaks,
          everything can roll onto the other.
        </p>
      </AboutSection>

      <AboutSection
        id="fix"
        title="Fix broken media & find missing"
        glyph={<FixGlyph {...GLYPH} />}
      >
        <p>
          Something won’t play? Wrong language, bad quality, wrong movie entirely? Open the title in
          the Library and hit <strong>Fix</strong>. It blocklists the bad release — or removes the
          file when there’s no grab history to blame — and then searches for a fresh copy
          automatically.
        </p>
        <p>Two special cases:</p>
        <ul>
          <li>
            <strong>Missing subtitles</strong> — pick that reason in the Fix form and only subtitles
            are fetched (Bazarr grabs just the subs; the video file is untouched). If that doesn’t
            cure it, run a plain Fix.
          </li>
          <li>
            <strong>Force Search</strong> — the on-demand hunt for something that’s missing
            entirely. Sometimes the backend misses one; this kicks it.
          </li>
        </ul>
        <p>
          Fix and Force Search share a budget of 25 per hour per person — plenty for real problems,
          just enough to stop a runaway clicking spree.
        </p>
        <p>
          Want to watch your fix land?{' '}
          <strong>
            <Link href="/library?tab=activity">Library → Activity</Link>
          </strong>{' '}
          shows everything in flight. The badges: <strong>Searching</strong> (hunting for a
          release), a <strong>percentage</strong> (downloading), <strong>Importing</strong> (landing
          in the library), <strong>Stuck</strong> (something went sideways), and{' '}
          <strong>Just added</strong> (done). Stuck comes in four flavors:
        </p>
        <ul>
          <li>
            <strong>Stranded</strong> — the download finished but never made it into the library.
          </li>
          <li>
            <strong>Import failed</strong> — the importer ran but couldn’t place the file.
          </li>
          <li>
            <strong>Download failed</strong> — the download itself died; there’s nothing to import.
          </li>
          <li>
            <strong>Blocked</strong> — the importer refused the file.
          </li>
        </ul>
        <p>
          Most stuck items clear themselves on the roughly-15-minute rescan, so give it a beat. If
          one just sits there, an admin has Retry and Re-search buttons for it — mention it in a{' '}
          <Link href="/bulletin">Ticket</Link> if it’s bugging you.
        </p>
        <p>
          Books have their own Fix: the <strong>Fix this</strong> button on a book’s page. It works
          the same way but never deletes the old file — the current copy stays on your shelf.
        </p>
      </AboutSection>

      <AboutSection id="tickets" title="Still have an issue?" glyph={<TicketGlyph {...GLYPH} />}>
        <p>
          When Fix didn’t do it — or something’s wrong that a button can’t express — file a ticket:
          top nav → <Link href="/bulletin">Tickets</Link> → <strong>New ticket</strong>.
        </p>
        <ul>
          <li>Give it a short title and pick a category.</li>
          <li>
            <strong>Link the title.</strong> The picker searches the library, and for TV or Music
            you can pick the exact season, episode, album, or track (or “Entire show”). The poster
            becomes your ticket’s tile, and whoever picks it up knows exactly what to look at.
          </li>
        </ul>
        <p>Tickets move Open → In progress → Complete (or Rejected).</p>
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
          Disk space isn’t infinite, so a rule engine (Maintainerr) keeps a bucket of low-quality
          and never-watched stuff flagged for cleanup. Admins batch it up for deletion, and every
          batch gets a save window — currently{' '}
          <strong>
            {trashWindowDays} {trashWindowDays === 1 ? 'day' : 'days'}
          </strong>{' '}
          by default — before anything is actually removed.
        </p>
        <p>
          See something on the <Link href="/trash">Trash</Link> page you want to keep?{' '}
          <strong>Tap its poster’s shield to save it.</strong> A saved item is excluded from ever
          being a Trash candidate again (until someone un-saves it), and it drops off the Trash page
          after the next backend sync — that takes a few minutes, so don’t panic when it doesn’t
          vanish instantly.
        </p>
        <p>
          You can dig past the current batch too: the “Potential in future batches” wall shows
          what’s eligible next time, and the shield works there just the same.
        </p>
      </AboutSection>

      <AboutSection id="requests" title="Request media" glyph={<RequestGlyph {...GLYPH} />}>
        <p>
          TV and Movies go through <strong>Seerr</strong> — the request app on your dashboard.
          Search for what you want, hit request, done. Anything you add to your Plex Watchlist gets
          picked up by Seerr too.
        </p>
        <p>
          Books work differently: there’s no request form at all. Your Goodreads shelf <em>is</em>{' '}
          the request form — see the Goodreads section below.
        </p>
      </AboutSection>

      <AboutSection
        id="goodreads"
        title="Goodreads integration"
        glyph={<GoodreadsGlyph {...GLYPH} />}
      >
        <p>
          Head to <strong>user menu → Integrations →</strong>{' '}
          <strong>
            <Link href="/integrations/goodreads">Goodreads</Link>
          </strong>{' '}
          and paste your public Goodreads profile URL. One per person, and your shelves must be
          public (Goodreads <strong>Settings → Privacy</strong>).
        </p>
        <p>
          From there the backend gets to work filling the library with everything on your shelves.
          The sync runs hourly and retries automatically — popular titles land fast, obscure ones
          can take days to track down. Be patient; it hasn’t forgotten.
        </p>
        <p>
          And never worry about which format to ask for: we always search for{' '}
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
          — same SSO login as everything else. Comics sit in the same library and open in the same
          reader.
        </p>
        <p>
          One web-reader quirk worth knowing: on a phone, open the epub reader’s settings and set{' '}
          <strong>Layout Mode</strong> to single-column scroll. Much nicer — and it remembers your
          spot.
        </p>
        <p>
          On iOS, get <strong>Panels</strong>:
        </p>
        <ol>
          <li>
            In Kavita on the web: <strong>Settings</strong> → your account → enable{' '}
            <strong>OPDS</strong> → copy your personal OPDS URL.
          </li>
          <li>
            In Panels: add a source → <strong>OPDS</strong> → paste the URL as Host → Save.
          </li>
        </ol>
        <p>Reading progress syncs back to Kavita.</p>
        <p className="about-flag">
          Tom hasn’t test-driven these steps yet — ping him if they misbehave.
        </p>
        <p>
          On Android, any OPDS reader works — Moon+ Reader, Librera, KOReader — pointed at the same
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
          — same SSO login.
        </p>
        <ul>
          <li>
            <strong>iOS:</strong> grab <strong>AudioBooth</strong> from the App Store. Add a server
            → enter the URL above → choose <strong>OIDC Login</strong> →{' '}
            <strong>Log in with SSO</strong> → the same Plex login as everything else.
          </li>
          <li>
            <strong>Android:</strong> the official <strong>Audiobookshelf</strong> app from the Play
            Store. Enter the server URL → <strong>Login with SSO</strong>.
          </li>
        </ul>
        <p>
          One hard-earned household tip: the <strong>web</strong> player only saves your spot when
          you hit Pause (or when its periodic sync fires). Close the tab mid-chapter and you can
          lose your place. Use the apps — or at least hit Pause before you close.
        </p>
      </AboutSection>

      <AboutSection id="watching" title="Watching Movies & TV" glyph={<WatchingGlyph {...GLYPH} />}>
        <p>
          Plex has apps for basically every screen ever made — phones, tablets, smart TVs, streaming
          boxes, consoles, browsers. Install it wherever you watch.
        </p>
        <p>
          First thing: clean up the home screen. Plex ships full of its own streaming filler — go to{' '}
          <strong>Settings → Online Media Sources</strong> and disable Live TV, Movies &amp; Shows,
          and Discover (or just unpin them). Then pin <em>our</em> libraries to your sidebar and put
          them in the order you like.
        </p>
        <p>Your Watchlist works here too — anything you Watchlist gets picked up by Seerr.</p>
        <p>
          Settings I recommend, under{' '}
          <strong>Account Settings → Audio &amp; Subtitle Settings</strong>:
        </p>
        <ul>
          <li>
            Turn ON <strong>“Automatically select audio and subtitle tracks”</strong>.
          </li>
          <li>
            <strong>Preferred audio language:</strong> English.
          </li>
          <li>
            <strong>Subtitle Mode:</strong> “Shown with foreign audio”.
          </li>
        </ul>
        <p>
          The result: an English movie with a stray German track picks English, and a foreign film
          keeps its original language with subtitles. There’s no “prefer original language” toggle —
          Plex simply doesn’t have one — so for a foreign film, pick the original track once and
          Plex remembers your choice for that title.
        </p>
        <p className="about-flag">
          Tom is still validating these exact setting names — tell him if your menus disagree.
        </p>
        <p>Two gotchas:</p>
        <ul>
          <li>
            When choosing subtitles, prefer <strong>SRT</strong>. Image-based subs (PGS/VOBSUB)
            force the server to transcode the whole video and can stutter.
          </li>
          <li>
            Some TV apps keep their <em>own</em> audio settings that override the account ones — if
            a TV keeps picking the wrong track, check the app’s local settings.
          </li>
        </ul>
      </AboutSection>

      <AboutSection id="music" title="Listening to music" glyph={<MusicGlyph {...GLYPH} />}>
        <p>
          Honestly? Nobody here listens to music through Plex. And that’s fine. But if you’re
          curious,{' '}
          <strong>
            <a href="https://www.plex.tv/plexamp/" {...EXT}>
              Plexamp
            </a>
          </strong>{' '}
          (free, every platform) is a genuinely excellent player — one of the best things Plex
          makes.
        </p>
        <p>
          The music library lives on the k8splex server, so if you don’t see it, add it via{' '}
          <strong>
            <Link href="/library/plex">My Plex</Link>
          </strong>{' '}
          first.
        </p>
      </AboutSection>
    </div>
  );
}
