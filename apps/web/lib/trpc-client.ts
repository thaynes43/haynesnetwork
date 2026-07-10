import { createTRPCReact, type CreateTRPCReact } from '@trpc/react-query';
import type { inferRouterOutputs } from '@trpc/server';
import type { AppRouter } from '@hnet/api';

export const trpc: CreateTRPCReact<AppRouter, unknown> = createTRPCReact<AppRouter>();

/** Server-inferred tRPC query/mutation output types (e.g. `RouterOutputs['metrics']['apps']`). */
export type RouterOutputs = inferRouterOutputs<AppRouter>;
