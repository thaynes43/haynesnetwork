import 'server-only';
import { headers } from 'next/headers';
import { appRouter, createCallerFactory, createTRPCContext } from '@hnet/api';

const callerFactory = createCallerFactory(appRouter);

/**
 * Server-component/prefetch caller (DESIGN-003 D-03): same context factory as the
 * route handler, fed from the incoming request's headers so the Better Auth session
 * cookie flows through.
 */
export async function getServerCaller() {
  const h = await headers();
  const ctx = await createTRPCContext({ headers: h });
  return callerFactory(ctx);
}
