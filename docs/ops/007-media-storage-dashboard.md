# OPS-007: Media storage dashboard — dashboard-as-code

- **Status:** Accepted — **shipped & live 2026-07-07** (PLAN-013). The dashboard is authored, pushed to
  `haynes-ops`, and sidecar-imported into Grafana's **Media** folder.
- **Implements:** ADR-030 C-02/C-04 (the Grafana half of the HYBRID surface); relates DESIGN-013.
- **Sibling repo:** `haynes-ops`
  `kubernetes/main/apps/observability/grafana/app/dashboards/media-storage-utilization.json`

How the media-library **free-space / utilization** Grafana dashboard is delivered as code, why it is a
**deep-link not an embed**, and the one data caveat (exportarr carries no total). Secret *values* never
appear here.

## 0. What it shows, in one breath

The media libraries are invisible to node-exporter and kubelet (ADR-030 C-02) — the only Prometheus
series for them is the `*-exportarr` sidecars' `{radarr,sonarr,lidarr}_rootfolder_freespace_bytes`,
labelled with the mount `path`. This dashboard plots **free space per root folder over time** (the
fill/drain trend), a **stat row of current free space per path**, and a **HaynesTower % used** gauge —
the historical companion to the app's native point-in-time utilization card.

## 1. The dashboard (uid `media-storage-utilization`)

- **Title:** "Media Storage — Utilization & Free Space"; **folder:** Media (uid `bfre4dl5p9xq8b`);
  **tags:** `media, storage, exportarr, plan-013`. Datasource `prometheus` (the default).
- **Panels:**
  1. **Stat row — current free per root folder:** `radarr_rootfolder_freespace_bytes`,
     `sonarr_rootfolder_freespace_bytes`, `lidarr_rootfolder_freespace_bytes` (`legendFormat {{path}}`,
     unit bytes, `lastNotNull`).
  2. **Timeseries — free space over time per root folder:** the same three metrics, unit bytes, `min 0`,
     with a **static threshold line at ~106 TB** (`105990000000000` = the HaynesTower 20%-free floor =
     the 80%-used target) rendered `custom.thresholdsStyle.mode: "line"`. Panel description documents
     it as the current static HaynesTower target (music/CephFS has no target).
  3. **Gauge — HaynesTower % used:** `(1 - radarr_rootfolder_freespace_bytes{path="/data/haynestower/
     Media/Movies"} / 529960000000000) * 100`, unit percent, green < 80 / red ≥ 80.

Live-validated 2026-07-07: gauge rendered **78.787% used**; radarr/sonarr both ~112.46 TB free (they
share the array); lidarr music ~130.45 TB free ≈ 25.4% used.

## 2. Deep-link (NOT embed) — the app coupling (ADR-030 C-04)

> **Amendment (2026-07-09, ADR-030 C-04 amendment / DESIGN-013 D-07):** the deep-link is **retired
> as the app's user-facing trend surface** — `grafana.haynesops.com` resolves LAN-only, so the card
> was a dead link off-LAN. The Storage tab now renders a **native trend chart** off `storage.trend`,
> which queries the in-cluster Prometheus directly:
> `http://prometheus-operated.observability.svc.cluster.local:9090` (the same URL this Grafana's
> datasource uses), **defaulted in code** and overridable via a `PROMETHEUS_URL` env on the
> haynesnetwork helmrelease (no env line is required for the default). This dashboard is unchanged
> and remains the LAN power tool; the app keeps a muted footnote link to it under the chart.

The app linked out to `https://grafana.haynesops.com/d/media-storage-utilization` (opens behind the
same Authentik SSO). It was **deliberately not iframe-embedded**: today the app + Grafana share
`haynesops.com` so an embed would be same-site, but at the `haynesnetwork.com` cutover (PLAN-008 R-64)
the Grafana session cookie becomes cross-site (SameSite=Lax stops flowing) and Authentik refuses
in-iframe login. The uid + deep-link are recorded in DESIGN-013 D-05 (now the footnote target).

## 3. Dashboard-as-code delivery (mirrors media-pipeline-resilience)

The JSON is committed to `haynes-ops` and delivered by a **`configMapGenerator`** in that dir's
`kustomization.yaml` (label `grafana_dashboard: "true"`, annotation `grafana_folder: Media`); the
Grafana sidecar (`searchNamespace: ALL`, `foldersFromFilesStructure`, `disableDelete`) auto-imports it.

```yaml
configMapGenerator:
  - name: grafana-dashboard-media-storage
    files:
      - dashboards/media-storage-utilization.json
    options:
      disableNameSuffixHash: true
      labels:
        grafana_dashboard: "true"
      annotations:
        grafana_folder: Media
```

**The JSON must be token-free** — `$__range`/`$__rate_interval`/`$__interval` are stripped (fixed
durations like `now-7d` used instead) so Flux `postBuild.substitute` can't blank Grafana's built-in
variables. This is the same discipline the sibling `media-pipeline-resilience.json` follows; the
kustomization comment records it.

**Authoring loop:** iterate live via the Grafana MCP (`update_dashboard` into the Media folder, verify
with `get_dashboard_by_uid` + a `query_prometheus` sanity check), then commit the finalized token-free
JSON to `haynes-ops` git as the source of truth. Git-sync provisioning remains authoritative; the MCP
is for authoring/preview only.

## 4. The data caveat (ADR-030 C-06)

exportarr's `*_rootfolder_freespace_bytes` carries **freeSpace only, no total**. So:
- The **trend** plots free-*bytes* with a static target line (not a %), which is robust as long as
  exportarr is scraped.
- The **% used gauge** bakes the array total (**529.96 TB**) in as a constant — **update it if the
  HaynesTower array grows**. The app's native card avoids this by reading `totalSpace` live from the
  *arr `GET /diskspace` API (the utilization source of record).
- There is **no HaynesTower node-exporter/SMART fallback** (it is external to the cluster, unscraped) —
  if exportarr stops, the Grafana trend blanks; the app's native diskspace card still works.

## 5. Rollback

Read-only/additive — revert the `haynes-ops` commit (drop the `configMapGenerator` entry + the JSON)
and reconcile; the sidecar removes the dashboard (`disableDelete` guards manual UI deletes, not a
provisioning removal). No secret to unwind.

## Related

- ADR-030 (the surface decision), DESIGN-013 (the native vertical + deep-link card), OPS-006 pattern
  for the `haynes-ops` cross-repo coupling discipline.
