'use client';

// ADR-032 / DESIGN-004 D-16 · IA reshuffle (2026-07-09, build B/C) — the GENERAL tab of the tabbed
// Trash Settings hub. Admin-only (every control here is an adminProcedure). It stacks TWO save units
// as two sibling cards:
//   A. The consolidated pipeline form (this file):
//      1. Admin gate — a SEPARATE, immediate audited ceremony (ConfirmButton to disable; plain to
//         enable). It is not part of the form (it flips one boolean with its own confirm).
//      2 + 3. Default save window + the Pushover delivery window (the "Notifications" card, relocated
//         here from /admin/storage) — CONSOLIDATED into ONE form with ONE green primary Save (the #134
//         pattern: related knobs commit together; only the changed writes fire). ADR-015: the status
//         slot is reserved so save feedback recolors, never reflows.
//   B. <BatchPolicyCard /> — moved here from the Storage tab (build C, 2026-07-09: batch composition
//      is pipeline behavior, not storage). It keeps its OWN single green Save, so it renders as a
//      sibling card BELOW the consolidated form rather than interleaved into it — a second independent
//      Save can't live inside the #134 single-Save form. Order: Admin gate → save window →
//      Notifications (one Save), then Batch policy (its own Save) — every pipeline knob on one tab.
import { useState } from 'react';
import { ConfirmButton } from '@hnet/ui';
import { trpc } from '@/lib/trpc-client';
import { describeMutationError } from '@/lib/app-error';
import { NOTIFY_TZ_OPTIONS, describeWindow, isValidWindow } from '@/lib/notify-window';
import { BatchPolicyCard } from './batch-policy-card';

interface GeneralDraft {
  windowDays: string;
  notifyStart: string;
  notifyEnd: string;
  notifyTz: string;
}

const intOrNaN = (s: string): number => (/^-?\d+$/.test(s.trim()) ? Number(s) : NaN);

export function GeneralTab() {
  const utils = trpc.useUtils();
  const settings = trpc.trash.settings.get.useQuery();
  const notify = trpc.storage.notify.window.get.useQuery();
  const [draft, setDraft] = useState<GeneralDraft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const gateMut = trpc.trash.settings.set.useMutation({
    onSuccess: () => {
      setError(null);
      void utils.trash.settings.get.invalidate();
    },
    onError: (err: unknown) => setError(describeMutationError(err)),
  });
  const saveWindow = trpc.trash.settings.set.useMutation();
  const saveNotify = trpc.storage.notify.window.set.useMutation();

  const skipGate = settings.data?.trash_skip_admin_gate === true;
  const loaded = settings.data !== undefined && notify.data !== undefined;
  const server: GeneralDraft | null = loaded
    ? {
        windowDays: String(settings.data?.trash_default_window_days ?? 21),
        notifyStart: String(notify.data!.startHour),
        notifyEnd: String(notify.data!.endHour),
        notifyTz: notify.data!.tz,
      }
    : null;
  const form = draft ?? server;

  const dirty = form !== null && server !== null && JSON.stringify(form) !== JSON.stringify(server);
  const winVal = form ? intOrNaN(form.windowDays) : NaN;
  const winValid = winVal >= 1 && winVal <= 365;
  const notifyStart = form ? Number(form.notifyStart) : NaN;
  const notifyEnd = form ? Number(form.notifyEnd) : NaN;
  const notifyValid = isValidWindow(notifyStart, notifyEnd);
  const valid = winValid && notifyValid;
  const saving = saveWindow.isPending || saveNotify.isPending;

  const patch = (next: Partial<GeneralDraft>) => {
    if (form === null) return;
    setSaved(false);
    setDraft({ ...form, ...next });
  };

  const flipGate = async (next: boolean): Promise<'ok' | 'failed'> => {
    try {
      await gateMut.mutateAsync({ trashSkipAdminGate: next });
      return 'ok';
    } catch {
      return 'failed'; // gateMut.onError already set the message
    }
  };

  const onSave = async () => {
    if (form === null || server === null || !valid) return;
    setError(null);
    setSaved(false);
    try {
      // Only write the parts that actually changed (each is an audited app_settings write).
      if (form.windowDays !== server.windowDays) {
        await saveWindow.mutateAsync({ trashDefaultWindowDays: winVal });
      }
      if (
        form.notifyStart !== server.notifyStart ||
        form.notifyEnd !== server.notifyEnd ||
        form.notifyTz !== server.notifyTz
      ) {
        await saveNotify.mutateAsync({
          startHour: notifyStart,
          endHour: notifyEnd,
          tz: form.notifyTz,
        });
      }
      setDraft(null);
      setSaved(true);
      void utils.trash.settings.get.invalidate();
      void utils.storage.notify.window.get.invalidate();
    } catch (err) {
      setError(describeMutationError(err));
    }
  };

  return (
    <>
      <section className="card batch-settings" data-testid="trash-settings">
        <h2 className="batch-settings__head">General</h2>
        {error !== null ? (
          <p className="alert" role="alert">
            {error}
          </p>
        ) : null}

        {/* Admin gate — a SEPARATE, immediate action (its own audited ConfirmButton ceremony). */}
        <div className="batch-settings__row">
          <div className="batch-settings__copy">
            <strong>Admin gate</strong>
            <p className="muted">
              With the gate on, every batch waits in Admin review for the poster pass. Turning it
              off sends new batches <strong>straight to Leaving Soon</strong> — no human review
              before the save window opens. The flip is audited either way.
            </p>
            <p data-testid="skipgate-state">
              {settings.isLoading
                ? 'Loading…'
                : skipGate
                  ? 'Admin gate is OFF — new batches go straight to Leaving Soon.'
                  : 'Admin gate is ON — every batch waits for admin review.'}
            </p>
          </div>
          {skipGate ? (
            <button
              type="button"
              className="btn sm"
              data-testid="gate-enable"
              disabled={gateMut.isPending || settings.isLoading}
              onClick={() => void flipGate(false)}
            >
              Enable
            </button>
          ) : (
            <ConfirmButton
              className="btn sm danger"
              data-testid="gate-disable"
              label="Disable"
              reArmOnFailure
              disabled={gateMut.isPending || settings.isLoading}
              restingAriaLabel="Disable the admin gate — new batches go straight to Leaving Soon without review — click twice to confirm"
              confirmAriaLabel="Confirm disabling the admin gate"
              onConfirm={() => flipGate(true)}
            />
          )}
        </div>

        {/* Default save window — part of the shared form. */}
        <div className="batch-settings__row">
          <div className="batch-settings__copy">
            <strong>Default save window</strong>
            <p className="muted">
              How long a green-lit batch stays in Leaving Soon before the sweep deletes the
              remainder. Green-light can override per batch.
            </p>
          </div>
          <span className="batch-settings__field">
            <input
              type="number"
              className="batch-window-input"
              min={1}
              max={365}
              value={form?.windowDays ?? ''}
              disabled={!loaded}
              data-testid="settings-window"
              aria-label="Default save window in days"
              aria-invalid={(form !== null && !winValid) || undefined}
              onChange={(e) => patch({ windowDays: e.target.value })}
            />
            <span className="muted">days</span>
          </span>
        </div>

        {/* Notifications delivery window (ADR-034 / DESIGN-015) — relocated from /admin/storage, now
          part of the shared General form (no separate Save). */}
        <div className="batch-policy" data-testid="notify-window" aria-label="Notifications">
          <h3 className="batch-settings__subhead">Notifications</h3>
          <p className="muted">
            Pushover pings when a Trash batch is posted and the day before it leaves. Choose the
            hours you want to be notified in — a ping raised outside the window waits until it next
            opens.
          </p>
          <p className="muted" data-testid="notify-window-summary">
            {notify.isLoading
              ? 'Loading…'
              : notify.data
                ? `Currently: ${describeWindow(notify.data)}`
                : ''}
          </p>
          <div className="batch-settings__row">
            <div className="batch-settings__copy">
              <strong>Delivery window</strong>
              <p className="muted">
                Quiet hours outside this range — pings wait until it next opens.
              </p>
            </div>
            <span className="batch-settings__field notify-window__form">
              <label className="notify-window__field">
                <span>From</span>
                <input
                  type="number"
                  inputMode="numeric"
                  min={0}
                  max={23}
                  step={1}
                  value={form?.notifyStart ?? ''}
                  disabled={!loaded}
                  aria-label="Delivery window start hour (0–23)"
                  aria-invalid={(form !== null && !notifyValid) || undefined}
                  data-testid="notify-start"
                  onChange={(e) => patch({ notifyStart: e.target.value })}
                />
                <span className="muted">:00</span>
              </label>
              <label className="notify-window__field">
                <span>To</span>
                <input
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={24}
                  step={1}
                  value={form?.notifyEnd ?? ''}
                  disabled={!loaded}
                  aria-label="Delivery window end hour (1–24)"
                  aria-invalid={(form !== null && !notifyValid) || undefined}
                  data-testid="notify-end"
                  onChange={(e) => patch({ notifyEnd: e.target.value })}
                />
                <span className="muted">:00</span>
              </label>
              <label className="notify-window__field">
                <span>Timezone</span>
                <select
                  value={form?.notifyTz ?? 'America/New_York'}
                  disabled={!loaded}
                  aria-label="Delivery window timezone"
                  data-testid="notify-tz"
                  onChange={(e) => patch({ notifyTz: e.target.value })}
                >
                  {NOTIFY_TZ_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </label>
            </span>
          </div>
        </div>

        {/* The single green Save for the whole form (gate stays its own action above). */}
        <div className="form-actions batch-settings__save">
          <button
            type="button"
            className="btn primary"
            data-testid="general-save"
            disabled={!loaded || saving || !dirty || !valid}
            onClick={() => void onSave()}
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
          {/* Reserved status slot — appearing text recolors, never reflows (ADR-015). */}
          <span className="batch-settings__status" role="status">
            {!winValid && form !== null
              ? '1–365 days'
              : !notifyValid && form !== null
                ? 'Start must be before end'
                : saved
                  ? 'Saved'
                  : dirty
                    ? 'Unsaved'
                    : ' '}
          </span>
        </div>
      </section>

      {/* Batch policy — its own single-Save card, a sibling of the consolidated form above (build C). */}
      <BatchPolicyCard />
    </>
  );
}
