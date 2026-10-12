'use client';

// ADR-109 / DESIGN-055 D-01, D-09 (PLAN-077 P1) — the Repair Guide's settings on /admin/fixes: the per-remedy kill
// switch (`repair_guide_remedies`) and the Known-Issue Servers (T-314). One form, one Save, audited
// (`update_app_setting`). Every remedy ships off; staff turn each on after its live check. With every remedy off, Fix
// opens today's dialog. Reflow-safe (hard rule 9): the save-status slot is reserved, toggles only change their own box.
import { useState } from 'react';
import { trpc } from '@/lib/trpc-client';
import { describeMutationError } from '@/lib/app-error';

type Remedy = 'replacement_preview' | 'season_guard' | 'language_check' | 'playback_triage';

const REMEDIES: ReadonlyArray<{ key: Remedy; label: string; hint: string }> = [
  {
    key: 'replacement_preview',
    label: 'Check the replacement before deleting',
    hint: 'When a Fix would delete a file, it first looks up the release that would replace it. It refuses when that is the same release, or when nothing acceptable is available.',
  },
  {
    key: 'season_guard',
    label: 'Season guard',
    hint: 'A season Fix asks which episodes are wrong and never blocks a pack that also holds episodes marked fine. An episode Fix shows the other episodes its pack would cost.',
  },
  {
    key: 'language_check',
    label: 'Check the audio before a Wrong language Fix',
    hint: 'Reads the file’s audio tracks first. When the wanted language is already there, nothing is removed and the person is shown how to pick the track.',
  },
  {
    key: 'playback_triage',
    label: 'Check the play before a Won’t play Fix',
    hint: 'Looks for the person’s play on our servers first. When it never reached them, the guide points to our copy instead of replacing a working file.',
  },
];

export function RepairGuideSettings() {
  const utils = trpc.useUtils();
  const settings = trpc.fix.guideSettings.useQuery();
  // Unsaved edits; null means "show what is stored".
  const [draftRemedies, setRemedies] = useState<Record<Remedy, boolean> | null>(null);
  const [draftServers, setServers] = useState<ReadonlySet<string> | null>(null);
  const [status, setStatus] = useState<string>('');
  const remedies = draftRemedies ?? settings.data?.remedies ?? null;
  const servers = draftServers ?? new Set(settings.data?.knownIssueServers ?? []);

  const save = trpc.fix.setGuideSettings.useMutation({
    onSuccess: () => {
      setRemedies(null);
      setServers(null);
      setStatus('Saved.');
      void utils.fix.guideConfig.invalidate();
      void utils.fix.guideSettings.invalidate();
    },
    onError: (err) => setStatus(describeMutationError(err)),
  });

  if (settings.isLoading || remedies === null) return <p className="muted">Loading the Repair Guide settings…</p>;
  if (settings.error) {
    return (
      <p className="alert" role="alert">
        Failed to load the Repair Guide settings: {settings.error.message}
      </p>
    );
  }

  return (
    <section className="card repair-guide-settings" aria-labelledby="repair-guide-settings-title">
      <h2 id="repair-guide-settings-title">Repair Guide</h2>
      <p className="muted">
        Fix opens the Repair Guide for movies and TV once any check below is on. A check that is off is skipped. With
        all of them off, Fix works as it always has.
      </p>
      <form
        className="admin-form"
        onSubmit={(e) => {
          e.preventDefault();
          setStatus('');
          save.mutate({ remedies, knownIssueServers: [...servers] });
        }}
      >
        <ul className="check-list">
          {REMEDIES.map((r) => (
            <li key={r.key}>
              <label className="check-row repair-guide-settings__row">
                <input
                  type="checkbox"
                  checked={remedies[r.key]}
                  onChange={(e) => setRemedies({ ...remedies, [r.key]: e.target.checked })}
                />
                <span>
                  <strong>{r.label}</strong>
                  <span className="muted repair-guide-settings__hint">{r.hint}</span>
                </span>
              </label>
            </li>
          ))}
        </ul>
        <fieldset className="field">
          <legend>Servers with a known playback problem</legend>
          <p className="muted repair-guide-settings__hint">
            When someone&rsquo;s play reached only these servers, the guide suggests another server before a Fix.
          </p>
          <ul className="check-list">
            {(settings.data?.servers ?? []).map((s) => (
              <li key={s.slug}>
                <label className="check-row">
                  <input
                    type="checkbox"
                    checked={servers.has(s.slug)}
                    onChange={(e) => {
                      const next = new Set(servers);
                      if (e.target.checked) next.add(s.slug);
                      else next.delete(s.slug);
                      setServers(next);
                    }}
                  />
                  <span>{s.name}</span>
                </label>
              </li>
            ))}
          </ul>
        </fieldset>
        <div className="form-actions">
          <button type="submit" className="btn primary" disabled={save.isPending}>
            {save.isPending ? 'Saving…' : 'Save'}
          </button>
          <span className="muted repair-guide-settings__status" role="status">
            {status}
          </span>
        </div>
      </form>
    </section>
  );
}
