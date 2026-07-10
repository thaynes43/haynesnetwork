'use client';

// ADR-037 / DESIGN-016 D-05 — the Metrics section SHELL: a `?tab=`-driven sub-tab bar (the
// role="tablist" + roving-tabindex idiom shared with /trash · /library · /ledger · /settings/trash).
// Overview, Apps, Hardware (ADR-040 / DESIGN-020, PLAN-019), and Network are all live. ADR-015: the
// panel region swaps content in place.
import { Suspense, useEffect, useRef, type KeyboardEvent } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import type { MetricsLevel } from '@hnet/db';
import { OverviewTab } from './overview-tab';
import { AppsTab } from './apps-tab';
import { HardwareTab } from './hardware-tab';
import { NetworkTab } from './network-tab';

const METRICS_TABS = [
  { key: 'overview', label: 'Overview' },
  { key: 'apps', label: 'Apps' },
  { key: 'hardware', label: 'Hardware' },
  { key: 'network', label: 'Network' },
] as const;
type TabKey = (typeof METRICS_TABS)[number]['key'];

function resolveTab(raw: string | null): TabKey {
  return METRICS_TABS.some((t) => t.key === raw) ? (raw as TabKey) : 'overview';
}

function MetricsContent({ metricsLevel }: { metricsLevel: MetricsLevel }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const active = resolveTab(searchParams.get('tab'));
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  // Normalize a bare /metrics (or an unknown tab) to Overview — same replace-only contract as the
  // other hubs (no history spam, no scroll jump).
  useEffect(() => {
    if (searchParams.get('tab') !== active) {
      const params = new URLSearchParams();
      params.set('tab', active);
      router.replace(`${pathname}?${params.toString()}`, { scroll: false });
    }
  }, [searchParams, active, pathname, router]);

  const selectTab = (key: TabKey) => {
    const params = new URLSearchParams();
    params.set('tab', key);
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  };

  const onTabKeyDown = (e: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let nextIndex: number | null = null;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') nextIndex = (index + 1) % METRICS_TABS.length;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp')
      nextIndex = (index - 1 + METRICS_TABS.length) % METRICS_TABS.length;
    else if (e.key === 'Home') nextIndex = 0;
    else if (e.key === 'End') nextIndex = METRICS_TABS.length - 1;
    if (nextIndex === null) return;
    e.preventDefault();
    selectTab(METRICS_TABS[nextIndex]!.key);
    tabRefs.current[nextIndex]?.focus();
  };

  return (
    <>
      <h1 className="page-title">Metrics</h1>

      <div className="library-tabs" role="tablist" aria-label="Metrics sections">
        {METRICS_TABS.map((tab, index) => (
          <button
            key={tab.key}
            ref={(el) => {
              tabRefs.current[index] = el;
            }}
            type="button"
            role="tab"
            id={`metricstab-${tab.key}`}
            data-testid={`metricstab-${tab.key}`}
            aria-selected={active === tab.key}
            aria-controls="metrics-panel"
            tabIndex={active === tab.key ? 0 : -1}
            onClick={() => selectTab(tab.key)}
            onKeyDown={(e) => onTabKeyDown(e, index)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div id="metrics-panel" role="tabpanel" aria-labelledby={`metricstab-${active}`}>
        {active === 'overview' ? (
          <OverviewTab active metricsLevel={metricsLevel} />
        ) : active === 'apps' ? (
          <AppsTab active metricsLevel={metricsLevel} />
        ) : active === 'hardware' ? (
          <HardwareTab active metricsLevel={metricsLevel} />
        ) : active === 'network' ? (
          <NetworkTab active metricsLevel={metricsLevel} />
        ) : (
          <section className="card empty-state" data-testid={`metrics-comingsoon-${active}`}>
            <p className="muted">Coming soon — this view lands in a later release.</p>
          </section>
        )}
      </div>
    </>
  );
}

export function MetricsClient({ metricsLevel }: { metricsLevel: MetricsLevel }) {
  // useSearchParams needs a Suspense boundary in the App Router.
  return (
    <Suspense fallback={<p className="muted">Loading…</p>}>
      <MetricsContent metricsLevel={metricsLevel} />
    </Suspense>
  );
}
