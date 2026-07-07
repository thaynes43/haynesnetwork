'use client';

// DESIGN-010 D-04 — the Maintainerr safety banner, shared by /trash (the user-facing
// deletion surfaces) and /settings/trash (rules + operational settings — ADR-032 moved
// them out of the Trash tabs). Reserved height in every state (ADR-015): the banner
// recolors between loading/safe/warn/down, it never appears/disappears under the page.
import type { ReactNode } from 'react';

/** Structural mirror of the trash.status wire shape (DESIGN-010 D-08) — the client
 *  never imports server packages. */
export interface SafetyStatus {
  safe: boolean;
  reachable: boolean;
  version: string | null;
  integrations: Record<string, boolean>;
  armedRules: number;
  activeCollections: number;
}

const INTEGRATION_LABELS: Record<string, string> = {
  plex: 'Plex',
  radarr: 'Radarr',
  sonarr: 'Sonarr',
  tautulli: 'Tautulli',
  seerr: 'Seerr',
};

/** DESIGN-010 D-04 — the safety banner. Reserved height in every state (ADR-015). */
export function SafetyBanner({
  status,
  loading,
  failed,
}: {
  status: SafetyStatus | undefined;
  loading: boolean;
  failed: boolean;
}) {
  let state: 'loading' | 'safe' | 'warn' | 'down';
  let body: ReactNode;
  if (loading) {
    state = 'loading';
    body = <span className="muted">Checking Maintainerr…</span>;
  } else if (failed || status === undefined || !status.reachable) {
    state = 'down';
    body = (
      <span>
        <strong>Maintainerr is unreachable.</strong> Trash is read-only until it’s back — nothing
        can be saved, expedited, or edited.
      </span>
    );
  } else if (!status.safe) {
    const down = Object.entries(status.integrations)
      .filter(([, ok]) => !ok)
      .map(([k]) => INTEGRATION_LABELS[k] ?? k);
    state = 'warn';
    body = (
      <span>
        <strong>Maintainerr safety check failed</strong> — {down.join(', ')} not connected. Deletion
        actions are disabled until every integration is back (the watch/keep signal chain can’t be
        trusted without them).
      </span>
    );
  } else {
    state = 'safe';
    body = (
      <span>
        <strong>Maintainerr connected</strong>
        {status.version !== null ? ` · v${status.version}` : ''} · {status.armedRules} rule
        {status.armedRules === 1 ? '' : 's'} armed · {status.activeCollections} active collection
        {status.activeCollections === 1 ? '' : 's'}
      </span>
    );
  }
  return (
    <div className="trash-safety" data-state={state} data-testid="trash-safety" role="status">
      <span className="trash-safety__dot" aria-hidden="true" />
      {body}
    </div>
  );
}
