# PLAN-021: AI capabilities — Open WebUI (GPU repair, models, RBAC, image-gen, advertise)

- **Status:** ✅ **COMPLETED** — the AI ops wave shipped per the session-3 chronicle
  (`.agents/context/2026-07-11-session-wrap.md`): Ollama starter models on gasha01, Open WebUI
  group RBAC (small→all, large→Family+Admin), ComfyUI image-gen (Qwen workflow), and the
  AI-usage-metrics sub-tab are live. **Deferred threads that live ON as separate future work (NOT
  this plan):** GPU repair / 2nd 3090 (owner-present, Q-02) and the Q&A agent (its own future plan,
  Q-03). Filed to completed/ during the 2026-07-11 board audit. <!-- Draft → Executing → Completed -->

## Owner rulings (2026-07-10 — normative, override conflicting parts/TODOs below)

- **GPU (Q-02): DEFERRED ENTIRELY.** Part (a) stays a documented runbook only; everything else is
  built assuming CURRENT single-GPU capacity. No talosw01 reboot / spare-swap this round. Revisit
  when usage metrics show it's needed.
- **Models (Q-01): balanced starter, ~150GB ceiling on the gasha01 mount** — a general chat model
  (verify current-best 70B-class quant), a fast small tool-capable model (~8B), and an embeddings
  model. gasha01 now also hosts the books libraries — respect the shared budget.
- **Model + image-gen RBAC (Q-04, Q-05 resolved 2026-07-10):**
  - **Small models → ALL logged-in users** (Default+).
  - **Large models → Family + Admin only.**
  - **ComfyUI image generation → ALL users incl. Default** (the reused AppDaemon `image_qwen_Image_2512`
    workflow is lightweight — no need to gate it). **Future want (TODO, not this round):** a way to
    SWITCH the ComfyUI workflow to a higher-quality / upgraded-model workflow (likely role-gated when
    added) — right now everyone shares the one lightweight workflow.
  - **NO Open WebUI queue** — owner correctly noted an OWUI-level queue can't govern GPU contention
    (ComfyUI + AppDaemon + Home Assistant all hit the GPU independently). Keep gating simple; add
    USAGE METRICS instead so we know when to add gates/GPUs if AI gets popular.
- **Q&A agent (Q-03): DEFERRED to its own future plan** (needs its own design — tool-model choice,
  site-data scope, access control). Part (e) stays a research note.
- **NEW — AI usage metrics (owner requirement, Q-04 follow-on):** a usage view (distinct from
  PLAN-019 hardware/perf). **General users see aggregate-over-time: # chats, # image gens.** **Admins
  see the backend detail: who used it, how long, and for what.** Feasible: Open WebUI's DB carries
  `chat.user_id`/`created_at`/model + image outputs as files; the clean read path is the Open WebUI
  admin API (`OPENWEBUI_API_KEY`, already in 1P) synced into the app (the *arr-ledger pattern) and
  surfaced as an **AI sub-tab on the Metrics section** (reuses 017's full|limited level: limited =
  aggregate counts; full/admin = per-user attribution — mirrors the user-aware-metrics gating rule).
- **Satisfies:** PRD-001 new R-NN block (AI capabilities surface; who-can-pull-models RBAC;
  image generation; catalog advertisement); new ADR-NN (Open WebUI RBAC via its admin API +
  role model); new OPS-NN (GPU repair runbook, HaynesIntelligence); new DESIGN-NN (catalog AI
  card). Glossary (Open WebUI role, model pull, image-gen engine). Migration only if a role→AI
  grant column is added (Part c may reuse existing role plumbing — ADR decides). **ID
  reconciliation:** ceilings at authoring — ADR-036, DESIGN-015, migration 0030, R-116, T-105,
  OPS-007. Take next-free at authoring; re-grep first — parallel round-2 plans consume numbers.
- **Depends on:** none hard. Soft: shares the catalog/app surface (ADR-013) for Part (d); shares
  the role model for Part (c). GPU repair (a) gates model/image capacity (both GPUs needed for
  headroom). Not tied to the Metrics track (017–020), though GPU/DCGM metrics could later feed
  PLAN-019's Hardware tab.
- **TODO source:** owner backlog `haynes-ops/zprompt.md` §"Integrate with AI capabilities" +
  coordinator addition 2026-07-10 (ComfyUI image generation).

---

## Recon outcome (verified 2026-07-10)

- **Open WebUI** — deployed `apps/ai/open-webui` at `ai.haynesnetwork.com`, Authentik OIDC SSO
  (`ENABLE_OAUTH_SIGNUP=true`, `DEFAULT_USER_ROLE=user`), points at `ollama-prime`. So today ANY
  Plex-login user can chat; the owner is the only admin who can pull models. 1P item `openwebui`
  gets `OPENWEBUI_API_KEY` tonight (admin API for RBAC).
- **Ollama Prime** — `apps/ai/ollama/prime`, GPU node (`feature.node.kubernetes.io/nvidia-3090-gpu`),
  `OLLAMA_MODELS=/models` → **NFS `gasha01.haynesnetwork:/hdd-nfs-repl` subPath `misc/ollama/models`,
  currently EMPTY post-migration.** Models are gone → Open WebUI has nothing to serve until restocked.
- **ComfyUI** — `apps/ai/stable-diffusion/comfyui`, svc `comfyui:8188` (→
  `http://comfyui.ai.svc.cluster.local:8188`), ingress `comfyui.haynesops.com`, GPU runtimeClass.
  `resources/provisioning.sh` + `models.txt` bootstrap ALL required models into the image →
  workflows are self-sufficient. API-format workflows at `resources/api-workflows/`:
  `image_qwen_Image_2512_API.json` is text→image (the `02_qwen_Image_edit_*` variants need input
  images — out of scope for text-to-image). Consumer reference (which node inputs get patched:
  prompt/seed/dimensions): `hass-sandbox/appdaemon/providers/ai_providers/comfyui/comfyui_image_generation_provider.py`.
- **GPU fault** — HaynesIntelligence (`192.168.40.11`, glances host) should have two 3090s; owner
  **detached one from VM `talosw01`** because it was dropping off the bus. Capacity is halved until
  repaired — relevant to model/image throughput.

## Parts

**(a) GPU repair runbook — OWNER-PRESENT, document don't execute (OPS-NN).** Write the diagnostic
sequence, do NOT run it: on the **Proxmox host** — `dmesg | grep -i nvrm/nvidia/pcie/AER`, `lspci
-nnk | grep -iA3 nvidia`, IOMMU-group + `vfio-pci` binding check, PCIe link width/speed (`lspci
-vv` `LnkSta`); on the **VM `talosw01`** after the owner **reboots the VM to re-attach** —
`nvidia-smi`, `nvidia-smi -q | grep -i xid`, kernel Xid scan. Decision tree: bus-drop persists →
reseat / swap to the **spare 3090** the owner has on hand; passthrough config error → fix VM PCI
map. Runbook ends at "both GPUs healthy in `nvidia-smi`, node label present." OWNER executes; the
plan only writes the OPS doc + records evidence placeholders.

**(b) Ollama model management + storage budget.** Propose a **starter model set** (chat + a
tool-capable small model + an embeddings model) with per-model sizes and a **total budget on
gasha01** (models mount competes with all other `hdd-nfs-repl` content — tie to the 013/gasha01
storage concern). Deliverable: a documented pull list + a `helmrelease`-adjacent bootstrap note in
haynes-ops (owner runs the pulls, RBAC-gated per Part c). No app schema.

**(c) RBAC — who can pull models (+ use image-gen).** Formalize via the **Open WebUI admin API**
(`OPENWEBUI_API_KEY` from 1P `openwebui`): app maps its roles → Open WebUI roles (`admin` = can
pull models + configure; `user` = chat/generate only; optionally a `no-AI` tier). Document the role
model in the ADR; enforce pull-restriction is already Open WebUI-native (only admins pull) — this
part makes the mapping explicit + repeatable (a reconcile action, audited if it writes app state).
Reuse the app's existing role plumbing; add an `ai` section grant only if the owner wants in-app
gating of the AI catalog entry.

**(d) Advertise AI in the haynesnetwork catalog/app.** A catalog card (admin-curated URL →
`ai.haynesnetwork.com`, ADR-013) plus a short "what you can do" blurb (chat models available,
image generation, how to request a model). DESIGN-NN: the card + capability copy. This is the
user-facing payoff of (b)/(c)/(f).

**(f) ComfyUI image generation in Open WebUI (coordinator addition).** Wire Open WebUI's native
image settings in the haynes-ops helmrelease/admin config: `IMAGE_GENERATION_ENGINE=comfyui`,
`COMFYUI_BASE_URL=http://comfyui.ai.svc.cluster.local:8188`, and the **ComfyUI workflow JSON +
node-id input mapping REUSED from AppDaemon** (`image_qwen_Image_2512_API.json`; patch the same
prompt/seed/dimension nodes the `comfyui_image_generation_provider.py` patches) — do NOT invent a
new workflow. Image-gen availability respects the **same RBAC story as model pulls** where Open
WebUI allows gating. Note: single GPU is shared with other workloads and **capacity is halved until
Part (a)** re-attaches the second 3090 — flag rate/queue limits as a TODO-question.

**(e) STRETCH — haynesnetwork Q&A agent POC (separate research-level section, do NOT spec).** A bot
answering questions about `haynesnetwork.com`: local Ollama model with tool-calls (widely
available, but small-model tool-calling is the risk) vs a rate-limited, heavily access-controlled
API model to get a POC off the ground. Keep as a TODO-question + research note only; more GPUs /
new worker nodes would be needed for a durable local option.

## Verification

- Merge gate for the app-side deliverables (c RBAC mapping, d catalog card): lint, lint:css,
  typecheck, test, build. Unit test the role→Open-WebUI-role mapping + audited write if any.
- LIVE: catalog card renders + links to `ai.haynesnetwork.com`; a non-admin cannot pull a model
  (Open WebUI enforces); after (b) an admin has ≥1 chat model and it responds; after (f) an image
  generates from the Qwen workflow. OPS runbook (a) reviewed by owner (not executed by agent).
  Screenshots at 390px + desktop.

## Out of scope

Executing the GPU repair (owner-present); Ollama chart/node-count changes to add GPUs; the Q&A
agent beyond a research note; ComfyUI image-EDIT (input-image) workflows; any non-Open-WebUI AI
surface; GPU metrics on the Hardware tab (future 019 follow-up).

## TODO-questions (owner) — resolved 2026-07-10 except Q-05

- ~~Q-01 models~~ → balanced ~150GB starter (ruling above). ~~Q-02 GPU~~ → deferred.
  ~~Q-03 Q&A agent~~ → deferred to own plan. ~~Q-04 image-gen queue~~ → no queue; role-gate +
  usage metrics.
- **Q-05 (OPEN — the one blocker for the ops wave):** which role gets the **larger models +
  image generation**? (Small models = all users. Candidate: Family + admins. Name the role[s].)

## Dispatch shape (for owner go)

- **Ops wave (no app UX; dispatch on go + Q-05 answer):** (b) deploy the ~150GB starter models to
  gasha01, (c) Open WebUI group RBAC — small-to-all, larger-to-<Q-05 role>, (f) ComfyUI image-gen
  wiring gated to the same role. All haynes-ops config + Open WebUI admin-API, reversible.
- **AI-usage-metrics sub-tab (new app UX; own release, confirm surface first):** OWUI-API usage
  sync → new `ai` sub-tab on the Metrics section; limited = aggregate # chats / # image gens over
  time, full/admin = per-user who/what/how-long. Sequenced after (or alongside) the ops wave.
- **(a) GPU runbook + (e) Q&A note:** docs-only, land with whichever release is convenient.
