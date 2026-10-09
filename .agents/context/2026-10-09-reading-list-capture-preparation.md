# Reading-list successor: fresh capture preparation

haynes-ops #3644 merged `85ced847d15c92566e953e9ea816f41647ec2258` at 16:33:45Z.
Its final head passed 23 finite source/fixture checks and a clean advisory review.
This prepares the bounded native writer; it does not approve any production list stage.
The source README and protocol are `scripts/book-reading-list-stage/` in haynes-ops.

## Actual bounded read-only adapter compatibility

At 17:00:42.989Z–17:00:43.344Z, a single serial `nice -n 19` native child used the
actual deployed Libretto KavitaTarget with a hard 30s child / 5s-request deadline and
eight-request ceiling. The six actual calls were recipes GET, plugin authentication,
reading-list listing, existing list 10's item read and two series-volume reads. No
library/list write, provider/acquisition request, Job, service/config change or full
library scan occurred. Normal library and acquisition settings remained running.

List 10 returned three native items with 25 fields, including item/chapter/volume IDs,
order and progress payloads. Fresh chapters for series 61 and 506 returned one and two
chapters respectively, each with 81 fields. Every selected item referenced an actual
returned chapter. The five required native adapter methods were present. The actual
`target/kavita.js` SHA-256 was
`fe42e5d845332f264823f3a60a9c5f12524fd75ceba1fa5511a2c0c6b100e671`.

The private full-payload artifact is
`/tmp/hn-825-reading-list-interface-1009/actual-private-interface-proof.json`, SHA-256
`25c73632bfd08021dbe9d32d976c4ff58168266eb422e68fc46379d38f1bc455`.
This proves actual interface/payload compatibility only. It does not establish
canonical source identity, full corpus/physical proof, desired membership or an
approved recipe. Its original clock naturally expired at 17:05:42.989Z; it must never
be used as an apply input after library recovery. User payloads remain private.

## Efficient fresh capture plan, not a frozen approval

After library recovery and an actual fresh 104-scope preview, capture one existing
ready unchanged recipe first; subsequent phases contain at most four. Begin the
original 300s evidence clock before the first native/store/source/scheduler read.
Retain every native item/chapter field wholesale; do not project a guessed schema or
reconstruct contributor boundaries from CSV. Preserve all old item IDs and every
non-order payload. Unproved works or physical chapter mappings remain held.

A proposed read-only capture helper must collect full parsed recipe payloads, complete
raw run-store SHA, all deployed JavaScript/JSON module hashes, Pod/ReplicaSet/Deployment
UID/spec/image/restart/readiness, timezone and installed scheduler's next execution.
It must retain actual fresh canonical work/contributor provider payloads and full
physical/source/state proofs in immutable private artifacts, with their original
capture starts and byte hashes. Root reviews their substance; an opaque `verified`
boolean cannot replace that proof. Input artifacts and native identity are re-read
before admission and each write ACK by the merged stage launcher.

Capture the full fresh native Books item index once, reuse that same in-memory index
across the phase's one-to-four matching calculations, and collect each selected series'
full current chapter payload once for the capture. Native stage execution independently
re-reads actual current matcher/chapter/list state. No disk cache write or provider
mutation is included. Cost must be measured within the original clock; the 355ms
representative check is not a promise for a complete library traversal.

The capture output must have runtime authorization false, no exact root approval and
no execution shortcut. Only after fresh independent review may root ratify the exact
approval SHA for the current phase. The writer retains its original 300s evidence /
180s child bounds, durable per-write before/intent/response/readback ACKs, outbound
no-delete barrier, current run/store rechecks and halt on unknown outcome. Normal
services, global acquisition and schedules remain on throughout list preparation.

SOURCE/MAIN v0.110.5 preparation is distinct from the consumed f062/v2/v3 packets.
Those bind old images and selections and are not restamped or adopted. Fresh full
native corpus closure and current primary PostgreSQL16 fences must precede the new
Pathfinder two-extra phase; this representative interface check supplies no COPY or
Ransom strip authority.
