'use client';

// ADR-017 / DESIGN-007 D-06 (R-25..R-28) — self-service Plex library access. A signed-in user
// sees the libraries their Role allows, grouped per server, and adds/removes access on their
// OWN Plex account. Add is a plain action; Remove is destructive → the @hnet/ui ConfirmButton
// inline two-step (CLAUDE.md rule 8 / ADR-014 — never window.confirm). Non-permitted libraries
// are never offered (the query returns only the allowed set). No layout reorientation on
// interaction (ADR-015): the action cell reserves width and the ConfirmButton reserves its
// armed-label width, so arming/removing never reflows neighbors. Mutations invalidate-and-refetch.

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
  const busy = add.isPending || remove.isPending;

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
              ) : !server.friendMatched ? (
                <span className="plex-server__note" role="status">
                  Your account isn’t a Plex friend of this server yet — ask an admin to add you.
                </span>
              ) : null}
            </div>
            <ul className="plex-lib-list">
              {server.libraries.map((lib) => (
                <li className="plex-lib-row" key={lib.id}>
                  <span className="plex-lib-name">
                    {lib.name}
                    <span className="plex-lib-type muted"> · {lib.mediaType}</span>
                  </span>
                  <span className="plex-lib-action">
                    {lib.shared ? (
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
