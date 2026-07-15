'use client';

// ADR-060 / DESIGN-031 D-07 (PLAN-035) — the user-menu email opt-in (R-196): "email me when my
// tickets get replies or status changes". One check-row inside the avatar menu (no profile page
// exists; the menu IS the personal surface). Recolor-only state change (ADR-015 — the row never
// moves); tokens only (hard rule 2). The checked state derives from the query cache with a local
// optimistic override while the mutation flies; success writes the server truth back into the
// cache, failure drops the override (the stored value stands).
import { useState } from 'react';
import { trpc } from '@/lib/trpc-client';

export function EmailUpdatesToggle() {
  const pref = trpc.profile.notificationPreference.useQuery(undefined, { staleTime: 60_000 });
  const utils = trpc.useUtils();
  const [override, setOverride] = useState<boolean | null>(null);
  const checked = override ?? pref.data?.emailTicketUpdates ?? false;

  const save = trpc.profile.setNotificationPreference.useMutation({
    onSuccess: (data) => {
      utils.profile.notificationPreference.setData(undefined, data);
      setOverride(null);
    },
    onError: () => setOverride(null),
  });

  return (
    <label className="check-row check-row--inline usermenu__pref" data-testid="email-updates-toggle">
      <input
        type="checkbox"
        checked={checked}
        disabled={pref.isLoading || save.isPending}
        onChange={(e) => {
          const next = e.target.checked;
          setOverride(next);
          save.mutate({ emailTicketUpdates: next });
        }}
      />
      <span>Email me ticket updates</span>
    </label>
  );
}
