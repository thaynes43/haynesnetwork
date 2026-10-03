import type { DbClient } from '@hnet/db';
import { MaintainerrUpstreamError } from './errors';
import { guardMaintainerrCall, type MaintainerrClientBundle } from './maintainerr-clients';
import { markSaveIntentApplied, recordSaveIntentApplyFailure } from './trash-save-intents';

/**
 * ADR-099 — a Trash Save is RECORDED FIRST and ENFORCED SECOND.
 *
 * The owner's requirement (2026-10-03): "if someone clicks save it's saved forever". A Save used to be only as good as
 * Maintainerr's answer: the exclusion was written first with the 30 s `@hnet/arr` timeout, and Maintainerr holds
 * exclusion writes while it runs its scheduled rules (00:00, 08:00, 16:00, about five minutes each), so a Save tapped
 * in that window timed out and was lost (#642). Now the app's own record (the open save intent, plus the batch row on
 * the batch wall) is the protection every deletion path reads, written in one transaction before Maintainerr is
 * touched; this module is the enforcement half that follows it.
 *
 * `applySaveIntentExclusion` makes Maintainerr hold the exclusion for one open intent and reads it back. It never
 * throws for a Maintainerr failure: the Save is already durable, so a busy or unreachable Maintainerr only leaves the
 * intent pending, counted on the row, for the keeper's next tick (`keepTrashSaves`, every 15 minutes).
 */

/** How long a Save tap waits for Maintainerr before answering (the exclusion, its read-back and the Leaving-Soon
 *  removal). Short on purpose: the Save is recorded before this starts, so waiting longer only holds the wall's busy
 *  ring. Whatever is not done in time is finished by the keeper. */
export const SAVE_ENFORCE_DEADLINE_MS = 8_000;

/** The keeper's per-intent budget. Longer than a tap's (nobody is waiting), still bounded so one stalled call cannot
 *  hold the 15-minute sync tick. */
export const KEEPER_APPLY_DEADLINE_MS = 20_000;

/** Maintainerr did not answer inside the deadline. A subclass of the upstream error, so every existing
 *  `MaintainerrUpstreamError` branch (fail closed, "Maintainerr didn't respond") treats it the same way. */
export class MaintainerrDeadlineError extends MaintainerrUpstreamError {
  constructor(what: string, ms: number) {
    super(`${what} did not answer within ${Math.round(ms / 100) / 10} s`);
  }
}

/** Set when the deadline passed: a multi-step `fn` checks it between its calls, so nothing new is sent to Maintainerr
 *  after the caller stopped waiting (a late write after an un-save would leave an exclusion no Save stands behind). */
export interface DeadlineSignal {
  aborted: boolean;
}

/**
 * Run `fn` but stop waiting after `ms`. The request in flight is not cancelled (the shared HTTP client owns its own
 * timeout); its late result or failure is swallowed, so nothing escapes as an unhandled rejection, and `signal.aborted`
 * tells `fn` to send nothing further. A late SUCCESS of the call in flight is harmless by construction: the keeper
 * reads the exclusion back before it trusts it, and finds it already there.
 */
export async function withMaintainerrDeadline<T>(
  what: string,
  ms: number,
  fn: (signal: DeadlineSignal) => Promise<T>,
): Promise<T> {
  const signal: DeadlineSignal = { aborted: false };
  const work = fn(signal);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      signal.aborted = true;
      reject(new MaintainerrDeadlineError(what, ms));
    }, ms);
  });
  try {
    return await Promise.race([work, deadline]);
  } catch (err) {
    work.catch(() => undefined);
    throw err;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export type SaveApplyOutcome =
  /** Maintainerr now holds the exclusion (written here, or found already there) and the intent is confirmed. */
  | 'applied'
  /** Maintainerr answered with an error: the intent stays pending and the keeper tries again. */
  | 'pending'
  /** Maintainerr did not answer inside the deadline (it holds exclusion writes while it runs its rules): pending,
   *  and the keeper stops this tick rather than queue more calls behind a busy Maintainerr. */
  | 'busy'
  /** The Save was un-saved while this ran: the exclusion just written was taken back off (best effort). */
  | 'revoked';

/**
 * Make Maintainerr hold the GLOBAL exclusion on `maintainerrMediaId` for one open intent, read it back, and stamp the
 * intent confirmed. Idempotent: an exclusion already present is confirmed without a write. A Maintainerr failure is
 * recorded on the intent and answered `pending` (`busy` for a missed deadline); any other error (a database fault)
 * propagates.
 */
export async function applySaveIntentExclusion(input: {
  db?: DbClient;
  maintainerr: MaintainerrClientBundle;
  intentId: string;
  maintainerrMediaId: string;
  deadlineMs: number;
}): Promise<SaveApplyOutcome> {
  const key = input.maintainerrMediaId;
  let wrote = false;
  try {
    await withMaintainerrDeadline('maintainerr exclusion', input.deadlineMs, async (signal) => {
      const existing = await guardMaintainerrCall('maintainerr GET /rules/exclusion', () =>
        input.maintainerr.read.getExclusions({ mediaServerId: key }),
      );
      if (existing.length > 0 || signal.aborted) return;
      wrote = true;
      await guardMaintainerrCall('maintainerr POST /rules/exclusion', () =>
        input.maintainerr.write.addExclusion(key),
      );
      // Read back: Maintainerr answers a write it did not apply with a 2xx often enough (ADR-023 C-05's phantom
      // exclusions) that only its own list counts as proof.
      const after = await guardMaintainerrCall('maintainerr GET /rules/exclusion', () =>
        input.maintainerr.read.getExclusions({ mediaServerId: key }),
      );
      if (after.length === 0) {
        throw new MaintainerrUpstreamError(
          `maintainerr POST /rules/exclusion answered but ${key} is not excluded on read-back`,
        );
      }
    });
  } catch (err) {
    if (!(err instanceof MaintainerrUpstreamError)) throw err;
    await recordSaveIntentApplyFailure(input.db, { intentId: input.intentId, error: err.message });
    return err instanceof MaintainerrDeadlineError ? 'busy' : 'pending';
  }

  if (await markSaveIntentApplied(input.db, { intentId: input.intentId, maintainerrMediaId: key })) {
    return 'applied';
  }
  if (!wrote) return 'revoked'; // the exclusion was there before us; it is not ours to take off.
  // Un-saved while the exclusion was being applied: the un-save found nothing to remove, so take ours back off. Best
  // effort — a leftover exclusion only keeps a title, never deletes one.
  try {
    await withMaintainerrDeadline('maintainerr DELETE /rules/exclusions', input.deadlineMs, () =>
      guardMaintainerrCall('maintainerr DELETE /rules/exclusions', () =>
        input.maintainerr.write.removeExclusion(key),
      ),
    );
  } catch (err) {
    if (!(err instanceof MaintainerrUpstreamError)) throw err;
  }
  return 'revoked';
}
