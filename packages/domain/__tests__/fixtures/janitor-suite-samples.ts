// ADR-095 / DESIGN-046 D-18, D-19 — anonymized samples of the live LazyLibrarian, SABnzbd and Kapowarr responses the
// queue janitor reads (captured read-only on 2026-09-29). Every field name, value shape and failure text is the live
// one; book ids, titles, authors, job ids and hashes are replaced, and every indexer URL carries the fake key
// `FAKEKEY` (the live `NZBurl` and some `DLResult` values embed the indexer apikey, which never enters the repo).

const PROWLARR = 'http://prowlarr.downloads.svc.cluster.local:9696';
const DL = '/data/cephfs-hdd/data/usenet/complete-k8s/lazylibrarian';
const AUDIO = '/data/cephfs-hdd/data/media/books/AudioBooks';
const EBOOK = '/data/cephfs-hdd/data/media/books/EBooks';

export const SAMPLE_PATHS = { downloadRoot: DL, libraryRoots: [EBOOK, AUDIO] };

/** A `cmd=getHistory` row as LazyLibrarian serves it (capitalized keys; `NZBurl` carries the indexer key). */
function llRow(o: Record<string, unknown>): Record<string, unknown> {
  return {
    BookID: null,
    NZBtitle: null,
    NZBdate: '2026-09-28 04:41:48',
    NZBprov: `${PROWLARR}/14/api`,
    NZBurl: `${PROWLARR}/14/api?t=get&id=00000000-0000-0000-0000-000000000000&apikey=FAKEKEY`,
    NZBsize: '128.19',
    NZBmode: 'nzb',
    Source: 'SABNZBD',
    DownloadID: null,
    AuxInfo: 'AudioBook',
    Status: 'Failed',
    DLResult: null,
    Completed: 0,
    Label: '',
    ...o,
  };
}

const failed = (bookId: string, aux: string, n: number, dlResult: string, id = bookId) =>
  Array.from({ length: n }, (_, i) =>
    llRow({
      BookID: bookId,
      NZBtitle: `Author Loop - ${id} - [04_74] - _004 Author Loop (2014) ${id}.mp4_`,
      DownloadID: `nzo-${id}-fail-${i}`,
      AuxInfo: aux,
      Status: 'Failed',
      DLResult: dlResult,
    }),
  );

/** LazyLibrarian `cmd=getHistory` — one row per grab attempt, never pruned. */
export const LL_HISTORY_SAMPLE: Array<Record<string, unknown>> = [
  // A strand: SABnzbd finished the job, LazyLibrarian never imported it (it never aborts a download at 100%).
  llRow({
    BookID: 'bkStrand0001',
    NZBtitle: 'Author One - Book One (2014) MP3',
    DownloadID: 'nzo-strand-0001',
    Status: 'Snatched',
    Completed: 1790650000,
  }),
  // A snatch whose SABnzbd job failed and LazyLibrarian has not aborted yet.
  llRow({
    BookID: 'bkFailed0002',
    NZBtitle: 'Author Two - Book Two (Retail)',
    DownloadID: 'nzo-failed-0002',
    AuxInfo: 'eBook',
    Status: 'Snatched',
  }),
  // Still downloading in SABnzbd.
  llRow({ BookID: 'bkFlight0003', NZBtitle: 'Author Three - Book Three', DownloadID: 'nzo-flight-0003', Status: 'Snatched' }),
  // SABnzbd no longer shows the job: LazyLibrarian aborts it itself after its task age.
  llRow({ BookID: 'bkGone00004', NZBtitle: 'Author Four - Book Four', DownloadID: 'nzo-gone-0004', Status: 'Snatched' }),
  // A MyAnonaMouse torrent still downloading (live shape: torznab, QBITTORRENT, a 40-hex hash (synthetic here), Completed 0).
  llRow({
    BookID: 'bkTorrent005',
    NZBtitle: 'Book Five by Author Five',
    NZBprov: `${PROWLARR}/17/api`,
    NZBmode: 'torznab',
    Source: 'QBITTORRENT',
    DownloadID: '0000000000000000000000000000000000000005',
    Status: 'Snatched',
    NZBsize: '319.8',
  }),
  // A MAM torrent finished but not imported.
  llRow({
    BookID: 'bkTorrent006',
    NZBtitle: 'Book Six by Author Six',
    NZBprov: `${PROWLARR}/17/api`,
    NZBmode: 'torznab',
    Source: 'QBITTORRENT',
    DownloadID: '0000000000000000000000000000000000000006',
    Status: 'Snatched',
    Completed: 1790640000,
  }),
  // Processed downloads (LazyLibrarian copies: the SABnzbd folder stays). DLResult is the recorded destination.
  llRow({
    BookID: 'bkLeft00007',
    NZBtitle: 'Author Seven - Book Seven (2014) MP3',
    DownloadID: 'nzo-left-0007',
    Status: 'Processed',
    DLResult: `${AUDIO}/Author Seven/Book Seven/Author Seven - Book Seven - 01 of 16.mp3`,
    Completed: 1790653420,
  }),
  llRow({
    BookID: 'bkMissing008',
    NZBtitle: 'Author Eight - Book Eight MP3',
    DownloadID: 'nzo-missing-0008',
    Status: 'Processed',
    DLResult: `${AUDIO}/Author Eight/Book Eight/01. Author Eight - Book Eight.mp3`,
    Completed: 1790653420,
  }),
  llRow({
    BookID: 'bkSwept0009',
    NZBtitle: 'Author Nine - Book Nine',
    DownloadID: 'nzo-swept-0009',
    AuxInfo: 'eBook',
    Status: 'Processed',
    DLResult: `${EBOOK}/Author Nine/Book Nine/Book Nine - Author Nine.epub`,
    Completed: 1790653420,
  }),
  // An old Processed job whose folder was deleted by hand; a later job (the strand above) reused the folder name, so
  // SABnzbd's archive now points this job at the strand's folder. It must never read as a leftover.
  llRow({
    BookID: 'bkReuse00015',
    NZBtitle: 'Author One - Book One (2014) MP3',
    DownloadID: 'nzo-reuse-0015',
    Status: 'Processed',
    DLResult: `${AUDIO}/Author Seven/Book Seven/Author Seven - Book Seven - 01 of 16.mp3`,
    Completed: 1780000000,
  }),
  // A failed download whose folder SABnzbd left behind (Q-06: reported, never deleted).
  llRow({
    BookID: 'bkFailDir010',
    NZBtitle: 'Author Ten - Book Ten',
    DownloadID: 'nzo-faildir-0010',
    Status: 'Failed',
    DLResult: 'Unpacking failed, see logfile',
  }),
  // A seeding MAM torrent (processed, never the janitor's).
  llRow({
    BookID: 'bkSeed00011',
    NZBtitle: 'Book Eleven',
    NZBprov: `${PROWLARR}/17/api`,
    NZBmode: 'torznab',
    Source: 'QBITTORRENT',
    DownloadID: '0000000000000000000000000000000000000011',
    AuxInfo: 'eBook',
    Status: 'Seeding',
    DLResult: `${EBOOK}/Author Eleven/Book Eleven/Book Eleven - Author Eleven.epub`,
  }),
  // A fail loop: 7 failed grabs of one eBook, still Wanted (the live worst had 173).
  ...failed('bkLoop00012', 'eBook', 3, 'Duplicate NZB'),
  ...failed(
    'bkLoop00012',
    'eBook',
    3,
    `Failed to send nzb to @ <a href="${PROWLARR}/14/api?t=get&id=0&apikey=FAKEKEY">SABNZBD</a>`,
    'bkLoop00012b',
  ),
  ...failed(
    'bkLoop00012',
    'eBook',
    1,
    `Unable to locate a valid filetype (ebook) in ${DL}/Author Loop - Expanse 04 Book Loop (2014) MP3, leaving for manual processing`,
    'bkLoop00012c',
  ),
  // 5 failed grabs of an audiobook LazyLibrarian now has (Open): not a loop any more.
  ...failed('bkOpen00013', 'AudioBook', 5, 'Aborted, cannot be completed - https://sabnzbd.org/not-complete'),
  // 4 failed grabs, still Wanted: under the threshold.
  ...failed('bkUnder0014', 'AudioBook', 4, 'Duplicate NZB'),
  // LazyLibrarian's synthetic failure row (no BookID): dropped by the read client.
  llRow({
    Status: 'Failed',
    AuxInfo: null,
    Source: null,
    NZBprov: null,
    NZBurl: null,
    NZBmode: null,
    NZBsize: null,
    Label: null,
    DLResult: `Unable to locate a valid filetype (ebook) in ${DL}/Author Loop - Expanse 04 Book Loop (2014) MP3, leaving for manual processing`,
  }),
];

/** LazyLibrarian `cmd=getAllBooks` (the fields the janitor reads). */
export const LL_BOOKS_SAMPLE: Array<Record<string, unknown>> = [
  { BookID: 'bkLoop00012', BookName: 'Book Loop', Status: 'Wanted', AudioStatus: 'Skipped', BookLibrary: null, AudioLibrary: null },
  { BookID: 'bkOpen00013', BookName: 'Book Open', Status: 'Skipped', AudioStatus: 'Open', BookLibrary: null, AudioLibrary: '2026-09-01 10:00:00' },
  { BookID: 'bkUnder0014', BookName: 'Book Under', Status: 'Skipped', AudioStatus: 'Wanted', BookLibrary: null, AudioLibrary: null },
];

/** A SABnzbd history slot (the fields the janitor reads, as SABnzbd 5.1.3 serves them) and which view holds it. */
export interface SabSlotSample {
  slot: Record<string, unknown>;
  archive: boolean;
}

const sabSlot = (o: Record<string, unknown>): Record<string, unknown> => ({
  category: 'lazylibrarian',
  fail_message: '',
  completed: 1790650000,
  bytes: 118768508,
  url: `${PROWLARR}/14/api?t=get&id=0&apikey=FAKEKEY`,
  ...o,
});

/** SABnzbd history, both views (the live history is nearly empty: LazyLibrarian deletes, SABnzbd archives). */
export const SAB_HISTORY_SAMPLE: SabSlotSample[] = [
  { archive: false, slot: sabSlot({ nzo_id: 'nzo-strand-0001', name: 'Author One - Book One (2014) MP3', status: 'Completed', storage: `${DL}/Author One - Book One (2014) MP3` }) },
  {
    archive: false,
    slot: sabSlot({
      nzo_id: 'nzo-failed-0002',
      name: 'Author Two - Book Two (Retail)',
      status: 'Failed',
      fail_message: 'Repair failed, not enough repair blocks (1175 short)',
      storage: `${DL}/_FAILED_Author Two - Book Two (Retail)`,
    }),
  },
  { archive: true, slot: sabSlot({ nzo_id: 'nzo-reuse-0015', name: 'Author One - Book One (2014) MP3', status: 'Completed', completed: 1780000000, storage: `${DL}/Author One - Book One (2014) MP3` }) },
  { archive: true, slot: sabSlot({ nzo_id: 'nzo-left-0007', name: 'Author Seven - Book Seven (2014) MP3', status: 'Completed', storage: `${DL}/Author Seven - Book Seven (2014) MP3` }) },
  { archive: true, slot: sabSlot({ nzo_id: 'nzo-missing-0008', name: 'Author Eight - Book Eight MP3', status: 'Completed', storage: `${DL}/Author Eight - Book Eight MP3` }) },
  { archive: true, slot: sabSlot({ nzo_id: 'nzo-swept-0009', name: 'Author Nine - Book Nine', status: 'Completed', storage: `${DL}/Author Nine - Book Nine` }) },
  { archive: true, slot: sabSlot({ nzo_id: 'nzo-faildir-0010', name: 'Author Ten - Book Ten', status: 'Completed', storage: `${DL}/Author Ten - Book Ten` }) },
];

/** SABnzbd `mode=queue` (the fields the janitor reads). */
export const SAB_QUEUE_SAMPLE = {
  queue: {
    slots: [
      { nzo_id: 'nzo-flight-0003', filename: 'Author Three - Book Three', percentage: '42', status: 'Downloading', cat: 'lazylibrarian' },
    ],
  },
};

/** The folders on disk in the LazyLibrarian download folder (the leftover census's one directory read). */
export const DOWNLOAD_FOLDERS_SAMPLE = [
  'Author One - Book One (2014) MP3',
  'Author Seven - Book Seven (2014) MP3',
  'Author Eight - Book Eight MP3',
  'Author Ten - Book Ten',
];

/** The library files on disk (Book Eight's recorded destination is gone: the 79-row shape of 2026-09-29). */
export const LIBRARY_FILES_SAMPLE = [
  `${AUDIO}/Author Seven/Book Seven/Author Seven - Book Seven - 01 of 16.mp3`,
  `${EBOOK}/Author Nine/Book Nine/Book Nine - Author Nine.epub`,
];

/** Kapowarr `GET /api/activity/queue` (enveloped). A `failed` entry that stays is stuck; the rest are in flight. */
export const KAPOWARR_QUEUE_SAMPLE = {
  error: null,
  result: [
    {
      id: 7,
      volume_id: 1,
      issue_id: null,
      web_link: 'https://getcomics.org/other-comics/comic-one-1-6-color-edition/',
      web_title: 'Comic One #1 – 6 (Color Edition)',
      title: 'Comic One (2004) Volume 01 Issue 001 - 006',
      source: 'GetComics',
      status: 'failed',
      progress: 100,
      size: 104857600,
    },
    {
      id: 8,
      volume_id: 2,
      issue_id: 31,
      web_title: 'Comic Two #3',
      title: 'Comic Two (2019) Issue 003',
      source: 'GetComics',
      status: 'downloading',
      progress: 12.5,
    },
  ],
};
