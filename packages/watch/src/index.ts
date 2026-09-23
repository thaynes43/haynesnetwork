// @hnet/watch — the Watch Companion's pure math (DESIGN-049; PLAN-068 S4): title identity (D-08),
// progress and states (D-10), the title resolver (D-13), the Taste Profile, exclusions and scoring
// (D-16..D-19) and the spoken answers (D-20, D-21). No database, no network, no clock: every
// function takes `now` (unix seconds) when it needs one. Read queries join in a later stage.
export * from './types';
export * from './normalize';
export * from './identity';
export * from './genres';
export * from './progress';
export * from './resolver';
export * from './recommend';
export * from './spoken';
export * from './format';
