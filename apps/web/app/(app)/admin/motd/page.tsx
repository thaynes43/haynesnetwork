'use client';

// ADR-027 / DESIGN-004 D-15 (PLAN-010) — /admin/motd: compose/enable/clear the dashboard
// Message-of-the-Day. One static form (message textarea, severity select, enabled toggle, optional
// start/end window) mirroring the /admin/catalog D-11 form. Save → motd.set; Clear → motd.clear behind
// a @hnet/ui ConfirmButton (inline two-step — clearing removes something users see; never
// window.confirm, hard rule 8). A live preview reuses the real .motd banner classes; changing severity
// recolors ONLY the preview, never the layout (ADR-015 / hard rule 9).

import { useState, type FormEvent } from 'react';
import { ConfirmButton } from '@hnet/ui';
// The enum const comes from the pg-free `@hnet/db/schema` subpath: importing the `@hnet/db` ROOT into
// a client component would drag the `pg` Pool into the browser bundle (server components may; this may
// not). The value is client-safe (pure const array); the type is erased.
import { MOTD_SEVERITIES, type MotdSeverity } from '@hnet/db/schema';
import { trpc } from '@/lib/trpc-client';
import { describeMutationError } from '@/lib/app-error';

/** ISO instant → the value a <input type="datetime-local"> expects (local wall time, minute precision). */
function isoToLocalInput(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const offsetMs = d.getTimezoneOffset() * 60_000;
  return new Date(d.getTime() - offsetMs).toISOString().slice(0, 16);
}

/** datetime-local value (local wall time) → a UTC ISO instant for the wire, or null when empty. */
function localInputToIso(local: string): string | null {
  if (!local) return null;
  const d = new Date(local);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

interface FormState {
  message: string;
  severity: MotdSeverity;
  enabled: boolean;
  startsAt: string; // datetime-local
  endsAt: string; // datetime-local
}

const EMPTY_FORM: FormState = {
  message: '',
  severity: 'info',
  enabled: false,
  startsAt: '',
  endsAt: '',
};

export default function AdminMotdPage() {
  const utils = trpc.useUtils();
  const current = trpc.motd.get.useQuery();
  // `draft` overlays the stored record when the admin has edited (the batches-tab settings pattern —
  // no prefill effect). null ⇒ mirror the server data; a Save/Clear resets it so the form re-syncs.
  const [draft, setDraft] = useState<FormState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const base: FormState = current.data
    ? {
        message: current.data.message,
        severity: current.data.severity,
        enabled: current.data.enabled,
        startsAt: isoToLocalInput(current.data.startsAt),
        endsAt: isoToLocalInput(current.data.endsAt),
      }
    : EMPTY_FORM;
  const form = draft ?? base;
  const setForm = (next: FormState) => setDraft(next);

  const invalidate = () =>
    Promise.all([utils.motd.get.invalidate(), utils.motd.getActive.invalidate()]);

  const save = trpc.motd.set.useMutation({
    onError: (err) => {
      setError(describeMutationError(err));
      setSaved(false);
    },
    onSuccess: () => {
      setError(null);
      setSaved(true);
      setDraft(null); // re-sync the form to the freshly-saved record
    },
    onSettled: invalidate,
  });

  const clear = trpc.motd.clear.useMutation({
    onError: (err) => setError(describeMutationError(err)),
    onSuccess: () => {
      setError(null);
      setSaved(false);
      setDraft(null); // re-sync to the now-disabled record
    },
    onSettled: invalidate,
  });

  const windowInvalid =
    form.startsAt !== '' &&
    form.endsAt !== '' &&
    new Date(form.startsAt).getTime() > new Date(form.endsAt).getTime();
  const messageEmpty = form.message.trim() === '';
  const busy = save.isPending || clear.isPending;

  function submit(e: FormEvent) {
    e.preventDefault();
    setSaved(false);
    if (messageEmpty || windowInvalid) return;
    save.mutate({
      message: form.message.trim(),
      severity: form.severity,
      enabled: form.enabled,
      startsAt: localInputToIso(form.startsAt),
      endsAt: localInputToIso(form.endsAt),
    });
  }

  if (current.isLoading) return <p className="muted">Loading…</p>;

  return (
    <>
      <div className="admin-head">
        <h1>Message of the Day</h1>
      </div>
      <p className="muted">
        An optional banner shown at the top of every signed-in user’s dashboard. Enable it to
        broadcast a notice; clear it (or set an end time) to take it down.
      </p>

      {error ? (
        <p className="alert" role="alert">
          {error}
        </p>
      ) : null}
      {saved ? (
        <p className="status-note" role="status">
          Saved. {form.enabled ? 'The banner is live.' : 'The banner is disabled.'}
        </p>
      ) : null}

      {/* Live preview — reuses the real banner classes; severity recolors this only (ADR-015). */}
      <div className="motd-preview" aria-hidden="true">
        <span className="field-hint">Preview</span>
        <div className={`motd motd--${form.severity}`} data-severity={form.severity}>
          <span className="motd__icon">{form.severity === 'warning' ? '⚠' : 'ℹ'}</span>
          <p className="motd__message">{form.message.trim() || 'Your message will appear here.'}</p>
          <span className="motd__dismiss" role="presentation">
            ✕
          </span>
        </div>
      </div>

      <form className="admin-form" onSubmit={submit}>
        <label className="field">
          <span>
            Message <span className="req" aria-hidden="true">*</span>
          </span>
          <textarea
            required
            aria-label="Message"
            maxLength={280}
            rows={3}
            value={form.message}
            onChange={(e) => setForm({ ...form, message: e.target.value })}
          />
          <span className="field-hint">{form.message.trim().length}/280 · plain text</span>
        </label>

        <label className="field">
          <span>Severity</span>
          <select
            aria-label="Severity"
            value={form.severity}
            onChange={(e) => setForm({ ...form, severity: e.target.value as MotdSeverity })}
          >
            {MOTD_SEVERITIES.map((sev) => (
              <option key={sev} value={sev}>
                {sev === 'warning' ? 'Warning' : 'Info'}
              </option>
            ))}
          </select>
        </label>

        <label className="check-row">
          <input
            type="checkbox"
            checked={form.enabled}
            onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
          />
          <span>Enabled — show this banner to everyone</span>
        </label>

        <label className="field">
          <span>Show from (optional)</span>
          <input
            type="datetime-local"
            aria-label="Show from"
            value={form.startsAt}
            onChange={(e) => setForm({ ...form, startsAt: e.target.value })}
          />
        </label>

        <label className="field">
          <span>Show until (optional)</span>
          <input
            type="datetime-local"
            aria-label="Show until"
            value={form.endsAt}
            onChange={(e) => setForm({ ...form, endsAt: e.target.value })}
            aria-invalid={windowInvalid}
          />
          {windowInvalid ? (
            <span className="field-error">The end must be after the start.</span>
          ) : (
            <span className="field-hint">Leave blank to show indefinitely.</span>
          )}
        </label>

        <div className="form-actions">
          <button type="submit" className="btn primary" disabled={busy || messageEmpty || windowInvalid}>
            Save
          </button>
          <ConfirmButton
            className="btn danger"
            data-testid="motd-clear"
            disabled={busy}
            label="Clear"
            restingAriaLabel="Clear the Message of the Day — it disappears for everyone — click twice to confirm"
            confirmAriaLabel="Confirm clear the Message of the Day"
            onConfirm={() => clear.mutate()}
          />
        </div>
      </form>
    </>
  );
}
