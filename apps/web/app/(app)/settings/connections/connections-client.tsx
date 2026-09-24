'use client';

// ADR-091 C-10 / DESIGN-050 D-08 / D-14 — the Connected apps list. Each row: the client name, where it sends the
// browser back to, when it connected and was last used, its scope chips, and Disconnect — the ADR-014 inline
// two-step confirm (hard rule 8), armed label "Confirm disconnect". ADR-015: the action slot reserves the width of
// the widest (bold, armed) label, so arming never moves the row, and a disconnected row stays in place showing
// "Disconnected" in that same slot until the page is next loaded (no reflow).
import { useState } from 'react';
import { ConfirmButton } from '@hnet/ui';
import type { ConnectionRow } from '@/lib/connections';
import { disconnectConnection } from './actions';

/** The two labels of the slot stacked in one grid cell: the slot is always as wide as the widest. */
function Reserved({ children }: { children: React.ReactNode }) {
  return (
    <span className="conn-reserve">
      <span>{children}</span>
      <span className="conn-reserve__ghost" aria-hidden="true">
        Confirm disconnect
      </span>
    </span>
  );
}

function Row({ row }: { row: ConnectionRow }) {
  const [state, setState] = useState<'connected' | 'pending' | 'disconnected'>('connected');
  const done = state === 'disconnected';
  return (
    <li className="conn-row" data-state={state} data-testid="connection-row">
      <div className="conn-row__main">
        <p className="conn-row__title">
          <strong>{row.clientName}</strong> <span className="muted">{row.redirectHost}</span>
        </p>
        {row.user ? (
          <p className="conn-row__user muted" data-testid="connection-user">
            {row.user.name} · {row.user.email}
          </p>
        ) : null}
        <p className="conn-row__meta muted">
          {row.connected} · {row.lastUsed}
        </p>
        <ul className="chips chips--list conn-row__chips">
          {row.chips.map((chip) => (
            <li key={chip} className="chip">
              {chip}
            </li>
          ))}
        </ul>
      </div>
      <div className="conn-row__action">
        {done ? (
          <span
            className="btn sm conn-row__done"
            role="status"
            data-testid="connection-disconnected"
          >
            <Reserved>Disconnected</Reserved>
          </span>
        ) : (
          <ConfirmButton
            className="btn sm danger conn-row__disconnect"
            data-testid="connection-disconnect"
            disabled={state === 'pending'}
            label={<Reserved>Disconnect</Reserved>}
            confirmLabel={<Reserved>Confirm disconnect</Reserved>}
            restingAriaLabel={`Disconnect ${row.clientName} — click twice to confirm`}
            confirmAriaLabel={`Confirm disconnect ${row.clientName}`}
            reArmOnFailure
            onConfirm={async () => {
              setState('pending');
              const result = await disconnectConnection(row.clientId, row.userId);
              setState(result === 'ok' ? 'disconnected' : 'connected');
              return result;
            }}
          />
        )}
      </div>
    </li>
  );
}

export function ConnectionsClient({ rows }: { rows: ConnectionRow[] }) {
  if (rows.length === 0) {
    return (
      <p className="muted" data-testid="connections-empty">
        No connected apps yet.
      </p>
    );
  }
  return (
    <ul className="conn-list" data-testid="connections-list">
      {rows.map((row) => (
        <Row key={row.key} row={row} />
      ))}
    </ul>
  );
}
