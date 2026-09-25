// @hnet/watch — the Watch Companion's pure math (DESIGN-049; PLAN-068 S4): title identity (D-08),
// progress and states (D-10), the title resolver (D-13), the Taste Profile, exclusions and scoring
// (D-16..D-19) and the spoken answers (D-20, D-21); the Title State helpers shared by the sync, the
// revalidation and the mark write-through (S5); and the read queries (S5/S7 — SELECT only, each takes a
// `db`). No network, no clock: every function takes `now` (unix seconds) when it needs one.
export * from './types';
export * from './normalize';
export * from './identity';
export * from './genres';
export * from './progress';
export * from './resolver';
export * from './recommend';
export * from './spoken';
export * from './format';
export * from './state';
export * from './queries';
export * from './views';
export * from './watchlist';
