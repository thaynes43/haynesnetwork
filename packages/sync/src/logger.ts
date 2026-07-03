// Structured console logging for the sync runner (DESIGN-005 D-14: CronJob logs are
// the per-run observability surface next to sync_runs). One JSON object per line so
// k8s log pipelines can parse fields without regexes.

export type SyncLogLevel = 'info' | 'warn' | 'error';

export interface SyncLogger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

function emit(level: SyncLogLevel, message: string, fields?: Record<string, unknown>): void {
  const line = JSON.stringify({
    level,
    time: new Date().toISOString(),
    msg: message,
    ...fields,
  });
  // stderr for warn/error so `kubectl logs` severity filters work; stdout otherwise.
  if (level === 'info') {
    console.log(line);
  } else {
    console.error(line);
  }
}

/** JSON-lines logger for the CLI/CronJob. */
export function createConsoleLogger(): SyncLogger {
  return {
    info: (message, fields) => emit('info', message, fields),
    warn: (message, fields) => emit('warn', message, fields),
    error: (message, fields) => emit('error', message, fields),
  };
}

/** Silent logger for tests. */
export const noopLogger: SyncLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};
