// Synthetic plex.tv v1 XML fixtures shaped EXACTLY like the live responses captured
// 2026-07-06 (attribute names/nesting verified against real haynestower data), with fake
// emails/usernames/ids so no PII lands in the repo. Used by the @hnet/plex client tests.

/** `GET /api/users` — two friends, one matching the app user's email. */
export const USERS_XML = `<?xml version="1.0" encoding="UTF-8"?>
<MediaContainer friendlyName="HaynesTower" identifier="com.plexapp.plugins.myplex" size="2" totalSize="2" machineIdentifier="mid-tower">
  <User id="111" title="Alice" username="alice" email="Alice@Example.com" home="0" restricted="0">
    <Server id="900" serverId="1" machineIdentifier="mid-tower" name="HaynesTower" owned="0" pending="0" allLibraries="1" numLibraries="4"/>
  </User>
  <User id="222" title="Bob" username="bob" email="bob@example.com" home="0" restricted="0">
    <Server id="901" serverId="1" machineIdentifier="mid-tower" name="HaynesTower" owned="0" pending="0" allLibraries="0" numLibraries="2"/>
  </User>
</MediaContainer>`;

/** `GET /api/servers/{machineId}` — the section key → plex.tv id map (title carries an &amp;). */
export const SERVER_SECTIONS_XML = `<?xml version="1.0" encoding="UTF-8"?>
<MediaContainer friendlyName="myPlex" identifier="com.plexapp.plugins.myplex" size="1">
  <Server name="HaynesTower" machineIdentifier="mid-tower">
    <Section id="118181361" key="1" type="movie" title="HNet Movies"/>
    <Section id="118251661" key="2" type="show" title="HNet TV &amp; Specials"/>
    <Section id="118278404" key="4" type="photo" title="HNet Photos"/>
    <Section id="118278994" key="5" type="movie" title="HNet Home Videos"/>
  </Server>
</MediaContainer>`;

/**
 * `GET /api/servers/{machineId}/shared_servers` — Alice (user 111) has a partial share of two
 * of four sections (keys 1 and 2 shared; 4 and 5 not). Bob (222) has none listed.
 */
export const SHARED_SERVERS_XML = `<?xml version="1.0" encoding="UTF-8"?>
<MediaContainer friendlyName="HaynesTower" identifier="com.plexapp.plugins.myplex" size="1" machineIdentifier="mid-tower">
  <SharedServer id="30001" username="alice" email="alice@example.com" userID="111" accessToken="tok-redacted" name="HaynesTower" acceptedAt="1700000000" invitedAt="1699000000" allowSync="0" allLibraries="0" owned="0">
    <Section id="118181361" key="1" title="HNet Movies" type="movie" shared="1"/>
    <Section id="118251661" key="2" title="HNet TV &amp; Specials" type="show" shared="1"/>
    <Section id="118278404" key="4" title="HNet Photos" type="photo" shared="0"/>
    <Section id="118278994" key="5" title="HNet Home Videos" type="movie" shared="0"/>
  </SharedServer>
</MediaContainer>`;

/** `POST .../shared_servers` success — the newly created SharedServer echoed back. */
export const CREATED_SHARED_SERVER_XML = `<?xml version="1.0" encoding="UTF-8"?>
<MediaContainer size="1">
  <SharedServer id="30099" username="bob" userID="222" allLibraries="0">
    <Section id="118181361" key="1" title="HNet Movies" type="movie" shared="1"/>
  </SharedServer>
</MediaContainer>`;

/** `GET /library/sections` JSON (PMS read) — three-library server. */
export const LIBRARY_SECTIONS_JSON = {
  MediaContainer: {
    size: 3,
    Directory: [
      { key: '1', type: 'movie', title: 'HOps Movies', agent: 'tv.plex.agents.movie' },
      { key: '2', type: 'show', title: 'HOps TV Shows', agent: 'tv.plex.agents.series' },
      { key: '3', type: 'artist', title: 'HOps Music', agent: 'tv.plex.agents.music' },
    ],
  },
};

/** `GET /identity` JSON. */
export const IDENTITY_JSON = {
  MediaContainer: { machineIdentifier: 'mid-ops', version: '1.43.2.10687-563d026ea' },
};

/**
 * ADR-038 / DESIGN-017 — `GET /library/sections/{key}/all` JSON (PMS read) for a ytdl-sub
 * "TV Show by Date" library: numeric-ish fields as strings (as Plex emits), a Plex-relative thumb.
 */
export const SECTION_CONTENTS_JSON = {
  MediaContainer: {
    size: 2,
    Metadata: [
      {
        ratingKey: '9001',
        key: '/library/metadata/9001/children',
        type: 'show',
        title: 'Bike Bootcamp',
        thumb: '/library/metadata/9001/thumb/1699999999',
        childCount: '4',
        leafCount: '128',
        year: '2024',
        addedAt: '1699990000',
      },
      {
        ratingKey: 9002, // Plex sometimes emits a number
        type: 'show',
        title: 'Power Zone Endurance',
        // no thumb → the UI falls back to the KindIcon tile
        childCount: 3,
        leafCount: 57,
      },
    ],
  },
};

/**
 * DESIGN-017 D-09 — `GET /library/metadata/{key}` JSON (the drill-in head): one show with the
 * owning librarySectionID on the ITEM (as Plex emits for a single-metadata read).
 */
export const METADATA_ITEM_JSON = {
  MediaContainer: {
    size: 1,
    Metadata: [
      {
        ratingKey: '9001',
        key: '/library/metadata/9001/children',
        type: 'show',
        title: 'Bike Bootcamp',
        summary: '',
        librarySectionID: 4, // number, coerced to '4'
        thumb: '/library/metadata/9001/thumb/1699999999',
        childCount: 4,
        leafCount: 481,
        addedAt: 1747617465,
      },
    ],
  },
};

/**
 * DESIGN-017 D-09 — `GET /library/metadata/{key}/children` JSON for a SEASON (episodes): the
 * container carries librarySectionID + totalSize (paged); episodes carry index, duration (ms) and
 * originallyAvailableAt, mirroring the live k8plex shape probed 2026-07-10.
 */
export const METADATA_CHILDREN_JSON = {
  MediaContainer: {
    size: 2,
    totalSize: '261',
    librarySectionID: 4,
    Metadata: [
      {
        ratingKey: '579874',
        parentRatingKey: '448161',
        type: 'episode',
        title: '2026-06-09 - 30 min Bootcamp',
        index: '701',
        duration: '1991936',
        originallyAvailableAt: '2026-06-09',
        thumb: '/library/metadata/579874/thumb/1781888110',
      },
      {
        ratingKey: 579875,
        type: 'episode',
        title: '2026-06-02 - 30 min Bootcamp',
        index: 700,
        duration: 1800000,
        // no thumb, no air date → nulls downstream
      },
    ],
  },
};

/**
 * `GET /api/v2/user` JSON (plex.tv) — the token account, i.e. the server OWNER. Shaped like the
 * live response (id is a number; many extra fields) with a fake email/id so no PII lands in the
 * repo. The read client consumes only { id, email, username } (ADR-029).
 */
export const ACCOUNT_JSON = {
  id: 12874060,
  uuid: '6430780f7aa923ed',
  username: 'owneruser',
  title: 'Owner User',
  email: 'Owner@Example.com',
  friendlyName: 'owneruser',
  hasPassword: true,
};
