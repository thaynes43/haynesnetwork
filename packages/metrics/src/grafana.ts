// DESIGN-016 D-07 — the Metrics Grafana deep-links are ADMIN-ONLY. Grafana stays the verbose LAN power
// tool, deep-linked never embedded (ADR-030 C-04 / ADR-037 C-09); its dashboards resolve ONLY on the
// owner's LAN/VPN, so a non-admin viewer would only ever get dead links. The gate is the session's ADMIN
// status specifically — NOT the metrics level (a `full` non-admin like Family has the detail grant but
// not necessarily LAN access) — and it is enforced SERVER-SIDE in the payload SHAPE: the router attaches
// one of these link objects ONLY when the caller is an admin, so a non-admin response never contains a
// Grafana URL at all (the same never-serialize seam ADR-037 C-03 established for the level-shaped keys).
//
// This module is the single source of truth for the deep-link URLs (previously duplicated as per-tab
// client constants). The UI renders links only when its payload carries the matching `grafana` object,
// so member panels simply omit the links — reflow-free per ADR-015 (nothing appears/disappears on an
// interaction; the object's presence is fixed for the session by the caller's admin status).

/** The base Grafana origin (LAN-only). Single source of truth for every Metrics deep-link. */
export const GRAFANA_BASE_URL = 'https://grafana.haynesops.com';

/** Overview footnote target — root Grafana ("Full infra dashboards: Grafana"). */
export interface OverviewGrafanaLinks {
  base: string;
}

/** Apps sub-tab board targets (DESIGN-018 D-04 / OPS-008). */
export interface AppsGrafanaLinks {
  /** Collection + Acquisition-pipeline groups → the curated *arr library board. */
  library: string;
  /** Download-clients + Indexers groups → the curated downloads/clients/indexers board. */
  downloads: string;
}

/** Network sub-tab board targets (DESIGN-019). The Client-Insights board is DELIBERATELY absent. */
export interface NetworkGrafanaLinks {
  /** WAN + site + gateway rollups (UniFi-Poller: Network Sites). */
  sites: string;
  /** UAP Insights (access points). */
  uap: string;
  /** USW Insights (switches). */
  usw: string;
}

/** Hardware sub-tab board targets (DESIGN-020). */
export interface HardwareGrafanaLinks {
  /** Unraid NAS — HaynesTower (storage, disks & SMART) — the pool + footnote target. */
  nas: string;
  /** smartctl_exporter dashboard — the Drive-health group. */
  smart: string;
  /** Node Exporter Full — the Node-load group. */
  nodes: string;
  /** Grafana Explore — the Proxmox showcase (no dedicated pve board yet; DESIGN-020 Q-02). */
  pve: string;
}

export function overviewGrafanaLinks(): OverviewGrafanaLinks {
  return { base: GRAFANA_BASE_URL };
}

export function appsGrafanaLinks(): AppsGrafanaLinks {
  return {
    library: `${GRAFANA_BASE_URL}/d/arr-library-overview`,
    downloads: `${GRAFANA_BASE_URL}/d/downloads-clients-indexers`,
  };
}

export function networkGrafanaLinks(): NetworkGrafanaLinks {
  return {
    sites: `${GRAFANA_BASE_URL}/d/9WaGWZaZk`,
    uap: `${GRAFANA_BASE_URL}/d/g5wFWqxZk`,
    usw: `${GRAFANA_BASE_URL}/d/FsfxpWaZz`,
  };
}

export function hardwareGrafanaLinks(): HardwareGrafanaLinks {
  return {
    nas: `${GRAFANA_BASE_URL}/d/nas-haynestower`,
    smart: `${GRAFANA_BASE_URL}/d/f8f249a0-be78-41b1-97fe-8d0a92a71b93`,
    nodes: `${GRAFANA_BASE_URL}/d/rYdddlPWk`,
    pve: `${GRAFANA_BASE_URL}/explore`,
  };
}
