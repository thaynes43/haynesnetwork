'use client';

import { useState, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { httpBatchLink } from '@trpc/client';
import { trpc } from './trpc-client';

// DESIGN-003 D-03 — tRPC v11 + httpBatchLink + React Query v5 (donor pattern; no wire
// transformer). React Query cache invalidation delivers AC-05's "next dashboard query
// or live refresh" semantics (ADR-004 C-02).
export function TRPCProvider({ children }: { children: ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { staleTime: 5_000, refetchOnWindowFocus: false },
        },
      }),
  );
  const [trpcClient] = useState(() =>
    trpc.createClient({
      links: [
        httpBatchLink({
          url:
            typeof window === 'undefined'
              ? `${process.env.NEXT_PUBLIC_BASE_URL ?? 'http://localhost:3000'}/api/trpc`
              : '/api/trpc',
        }),
      ],
    }),
  );

  return (
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </trpc.Provider>
  );
}
