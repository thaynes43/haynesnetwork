// Issues #781 / #744 (DESIGN-028 amendment 2026-10-06, glossary T-290) — the Held File Check: does the file LazyLibrarian
// holds for a book name that book? Every case is a live shape from the 2026-10-06 audit of Veronica Roth's and Hugh
// Howey's folders (the file's OPF `dc:title`, LazyLibrarian's `BookName` / `BookSub`, the path it stores).
import { describe, expect, it } from 'vitest';
import {
  heldFileNameNamesBook,
  heldFileNameTitles,
  heldFileNamesBook,
  isSeriesDesignation,
  judgeableTitle,
  llTitleText,
  stripTrackMarkers,
} from '../src/ll-book-check';

const roth = (title: string, subtitle: string | null = null) => ({
  title,
  subtitle,
  author: 'Veronica Roth',
});
const howey = (title: string, subtitle: string | null = null) => ({
  title,
  subtitle,
  author: 'Hugh Howey',
});

describe('llTitleText (LazyLibrarian writes a colon as a period)', () => {
  it('reads the period back as a part break', () => {
    expect(llTitleText('Four. The Traitor')).toBe('Four: The Traitor');
    expect(llTitleText('The World of Divergent. The Path to Allegiant')).toBe(
      'The World of Divergent: The Path to Allegiant',
    );
    expect(llTitleText('The Traitor. A Divergent Story')).toBe('The Traitor: A Divergent Story');
  });
  it('keeps an abbreviation and a title with no period', () => {
    expect(llTitleText('Mr. Mercedes')).toBe('Mr. Mercedes');
    expect(llTitleText('Dr. Sleep')).toBe('Dr. Sleep');
    expect(llTitleText('Shift')).toBe('Shift');
  });
  it('a series index before the period, and an article after it', () => {
    expect(llTitleText('Reckoners 1. Steelheart')).toBe('Reckoners 1: Steelheart');
    expect(llTitleText('The Churn. an Expanse Novella (the Expanse)')).toBe(
      'The Churn: an Expanse Novella (the Expanse)',
    );
  });
});

// The first live pass (2026-10-06, 1,550 held files): what it flagged and was right to, and what it must not flag.
describe('heldFileNamesBook: the first live pass', () => {
  const book = (title: string, author: string, subtitle: string | null = null) => ({
    title,
    subtitle,
    author,
  });
  it('flags another volume, another work and a collection', () => {
    expect(heldFileNamesBook("Winter's Heart", book('A Crown of Swords', 'Robert Jordan'))).toBe(
      false,
    );
    expect(
      heldFileNamesBook('Anne of Windy Poplars', book('Anne of Green Gables', 'L. M. Montgomery')),
    ).toBe(false);
    expect(
      heldFileNamesBook(
        'More Tales of the Unexpected',
        book('Tales of the Unexpected', 'Roald Dahl'),
      ),
    ).toBe(false);
    expect(heldFileNamesBook('Fifty Shades Freed', book('Freed', 'E.L. James'))).toBe(false);
    expect(heldFileNamesBook('Warriors', book('Warriors 3', 'Erin Hunter'))).toBe(false);
    expect(
      heldFileNamesBook(
        "The Science of Discworld III: Darwin's Watch",
        book('The Science of Discworld II', 'Terry Pratchett'),
      ),
    ).toBe(false);
    expect(
      heldFileNamesBook(
        'The Expanse Origins #2 (of 4)',
        book('The Expanse Origins #3', 'James S. A. Corey'),
      ),
    ).toBe(false);
    expect(
      heldFileNamesBook(
        'Magnus Chase and the Gods of Asgard, Book 2: The Hammer of Thor',
        book('Magnus Chase and the Gods of Asgard, Book 3 The Ship of the Dead', 'Rick Riordan'),
      ),
    ).toBe(false);
    expect(
      heldFileNamesBook(
        'Outlander',
        book('A Plague of Zombies. An Outlander Novella', 'Diana Gabaldon'),
      ),
    ).toBe(false);
    expect(
      heldFileNamesBook(
        "Worlds of Exile and Illusion: Rocannon's World, Planet of Exile, City of Illusions",
        book('City of Illusions', 'Ursula K. Le Guin'),
      ),
    ).toBe(false);
  });
  it('a record named with its series in front', () => {
    expect(
      heldFileNamesBook(
        'The Golden Compass',
        book('His Dark Materials. The Golden Compass (Book 1)', 'Philip Pullman'),
      ),
    ).toBe(true);
    expect(
      heldFileNamesBook(
        'The Lost Hero',
        book('The Heroes of Olympus, Book One. The Lost Hero', 'Rick Riordan'),
      ),
    ).toBe(true);
    expect(
      heldFileNamesBook(
        'The Sea of Monsters',
        book('Percy Jackson and the Sea of Monsters', 'Rick Riordan'),
        {
          authorTitles: [
            'Percy Jackson and the Sea of Monsters',
            'Percy Jackson and the Olympians',
          ],
        },
      ),
    ).toBe(true);
    expect(heldFileNamesBook('Lowball', book('Wild Cards. Lowball', 'George R.R. Martin'))).toBe(
      true,
    );
    expect(
      heldFileNamesBook(
        'Steelheart (Unabridged)',
        book('Reckoners 1. Steelheart', 'Brandon Sanderson'),
      ),
    ).toBe(true);
    expect(
      heldFileNamesBook(
        'The Churn',
        book('The Churn. an Expanse Novella (the Expanse)', 'James S. A. Corey'),
      ),
    ).toBe(true);
  });
  it('a file title with a series index, a bracket, a spelling or an edition word', () => {
    expect(
      heldFileNamesBook('Expanse 05 Nemesis Games', book('Nemesis Games', 'James S. A. Corey')),
    ).toBe(true);
    expect(
      heldFileNamesBook(
        "[The Expanse 3.0] Abaddon's Gate",
        book("Abaddon's Gate", 'James S. A. Corey'),
      ),
    ).toBe(true);
    expect(
      heldFileNamesBook(
        'SSQ4 The Secrets of Sir Richard Kenworthy',
        book('The Secrets of Sir Richard Kenworthy', 'Julia Quinn'),
      ),
    ).toBe(true);
    expect(
      heldFileNamesBook(
        'The History of Middle-earth Vol-7- The Treason of Isengard J.R.R Tolkien',
        book('The Treason Of Isengard', 'J.R.R. Tolkien'),
      ),
    ).toBe(true);
    expect(
      heldFileNamesBook('The Colour of Magic', book('The Color of Magic', 'Terry Pratchett')),
    ).toBe(true);
    expect(
      heldFileNamesBook(
        'Alcatraz Versus the Evil Librarians',
        book('Alcatraz Vs. the Evil Librarians', 'Brandon Sanderson'),
      ),
    ).toBe(true);
    expect(
      heldFileNamesBook(
        'Brisingr Deluxe Edition (The Inheritance Cycle Book 3)',
        book('Brisingr', 'Christopher Paolini'),
      ),
    ).toBe(true);
    expect(
      heldFileNamesBook(
        'Artificial Condition--The Murderbot Diaries',
        book('Artificial Condition', 'Martha Wells'),
      ),
    ).toBe(true);
    expect(
      heldFileNamesBook(
        'Confessions ofanUglyStepsister',
        book('Confessions of an Ugly Stepsister', 'Gregory Maguire'),
      ),
    ).toBe(true);
    expect(
      heldFileNamesBook(
        'NINE TOMORROWS Tales of the Near Future',
        book('Nine Tomorrows', 'Isaac Asimov'),
      ),
    ).toBe(true);
    expect(
      heldFileNamesBook(
        'Follett, Ken - On Wings of Eagles.txt',
        book('On Wings of Eagles', 'Ken Follett'),
      ),
    ).toBe(true);
  });
  it('a series designation cannot say, unless it names another volume', () => {
    expect(isSeriesDesignation('Redwall - 08')).toBe(true);
    expect(isSeriesDesignation('Throne of Glass bk 5')).toBe(true);
    expect(isSeriesDesignation('Wild Cards VII (Unabridged)')).toBe(true);
    expect(isSeriesDesignation('Disc 01')).toBe(true);
    expect(isSeriesDesignation('Chain of Iron - The Last Hours Series, Book 2')).toBe(false);
    expect(isSeriesDesignation('The Best American Science Fiction and Fantasy 2024')).toBe(false);
    expect(
      heldFileNamesBook('Throne of Glass bk 5', book('Empire of Storms', 'Sarah J. Maas')),
    ).toBeNull();
    expect(
      heldFileNamesBook('Wild Cards IV', book('Aces Abroad', 'George R.R. Martin')),
    ).toBeNull();
    expect(
      heldFileNamesBook(
        'read by Hugh Laurie',
        book('The Giraffe and the Pelly and Me', 'Roald Dahl'),
      ),
    ).toBeNull();
    expect(
      heldFileNamesBook(
        'Chain of Iron - The Last Hours Series, Book 2',
        book('Chain of Iron', 'Cassandra Clare'),
      ),
    ).toBe(true);
  });
  it('track markers', () => {
    expect(stripTrackMarkers('13 Dead Ever After Part 1')).toBe('Dead Ever After');
    expect(stripTrackMarkers('07 Bitter of Tongue')).toBe('Bitter of Tongue');
    expect(stripTrackMarkers('01: High Chasaline')).toBe('High Chasaline');
  });
});

describe('heldFileNamesBook: the wrong files of issue #781', () => {
  it('the four-story collection held as Four: The Traitor', () => {
    expect(
      heldFileNamesBook(
        'Four Divergent Stories: The Transfer, The Initiate, The Son, and The Traitor (Divergent Series)',
        roth('Four. The Traitor'),
      ),
    ).toBe(false);
  });
  it('First Shift: Legacy and Third Shift: Pact held as Shift', () => {
    expect(heldFileNamesBook('First Shift - Legacy', howey('Shift'), { series: 'Wool' })).toBe(
      false,
    );
    expect(
      heldFileNamesBook('Third Shift - Pact (Part 8 of the Silo Series) (Wool)', howey('Shift')),
    ).toBe(false);
    expect(
      heldFileNamesBook('Second Shift - Order (Part 7 of the Silo Series)', howey('Shift')),
    ).toBe(false);
  });
  it('the collection held as Divergent', () => {
    expect(heldFileNamesBook('Four Divergent Stories - Omnibus', roth('Divergent'))).toBe(false);
  });
  it('another part of the same series (the lenient check catches it)', () => {
    expect(
      heldFileNamesBook(
        "Four: The Son (Kindle Single) (Divergent Series-Collector's Edition Book 3)",
        roth('Four. The Traitor'),
      ),
    ).toBe(false);
  });
  it('another work entirely, and a short story filed as a novel', () => {
    expect(heldFileNamesBook('Glitch: A Short Story (Kindle Single)', howey('Shift'))).toBe(false);
    expect(
      heldFileNamesBook('The Best American Science Fiction and Fantasy 2024', howey('Sand')),
    ).toBe(false);
  });
});

describe('heldFileNamesBook: the right files stay quiet', () => {
  it('the repaired books', () => {
    expect(
      heldFileNamesBook(
        'Four: The Traitor (Kindle Single) (Divergent Trilogy Book 4)',
        roth('Four. The Traitor'),
      ),
    ).toBe(true);
    expect(
      heldFileNamesBook(
        'Four: The Traitor (Kindle Single) (Divergent Trilogy Book 4)',
        roth('The Traitor. A Divergent Story'),
      ),
    ).toBe(true);
    expect(heldFileNamesBook('Shift Omnibus Edition (Shift 1-3) (Silo Saga)', howey('Shift'))).toBe(
      true,
    );
  });
  it('a file title with series decoration, a subtitle or an edition note', () => {
    expect(heldFileNamesBook('Insurgent (Divergent)', roth('Insurgent'))).toBe(true);
    expect(
      heldFileNamesBook(
        "Four: The Son (Kindle Single) (Divergent Series-Collector's Edition Book 3)",
        roth('Four. The Son'),
      ),
    ).toBe(true);
    expect(heldFileNamesBook('Beacon 23: The Complete Novel', howey('Beacon 23'))).toBe(true);
    expect(
      heldFileNamesBook(
        'Molly Fyde and the Parsona Rescue (The Bern Saga Book 1)',
        howey('Molly Fyde and the Parsona Rescue'),
      ),
    ).toBe(true);
    expect(heldFileNamesBook('Void (The Far Reaches collection)', roth('Void'))).toBe(true);
  });
  it('a record whose subtitle the file drops or words differently', () => {
    expect(
      heldFileNamesBook(
        'The World of Divergent',
        roth('The World of Divergent. The Path to Allegiant'),
      ),
    ).toBe(true);
    expect(
      heldFileNamesBook(
        'Free Four: Tobias Tells the Story',
        roth('Free Four', 'Tobias Tells the Divergent Knife-Throwing Scene'),
      ),
    ).toBe(true);
    expect(
      heldFileNamesBook('Machine Learning', howey('Machine Learning', 'New and Collected Stories')),
    ).toBe(true);
  });
  it('a series prefix, an author prefix, a leading index', () => {
    expect(
      heldFileNamesBook('Mistborn: The Final Empire', {
        title: 'The Final Empire',
        author: 'Brandon Sanderson',
      }),
    ).toBe(true);
    expect(heldFileNamesBook('Hugh Howey - Shift', howey('Shift'))).toBe(true);
    expect(
      heldFileNamesBook("Expanse 03 - Abaddon's Gate", {
        title: "Abaddon's Gate",
        author: 'James S. A. Corey',
      }),
    ).toBe(true);
  });
  it("the file's own series name is not an extra work", () => {
    expect(
      heldFileNamesBook(
        'Mistborn The Final Empire',
        { title: 'The Final Empire', author: 'Brandon Sanderson' },
        {
          series: 'Mistborn',
        },
      ),
    ).toBe(true);
  });
  it('no title worth judging decides nothing', () => {
    expect(heldFileNamesBook('Unknown', howey('Shift'))).toBeNull();
    expect(heldFileNamesBook('', howey('Shift'))).toBeNull();
    expect(heldFileNamesBook(null, howey('Shift'))).toBeNull();
    expect(heldFileNamesBook('1984', { title: '1984', author: 'George Orwell' })).toBeNull();
    expect(judgeableTitle('Untitled')).toBe(false);
  });
});

// Issue #799: a file whose title is the record's with words cut. The Volume Check read either way round passed any
// such file, so Catwings (book 1) held as "Wonderful Alexander and the Catwings" (book 3) logged nothing. Author titles
// are LazyLibrarian's own for that author (2026-10-07 snapshot).
describe('heldFileNamesBook: a cut title (issue #799)', () => {
  const book = (title: string, author: string) => ({ title, subtitle: null, author });
  const leGuin = ['Wonderful Alexander and the Catwings', 'Worlds of Exile and Illusion', 'Tehanu'];
  const herbert = [
    'Dune (Movie Tie-In)',
    'Dune. Deluxe Hardcover Edition',
    'Dune Messiah',
    'Children of Dune',
  ];
  const martin = ['Wild Cards. Lowball', 'Wild Cards. Fort Freak', 'Wild Cards. High Stakes'];
  const roth4 = ['Four. The Traitor', 'Four. The Son', 'Four. The Transfer', 'Divergent'];
  const riordan = [
    'Percy Jackson and the Sea of Monsters',
    'Percy Jackson and the Olympians. The Lightning Thief Illustrated Edition',
  ];
  const colfer = ['Artemis Fowl (Mass market edition)', 'Artemis Fowl and the Eternity Code'];
  const pullman = [
    'His Dark Materials. The Golden Compass (Book 1)',
    'The Golden Compass Graphic Novel, Volume 1',
    'The Subtle Knife',
  ];
  it('flags an earlier book or the series name cut out of a longer title', () => {
    expect(
      heldFileNamesBook(
        'Catwings',
        book('Wonderful Alexander and the Catwings', 'Ursula K. Le Guin'),
        { authorTitles: leGuin },
      ),
    ).toBe(false);
    expect(
      heldFileNamesBook('Dune', book('Dune Messiah', 'Frank Herbert'), { authorTitles: herbert }),
    ).toBe(false);
    expect(
      heldFileNamesBook('Dune', book('Children of Dune', 'Frank Herbert'), {
        authorTitles: herbert,
      }),
    ).toBe(false);
    expect(
      heldFileNamesBook('Wild Cards', book('Wild Cards. Lowball', 'George R.R. Martin'), {
        authorTitles: martin,
      }),
    ).toBe(false);
    expect(
      heldFileNamesBook('Four', book('Four. The Traitor', 'Veronica Roth'), {
        authorTitles: roth4,
      }),
    ).toBe(false);
    expect(
      heldFileNamesBook(
        'Mistborn',
        book('Mistborn: The Final Empire (Mistborn #1)', 'Brandon Sanderson'),
      ),
    ).toBe(false);
  });
  it('flags one book of a record that names two', () => {
    expect(
      heldFileNamesBook(
        'A Secret Rage',
        book('A Secret Rage and Sweet and Deadly', 'Charlaine Harris'),
      ),
    ).toBe(false);
    expect(
      heldFileNamesBook(
        'Code to Zero',
        book('Code to Zero [and] The Man from St Petersburg', 'Ken Follett'),
      ),
    ).toBe(false);
    expect(heldFileNamesBook('Disciple', book('Merge / Disciple', 'Walter Mosley'))).toBe(false);
    expect(
      heldFileNamesBook(
        "1-The Hitchhiker's Guide To The Galaxy",
        book("The Ultimate Hitchhiker's Guide to the Galaxy", 'Douglas Adams'),
      ),
    ).toBe(false);
  });
  it('a subtitle, an edition note or a collection tail cut off the end', () => {
    expect(
      heldFileNamesBook('Dune', book('Dune. Deluxe Hardcover Edition', 'Frank Herbert'), {
        authorTitles: herbert,
      }),
    ).toBe(true);
    expect(heldFileNamesBook('Dune', book('Dune: Deluxe Edition', 'Frank Herbert'))).toBe(true);
    expect(heldFileNamesBook('Picasso', book('Picasso: A Biography', "Patrick O'Brian"))).toBe(
      true,
    );
    expect(
      heldFileNamesBook(
        'A Plague of Zombies',
        book('A Plague of Zombies. An Outlander Novella', 'Diana Gabaldon'),
      ),
    ).toBe(true);
    expect(heldFileNamesBook('Just Like Heaven', book('Just Like Heaven LP', 'Julia Quinn'))).toBe(
      true,
    );
    expect(
      heldFileNamesBook(
        'Harry Potter and the Prisoner of Azkaban',
        book('Harry Potter and the Prisoner of Azkaban - Hufflepuff Edition', 'J.K. Rowling'),
      ),
    ).toBe(true);
    expect(
      heldFileNamesBook(
        'The Martian Way',
        book('The Martian Way and Other Stories', 'Isaac Asimov'),
      ),
    ).toBe(true);
    expect(
      heldFileNamesBook(
        'The Curious Case of Benjamin Button',
        book(
          'The Curious Case of Benjamin Button and Other Tales of the Jazz Age',
          'F. Scott Fitzgerald',
        ),
      ),
    ).toBe(true);
  });
  it('a series or character name cut off the front', () => {
    expect(
      heldFileNamesBook(
        'The Golden Compass',
        book('His Dark Materials. The Golden Compass (Book 1)', 'Philip Pullman'),
        { authorTitles: pullman },
      ),
    ).toBe(true);
    expect(
      heldFileNamesBook(
        'A Crash of Fate',
        book("Star Wars. Galaxy's Edge A Crash of Fate", 'Zoraida Córdova'),
        { authorTitles: ["Star Wars. Galaxy's Edge Black Spire"] },
      ),
    ).toBe(true);
    expect(
      heldFileNamesBook(
        'Turn of the Cards',
        book('Wild Cards XII. Turn of the Cards', 'George R.R. Martin'),
        { authorTitles: martin },
      ),
    ).toBe(true);
    expect(
      heldFileNamesBook(
        'The Eternity Code',
        book('Artemis Fowl and the Eternity Code', 'Eoin Colfer'),
        { authorTitles: colfer },
      ),
    ).toBe(true);
    expect(
      heldFileNamesBook(
        'The Sea of Monsters',
        book('Percy Jackson and the Sea of Monsters', 'Rick Riordan'),
        { authorTitles: riordan },
      ),
    ).toBe(true);
    expect(
      heldFileNamesBook(
        'Get What They Deserve',
        book('The Fowl Twins Get What They Deserve', 'Eoin Colfer'),
        { series: 'The Fowl Twins' },
      ),
    ).toBe(true);
    expect(
      heldFileNamesBook(
        'Arch-Conspirator',
        book('Sneak Peek for Arch-Conspirator', 'Veronica Roth'),
      ),
    ).toBe(true);
    expect(
      heldFileNamesBook(
        'Where the Crawdads Sing',
        book('ILL/ Where the Crawdads Sing', 'Delia Owens'),
      ),
    ).toBe(true);
  });
  it('without other titles of the author, a cut front is not a series name', () => {
    expect(
      heldFileNamesBook(
        'The Sea of Monsters',
        book('Percy Jackson and the Sea of Monsters', 'Rick Riordan'),
      ),
    ).toBe(false);
  });
  it('one other title that extends the file’s is not a series, nor is a twin record', () => {
    expect(
      heldFileNamesBook(
        'The World of Divergent',
        book('The World of Divergent. The Path to Allegiant', 'Veronica Roth'),
        { authorTitles: ['The World of Divergent. The Path to Allegiant', 'Divergent'] },
      ),
    ).toBe(true);
    expect(
      heldFileNamesBook('Theodore Boone', book('Theodore Boone. Kid Lawyer', 'John Grisham'), {
        authorTitles: ['Theodore Boone', 'Theodore Boone. Kid Lawyer'],
      }),
    ).toBe(true);
  });
  it('a series in front does not vouch for what is cut from the kept part (review of #805)', () => {
    expect(
      heldFileNamesBook('Dune', book('Dune Chronicles. God Emperor of Dune', 'Frank Herbert')),
    ).toBe(false);
    expect(
      heldFileNamesBook(
        'Catwings',
        book('Catwings Tales. Wonderful Alexander and the Catwings', 'Ursula K. Le Guin'),
      ),
    ).toBe(false);
    expect(
      heldFileNamesBook(
        'A Crash of Fate',
        book("Star Wars. Galaxy's Edge A Crash of Fate", 'Zoraida Córdova'),
      ),
    ).toBe(false);
  });
  it('a prologue cut off the front is still a separate work', () => {
    expect(
      heldFileNamesBook(
        'Towers of Midnight',
        book('Distinctions. Prologue to Towers of Midnight', 'Robert Jordan'),
      ),
    ).toBe(false);
  });
});

describe('the name side (folder and file name)', () => {
  const E = '/data/cephfs-hdd/data/media/books/EBooks/';
  it('cuts the author and the track markers', () => {
    expect(
      heldFileNameTitles(
        `${E}Hugh Howey/First Shift - Legacy/Hugh Howey - First Shift - Legacy.epub`,
        'Hugh Howey',
      ),
    ).toEqual(['First Shift - Legacy']);
    expect(
      heldFileNameTitles(
        '/data/cephfs-hdd/data/media/books/AudioBooks/Veronica Roth/Divergent/Veronica Roth - Divergent Part 01 of 39.mp3',
        'Veronica Roth',
      ),
    ).toEqual(['Divergent']);
    expect(
      heldFileNameTitles(
        '/x/AudioBooks/Hugh Howey/Shift/Hugh Howey - Shift (10).mp3',
        'Hugh Howey',
      ),
    ).toEqual(['Shift']);
    expect(
      heldFileNameTitles(
        `${E}Veronica Roth/Four. The Traitor/Four. The Traitor - Veronica Roth.epub`,
        'Veronica Roth',
      ),
    ).toEqual(['Four: The Traitor']);
  });
  it('a name that names another volume', () => {
    expect(
      heldFileNameNamesBook(`${E}Erin Hunter/Warriors 1/Warriors 1 - Erin Hunter.epub`, {
        title: 'Warriors 3',
        author: 'Erin Hunter',
      }),
    ).toBe(false);
    expect(
      heldFileNameNamesBook(
        `${E}George R.R. Martin/Wild Cards IV - Aces Abroad/Wild Cards IV - Aces Abroad - George R.R. Martin.epub`,
        {
          title: 'Wild Cards I',
          author: 'George R.R. Martin',
        },
      ),
    ).toBe(false);
  });
  it('a scan-linked file in another book’s folder', () => {
    expect(
      heldFileNameNamesBook(
        `${E}Hugh Howey/First Shift - Legacy/Hugh Howey - First Shift - Legacy.epub`,
        howey('Shift'),
      ),
    ).toBe(false);
    expect(
      heldFileNameNamesBook(
        `${E}Veronica Roth/Four - A Divergent Story Collection/Veronica Roth - Four - A Divergent Story Collection.epub`,
        roth('Divergent'),
      ),
    ).toBe(false);
  });
  it('a name that names the book in either place passes', () => {
    expect(
      heldFileNameNamesBook(
        `${E}Veronica Roth/The Traitor/Veronica Roth - The Traitor.epub`,
        roth('Four. The Traitor'),
      ),
    ).toBe(true);
    expect(
      heldFileNameNamesBook(
        `${E}Hugh Howey/Machine Learning - New and Collected Stories/Hugh Howey - Machine Learning - New and Collected Stories.epub`,
        howey('Machine Learning', 'New and Collected Stories'),
      ),
    ).toBe(true);
    expect(
      heldFileNameNamesBook(
        '/x/AudioBooks/Hugh Howey/Beacon 23/Hugh Howey - Beacon 23- The Complete Novel - 01 of 34.mp3',
        howey('Beacon 23'),
      ),
    ).toBe(true);
  });
});
