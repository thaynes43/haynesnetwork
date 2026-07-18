// ADR-071 / DESIGN-004 D-24 — the media-action system barrel. The sanctioned surface for every
// per-item media action (Fix / Force Search / consume / retry / not-on-disk): a registry of the
// ONE canonical label+look per verb, plus the components that render it reflow-safely. Re-exported
// from the package root (@hnet/ui); the `action-anatomy` guard forbids hand-rolling these controls.
export {
  MEDIA_ACTIONS,
  MEDIA_ACTION_TYPES,
  composeActionLabel,
} from './action-registry';
export type {
  MediaActionType,
  MediaActionVariant,
  MediaActionSpec,
} from './action-registry';

export { MediaAction } from './MediaAction';
export type { MediaActionProps } from './MediaAction';

export { MediaActionBar } from './MediaActionBar';
export type { MediaActionBarProps } from './MediaActionBar';

export { ConsumeLink } from './ConsumeLink';
export type { ConsumeLinkProps } from './ConsumeLink';

export { ReservedActionSlot } from './ReservedActionSlot';
export type { ReservedActionSlotProps, ReservedActionSlotReserve } from './ReservedActionSlot';

export { MediaHero } from './MediaHero';
export type { MediaHeroProps, MediaHeroBadge } from './MediaHero';
