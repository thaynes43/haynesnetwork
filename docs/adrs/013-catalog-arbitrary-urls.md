# ADR-013: Catalog accepts arbitrary user-supplied URLs with normalization

- **Status:** Accepted
- **Date:** 2026-07-05
- **Deciders:** Tom Haynes

## Context and problem statement

The app catalog originally forced every tile URL to `https://<sub>.haynesnetwork.com`
(R-14, and CLAUDE.md hard rule 3). That restriction was enforced at **four layers** — a zod
regex at the tRPC edge, a domain-writer assertion, a DB CHECK constraint, and a unit test —
and its stated purpose was to keep LAN-only `*.haynesops.com` ingresses from ever appearing
as a user-facing link (ADR-006 C, R-14).

The owner now wants the catalog to display links to **any** of his domains and to arbitrary
external sites (documentation, dashboards, third-party tools), entered as a **plain string**
in the admin console rather than a scheme-qualified `haynesnetwork.com` subdomain. The
whitelist is now friction with no matching threat: the catalog is admin-curated (only Admins
write catalog rows, ADR-004), so there is no untrusted-input vector to defend against with a
host allowlist.

ADR-006 (Accepted, **immutable**) documents the staging ingress
`haynesnetwork.haynesops.com` on `traefik-internal` for in-cluster validation — a real
LAN-only host on the very domain the old rule banned. The owner reviewed that fact directly
and, with it in front of them, chose to remove the host guard entirely anyway (see
BRANCH-A below), accepting that an admin could now paste a LAN-only or otherwise internal
link into a tile.

## Decision drivers

1. **Owner intent** — display links to any domain, not just `*.haynesnetwork.com`.
2. **Plain-string ergonomics** — an admin should be able to type `google.com` or
   `www.example.com` without remembering to prefix a scheme.
3. **Admin-curated, low threat** — catalog writes are Admin-only (ADR-004); the host
   allowlist guarded against a vector that does not exist here.
4. **Keep a real safety floor** — reject things that are not navigable web links
   (`javascript:`, `mailto:`, embedded credentials) so a tile can never carry a hostile or
   nonsensical href.
5. **One normalizer, one source of truth** — the same normalization must apply at the edge,
   in the domain writer, and in the stored value, so the DB always holds a canonical URL.

## Considered options

- **BRANCH-A — no host rules at all** (chosen). Any well-formed `http(s)` URL is accepted,
  including `*.haynesops.com`. Simplest model; matches "admin curates, we don't second-guess
  the host." Trade-off: an admin can add a LAN-only/internal link that off-network users
  cannot reach.
- **BRANCH-B — keep a soft `*.haynesops.com` deny** while allowing every other host. Retains
  one thread of the old 4-layer guard for the single host class ADR-006 makes reachable.
  Rejected: reintroduces a host-classification layer (and its test target) for a case the
  owner explicitly accepted, and still cannot distinguish "internal" third-party hosts it
  doesn't know about — so it buys little while keeping the complexity the change is removing.
- **Status quo — keep the `*.haynesnetwork.com` whitelist.** Rejected: it is the exact
  restriction the owner is retiring.

The owner chose **BRANCH-A** with the ADR-006 staging-ingress fact explicitly in view.

## Decision outcome

Chosen option: **BRANCH-A — the catalog accepts any normalized `http(s)` URL, with no host
allow/deny list.**

- Catalog URLs are entered as a **plain string**. A single normalizer,
  `normalizeCatalogUrl`, canonicalizes common forms:
  - a bare or `www.` host with no scheme (`google.com`, `www.google.com`) defaults to
    `https://`;
  - an explicit scheme is preserved (`http://` stays `http://`, `https://` stays `https://`);
  - a bare `host:port` (`plex.example.com:32400`) is treated as a host, not a scheme, and
    still defaults to `https://`;
  - the lone trailing slash a bare host picks up is trimmed for a clean canonical value.
- The **only floor** is: the result must parse as an `http:`/`https:` URL with **no** embedded
  credentials (`user:pass@`) and a host that is a real domain (contains a dot), an IP, or
  `localhost` — so obvious typos (`eeeee`) and interior whitespace are rejected. Everything
  else (`javascript:`, `mailto:`, `ftp://`, blank input) is rejected with a specific message.
- **No host allow/deny logic anywhere.** `*.haynesops.com`, arbitrary external hosts, and
  `*.haynesnetwork.com` are all equally acceptable.
- The **domain layer stays the single writer**: it normalizes + validates authoritatively and
  stores the **canonical** URL (not the raw input), so DB rows and audit rows carry the
  canonical form. The tRPC edge schema stays lenient (trim + non-empty); the web client keeps
  an identical mirror of the normalizer for live UX only.

### Consequences

| ID | Consequence |
|----|-------------|
| C-01 | Good: admins can point a tile at any domain or external site, typed as a plain string; scheme-less and `www.` forms are normalized automatically. R-14's host restriction is retired (PRD-001 amends R-14 in place; AC-04 relaxes to "a valid http(s) URL"; R-10 softens to "their configured URL"). |
| C-02 | Bad (accepted): with no host guard, an Admin can add a LAN-only/internal link (e.g. a `*.haynesops.com` staging host per ADR-006, or any private host) that off-network users cannot reach. The owner accepted this trade-off with the ADR-006 staging ingress explicitly in view — the catalog is admin-curated (ADR-004), so this is a curation choice, not an untrusted-input risk. |
| C-03 | Good: the 4-layer host allowlist collapses to a single **scheme backstop**. The DB CHECK becomes a scheme-only constraint (`app_catalog_url_scheme`, `url ~ '^https?://'`, new migration `0008_relax_catalog_url.sql`); the zod regex is gone; the domain writer is the authoritative normalize/validate point. |
| C-04 | Good: reverse-tabnabbing is already mitigated independently of the host rule — dashboard tiles open with `rel="noopener" target="_blank"`, so accepting arbitrary external origins does not add a new tabnabbing surface. |
| C-05 | Note: `ForbiddenHostError` (code `CATALOG_URL_FORBIDDEN_HOST`) is renamed **`InvalidCatalogUrlError`** (code **`CATALOG_URL_INVALID`**), since nothing about the host is forbidden any more — it now signals a URL that fails the scheme/credentials/parse floor. The tRPC mapping stays `UNPROCESSABLE_CONTENT`. Every cross-package reference uses the new name/code. |
| C-06 | Note: ADR-010's named unit-test target "validation rejecting `*.haynesops.com` (R-14)" is **retired** by this ADR — that host is now valid, so the assertion no longer exists. Its replacement is a normalizer contract test (scheme defaulting, scheme preservation, credential/`javascript:` rejection). ADR-010 is immutable and not edited; this note records the supersession. |

## More information

- **PRD-001:** amends R-14 in place (host restriction retired — catalog accepts any
  normalized `http(s)` URL), relaxes AC-04 ("every dashboard href is a valid http(s) URL"),
  and softens R-10 ("their configured URL").
- **CLAUDE.md:** hard rule 3 reworded — the `*.haynesnetwork.com`-only clause and the
  `*.haynesops.com` link ban are removed (catalog links are admin-curated, arbitrary URLs
  allowed); the server-side `*.svc.cluster.local` carve-out is kept.
- **Sibling ADRs:** ADR-006 (hosting; documents the `haynesnetwork.haynesops.com` staging
  ingress that C-02 accepts — **immutable, not edited**), ADR-004 (catalog writes are
  Admin-only), ADR-010 (test strategy; its `*.haynesops.com`-rejection target is retired per
  C-06 — **immutable, not edited**).
- **Normalizer:** `normalizeCatalogUrl` — authoritative copy in `packages/domain`, identical
  mirror in the web client; `assertCatalogUrl` throws `InvalidCatalogUrlError` on failure.
- **Migration:** `packages/db/migrations/0008_relax_catalog_url.sql` (drops the host CHECK,
  adds the `app_catalog_url_scheme` scheme backstop).
