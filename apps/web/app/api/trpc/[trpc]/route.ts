import { fetchRequestHandler } from '@trpc/server/adapters/fetch';
import { appRouter, createTRPCContext } from '@hnet/api';

// DESIGN-003 — the single tRPC mount (donor: todos-for-dues route handler). Node
// runtime: the context reads the Better Auth session and the routers talk to Postgres.
export const runtime = 'nodejs';

const handler = (req: Request) =>
  fetchRequestHandler({
    endpoint: '/api/trpc',
    req,
    router: appRouter,
    createContext: () => createTRPCContext({ headers: req.headers }),
  });

export { handler as GET, handler as POST };
