# ADR-029: Plex server-owner recognition in self-service My Plex

- **Status:** Accepted
- **Date:** 2026-07-07
- **Deciders:** Tom Haynes (owner) · ratified by Fable 5 (autonomous fix run)
- **Amends:** [ADR-017](017-plex-library-sharing.md) C-06 (the user→account map assumed the caller
  is always a *friend*; the server owner is a distinct, previously-unhandled case).

## Context and problem statement

`plex.myLibraries` (ADR-017 D-05) maps the signed-in app user to a Plex account by matching their
OIDC email against the server's **friend list** (`GET /api/users`) via `findFriendByEmail`. A
no-match sets `friendMatched: false` and the My Plex page shows *"Your account isn't a Plex friend
of this server yet — ask an admin to add you."*

The owner reported that exact message on staging (v0.15.0) despite logging in with a real Plex
account. Root cause, verified **live** against plex.tv on 2026-07-07 (GET-only, owner tokens):

- All three server tokens (`haynestower`, `haynesops`, `hayneskube`) authenticate as the **same
  owner account**, `manofoz@gmail.com` (plex.tv user id `12874060`, username `manofoz`). All three
  `machineIdentifier`s report `owned="1"` for that account (`GET /api/servers`).
- `manofoz@gmail.com` is **absent from every server's friend list** (`GET /api/users` — 40 friends
  each, zero matches). Plex never lists an owner as their own friend.

So friend-matching **structurally cannot** match the owner: `findFriendByEmail` always returns
null → `friendMatched: false` → the "not a friend" copy. The message is simply wrong for the owner,
who already owns every library. ADR-017 C-06 only modelled *friends*; the owner was an unhandled
gap (Q-06 assumed "already a friend").

A second, related confusion: the owner's app identity can be the **local Authentik
`admin@haynesnetwork.com` bootstrap account, which has no Plex identity at all**. When he signs in
via that account, his email matches neither the owner nor any friend — the same `friendMatched:
false` branch — so the old copy ("not a friend yet") misdescribes a *no-Plex-link* situation.
Signing in **via Plex** (email `manofoz@gmail.com`, on the `BOOTSTRAP_ADMIN_EMAILS` allowlist)
bootstraps him to Admin under his Plex email and is the identity that owner-recognition keys on.

## Decision drivers

- The owner must never see a broken "ask an admin" state for servers they own.
- Owner-recognition must be derived from Plex truth, not hard-coded emails (tokens can be reissued;
  the owner account is whatever the token authenticates as).
- Read-only, within the BC-04 ACL (no new writes; the `@hnet/plex/write` guard is untouched).
- Degrade gracefully: a plex.tv hiccup on the new lookup must not blank the page — fall back to
  today's friend flow.
- Copy for a genuinely unlinked account must be accurate, not "not a friend yet".

## Considered options

1. **Resolve the owner from the token account (`GET /api/v2/user`) and short-circuit to an
   owner state.** (Chosen.)
2. **Hard-code `manofoz@gmail.com` / `BOOTSTRAP_ADMIN_EMAILS` as "owners."** Rejected: couples the
   Plex-ownership fact to the app's admin allowlist (different concerns — an admin is not
   necessarily a server owner), and breaks if a token is reissued to another account.
3. **Add the owner to their own friend list.** Impossible — Plex does not model an owner as their
   own friend; `/api/users` will never return them.
4. **Leave it; tell the owner to ignore the message.** Rejected: it is a visible defect and the
   owner is the primary user.

## Decision outcome

Chosen option: **1**. The plex read client gains a cached `getOwnerAccount()` /
`getOwnerEmail()` over plex.tv `GET /api/v2/user` (JSON), consuming only `{ id, email, username }`
through a new `plexAccountSchema` (BC-04 ACL). `plex.myLibraries` resolves the owner email per
server and, when it equals the caller's email, returns a per-server **owner** state instead of
running the friend lookup.

### Consequences

| ID | Consequence |
|----|-------------|
| C-01 | Good: **Owner recognized per server.** `MyServer.owner` is true when the caller's email == the server's token-account email. Every library reports `shared: true` (implicitly the owner's); the UI shows *"You own {server} — all libraries are already yours"* with no add/remove/friend/all-toggle controls (ADR-015 in-place — the action cell keeps its "Included" geometry). Not the "not a friend" error, not a broken state. |
| C-02 | Good: **Derived from Plex, not hard-coded.** The owner is whatever `GET /api/v2/user` returns for each server token; reissuing a token to a different account moves ownership with it. The account is cached per client (stable for its lifetime). |
| C-03 | Good: **Read-only, ACL-bounded.** `/api/v2/user` is a GET; the consumed subset is zod-validated in `@hnet/plex/schemas`. No write surface changes — the `@hnet/plex/write` import guard is untouched. |
| C-04 | Good: **Graceful degradation.** If the owner lookup throws (plex.tv error/parse), `myLibraries` catches it and falls back to the friend flow (today's behavior); the server is **not** marked unavailable on that account alone. |
| C-05 | Good: **Accurate unlinked-account copy.** The `!friendMatched` (non-owner, non-friend) note now reads *"This account isn't linked to a Plex identity on {server}. Sign in with Plex to manage your libraries — or ask an admin to add you."* — correct for the local `admin@haynesnetwork.com` account (no Plex identity) and still fair for a genuine non-friend. |
| C-06 | Neutral: **One extra cached plex.tv GET per server** on first `myLibraries` load (then cached on the client singleton). Read-only and cheap; the non-owner path adds one round-trip before the existing friend lookup. |
| C-07 | Neutral: **Owner ⇒ Admin, but they are independent facts.** The owner signs in via Plex and bootstraps to Admin (email on `BOOTSTRAP_ADMIN_EMAILS`), so Admin already grants every library implicitly (ADR-017 C-03). Owner-recognition is orthogonal — it is keyed on the Plex token account, and the owner branch takes precedence over the `allGranted` all/specific control in the UI. |

## More information

- Amends ADR-017 C-06 (friend-only user→account map); ADR-017 Q-06 (owner as a friend) closed for
  the owner case. ADR-024 (all-libraries self-service) unchanged. ADR-015 (no reflow) honored.
- DESIGN-007 D-05/D-06 updated (the `owner` server state + owner/unlinked copy); D-14 added.
- Live verification 2026-07-07 (owner tokens, GET-only): `GET /api/v2/user` → `manofoz@gmail.com`
  (id 12874060) for all three tokens; `GET /api/users` → owner absent from all three friend lists;
  `GET /api/servers` → all three machine identifiers `owned="1"`.
