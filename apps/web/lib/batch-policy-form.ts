// Pure save conversion used by the Batch policy card. Carry every unedited policy field through.
import type { SpacePolicy, SpacePolicyMode } from '@hnet/domain';
import { BYTES_PER_GB } from './trash-batches';

export interface KindCapsDraft {
  maxItems: { enabled: boolean; value: string };
  targetGb: { enabled: boolean; value: string };
}
export interface PolicyDraft {
  mode: SpacePolicyMode;
  minCandidates: string;
  perKind: Record<'movie' | 'tv', KindCapsDraft>;
}

const gbFromBytes = (bytes: number): string => String(Math.round((bytes / BYTES_PER_GB) * 10) / 10);

function kindToDraft(caps: SpacePolicy['perKind']['movie']): KindCapsDraft {
  return {
    maxItems: { enabled: caps.maxItems.enabled, value: String(caps.maxItems.value) },
    targetGb: { enabled: caps.targetBytes.enabled, value: gbFromBytes(caps.targetBytes.value) },
  };
}

export function toDraft(policy: SpacePolicy): PolicyDraft {
  return {
    mode: policy.mode,
    minCandidates: String(policy.minCandidates),
    perKind: { movie: kindToDraft(policy.perKind.movie), tv: kindToDraft(policy.perKind.tv) },
  };
}

const intOrNaN = (s: string): number => (/^-?\d+$/.test(s.trim()) ? Number(s) : NaN);

export function draftValid(d: PolicyDraft): boolean {
  const min = intOrNaN(d.minCandidates);
  if (!(min >= 0 && min <= 100000)) return false;
  for (const kind of ['movie', 'tv'] as const) {
    const k = d.perKind[kind];
    if (k.maxItems.enabled) {
      const v = intOrNaN(k.maxItems.value);
      if (!(v >= 1 && v <= 100000)) return false;
    }
    if (k.targetGb.enabled) {
      const v = Number(k.targetGb.value);
      if (!(Number.isFinite(v) && v > 0)) return false;
    }
  }
  return true;
}

export function draftToPolicy(d: PolicyDraft, base: SpacePolicy): SpacePolicy {
  const kindFromDraft = (
    k: KindCapsDraft,
    baseCaps: SpacePolicy['perKind']['movie'],
  ): SpacePolicy['perKind']['movie'] => ({
    maxItems: {
      enabled: k.maxItems.enabled,
      value: Number.isFinite(intOrNaN(k.maxItems.value))
        ? intOrNaN(k.maxItems.value)
        : baseCaps.maxItems.value,
    },
    targetBytes: {
      enabled: k.targetGb.enabled,
      value: Number.isFinite(Number(k.targetGb.value))
        ? Math.round(Number(k.targetGb.value) * BYTES_PER_GB)
        : baseCaps.targetBytes.value,
    },
    // The ranking has no control on this card — carry the configured one through so saving the caps
    // can't silently reset a kind to the default strategy.
    ...(baseCaps.strategy !== undefined ? { strategy: baseCaps.strategy } : {}),
  });
  return {
    ...base,
    mode: d.mode,
    minCandidates: intOrNaN(d.minCandidates),
    perKind: {
      movie: kindFromDraft(d.perKind.movie, base.perKind.movie),
      tv: kindFromDraft(d.perKind.tv, base.perKind.tv),
    },
  };
}
