# Issue #795 (2026-10-06): the Books Census's first live run lists 23 LazyLibrarian book files that are another book
# (wrong_file), plus the Catwings audiobook's stale pointer (missing_file). Fixed under the cross-volume repair rules (the
# #781 pattern, fix_781.py / fix_census_divergent.py); owner ruling 2026-10-06 "Yes, re-download all of them" for the
# records with no right copy anywhere. Run INSIDE the LazyLibrarian pod:
#   kubectl exec -i -n downloads deploy/lazylibrarian -c app -- python3 - < .agents/context/ll-library-audit/fix_census_795.py        # dry run
#   kubectl exec -i -n downloads deploy/lazylibrarian -c app -- python3 - --go < .agents/context/ll-library-audit/fix_census_795.py   # apply
# Content read first (2026-10-06 23:00-23:55Z, read-only): epub OPF dc:title + identifiers (zipfile), mobi/azw3 EXTH titles,
# audio tags and durations (ffprobe in the Audiobookshelf pod), md5s, LazyLibrarian's books/wanted tables (mode=ro),
# Audiobookshelf's database (read-only: no listening progress on any item touched here).
#
# Rule used for every wrong file: a book whose folder names it correctly (Outlander/ holds Outlander) stays where it is and
# only the LazyLibrarian opf naming the wrong record is held (the library scan reads that opf before the file, the Divergent
# precedent); a misfiled copy of a book held elsewhere is held `duplicate`; a misfiled only copy is re-homed under its own
# title (the #782 precedent). Nothing is deleted.
#
# Re-point (the right book is already on disk), 14 records:
#   ENRSDwAAQBAJ Nightflyers & Other Stories  -> its own folder's epub (OPF "Nightflyers & Other Stories", ISBN 9781250303844)
#   laM7DwAAQBAJ Wild Cards I                  -> Wild Cards I/ (OPF "Wild Cards 01 - Wild Cards I", ISBN 978-1-4299-2645-4)
#   H7XlVlTPqsIC A Crown of Swords (audio)     -> the 1996 unabridged m4b (album "[Wheel of Time, Book 7] A Crown of Swords",
#                                                 30.4 h, 45 chapters). The folder held SEVEN copies in one Audiobookshelf item
#                                                 (178 files, 241 h): the linked 43-track set is Winter's Heart (album tag,
#                                                 29.1 h; Winter's Heart 4W5RQY_MiMEC has its own copy) and five more A Crown
#                                                 of Swords copies (an identical m4b, a second m4b, 42-, 44- and 44-track mp3
#                                                 sets, two loose parts). All but the kept m4b are held `duplicate`.
#   i2fHDwAAQBAJ City of Illusions             -> the folder's azw3 (EXTH "City of Illusions", ISBN 9780060125691 = the
#                                                 record's); the epub is the omnibus Worlds of Exile and Illusion (held
#                                                 `duplicate`: Ruh5DQAAQBAJ has its own copy). The EPUB converter makes an epub.
#   Obm7DmrDsroC The Tempest Tales             -> the right epub, copied from grab 2056's seeding torrent (OPF "The Tempest
#                                                 Tales"); the folder's epub + mobi are The Further Tales of Tempest Landry,
#                                                 re-homed under that title and linked to its record HXHWBQAAQBAJ (eBook was
#                                                 Skipped with no file: now Open; nothing searched).
#   wzxmQgAACAAJ The Science of Discworld II   -> The Science Of Discworld II - The Globe/ (OPF "The Science of Discworld II")
#   IMlH63ZPShAC A Plague of Zombies           -> A Plague of Zombies/ (OPF, ISBN 978-0-345-54646-3)
#   opCLDQAAQBAJ, zTCLswEACAAJ How We Learn    -> Benedict Carey/How We Learn/ (OPF "How We Learn"; twin records, one file)
#   qKuOEAAAQBAJ Tales of the Unexpected       -> Tales of the Unexpected/ (OPF, ISBN 978-0-14-192901-9)
#   lSybHLQbZ_kC Distinctions (eBook)          -> Distinctions - Prologue to Towers of Midnight/ (OPF "Prologue to Towers of
#                                                 Midnight", ISBN 9781429957892 = the record's)
#   23fZCwAAQBAJ Anne of Green Gables          -> Anne of Green Gables - Collection/ (OPF "Anne of Green Gables", 343 kB, the
#                                                 twin record n1_9201PkZoC's file); the old file is Anne of Windy Poplars, md5
#                                                 equal to Anne of Windy Poplars/'s copy: held `duplicate`.
#   W4ZDugEACAAJ Magnus Chase 3                -> The Ship of the Dead/ (OPF, the twin 1BeXtAEACAAJ's file). The Hammer of Thor
#                                                 epub it held is linked to A-ZVAQAACAAJ "Magnus Chase and the Hammer of Thor",
#                                                 which was Wanted with no file (now Open; nothing searched).
#   VKBoDwAAQBAJ The Expanse Origins #3        -> The Expanse Origins #3/ (OPF "The Expanse Origins #3 (of 4)"); #1, #2 and #4
#                                                 each carried an opf naming #3: held.
# Re-want (no right copy anywhere: library, Kavita, Audiobookshelf, seeding torrents, completed usenet), 4 records. The
# pointer is blanked, the record queued (queueBook: Wanted, LazyLibrarian's normal backlog search does the rest), and the
# release that delivered the wrong book is blocked with a Failed wanted row (the #755 pattern) where there is one:
#   wDYhEAAAQBAJ Freed (eBook): the file is Fifty Shades Freed (grab 94, three copies of it now); held `duplicate`.
#   OwTswUGVzVcC Warriors 3 (eBook): the file is Warriors (vol. 1) in Warriors 1/, which stays; its opf is held. No grab row.
#   VNalCwAAQBAJ Partners (audio): the 102 tracks are Sparring Partners (tags, 10.0 h; grab 9567). Re-homed to Sparring
#                Partners/, where Audiobookshelf's item already lists exactly these 102 chapters (no LL record for it); the
#                folder's one leftover 14 s introduction track of a 2023 release is held.
#   uaBUIGS551cC Redwall (audio): the m4b is Eulalia! (tags, 12.6 h) in Eulalia!/, which stays; its Redwall.opf is held.
#                Redwall - Book One - The Wall/ is not Redwall either: 11 tracks of The Sable Queen (album "Redwall - 21",
#                13.5 h) that Audiobookshelf shows as "Redwall"; re-homed to The Sable Queen/ with its Audiobookshelf
#                metadata.json title corrected (original held). No grab row for Redwall's audiobook.
# Census Holds instead (the file holds the record's book; .agents/books-census-holds.yaml): Sweet and Deadly, Roald Dahl's
# Dirty Beasts (audio; its folder also carried the 15 tracks twice, md5-identical: the second set is held `duplicate`),
# Wilderness (audio), Dean Koontz, Distinctions (audio), and the foreign_held Game of Thrones (audio: English).
# missing_file QGPZEAAAQBAJ Wonderful Alexander and the Catwings (audio): no audio exists anywhere (the two grabs were PDFs);
# the pointer is cleared the way LazyLibrarian shows a book it does not hold and does not want (AudioFile NULL,
# AudioStatus Skipped). Nothing searched.
# Undo: move each manifest dst back to src (rehome: dst -> src), delete the copied Tempest Tales epub, drop the sort rows and
# the block rows, restore the printed old pointers (or the backup with LazyLibrarian stopped).
import os, re, sys, json, hashlib, time, shutil, sqlite3, zipfile, configparser, urllib.request, urllib.parse

B = '/data/cephfs-hdd/data/media/books/'
HR = 'quarantine/crossvolume-2026-10-05/'
H = B + HR
E, A = 'EBooks/', 'AudioBooks/'
GO = '--go' in sys.argv
TAG = '#795 2026-10-06: '
now = time.strftime('%Y-%m-%d %H:%M:%S', time.gmtime())
ts = lambda: time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
GRRM, RJ, MOS = E + 'George R.R. Martin/', A + 'Robert Jordan/A Crown of Swords/', E + 'Walter Mosley/'
ACOS_KEEP = RJ + '1996 - A Crown of Swords Wheel of Time, Book 7 (Unabridged).m4b'
TEMPEST = MOS + 'The Tempest Tales/The Tempest Tales - Walter Mosley'
FURTHER = MOS + 'The Further Tales of Tempest Landry/The Further Tales of Tempest Landry - Walter Mosley'
TORRENT = '/data/cephfs-hdd/torrents/books/books-mam/Walter Mosley - The Tempest Tales/Walter Mosley - The Tempest Tales.epub'
TORRENT_SIZE = 154299
HOT = E + 'Rick Riordan/The Hammer of Thor/Rick Riordan - The Hammer of Thor'
PARTNERS, SPARRING = A + 'John Grisham/Partners/', A + 'John Grisham/Sparring Partners/'
SABLE_OLD, SABLE_NEW = A + 'Brian Jacques/Redwall - Book One - The Wall/', A + 'Brian Jacques/The Sable Queen/'
DIRTY = A + 'Roald Dahl/Roald Dahls Dirty Beasts/'

# (record, column, old path or None, new path or None, extra SQL set, expected old Status-column value)
REPOINT = [
    ('ENRSDwAAQBAJ', 'BookFile', GRRM + 'Nightflyers - The Illustrated Edition/George R.R. Martin - Nightflyers - The Illustrated Edition.epub',
     GRRM + 'Nightflyers & Other Stories/Nightflyers & Other Stories - George R.R. Martin.epub'),
    ('laM7DwAAQBAJ', 'BookFile', GRRM + 'Wild Cards IV - Aces Abroad/George R.R. Martin - Wild Cards IV - Aces Abroad.epub',
     GRRM + 'Wild Cards I/Wild Cards I - George R.R. Martin.epub'),
    ('H7XlVlTPqsIC', 'AudioFile', RJ + 'A Crown of Swords 01.mp3', ACOS_KEEP),
    ('i2fHDwAAQBAJ', 'BookFile', E + 'Ursula K. Le Guin/City of Illusions/City of Illusions - Ursula K. Le Guin.epub',
     E + 'Ursula K. Le Guin/City of Illusions/City of Illusions - Ursula K. Le Guin.azw3'),
    ('wzxmQgAACAAJ', 'BookFile', E + "Terry Pratchett/The Science of Discworld III - Darwin's Watch/Terry Pratchett - The Science of Discworld III - Darwin's Watch.epub",
     E + 'Terry Pratchett/The Science Of Discworld II - The Globe/Terry Pratchett - The Science Of Discworld II - The Globe.epub'),
    ('IMlH63ZPShAC', 'BookFile', E + 'Diana Gabaldon/Outlander/Diana Gabaldon - Outlander.epub',
     E + 'Diana Gabaldon/A Plague of Zombies/Diana Gabaldon - A Plague of Zombies.epub'),
    ('opCLDQAAQBAJ', 'BookFile', E + 'Dean Koontz/Innocence - A Novel/Dean Koontz - Innocence - A Novel.epub',
     E + 'Benedict Carey/How We Learn/How We Learn - Benedict Carey.epub'),
    ('zTCLswEACAAJ', 'BookFile', E + 'Dean Koontz/Innocence - A Novel/Dean Koontz - Innocence - A Novel.epub',
     E + 'Benedict Carey/How We Learn/How We Learn - Benedict Carey.epub'),
    ('qKuOEAAAQBAJ', 'BookFile', E + 'Roald Dahl/More Tales of the Unexpected/Roald Dahl - More Tales of the Unexpected.epub',
     E + 'Roald Dahl/Tales of the Unexpected/Roald Dahl - Tales of the Unexpected.epub'),
    ('lSybHLQbZ_kC', 'BookFile', E + 'Robert Jordan/Towers of Midnight/Robert Jordan - Towers of Midnight.epub',
     E + 'Robert Jordan/Distinctions - Prologue to Towers of Midnight/Robert Jordan - Distinctions - Prologue to Towers of Midnight.epub'),
    ('23fZCwAAQBAJ', 'BookFile', E + 'L.M. Montgomery/Anne of Green Gables/Anne of Green Gables - L.M. Montgomery.epub',
     E + 'L.M. Montgomery/Anne of Green Gables - Collection/L.M. Montgomery - Anne of Green Gables - Collection.epub'),
    ('W4ZDugEACAAJ', 'BookFile', HOT + '.epub', E + 'Rick Riordan/The Ship of the Dead/Rick Riordan - The Ship of the Dead.epub'),
    ('VKBoDwAAQBAJ', 'BookFile', E + 'James S.A. Corey/The Expanse Origins #2/James S.A. Corey - The Expanse Origins #2.epub',
     E + 'James S.A. Corey/The Expanse Origins #3/James S.A. Corey - The Expanse Origins #3.epub'),
]
# The Tempest Tales keeps its path; the file under it changes (checked by md5 after the copy).
LINK = [  # records with no file that get the right book already on disk: (record, Status before, new path)
    ('A-ZVAQAACAAJ', 'Wanted', HOT + '.epub'),
    ('HXHWBQAAQBAJ', 'Skipped', FURTHER + '.epub'),
]
REWANT = [  # (record, column, old path, LL type, block wanted rowid or None)
    ('wDYhEAAAQBAJ', 'BookFile', E + 'E.L. James/Freed/Freed - E.L. James.epub', 'eBook', 94),
    ('OwTswUGVzVcC', 'BookFile', GRRM + 'Warriors 1/George R.R. Martin - Warriors 1.epub', 'eBook', None),
    ('VNalCwAAQBAJ', 'AudioFile', PARTNERS + 'John Grisham - Partners Part 001 of 102.mp3', 'AudioBook', 9567),
    ('uaBUIGS551cC', 'AudioFile', A + 'Brian Jacques/Eulalia!/Brian Jacques - Eulalia!.m4b', 'AudioBook', None),
]
CATWINGS = ('QGPZEAAAQBAJ', A + 'Ursula K. Le Guin/Wonderful Alexander and the Catwings/Ursula K. Le Guin - Wonderful Alexander and the Catwings Part 1 of 5.mp3')

OPF = 'off_catalog'
HOLD = [  # (path, category, record, evidence, counterparts)
    (E + 'E.L. James/Freed/Freed - E.L. James.epub', 'duplicate', 'wDYhEAAAQBAJ',
     'Fifty Shades Freed (OPF) filed as Freed (2021), grab 94; Fifty Shades Freed nDDCwAEACAAJ holds two copies; Freed re-wanted',
     [E + 'E.L. James/Fifty Shades Freed']),
    (E + 'E.L. James/Freed/Freed - E.L. James.opf', OPF, 'wDYhEAAAQBAJ', 'LL opf beside the held Fifty Shades Freed copy', []),
    (E + 'E.L. James/Freed/Freed - E.L. James.jpg', OPF, 'wDYhEAAAQBAJ', 'cover sidecar beside the held Fifty Shades Freed copy', []),
    (GRRM + 'Nightflyers - The Illustrated Edition/George R.R. Martin - Nightflyers - The Illustrated Edition.opf', OPF, 'ENRSDwAAQBAJ',
     'LL opf naming ENRSDwAAQBAJ beside Nightflyers: The Illustrated Edition (the novella; stays, no LL record)', []),
    (GRRM + 'Wild Cards IV - Aces Abroad/George R.R. Martin - Wild Cards IV - Aces Abroad.epub', 'duplicate', 'laM7DwAAQBAJ',
     'Wild Cards IV: Aces Abroad (OPF) linked as Wild Cards I; Aces Abroad DHiItwAACAAJ holds its own copy',
     [GRRM + 'Aces Abroad']),
    (GRRM + 'Wild Cards IV - Aces Abroad/George R.R. Martin - Wild Cards IV - Aces Abroad.opf', OPF, 'laM7DwAAQBAJ',
     'LL opf naming laM7DwAAQBAJ beside the held Aces Abroad copy', []),
    (GRRM + 'Wild Cards 1/George R.R. Martin - Wild Cards 1.epub', 'duplicate', 'laM7DwAAQBAJ',
     'Wild Cards V: Down & Dirty (OPF) filed as Wild Cards 1 with an opf naming Wild Cards I; Down & Dirty AApXQwAACAAJ holds its own copy',
     [GRRM + 'Down & Dirty']),
    (GRRM + 'Wild Cards 1/George R.R. Martin - Wild Cards 1.opf', OPF, 'laM7DwAAQBAJ',
     'LL opf naming laM7DwAAQBAJ beside the held Down & Dirty copy', []),
    (E + 'Ursula K. Le Guin/City of Illusions/City of Illusions - Ursula K. Le Guin.epub', 'duplicate', 'i2fHDwAAQBAJ',
     'the omnibus Worlds of Exile and Illusion (OPF) in City of Illusions/; Ruh5DQAAQBAJ holds the omnibus; the folder\'s azw3 '
     'is City of Illusions, now the record\'s file', [E + 'Ursula K. Le Guin/Worlds of Exile and Illusion']),
    (E + "Terry Pratchett/The Science of Discworld III - Darwin's Watch/Terry Pratchett - The Science of Discworld III - Darwin's Watch.opf",
     OPF, 'wzxmQgAACAAJ', 'LL opf naming wzxmQgAACAAJ (II) beside The Science of Discworld III (stays, no LL record)', []),
    (E + 'Diana Gabaldon/Outlander/Diana Gabaldon - Outlander.opf', OPF, 'IMlH63ZPShAC',
     'LL opf naming IMlH63ZPShAC (A Plague of Zombies) beside Outlander (stays)', []),
    (E + 'Dean Koontz/Innocence - A Novel/Dean Koontz - Innocence - A Novel.opf', OPF, 'zTCLswEACAAJ',
     'LL opf naming zTCLswEACAAJ (How We Learn) beside Innocence (stays)', []),
    (GRRM + 'Warriors 1/George R.R. Martin - Warriors 1.opf', OPF, 'OwTswUGVzVcC',
     'LL opf naming OwTswUGVzVcC (Warriors 3) beside Warriors, vol. 1 (stays); Warriors 3 re-wanted', []),
    (E + 'Roald Dahl/More Tales of the Unexpected/Roald Dahl - More Tales of the Unexpected.opf', OPF, 'qKuOEAAAQBAJ',
     'LL opf naming qKuOEAAAQBAJ (Tales of the Unexpected) beside More Tales of the Unexpected (stays)', []),
    (E + 'Robert Jordan/Towers of Midnight/Robert Jordan - Towers of Midnight.opf', OPF, 'lSybHLQbZ_kC',
     'LL opf naming lSybHLQbZ_kC (Distinctions) beside Towers of Midnight (stays)', []),
    (E + 'L.M. Montgomery/Anne of Green Gables/Anne of Green Gables - L.M. Montgomery.epub', 'duplicate', '23fZCwAAQBAJ',
     'Anne of Windy Poplars (OPF), md5 = Anne of Windy Poplars/\'s copy, filed as Anne of Green Gables (grab 9538)',
     [E + 'L.M. Montgomery/Anne of Windy Poplars']),
    (E + 'L.M. Montgomery/Anne of Green Gables/Anne of Green Gables - L.M. Montgomery.opf', OPF, '23fZCwAAQBAJ',
     'LL opf beside the held Anne of Windy Poplars copy', []),
    (E + 'L.M. Montgomery/Anne of Green Gables/Anne of Green Gables - L.M. Montgomery.jpg', OPF, '23fZCwAAQBAJ',
     'cover sidecar beside the held Anne of Windy Poplars copy', []),
    (HOT + '.opf', OPF, 'W4ZDugEACAAJ', 'LL opf naming W4ZDugEACAAJ (Ship of the Dead) beside The Hammer of Thor, now A-ZVAQAACAAJ\'s file', []),
    (E + 'James S.A. Corey/The Expanse Origins #2/James S.A. Corey - The Expanse Origins #2.opf', OPF, 'VKBoDwAAQBAJ',
     'LL opf naming VKBoDwAAQBAJ (#3) beside The Expanse Origins #2 (stays)', []),
    (E + 'James S.A. Corey/The Expanse Origins - Amos Burton/James S.A. Corey - The Expanse Origins - Amos Burton.opf', OPF, 'VKBoDwAAQBAJ',
     'LL opf naming VKBoDwAAQBAJ (#3) beside The Expanse Origins #4 (stays)', []),
    (E + 'James S.A. Corey/The Expanse Origins - James Holden/James S.A. Corey - The Expanse Origins - James Holden.opf', OPF, 'VKBoDwAAQBAJ',
     'LL opf naming VKBoDwAAQBAJ (#3) beside The Expanse Origins #1 (stays)', []),
    (A + 'Brian Jacques/Eulalia!/Redwall.opf', OPF, 'uaBUIGS551cC', 'LL opf naming uaBUIGS551cC (Redwall) beside Eulalia! (stays)', []),
    (SPARRING + 'John Grisham - Sparring Partners (1).mp3', OPF, '', 'a 14 s introduction track of another Sparring Partners '
     'release (album "JB 03.5 - Sparring Partners", 2023), the only audio left in Sparring Partners/ before the re-home', []),
    (PARTNERS + 'playlist.ll', OPF, 'VNalCwAAQBAJ', 'LL playlist of the Sparring Partners tracks re-homed out of Partners/', []),
    (SABLE_OLD + 'metadata.json', OPF, '', 'Audiobookshelf metadata titling The Sable Queen "Redwall"; a corrected copy is written '
     'beside the re-homed tracks', []),
    (RJ + 'metadata.json', OPF, 'H7XlVlTPqsIC', 'Audiobookshelf metadata of the 178-file item (seven copies); rebuilt by its scan', []),
    (RJ + 'playlist.ll', OPF, 'H7XlVlTPqsIC', 'LL playlist of the held Winter\'s Heart tracks', []),
]
acos = sorted(os.listdir(B + RJ))
WH = [f for f in acos if re.fullmatch(r'A Crown of Swords \d+\.mp3', f)]
ACOS_DUP = [f for f in acos if re.fullmatch(r'A Crown of Swords - \d+ of 42\.mp3|Robert Jordan - A Crown of Swords Part \d+ of 44\.mp3|'
                                             r'Robert Jordan - WOT7 A Crown of Swords - \d+ of 44\.mp3|'
                                             r'The Wheel of Time - Book 7 - A Crown of Swords, Part \d\.mp3', f)] + \
    ['Robert Jordan - A Crown of Swords.m4b', 'The Wheel of Time Book 7 - A Crown of Swords.m4b']
for f in WH:
    HOLD.append((RJ + f, 'duplicate', 'H7XlVlTPqsIC', 'Winter\'s Heart track (album tag "Winter\'s Heart"; 43 tracks, 29.1 h) linked as A '
                 'Crown of Swords; Winter\'s Heart 4W5RQY_MiMEC holds its own copy', [A + 'Robert Jordan/Winters Heart']))
for f in ACOS_DUP:
    HOLD.append((RJ + f, 'duplicate', 'H7XlVlTPqsIC', 'one of five extra A Crown of Swords copies in one Audiobookshelf item; the '
                 'record keeps the 1996 unabridged m4b (30.4 h, 45 chapters)', [ACOS_KEEP]))
dirty = sorted(os.listdir(B + DIRTY))
DIRTY_DUP = [f for f in dirty if re.fullmatch(r'\d\d Roald Dahl - Revolting Rhymes and Dirty Beasts\.mp3', f)]
for f in DIRTY_DUP:
    HOLD.append((DIRTY + f, 'duplicate', 'GCD3PwAACAAJ', 'second, md5-identical set of the 15 Revolting Rhymes and Dirty Beasts tracks '
                 'in one Audiobookshelf item; the LL-named Part NN of 15 set stays', [DIRTY]))
REHOME = [  # (src, dst, record, reason)
    (TEMPEST + '.epub', FURTHER + '.epub', 'HXHWBQAAQBAJ', 'The Further Tales of Tempest Landry (OPF, ISBN 9781101910887; grab 2680) '
     'filed as The Tempest Tales; its only library copy, linked to HXHWBQAAQBAJ'),
    (TEMPEST + '.mobi', FURTHER + '.mobi', 'HXHWBQAAQBAJ', 'The Further Tales of Tempest Landry (mobi EXTH title) filed as The Tempest Tales'),
]
for f in sorted(os.listdir(B + PARTNERS)):
    m = re.fullmatch(r'John Grisham - Partners Part (\d+) of 102\.mp3', f)
    if m:
        REHOME.append((PARTNERS + f, SPARRING + 'John Grisham - Sparring Partners Part %s of 102.mp3' % m.group(1), '',
                       'Sparring Partners (tags, 102 tracks, 10.0 h; grab 9567) filed as Partners; its only copy; Audiobookshelf\'s '
                       'Sparring Partners item lists these 102 chapters'))
for f in sorted(os.listdir(B + SABLE_OLD)):
    m = re.fullmatch(r'Brian Jacques - Redwall - Book One - The Wall \((\d+)\)\.mp3', f)
    if m:
        REHOME.append((SABLE_OLD + f, SABLE_NEW + 'Brian Jacques - The Sable Queen (%s).mp3' % m.group(1), '',
                       'The Sable Queen (album "Redwall - 21", title "The Sable Queen", 11 tracks, 13.5 h) in a folder named Redwall'))
REHOME.append((SABLE_OLD + 'cover.jpg', SABLE_NEW + 'cover.jpg', '', 'cover beside the re-homed Sable Queen tracks'))
RMDIR = [E + 'E.L. James/Freed', GRRM + 'Wild Cards IV - Aces Abroad', GRRM + 'Wild Cards 1', E + 'L.M. Montgomery/Anne of Green Gables',
         SABLE_OLD.rstrip('/')]
NEWDIRS = [MOS + 'The Further Tales of Tempest Landry', SABLE_NEW.rstrip('/')]


def md5(p):
    h = hashlib.md5()
    with open(p, 'rb') as fh:
        for b in iter(lambda: fh.read(1 << 22), b''): h.update(b)
    return h.hexdigest()


def opf_title(p):
    z = zipfile.ZipFile(p)
    o = re.search(r'full-path="([^"]+)"', z.read('META-INF/container.xml').decode('utf8', 'replace')).group(1)
    return '|'.join(re.findall(r'<dc:title[^>]*>(.*?)</dc:title>', z.read(o).decode('utf8', 'replace'), re.S))


db = sqlite3.connect('/config/lazylibrarian.db', timeout=60)
col = lambda i, c: db.execute('select %s from books where BookID=?' % c, (i,)).fetchone()
bad = []
for rec, c, old, new in REPOINT:
    if col(rec, c) != (B + old,): bad.append(('pointer moved', rec, col(rec, c)))
    if not os.path.isfile(B + new): bad.append(('target missing', new))
for rec, st, new in LINK:
    if col(rec, 'Status,BookFile,BookLang') != (st, None, 'en'): bad.append(('link record is', rec, col(rec, 'Status,BookFile,BookLang')))
for rec, c, old, typ, rid in REWANT:
    if col(rec, c) != (B + old,): bad.append(('pointer moved', rec, col(rec, c)))
    if rid and db.execute('select BookID,AuxInfo from wanted where rowid=?', (rid,)).fetchone() != (rec, typ):
        bad.append(('block row is', rid))
if col(CATWINGS[0], 'AudioStatus,AudioFile') != ('Open', B + CATWINGS[1]) or os.path.exists(B + CATWINGS[1]):
    bad.append(('catwings is', col(CATWINGS[0], 'AudioStatus,AudioFile')))
if col('Obm7DmrDsroC', 'BookFile') != (B + TEMPEST + '.epub',): bad.append(('tempest pointer', col('Obm7DmrDsroC', 'BookFile')))
if not os.path.isfile(TORRENT) or os.path.getsize(TORRENT) != TORRENT_SIZE or opf_title(TORRENT) != 'The Tempest Tales':
    bad.append(('torrent epub changed', TORRENT))
for p, *_ in HOLD:
    if not os.path.isfile(B + p): bad.append(('missing', p))
    if os.path.exists(H + p): bad.append(('hold target exists', HR + p))
for s, d, *_ in REHOME:
    if not os.path.isfile(B + s): bad.append(('missing', s))
    if os.path.exists(B + d): bad.append(('rehome target exists', d))
if len(WH) != 43 or len(ACOS_DUP) != 134 or len(DIRTY_DUP) != 15: bad.append(('set sizes', len(WH), len(ACOS_DUP), len(DIRTY_DUP)))
if sum(1 for s, *_ in REHOME if s.startswith(PARTNERS)) != 102 or sum(1 for s, *_ in REHOME if s.startswith(SABLE_OLD)) != 12:
    bad.append(('rehome sizes',))
if set(os.listdir(B + SPARRING)) != {'metadata.json', 'cover.jpg', 'John Grisham - Sparring Partners (1).mp3'}: bad.append(('Sparring Partners/ holds', os.listdir(B + SPARRING)))
for d in NEWDIRS:
    if os.path.exists(B + d): bad.append(('new dir exists', d))
gone = {p for p, *_ in HOLD} | {s for s, *_ in REHOME}
for d in RMDIR:
    left = [f for f in os.listdir(B + d) if d + '/' + f not in gone]
    if left: bad.append(('folder keeps', d, left))
# Counterparts really are the books held as their duplicates.
for p, want in [(GRRM + 'Aces Abroad/Aces Abroad - George R.R. Martin.epub', 'wild cards iv'),
                (GRRM + 'Down & Dirty/Down & Dirty - George R.R. Martin.epub', 'wild cards v'),
                (E + 'L.M. Montgomery/Anne of Windy Poplars/L.M. Montgomery - Anne of Windy Poplars.epub', 'windy poplars')]:
    t = opf_title(B + p) if os.path.isfile(B + p) else 'MISSING'
    print('counterpart', p.replace(E, ''), '->', t)
    if want not in t.lower(): bad.append(('counterpart title', p, t))
if md5(B + E + 'L.M. Montgomery/Anne of Green Gables/Anne of Green Gables - L.M. Montgomery.epub') != \
        md5(B + E + 'L.M. Montgomery/Anne of Windy Poplars/L.M. Montgomery - Anne of Windy Poplars.epub'): bad.append(('windy md5',))
touched = {B + x for r in REPOINT for x in r[2:4]} | {B + p for p, *_ in HOLD} | {B + s for s, *_ in REHOME}
others = [(x[0], x[1].replace(B, '')) for x in db.execute('select BookID,BookFile from books where BookFile is not null union all '
                                                         'select BookID,AudioFile from books where AudioFile is not null')
          if x[1] in touched and x[0] not in {r[0] for r in REPOINT} | {r[0] for r in REWANT} | {'Obm7DmrDsroC'}]
print('other records on touched files:', others)  # expected: the twins' own files only
if any(o[0] not in ('1BeXtAEACAAJ', 'n1_9201PkZoC') for o in others): bad.append(('unexpected refs', others))
print('repoint', len(REPOINT), '| link', len(LINK), '| rewant', len(REWANT), '| hold', len(HOLD), '| rehome', len(REHOME), '| rmdir', len(RMDIR))
if bad:
    for b in bad: print('REFUSE', *b)
    sys.exit('refused: nothing changed')
if not GO: sys.exit('dry run OK; re-run with --go')

bk = '/config/lazylibrarian.db.pre-795-20261006'
assert not os.path.exists(bk)
b2 = sqlite3.connect(bk); db.backup(b2)
ok = b2.execute('pragma integrity_check').fetchone()[0]; b2.close()
assert ok == 'ok', ok
print('backup', bk, 'integrity', ok)


def mkd(d, stop):
    if not os.path.isdir(d):
        os.makedirs(d); x = d
        while x.rstrip('/') != stop.rstrip('/'): os.chown(x, 1000, 1000); x = os.path.dirname(x)


man = open(H + 'manifest.jsonl', 'a'); srt = open(H + 'sort.jsonl', 'a')
for p, cat, rec, ev, cps in HOLD:
    s, d = B + p, H + p; m = md5(s); z = os.path.getsize(s); mkd(os.path.dirname(d), H)
    if p == SABLE_OLD + 'metadata.json':
        meta = json.load(open(s, encoding='utf-8'))
    os.rename(s, d)
    man.write(json.dumps({'op': 'hold', 'src': p, 'dst': HR + p, 'md5': m, 'size': z, 'reason': TAG + ev, 'record': rec,
                          'ts': ts()}, ensure_ascii=False) + '\n')
    srt.write(json.dumps({'path': HR + p, 'size': z, 'md5': m, 'category': cat, 'evidence': ev, 'record': rec,
                          'counterparts': cps}, ensure_ascii=False) + '\n')
for d in NEWDIRS: mkd(B + d, B + d.split('/')[0])
for s, d, rec, why in REHOME:
    m = md5(B + s); z = os.path.getsize(B + s); os.rename(B + s, B + d)
    man.write(json.dumps({'op': 'rehome', 'src': s, 'dst': d, 'md5': m, 'size': z, 'reason': TAG + why, 'record': rec,
                          'ts': ts()}, ensure_ascii=False) + '\n')
meta['title'] = 'The Sable Queen'
mp = B + SABLE_NEW + 'metadata.json'
with open(mp, 'w', encoding='utf-8') as fh: json.dump(meta, fh, indent=2, ensure_ascii=False)
os.chown(mp, 1000, 1000)
man.write(json.dumps({'op': 'write', 'dst': SABLE_NEW + 'metadata.json', 'reason': TAG + 'Audiobookshelf metadata.json of the '
                      're-homed Sable Queen with title "The Sable Queen" (the original, titled Redwall, is held)', 'record': '',
                      'ts': ts()}) + '\n')
tmp = B + MOS + 'The Tempest Tales/.The Tempest Tales - Walter Mosley.epub.795'
shutil.copyfile(TORRENT, tmp); os.chown(tmp, 1000, 1000); os.chmod(tmp, 0o664)
tm = md5(tmp); assert tm == md5(TORRENT)
os.rename(tmp, B + TEMPEST + '.epub')
man.write(json.dumps({'op': 'copy', 'src': TORRENT, 'dst': TEMPEST + '.epub', 'md5': tm, 'size': TORRENT_SIZE,
                      'reason': TAG + 'The Tempest Tales, copied from grab 2056\'s seeding torrent', 'record': 'Obm7DmrDsroC',
                      'ts': ts()}) + '\n')
for d in RMDIR:
    os.rmdir(B + d)
    man.write(json.dumps({'op': 'rmdir', 'src': d, 'reason': TAG + 'emptied folder', 'record': '', 'ts': ts()}) + '\n')
man.close(); srt.close()
dirs = {os.path.dirname(B + p) for p, *_ in HOLD} | {os.path.dirname(B + x) for s, d, *_ in REHOME for x in (s, d)} | \
       {os.path.dirname(B + d) for d in RMDIR} | {B + MOS + 'The Tempest Tales'}
for d in sorted(dirs | {os.path.dirname(d) for d in dirs}, key=len, reverse=True):
    if os.path.isdir(d): os.utime(d, None)  # hdd-nfs-repl does not bump a folder's mtime on rename; Kavita compares it
with db:
    for rec, c, old, new in REPOINT:
        assert db.execute('update books set %s=? where BookID=? and %s=?' % (c, c), (B + new, rec, B + old)).rowcount == 1, rec
    for rec, st, new in LINK:
        assert db.execute("update books set BookFile=?,BookLibrary=?,Status='Open' where BookID=? and BookFile is null and Status=?",
                          (B + new, now, rec, st)).rowcount == 1, rec
    for rec, c, old, typ, rid in REWANT:
        lib = 'BookLibrary' if c == 'BookFile' else 'AudioLibrary'
        assert db.execute('update books set %s=NULL,%s=NULL where BookID=? and %s=?' % (c, lib, c), (rec, B + old)).rowcount == 1, rec
        if rid:
            db.execute("""insert into wanted (BookID,NZBurl,NZBtitle,NZBdate,NZBprov,Status,NZBsize,AuxInfo,NZBmode,Source,DownloadID,
              DLResult,Completed,Label) select BookID,NZBurl,NZBtitle,?,NZBprov,'Failed',NZBsize,AuxInfo,NZBmode,NULL,NULL,?,0,''
              from wanted where rowid=?""", (now, 'Blocked by hand 2026-10-06 (#795): this release delivered another book, held '
                                                 'or re-homed (quarantine/crossvolume-2026-10-05)', rid))
    assert db.execute("update books set AudioFile=NULL,AudioLibrary=NULL,AudioStatus='Skipped' where BookID=? and AudioFile=? "
                      "and AudioStatus='Open'", (CATWINGS[0], B + CATWINGS[1])).rowcount == 1
db.close()
c = configparser.RawConfigParser(); c.read('/config/config.ini'); key = c.get('API', 'api_key')
for rec, col_, old, typ, rid in REWANT:
    u = 'http://localhost:5299/api?' + urllib.parse.urlencode({'apikey': key, 'cmd': 'queueBook', 'id': rec, 'type': typ})
    print('queueBook', rec, typ, urllib.request.urlopen(u, timeout=60).read().decode()[:20])
db = sqlite3.connect('file:/config/lazylibrarian.db?mode=ro', uri=True)
for rec in [r[0] for r in REPOINT] + ['Obm7DmrDsroC'] + [r[0] for r in LINK] + [r[0] for r in REWANT] + [CATWINGS[0]]:
    r = db.execute('select BookID,BookName,Status,AudioStatus,BookFile,AudioFile from books where BookID=?', (rec,)).fetchone()
    print(json.dumps([x.replace(B, '')[:90] if isinstance(x, str) else x for x in r], ensure_ascii=False),
          'files ok' if all(f is None or os.path.isfile(f) for f in r[4:6]) else 'FILE MISSING')
print('block rows', db.execute("select rowid,BookID,AuxInfo from wanted where DLResult like 'Blocked by hand 2026-10-06 (#795)%'").fetchall())
print('max wanted rowid', db.execute('select max(rowid) from wanted').fetchone())
