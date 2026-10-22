# The Stage R driver v2: `stage-r-driver-3`, registration `stage-r-2` (#165)

**Story:** OpenProject #165, epic #48, origin #160. **Plan:** `docs/pilot-plan-v3.md` v3.3. **Script:** `scripts/stage_r_driver_v2.py`.
**Tests:** `tests/test_stage_r_driver_v2.py`, fake runners only.

## Why, and the version names

The G0a pre-registration of Stage R pilot 1 (#160, PR #1037) found five things the #161 driver cannot express. This driver closes them as a new
opt-in version. **The #161 driver is unchanged, byte for byte.** That is `scripts/stage_r_driver.py`, labelled `stage-r-driver-2` in its state
since #1036, taking registration `stage-r-1`; a test pins its sha256. Because `stage-r-driver-2` is already that driver's label, the new driver is
**`stage-r-driver-3`**, and its registration is **`stage-r-2`**. Each driver refuses the other's registration.

The new driver subclasses the #161 one. It reuses, unchanged:
- every sampler operation and receipt rule;
- the listings and their completeness checks;
- the pod-health reads;
- the leak guard;
- WRITE-CONTROL and the unresolved-analysis stop;
- the final stat;
- the stop bookkeeping and the terminal state.

What it adds is listed below. Every new failure is a recorded stop: it has a `stop` with its phase and kind, the terminal `exit_code` 3, and no
further operation or target.

| Gap | What the driver does | Stop kind |
|---|---|---|
| **G-1, the library root** | `discovery.library_root` registers the TV root as path components below the selected mount, for example `["Media", "TV Shows"]`. Each component is a safe name: no `/`, `..`, NUL or control character. G0b reads the mount from `get deploy` as before, builds `<mount>/Media/TV Shows`, and lists that directory **directly** with the registered series prefix. It never lists the mount root or an intermediate folder. The listing stays descriptor-confined under the **mount** and must be complete, with exactly one series match. **Four `list` calls**, as before. | A missing root is the failed listing's own stop (`incomplete_listing` or the sampler's fatal kind), with the root named in the detail. |
| **G-2, the model tripwire** | After each G2 target, the driver reads the #159 call journal: `calls.log` and the reply copies, in the directory the registered path rule names (`{"env": "MRH_CALL_JOURNAL"}`, the shim's own variable). Only the lines appended during that target are read. The target's calls must all be paired (`start` and `stdout-closed`; a close is awaited up to 5 s, since the shim writes it after its tee ends). They must match the record's model turns one for one. Each successful call must report **exactly** the registered served model (one `modelUsage` key), and its total input tokens (input plus cache creation plus cache read) must not exceed `chars / divisor + slack_tokens`. Here `chars` is what the record shows the call sent: the system prompt plus the message (`chars_basis: sent`), or the system prompt alone (`system_prompt`). A call the journal marks failed is checked for whatever it reports: a served model other than the registered one, or usage over the limit when the record keeps its request, is a violation. Otherwise it is recorded as unverified, and the target's own record shows it. | `model_tripwire`: a violation, or a journal that cannot be read (a journal position that cannot be read before a target stops it before its harness run). An unset or non-absolute journal directory, or one that does not exist or is not readable and writable, is a pre-run stop. |
| **G-3, coordinator loss** | Before each target, in G1 and in G2, the driver checks that `os.getppid()` is unchanged since it started and is not 1. **In V2 a lost session pod kills the driver with it**, since every process of the pod dies. This check covers an **orphaned** driver: one whose parent died while the pod lives on. It is re-parented, to PID 1 or to a subreaper, so its parent id changes. | `coordinator_lost` |
| **G-4, the pre-run binding** | At start, before any operation, the driver verifies five things against `binding`. (1) The harness commit: `git rev-parse HEAD` of the tree the driver runs from, with `src/` and `scripts/` clean. (2) The sampler sha256. (3) The case-template digests. (4) The **config-hash basis**: the harness config is rebuilt from the registered arguments and the flags the driver adds, with the runner's own parser and `run_config`, and hashed with its one per-target field, `limits.max_total_cost_usd`, excluded. (5) The excluded field's name. After each G2 run, the recorded config must hash to its `config_hash`, its basis must be the registered one, the excluded field must be exactly the remainder the driver passed, and the recorded harness commit must be the registered one. The harness commit is also re-read before every target in G1 and G2, so a move stops the run before the next stat or model call. Because the G0b manifest commit would move that commit, **`--commit-repo` must be a separate clone**: at P0 the driver refuses a commit repository with the same `git rev-parse --show-toplevel` or the same `--git-common-dir` as the harness tree (a worktree of it included), or one it cannot identify. | `binding_mismatch`. Before any operation, nothing has run. |
| **G-5, the A0 expiry** | `--approved-at <ISO-8601 UTC>` (Tom's approval time) is required. The driver refuses to start without it, with a time that is not UTC, or with a time more than 5 minutes in the future (or so late that adding the expiry overflows the calendar: `approval_invalid`). It also refuses once now is past approval plus `approval.expiry_s` (at most 8 hours). Before each new target it stops once that point has passed. | `approval_missing`, `approval_invalid`, `approval_expired` |

The pre-run checks run as phase `P0`, in this order: the approval, the coordinator, the journal rule and directory, the commit repository, then the binding. They come before the first
`get deploy`, which is the read that consumes the approvals (plan §6).

## The registration (`stage-r-2`)

Every `stage-r-1` rule still applies (the #161 validator runs on the same registration), plus:

```json
{
  "registration": "stage-r-2",
  "discovery": {"mount_path_regex": "...", "library_root": ["Media", "TV Shows"], "series_prefix": "...", "season_dirs": {"...": "..."}},
  "model_journal": {"path_rule": {"env": "MRH_CALL_JOURNAL"}, "served_model": "<the harness --model>",
                    "tripwire": {"chars_basis": "sent", "divisor": 2.0, "slack_tokens": 5000}},
  "binding": {"harness_commit": "<40 hex>", "sampler_sha256": "<64 hex>", "case_templates_sha256": {"<key>": "<64 hex or inline>"},
              "config_hash_basis_sha256": "<64 hex>", "config_hash_excluded_field": "limits.max_total_cost_usd"},
  "approval": {"expiry_s": 28800}
}
```

- `discovery.library_root` needs at least one component.
- `served_model` must be the model the harness arguments request.
- `case_templates_sha256` must name every target.
- `case_templates_sha256` is of the exact bytes of each `case_template` file the driver parsed, from a single read at construction (not read again at P0).
- `config_hash_basis_sha256` is computed with `stage_r_driver_v2.config_basis(stage_r_driver_v2.config_of(harness_argv(...)))`, the same code the
  driver runs at P0.

Usage:

```
stage_r_driver_v2.py --registration G0A.json --out DIR --commit-repo DIR --approved-at 2026-10-22T09:00:00Z
```

`--commit-repo` must be a separate clone of the repository (the G0b commit must not move the harness tree's HEAD, which the registration binds).
`MRH_CALL_JOURNAL` must name the journal directory. That is the #159 registered launch, which already sets it for the shim.

The report (`scripts/stage_r_report.py`, `stage-r-report-1`) reads a `stage-r-driver-3` state as it reads a #161 one. Its roster rule now knows
`stage-r-2`, with the same counts as `stage-r-1`.

## Limits

- The tripwire reads the reply copies the shim keeps. A CLI that reports no `modelUsage` or no token usage for a successful call makes the journal
  unreadable, which is a stop.
- **The served-model rule is #159's registered rule:** exactly one `modelUsage` key, equal to the requested model. In #159's Opus run, all 117
  successful calls reported exactly `claude-opus-5-5` (`runs/dev-validity-opus55/devval-opus-5-5`, `turns[].meta.model_usage`). If a later CLI
  listed an auxiliary model too, or keyed the entry by another id, every call would stop. That stop fails safe, and allowing it would take a new
  registration version.
- The parent check sees an orphaned driver. It cannot tell a coordinator that is alive but stuck.
- The commit check binds `src/` and `scripts/`. The registration and its case templates are bound by their own digests.
- Like every #161 check, these have only run against fake runners, a scripted adapter and a synthetic journal: never in a pod, against the real CLI,
  or on real media.
