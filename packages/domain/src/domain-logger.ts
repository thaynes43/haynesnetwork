// ADR-093 / DESIGN-052 D-21 (PLAN-072) — the structured log seam the watchlist registry, the Registry Gate and the
// Trash sweep write their D-21 lines through. The sync CLI passes its JSON-lines SyncLogger (same shape); a web
// mutation (Expedite, the manual Expire now) falls back to `consoleDomainLogger`, which emits the same one-JSON-
// object-per-line format, so the Loki alerts match either path.
//
// NEVER logged (D-21): tokens, uuids, usernames, emails, a person's titles, which account lists a title. An account
// appears only as its class and `acct:<first 8 hex of sha256(account id)>` (`accountTag`).
import { createHash } from 'node:crypto';

export interface DomainLogger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

function emit(
  level: 'info' | 'warn' | 'error',
  message: string,
  fields?: Record<string, unknown>,
): void {
  const line = JSON.stringify({ level, time: new Date().toISOString(), msg: message, ...fields });
  if (level === 'info') console.log(line);
  else console.error(line);
}

/** JSON-lines console logger (the SyncLogger format). */
export const consoleDomainLogger: DomainLogger = {
  info: (message, fields) => emit('info', message, fields),
  warn: (message, fields) => emit('warn', message, fields),
  error: (message, fields) => emit('error', message, fields),
};

/** A silent logger (tests). */
export const silentDomainLogger: DomainLogger = { info: () => {}, warn: () => {}, error: () => {} };

/** D-21 — the only way an account appears in a log line: `acct:<first 8 hex of sha256(account id)>`. */
export function accountTag(plexAccountId: string): string {
  return `acct:${createHash('sha256').update(plexAccountId).digest('hex').slice(0, 8)}`;
}
