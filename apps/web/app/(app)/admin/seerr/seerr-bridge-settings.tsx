'use client';

// ADR-111 C-03 / DESIGN-055 D-10 (PLAN-077 P7) — the Seerr replies settings on /admin/seerr: the kill switch for the
// two writes the app makes in Seerr (the fix-it-yourself comment on each new report, the resolve once the repair a
// report's guide ran has completed) and the Seerr user they post as. One form, one Save, audited
// (`update_app_setting`). The user is read live from Seerr so staff see whether it can post. Reflow-safe (hard rule 9):
// the status slot is reserved and the toggles change only their own box. Token colours only.
import { useState } from 'react';
import { trpc } from '@/lib/trpc-client';
import { describeMutationError } from '@/lib/app-error';
import { formatWhen } from '@/lib/media';
import { SEERR_URL } from '@/lib/seerr-issues';

interface Draft {
  comment: boolean;
  resolve: boolean;
  bridgeUserId: string;
}

export function SeerrBridgeSettings() {
  const utils = trpc.useUtils();
  const bridge = trpc.seerrIssues.bridge.useQuery(undefined, { refetchOnWindowFocus: false });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [status, setStatus] = useState<string>('');
  const save = trpc.seerrIssues.setBridge.useMutation({
    onSuccess: (next) => {
      setDraft(null);
      setStatus('Saved.');
      utils.seerrIssues.bridge.setData(undefined, next);
    },
    onError: (err) => setStatus(describeMutationError(err)),
  });

  if (bridge.isLoading) return <p className="muted">Loading the Seerr reply settings…</p>;
  if (bridge.error || !bridge.data) {
    return (
      <p className="alert" role="alert">
        Failed to load the Seerr reply settings: {bridge.error?.message ?? 'no answer'}
      </p>
    );
  }
  const { setting, user, seerr } = bridge.data;
  const value: Draft = draft ?? {
    comment: setting.comment,
    resolve: setting.resolve,
    bridgeUserId: setting.bridgeUserId !== null ? String(setting.bridgeUserId) : '',
  };
  const idText = value.bridgeUserId.trim();
  const parsedId = idText === '' ? null : Number(idText);
  const idValid = parsedId === null || (Number.isInteger(parsedId) && parsedId > 1);

  let userLine: string;
  if (seerr === 'unconfigured') userLine = 'Seerr is not configured here, so nothing can be posted.';
  else if (seerr === 'unreachable') userLine = 'Seerr could not be reached just now, so the user could not be checked.';
  else if (setting.bridgeUserId === null) userLine = 'No Seerr user is set, so nothing is posted.';
  else if (user?.problem) userLine = `Seerr user ${setting.bridgeUserId} cannot post: ${user.problem}.`;
  else userLine = `Posting as ${user?.displayName ?? 'the Seerr user'} (Seerr user ${setting.bridgeUserId}).`;

  return (
    <section className="card seerr-bridge" aria-labelledby="seerr-bridge-title" data-testid="seerr-bridge-settings">
      <h2 id="seerr-bridge-title">Replies in Seerr</h2>
      <p className="muted seerr-bridge__lead">
        The app can answer reports in <a href={SEERR_URL}>Seerr</a> itself, as its own Seerr user and never as an
        admin&rsquo;s account. Each new report gets one comment with its fix-it-yourself link and a promise that staff
        still help if that doesn&rsquo;t sort it out. A report is resolved, with a note saying what fixed it, only after
        a repair started from that report has completed.
      </p>
      <p className={`seerr-bridge__user ${user?.problem ? 'alert' : 'muted'}`} data-testid="seerr-bridge-user">
        {userLine}
      </p>
      <form
        className="admin-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (!idValid) return;
          setStatus('');
          save.mutate({ comment: value.comment, resolve: value.resolve, bridgeUserId: parsedId });
        }}
      >
        <ul className="check-list">
          <li>
            <label className="check-row">
              <input
                type="checkbox"
                checked={value.comment}
                onChange={(e) => setDraft({ ...value, comment: e.target.checked })}
              />
              <span>
                <strong>Comment on new reports</strong>
                <span className="muted seerr-bridge__hint">
                  One comment per report, worded for what was reported, with its link. Only reports filed after this is
                  turned on get it.
                  {setting.comment && setting.commentFrom ? ` On since ${formatWhen(setting.commentFrom)}.` : ''}
                </span>
              </span>
            </label>
          </li>
          <li>
            <label className="check-row">
              <input
                type="checkbox"
                checked={value.resolve}
                onChange={(e) => setDraft({ ...value, resolve: e.target.checked })}
              />
              <span>
                <strong>Resolve once the repair is done</strong>
                <span className="muted seerr-bridge__hint">
                  Only when the newest repair started from the report has completed and nothing started from it is
                  still running. A failed repair leaves the report open for staff.
                </span>
              </span>
            </label>
          </li>
        </ul>
        <label className="field seerr-bridge__field">
          <span>Seerr user id to post as</span>
          <input
            inputMode="numeric"
            value={value.bridgeUserId}
            onChange={(e) => setDraft({ ...value, bridgeUserId: e.target.value })}
            aria-invalid={!idValid}
          />
          <span className="field-hint">
            A local Seerr user with only the Manage Issues permission. Never 1, the owner&rsquo;s account. Clear it to
            stop every reply.
          </span>
        </label>
        <div className="form-actions">
          <button type="submit" className="btn primary" disabled={save.isPending || !idValid}>
            {save.isPending ? 'Saving…' : 'Save'}
          </button>
          <span className="muted seerr-bridge__status" role="status">
            {idValid ? status : 'The user id must be a number above 1.'}
          </span>
        </div>
      </form>
    </section>
  );
}
