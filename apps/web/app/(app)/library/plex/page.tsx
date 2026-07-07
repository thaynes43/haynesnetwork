'use client';

// ADR-017 / DESIGN-007 D-06 (R-25..R-28) — self-service Plex library access. A signed-in user
// sees the libraries their Role allows, grouped per server, and adds/removes access on their
// OWN Plex account. Add is a plain action; Remove is destructive → the @hnet/ui ConfirmButton
// inline two-step (CLAUDE.md rule 8 / ADR-014 — never window.confirm). Non-permitted libraries
// are never offered (the query returns only the allowed set). No layout reorientation on
// interaction (ADR-015): the action cell reserves width and the ConfirmButton reserves its
// armed-label width, so arming/removing never reflows neighbors. Mutations invalidate-and-refetch.
//
// ADR-024 / DESIGN-007 D-13 — per-server all-libraries self-service. When the caller's role
// all-grants a server, its header carries a segmented "All libraries | Specific libraries"
// control (a segment names each state, so neither reads as "off"; both segments always render,
// so toggling changes tint only — ADR-015). While the account is all-libraries the rows are
// read-only ("Included") — per-library add/remove is refused server-side (PLEX_ALL_STATE), so
// the controls are simply not offered; the state note under the header explains that leaving
// All keeps today's libraries but stops new ones arriving automatically. Leaving All is
// LOSSLESS (the explicit list is seeded with the current full set) and instantly reversible,
// so it is a plain action — no two-step confirm (ADR-014 reserves that for destructive acts);
// the always-visible note is the "explanation before the click". The All↔explicit swap changes
// only THIS server block, in place: rows keep their height (the action cell reserves the
// button height) and the note area swaps same-shape text.

import { useState } from 'react';
import { ConfirmButton } from '@hnet/ui';
import { trpc } from '@/lib/trpc-client';
import { describeMutationError } from '@/lib/app-error';

export default function MyPlexPage() {
  const utils = trpc.useUtils();
  const query = trpc.plex.myLibraries.useQuery();
  const [error, setError] = useState<string | null>(null);

  const invalidate = () => utils.plex.myLibraries.invalidate();
  const add = trpc.plex.addLibrary.useMutation({
    onError: (err: unknown) => setError(describeMutationError(err)),
    onSuccess: () => setError(null),
    onSettled: invalidate,
  });
  const remove = trpc.plex.removeLibrary.useMutation({
    onError: (err: unknown) => setError(describeMutationError(err)),
    onSuccess: () => setError(null),
    onSettled: invalidate,
  });
  // ADR-024 — toggle the caller's own account between all-libraries and an explicit list.
  const setAll = trpc.plex.setServerAll.useMutation({
    onError: (err: unknown) => setError(describeMutationError(err)),
    onSuccess: () => setError(null),
    onSettled: invalidate,
  });
  const busy = add.isPending || remove.isPending || setAll.isPending;

  if (query.isLoading) return <p className="muted">Loading your libraries…</p>;
  if (query.error) {
    return (
      <p className="alert" role="alert">
        Failed to load: {query.error.message}
      </p>
    );
  }

  const servers = query.data?.servers ?? [];

  return (
    <>
      <div className="admin-head">
        <h1 className="page-title">My Plex libraries</h1>
      </div>
      <p className="muted">
        Add or remove Plex libraries on your own account. You only see the libraries your role
        allows — changes apply to your Plex account across the Haynes servers.
      </p>
      {error ? (
        <p className="alert" role="alert">
          {error}
        </p>
      ) : null}

      {servers.length === 0 ? (
        <p className="muted">No Plex libraries are available to your role yet.</p>
      ) : (
        servers.map((server) => (
          <section className="plex-server" key={server.slug} aria-label={server.name}>
            <div className="plex-server__head">
              <h2 className="plex-server__name">{server.name}</h2>
              {!server.available ? (
                <span className="plex-server__note" role="status">
                  Couldn’t reach this server — try again shortly.
                </span>
              ) : server.owner ? (
                // ADR-029 — the caller IS this server's Plex owner; every library is already
                // theirs. No add/remove/friend controls apply — the owner can't "add" access
                // they inherently have, and they are never in their own friend list.
                <span className="plex-server__note" role="status">
                  You own {server.name} — all libraries are already yours.
                </span>
              ) : !server.friendMatched ? (
                // ADR-029 / fix/plex-identity-mapping — matched neither the owner nor any Plex
                // friend. The common real case is a local Authentik account with no Plex identity,
                // OR an account whose sign-in email differs from its plex.tv email — an admin can
                // pin the real Plex email/username on /admin/users so matching resolves.
                <span className="plex-server__note" role="status">
                  This account isn’t linked to a Plex identity on {server.name}. Sign in with Plex
                  to manage your libraries — or ask an admin to set your Plex email or username so we
                  can match your account.
                </span>
              ) : null}
              {!server.owner && server.allGranted ? (
                <div
                  className="plex-mode"
                  role="group"
                  aria-label={`Library access on ${server.name}`}
                  data-testid={`plex-all-toggle-${server.slug}`}
                >
                  <button
                    type="button"
                    className="plex-mode__btn"
                    data-testid="plex-mode-all"
                    aria-pressed={server.allActive}
                    disabled={busy || !server.available || !server.friendMatched}
                    onClick={() => {
                      if (!server.allActive) setAll.mutate({ serverId: server.id, on: true });
                    }}
                  >
                    All libraries
                  </button>
                  <button
                    type="button"
                    className="plex-mode__btn"
                    data-testid="plex-mode-specific"
                    aria-pressed={!server.allActive}
                    disabled={busy || !server.available || !server.friendMatched}
                    onClick={() => {
                      if (server.allActive) setAll.mutate({ serverId: server.id, on: false });
                    }}
                  >
                    Specific libraries
                  </button>
                </div>
              ) : null}
            </div>
            {server.owner ? null : server.allGranted ? (
              // Both states render the same-shape note (similar length, same element) so the
              // All↔explicit swap doesn't shift the list below (ADR-015).
              <p className="plex-mode__note" role="status">
                {server.allActive
                  ? `You’re receiving all current and future libraries on ${server.name}. ` +
                    `Choosing specific libraries keeps today’s set, but new libraries won’t be added automatically.`
                  : `You choose specific libraries on ${server.name}. New libraries won’t be added ` +
                    `automatically — switch to all libraries to always get everything.`}
              </p>
            ) : server.allActive ? (
              // The account is all-libraries but the role doesn't grant the toggle — read-only.
              <p className="plex-mode__note" role="status">
                You’re receiving all current and future libraries on {server.name} — this is
                managed by an admin.
              </p>
            ) : null}
            <ul className="plex-lib-list">
              {server.libraries.map((lib) => (
                <li className="plex-lib-row" key={lib.id}>
                  <span className="plex-lib-name">
                    {lib.name}
                    <span className="plex-lib-type muted"> · {lib.mediaType}</span>
                  </span>
                  <span className="plex-lib-action">
                    {server.owner || server.allActive ? (
                      // Owner (ADR-029) or all-libraries state (ADR-024): everything is included.
                      // The owner owns every library; in the all state per-library add/remove is
                      // refused server-side (PLEX_ALL_STATE). Either way it is never offered.
                      <span className="plex-lib-included muted">Included</span>
                    ) : lib.shared ? (
                      <ConfirmButton
                        className="btn sm danger"
                        data-testid="plex-remove"
                        disabled={busy}
                        label="Remove"
                        restingAriaLabel={`Remove ${lib.name} on ${server.name} from your Plex account — click twice to confirm`}
                        confirmAriaLabel={`Confirm remove ${lib.name} on ${server.name}`}
                        onConfirm={() => remove.mutate({ libraryId: lib.id })}
                      />
                    ) : (
                      <button
                        type="button"
                        className="btn sm primary"
                        data-testid="plex-add"
                        disabled={busy || !server.available || !server.friendMatched}
                        onClick={() => add.mutate({ libraryId: lib.id })}
                      >
                        Add
                      </button>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ))
      )}
    </>
  );
}
