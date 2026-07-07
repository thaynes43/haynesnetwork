// ADR-031 / DESIGN-014 (PLAN-014) — pure presentation + merge helpers for the /admin/storage
// "Space policy" card and its tuning/graduation block. All pure (unit-tested in
// __tests__/space-policy.test.ts); the card component stays a thin binding over trpc.storage.policy.*
// + trpc.trash.tuning. Types are TYPE-ONLY from @hnet/domain (erased at compile — the client bundle
// never pulls the domain/pg dependency; same rule as the storage/motd pages).
import type {
  GraduationReadiness,
  SpacePolicy,
  SpacePolicyArrayConfig,
  TuningStats,
} from '@hnet/domain';

export type { SpacePolicy, GraduationReadiness, TuningStats };

/** The only physical array the policy surfaces today (DESIGN-014 — HaynesTower is the sole array with
 *  a space target + batchable kinds; music/CephFS is never batchable). */
export const POLICY_ARRAY_KEY = 'haynestower';
export const POLICY_ARRAY_LABEL = 'HaynesTower';

/** Merge a per-array config patch into the full policy object (immutable) — the card sends the whole
 *  merged value to storage.policy.set (like the targets editor). */
export function withArrayConfig(
  policy: SpacePolicy,
  key: string,
  patch: Partial<SpacePolicyArrayConfig>,
): SpacePolicy {
  const current = policy.perArray[key] ?? { enabled: false };
  return {
    ...policy,
    perArray: { ...policy.perArray, [key]: { ...current, ...patch } },
  };
}

/** Set the top-level global enabled flag (immutable). */
export function withEnabled(policy: SpacePolicy, enabled: boolean): SpacePolicy {
  return { ...policy, enabled };
}

/** The effective cooldown for an array (its override, else the policy default). */
export function effectiveCooldownDays(policy: SpacePolicy, key: string): number {
  return policy.perArray[key]?.cooldownDays ?? policy.cooldownDays;
}

/** Whether the array is opted in (its per-array enabled flag). */
export function arrayEnabled(policy: SpacePolicy, key: string): boolean {
  return policy.perArray[key]?.enabled === true;
}

/** "82% used vs 80% target — over" / "72% vs 80% — under" / "no target". A live over/under readout. */
export function overTargetLabel(usedPct: number | null, target: number | null): string {
  if (usedPct === null) return 'utilization unavailable';
  if (target === null) return `${usedPct}% used · no target set`;
  const verdict = usedPct > target ? 'over target' : 'under target';
  return `${usedPct}% used vs ${target}% target — ${verdict}`;
}

/** A relative "next eligible" label for a kind's cooldown. */
export function nextEligibleLabel(nextEligibleAt: string | null, now: Date = new Date()): string {
  if (nextEligibleAt === null) return 'eligible now';
  const ms = Date.parse(nextEligibleAt) - now.getTime();
  if (ms <= 0) return 'eligible now';
  const days = Math.ceil(ms / 86_400_000);
  return days <= 1 ? 'eligible in under a day' : `eligible in ${days} days`;
}

/** "18.2%" / "—" (null) — the rescue rate, one place. */
export function saveRateLabel(pct: number | null): string {
  return pct === null ? '—' : `${pct}%`;
}

/** A one-line human verdict for the graduation block. */
export function graduationVerdict(g: GraduationReadiness): string {
  const { thresholds } = g;
  if (g.meetsCriteria) {
    return `Ready: ${g.completedPolicyBatches} completed policy batches, ${saveRateLabel(
      g.aggregate.saveRatePct,
    )} save-rate, ${g.restoresOfSwept} restores — clears the ≥${thresholds.minCompletedBatches} / ≤${thresholds.maxSaveRatePct}% / ≤${thresholds.maxRestores} bar.`;
  }
  if (g.completedPolicyBatches < thresholds.minCompletedBatches) {
    return `Not yet: ${g.completedPolicyBatches} of ${thresholds.minCompletedBatches} completed policy batches so far.`;
  }
  const parts: string[] = [];
  if (g.aggregate.saveRatePct !== null && g.aggregate.saveRatePct > thresholds.maxSaveRatePct) {
    parts.push(`save-rate ${saveRateLabel(g.aggregate.saveRatePct)} > ${thresholds.maxSaveRatePct}%`);
  }
  if (g.aggregate.saveRatePct === null) parts.push('no deletions to judge yet');
  if (g.restoresOfSwept > thresholds.maxRestores) {
    parts.push(`${g.restoresOfSwept} restores of swept items`);
  }
  return `Not yet: ${parts.join('; ') || 'criteria not met'}.`;
}
