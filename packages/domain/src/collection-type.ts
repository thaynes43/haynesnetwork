// DESIGN-035 D-10 / PRD R-214 / DDD T-186 (PLAN-053 — Collection Type facet) — THE versioned
// collection-title classifier. One pure function, no I/O: `syncPlexCollections` calls it at every
// upsert, so the `plex_collections.collection_type` annotation is RECOMPUTED each collections-sync
// and the whole column rebuilds on the next run — bump COLLECTION_CLASSIFIER_VERSION when the
// rules change and the estate re-annotates itself (nothing migrates).
//
// Owner rulings (2026-07-16, FINAL): SIX buckets — trilogy / franchise_universe / director / actor
// / list / other; producer/writer FOLD INTO director. Rule order (first match wins):
//   1. trilogy            — "… Trilogy" + the explicit n-ology variants.
//   2. franchise_universe — the TMDb "… Collection" franchise idiom (+ "… Saga"), the
//                           "…verse"/"… Universe" idiom, and the universe-Default names our
//                           Kometa estate runs (research doc §4).
//   3. director / actor   — the people-file idiom: EXACT title match against the known-name
//                           lists seeded from our config's outputs (movies-people.yml). A bare
//                           person-name heuristic is TOO LOOSE (it would eat "Roald Dahl", an
//                           author LIST) — explicit lists only.
//   4. list               — charts (IMDb/Trakt/Trending/Popular/Top-N/Best-of + decade +
//                           seasonal) and awards (Oscars/Golden Globes/BAFTA/Cannes/…).
//   5. other              — everything else, HONESTLY (curated picks, studio lists, bare
//                           franchise names with no idiom, tech showcases).
import type { CollectionType } from '@hnet/db';

/** Bump when the rules below change — the next collections-sync re-annotates the estate. */
export const COLLECTION_CLASSIFIER_VERSION = 1;

/** Lowercase, whitespace-collapsed, curly-apostrophe-normalized matching key. */
function normalize(title: string): string {
  return title.trim().toLowerCase().replace(/\s+/g, ' ').replace(/’/g, "'");
}

// ── 1. trilogy — "… Trilogy" + explicit n-ology variants. The prefix list is CLOSED so
//      "Anthology" (an-thology) can never match.
const TRILOGY_RE =
  /\b(?:du|di|tri|quadri|tetra|penta|quint|hexa|hepta|septo|octo|ennea|deca)log(?:y|ies)\b/;

// ── 2. franchise_universe — the franchise Default's canonical "… Collection" tail, "… Saga",
//      and the "…verse" / "… Universe" tail (Marvel Cinematic Universe, Arrowverse, Shondaverse,
//      Monsterverse, View Askewniverse — all end the same way).
const FRANCHISE_COLLECTION_RE = /\bcollection$/;
const SAGA_RE = /\bsaga\b/;
const UNIVERSE_RE = /[a-z]verse$/;
/** Universe-Default / franchise names our estate runs bare (Kometa research §4) — exact titles. */
const UNIVERSE_NAMES = new Set(
  [
    'Marvel',
    'DC',
    'Star Wars',
    'Star Trek',
    'Wizarding World',
    'Harry Potter',
    'Middle Earth',
    'X-Men',
    'Alien / Predator',
    'Fast & Furious',
    'Rocky / Creed',
    'In Association with Marvel',
    'In Association with DC',
  ].map(normalize),
);

// ── 3. director / actor — the people-file idiom, seeded from movies-people.yml (our Kometa
//      config's known outputs). Producers/Directors section → director (the owner's fold);
//      Actors section → actor. Exact (normalized) titles only.
const DIRECTOR_NAMES = new Set(
  [
    'Alfred Hitchcock',
    'Ari Aster',
    'Christopher Nolan',
    'Coen Brothers',
    'David Lynch',
    'Edgar Wright',
    'James Cameron',
    'James Gunn',
    'Jon Favreau',
    'Jordan Peele',
    'M. Night Shyamalan',
    'Martin Scorsese',
    'Michael Bay',
    'Quentin Tarantino',
    'Ridley Scott',
    'Stanley Kubrick',
    'Steven Spielberg',
    'Tim Burton',
    'Wes Anderson',
    'Zack Snyder',
  ].map(normalize),
);
const ACTOR_NAMES = new Set(
  [
    'Adam Sandler',
    'Ben Affleck',
    'Bruce Lee',
    'Bruce Willis',
    'Christian Bale',
    'Chris Evans',
    'Chris Hemsworth',
    'Chris Pratt',
    'Chris Rock',
    'Christopher Walken',
    'Chuck Norris',
    'Clint Eastwood',
    'Daniel Craig',
    'Denzel Washington',
    'Dwayne Johnson',
    'Eddie Murphy',
    'Emma Stone',
    'Emma Watson',
    'Gene Wilder',
    'George Clooney',
    'Gerard Butler',
    'Harrison Ford',
    'Hugh Jackman',
    'Jack Black',
    'Jack Nicholson',
    'Jackie Chan',
    'Jenna Ortega',
    'Jennifer Lawrence',
    'Jim Carrey',
    'John Candy',
    'John Travolta',
    'Johnny Depp',
    'Julia Roberts',
    'Kevin Bacon',
    'Leonardo DiCaprio',
    'Liam Neeson',
    'Lucy Liu',
    'Mark Wahlberg',
    'Martin Short',
    'Matt Damon',
    'Mel Brooks',
    'Mel Gibson',
    'Melissa McCarthy',
    'Meryl Streep',
    'Michael Keaton',
    'Mike Myers',
    'Mila Kunis',
    'Morgan Freeman',
    'Natalie Portman',
    'Nicolas Cage',
    'Reese Witherspoon',
    'Robert De Niro',
    'Robert Downey Jr.',
    'Robin Williams',
    'Ryan Reynolds',
    'Samuel L. Jackson',
    'Sandra Bullock',
    'Sacha Baron Cohen',
    'Scarlett Johansson',
    'Sean Connery',
    'Steve Carell',
    'Steve Martin',
    'Sylvester Stallone',
    'Taika Waititi',
    'Tom Cruise',
    'Timothée Chalamet',
    'Tom Hanks',
    'Tom Holland',
    'Vin Diesel',
    'Will Ferrell',
    'Will Smith',
    'Woody Harrelson',
    'Zendaya',
  ].map(normalize),
);

// ── 4. list — charts + awards. NOTE the Top-N guard: only "Top <number>" / the chart phrases
//      match, never bare "Top …" (or "Top Gun" would misfile).
const CHART_RES: readonly RegExp[] = [
  /\bimdb\b/,
  /\btrakt\b/,
  /\btautulli\b/,
  /\btrending\b/,
  /\bpopular\b/,
  /\btop (?:rated|grossing|watched|airing|\d+)\b/,
  /\bbest of\b/,
  /\bcharts?\b/,
  /\bnow playing\b/,
  /\bin theaters\b/,
  /\bnew releases\b/,
  /\bmost watched\b/,
  /\b(?:19|20)\d0s\b/, // decade charts ("Best of the 1980s", "1990s Movies")
];
const SEASONAL_RES: readonly RegExp[] = [
  /\bchristmas\b/,
  /\bhalloween\b/,
  /\bthanksgiving\b/,
  /\beaster\b/,
  /\bvalentine/,
  /\bst\.? patrick/,
  /\bnew year/,
  /\bindependence day\b/,
  /\bmother's day\b/,
  /\bfather's day\b/,
  /\bmemorial day\b/,
  /\blabor day\b/,
  /\bveterans? day\b/,
];
const AWARD_RES: readonly RegExp[] = [
  /\boscars?\b/,
  /\bacademy awards?\b/,
  /\bgolden globes?\b/,
  /\bbafta\b/,
  /\bcannes\b/,
  /\bpalme\b/,
  /\bemmys?\b/,
  /\brazzies?\b/,
  /\bsundance\b/,
  /\bvenice\b/,
  /\bberlinale\b/,
  /\bcritics'? choice\b/,
  /\bindependent spirit\b/,
];

/**
 * Classify a mirrored Plex collection TITLE into its owner-ruled bucket (T-186). Pure and
 * deterministic; anything no explicit rule places lands honestly in 'other'.
 */
export function classifyCollectionType(title: string): CollectionType {
  const t = normalize(title);
  if (t === '') return 'other';
  if (TRILOGY_RE.test(t)) return 'trilogy';
  if (
    FRANCHISE_COLLECTION_RE.test(t) ||
    SAGA_RE.test(t) ||
    UNIVERSE_RE.test(t) ||
    UNIVERSE_NAMES.has(t)
  ) {
    return 'franchise_universe';
  }
  if (DIRECTOR_NAMES.has(t)) return 'director';
  if (ACTOR_NAMES.has(t)) return 'actor';
  if ([...CHART_RES, ...SEASONAL_RES, ...AWARD_RES].some((re) => re.test(t))) return 'list';
  return 'other';
}
