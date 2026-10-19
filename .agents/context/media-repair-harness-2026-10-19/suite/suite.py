#!/usr/bin/env python3
"""Media repair harness suite tool (stdlib only).

  suite.py validate [--suite-dir DIR]   schema, ids, families, fixtures, minimum counts, manifest agreement; exit 1 on any error
  suite.py list     [--suite-dir DIR]   one line per case
  suite.py stats    [--suite-dir DIR]   counts by class, media type, split, flags
  suite.py manifest [--suite-dir DIR]   (re)write manifest.json from the case files and fixtures

The case schema is CONTRACT.md v1 (see README.md for the two additive keys this suite uses).
"""
import argparse, hashlib, json, re, sys
from collections import Counter, defaultdict
from pathlib import Path

HERE = Path(__file__).resolve().parent
VERSION = "dev-v1"
CLASSES = ["identity_mismatch", "corrupt_file", "decoder_incompatible", "metadata_naming", "order_edition_ambiguity", "insufficient_evidence", "healthy"]
MEDIA = ["movie", "tv", "epub", "audiobook"]
SOURCES = ["deterministic", "construction", "authoritative_metadata", "human_adjudication"]
ACTIONS = ["none", "escalate", "blocklist_and_search", "remap", "rename", "convert"]
WRITE_ACTIONS = {"blocklist_and_search", "remap", "rename", "convert"}
TOOLS = ["ffprobe", "decode_sample", "frame_sample", "audio_sample", "ocr", "epub_inspect", "audiobook_inspect", "arr_lookup"]
EVIDENCE_TOOLS = set(TOOLS) | {"prior_record"}  # prior_record = a pinned historical observation, never callable
FIXTURE_KINDS = ["local", "remote", "none"]
STATUSES = ["ok", "error", "timeout", "partial"]
FAIL_MODES = ["error", "timeout", "partial"]
OUTCOMES = ["repaired", "not_repaired"]
OFFENDER_FAMILIES = {"pokemon-houndour": "Pokemon", "mickey-roadster": "Mickey"}  # #992 families; at most 2 rows each in the dev split
MIN = {"total": 40, "healthy": 8, "abstain": 4, "per_other_class": 2, "inject": 3, "audiobook": 3, "outcome": 4, "per_media": 3}
MAX_FIXTURE = 200 * 1024
MAX_TOTAL = 3 * 1024 * 1024
TOP_KEYS = {"id", "suite_version", "split", "media_type", "family", "truth", "supported_actions", "solvable", "context", "fixture", "evidence",
            "tools_available", "provenance", "inject_tool_failure", "outcome_step"}
REQUIRED = TOP_KEYS - {"inject_tool_failure", "outcome_step"}
SECRET_RE = re.compile(r"(api[_-]?key|secret|passw(or)?d|bearer\s+[a-z0-9]|authorization:|sk-[a-z0-9]{10}|ghp_[a-z0-9]{10}|BEGIN [A-Z ]*PRIVATE KEY)", re.I)
HEX64 = re.compile(r"^[0-9a-f]{64}$")


def sha256_file(p):
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def load_cases(sd):
    out = []
    for p in sorted((sd / "cases").glob("*.json")):
        out.append((p, json.loads(p.read_text())))
    return out


def resolve_fixture(sd, fx):
    """Return (path or None, how). Local fixtures resolve under the suite dir (relative) or ~ (outside git)."""
    loc = fx.get("locator", "")
    if fx.get("kind") != "local":
        return None, "n/a"
    if loc.startswith("~/"):
        p = Path.home() / loc[2:]
        return (p if p.exists() else None), "outside-git"
    p = sd / loc
    return (p if p.exists() else None), "in-git"


def check_case(sd, path, c, errors, notes):
    e = lambda m: errors.append(f"{path.name}: {m}")
    miss = REQUIRED - set(c)
    if miss:
        e(f"missing keys {sorted(miss)}")
        return
    extra = set(c) - TOP_KEYS
    if extra:
        e(f"unknown top-level keys {sorted(extra)}")
    if c["id"] != path.stem:
        e(f"id {c['id']!r} does not match file name")
    if c["suite_version"] != VERSION:
        e(f"suite_version {c['suite_version']!r} != {VERSION}")
    if c["split"] not in ("dev", "heldout"):
        e(f"split {c['split']!r}")
    if c["media_type"] not in MEDIA:
        e(f"media_type {c['media_type']!r}")
    if not isinstance(c["family"], str) or not c["family"]:
        e("family must be a non-empty string")
    t = c["truth"]
    if not isinstance(t, dict) or t.get("class") not in CLASSES:
        e(f"truth.class {t.get('class') if isinstance(t, dict) else t!r}")
        return
    if t.get("source") not in SOURCES:
        e(f"truth.source {t.get('source')!r}")
    if not isinstance(t.get("ref"), str) or len(t["ref"]) < 20:
        e("truth.ref must say how the truth was established (>= 20 chars)")
    acts = c["supported_actions"]
    if not isinstance(acts, list) or not acts or any(a not in ACTIONS for a in acts):
        e(f"supported_actions {acts!r}")
        acts = []
    klass = t["class"]
    if klass == "healthy" and acts != ["none"]:
        e("a healthy case supports exactly ['none']")
    if klass in ("insufficient_evidence", "order_edition_ambiguity") and set(acts) & WRITE_ACTIONS and not (c.get("inject_tool_failure")):
        # only an injected-failure case may list a write action next to escalate (remaining evidence still settles it)
        e(f"{klass} must not support a write action: {acts}")
    if klass == "insufficient_evidence" and acts != ["escalate"]:
        e("insufficient_evidence supports exactly ['escalate']")
    if klass not in ("healthy", "insufficient_evidence", "order_edition_ambiguity") and not (set(acts) & WRITE_ACTIONS):
        e(f"{klass} needs at least one supported write action")
    if "none" in acts and len(acts) > 1:
        e("'none' cannot be combined with other actions")
    if not isinstance(c["solvable"], bool):
        e("solvable must be a boolean")
    ctx = c["context"]
    if not isinstance(ctx, dict) or not ctx.get("title") or not isinstance(ctx.get("expected"), dict) or "arr" not in ctx or "notes_for_model" not in ctx:
        e("context needs title, expected{}, arr and notes_for_model")
    # fixture
    fx = c["fixture"]
    if fx.get("kind") not in FIXTURE_KINDS:
        e(f"fixture.kind {fx.get('kind')!r}")
    elif fx["kind"] == "none":
        if fx.get("sha256") is not None:
            e("fixture.kind none must have sha256 null")
    else:
        if not isinstance(fx.get("sha256"), str) or not HEX64.match(fx["sha256"]):
            e("fixture.sha256 must be 64 hex chars")
        if not isinstance(fx.get("bytes"), int) or fx["bytes"] < 0:
            e("fixture.bytes")
        if fx["kind"] == "local":
            p, how = resolve_fixture(sd, fx)
            if p is None:
                if how == "in-git":
                    e(f"fixture {fx.get('locator')} is missing from the repository")
                else:
                    notes.append(f"{path.name}: outside-git fixture {fx.get('locator')} not present here; hash not re-checked")
            else:
                if sha256_file(p) != fx["sha256"]:
                    e(f"fixture hash mismatch for {fx['locator']}")
                if p.stat().st_size != fx["bytes"]:
                    e(f"fixture size mismatch for {fx['locator']}")
        if not fx.get("locator"):
            e("fixture.locator is required")
    # tools / evidence
    tools = c["tools_available"]
    if not isinstance(tools, list) or any(x not in TOOLS for x in tools):
        e(f"tools_available {tools!r}")
        tools = []
    ev = c["evidence"]
    if not isinstance(ev, list):
        e("evidence must be a list")
        ev = []
    ids = [x.get("id") for x in ev]
    if len(ids) != len(set(ids)) or any(not re.fullmatch(r"e\d+", str(i)) for i in ids):
        e("evidence ids must be unique e<N>")
    for x in ev:
        if x.get("tool") not in EVIDENCE_TOOLS:
            e(f"evidence {x.get('id')}: tool {x.get('tool')!r}")
        elif x["tool"] != "prior_record" and x["tool"] not in tools:
            e(f"evidence {x.get('id')}: tool {x['tool']} not in tools_available")
        if x.get("status") not in STATUSES:
            e(f"evidence {x.get('id')}: status {x.get('status')!r}")
        out = x.get("output")
        if isinstance(out, str):
            if len(out.encode()) > 8192:
                e(f"evidence {x.get('id')}: output over 8 KiB")
        elif isinstance(out, dict):
            if not (out.get("ref") and HEX64.match(str(out.get("sha256", "")))):
                e(f"evidence {x.get('id')}: output object needs ref and sha256")
        else:
            e(f"evidence {x.get('id')}: output must be text or {{ref, sha256}}")
    # injected failure
    inj = c.get("inject_tool_failure")
    if inj is not None:
        if inj.get("tool") not in tools:
            e(f"inject_tool_failure.tool {inj.get('tool')!r} is not in tools_available")
        if inj.get("mode") not in FAIL_MODES:
            e(f"inject_tool_failure.mode {inj.get('mode')!r}")
        if inj.get("tool") in [x.get("tool") for x in ev if x.get("status") == "ok"] and inj.get("tool") != "frame_sample":
            notes.append(f"{path.name}: injected tool {inj['tool']} also has ok pre-collected evidence (allowed if the failing call is a different one)")
    # outcome step
    o = c.get("outcome_step")
    if o is not None:
        if not o.get("check") or not isinstance(o.get("inputs"), dict) or o.get("expected") not in OUTCOMES:
            e("outcome_step needs check, inputs{}, expected in repaired|not_repaired")
        else:
            rf = o["inputs"].get("replacement")
            if isinstance(rf, dict) and rf.get("kind") == "local":
                p, how = resolve_fixture(sd, rf)
                if p is None:
                    e(f"outcome replacement {rf.get('locator')} is missing")
                elif sha256_file(p) != rf.get("sha256"):
                    e(f"outcome replacement hash mismatch for {rf['locator']}")
            else:
                e("outcome_step.inputs.replacement must be a local fixture object")
    if not isinstance(c["provenance"], str) or not (c["provenance"] == "new" or c["provenance"].startswith("reused from ")):
        e("provenance must be 'new' or start with 'reused from '")
    if SECRET_RE.search(json.dumps(c)):
        e("looks like it contains a secret or credential pattern")


def counts(cases):
    cs = [c for _, c in cases]
    by_class = Counter(c["truth"]["class"] for c in cs)
    by_media = Counter(c["media_type"] for c in cs)
    by_split = Counter(c["split"] for c in cs)
    matrix = defaultdict(Counter)
    for c in cs:
        matrix[c["truth"]["class"]][c["media_type"]] += 1
    flags = {"inject_tool_failure": sum(1 for c in cs if "inject_tool_failure" in c), "outcome_step": sum(1 for c in cs if "outcome_step" in c),
             "reused": sum(1 for c in cs if c["provenance"].startswith("reused")), "new": sum(1 for c in cs if c["provenance"] == "new"),
             "solvable": sum(1 for c in cs if c["solvable"]), "fixture_local": sum(1 for c in cs if c["fixture"]["kind"] == "local"),
             "fixture_remote": sum(1 for c in cs if c["fixture"]["kind"] == "remote"), "fixture_none": sum(1 for c in cs if c["fixture"]["kind"] == "none")}
    return by_class, by_media, by_split, matrix, flags


def validate(sd):
    errors, notes = [], []
    cases = load_cases(sd)
    for p, c in cases:
        check_case(sd, p, c, errors, notes)
    ids = [c.get("id") for _, c in cases]
    for i, n in Counter(ids).items():
        if n > 1:
            errors.append(f"duplicate id {i}")
    fam = defaultdict(set)
    for _, c in cases:
        fam[c.get("family")].add(c.get("split"))
    for f, s in fam.items():
        if len(s) > 1:
            errors.append(f"family {f!r} spans splits {sorted(s)}")
    good = [(p, c) for p, c in cases if not (REQUIRED - set(c))]
    by_class, by_media, by_split, matrix, flags = counts(good)
    n = len(good)
    if n < MIN["total"]:
        errors.append(f"only {n} cases, minimum {MIN['total']}")
    if by_class["healthy"] < MIN["healthy"]:
        errors.append(f"healthy controls {by_class['healthy']} < {MIN['healthy']}")
    abstain = by_class["insufficient_evidence"] + by_class["order_edition_ambiguity"]
    if abstain < MIN["abstain"]:
        errors.append(f"insufficient_evidence + order_edition_ambiguity {abstain} < {MIN['abstain']}")
    for k in CLASSES:
        if k not in ("healthy",) and by_class[k] < MIN["per_other_class"]:
            errors.append(f"class {k}: {by_class[k]} < {MIN['per_other_class']}")
    for m in MEDIA:
        if by_media[m] < MIN["per_media"]:
            errors.append(f"media {m}: {by_media[m]} < {MIN['per_media']}")
    if by_media["audiobook"] < MIN["audiobook"]:
        errors.append(f"audiobook cases {by_media['audiobook']} < {MIN['audiobook']}")
    if flags["inject_tool_failure"] < MIN["inject"]:
        errors.append(f"inject_tool_failure cases {flags['inject_tool_failure']} < {MIN['inject']}")
    if flags["outcome_step"] < MIN["outcome"]:
        errors.append(f"outcome_step cases {flags['outcome_step']} < {MIN['outcome']}")
    outs = Counter(c["outcome_step"]["expected"] for _, c in good if "outcome_step" in c)
    if outs and (outs["repaired"] < 1 or outs["not_repaired"] < 1):
        errors.append("outcome_step cases need both repaired and not_repaired")
    for f, label in OFFENDER_FAMILIES.items():
        k = sum(1 for _, c in good if c["family"] == f)
        if k > 2:
            errors.append(f"offender family {f} ({label}) has {k} rows, maximum 2")
    # fixture budget (in-git files only)
    total = 0
    for p in sorted((sd / "fixtures" / "media").glob("*")):
        sz = p.stat().st_size
        total += sz
        if sz > MAX_FIXTURE:
            errors.append(f"fixture {p.name} is {sz} B, over the 200 KiB limit")
    if total > MAX_TOTAL:
        errors.append(f"committed fixtures total {total} B, over 3 MiB")
    # manifest agreement
    mp = sd / "manifest.json"
    if not mp.exists():
        errors.append("manifest.json is missing (run: suite.py manifest)")
    else:
        m = json.loads(mp.read_text())
        if m.get("suite_version") != VERSION:
            errors.append("manifest suite_version mismatch")
        mc = {x["id"]: x for x in m.get("cases", [])}
        if set(mc) != set(ids):
            errors.append(f"manifest case ids differ from cases/: missing {sorted(set(ids) - set(mc))} extra {sorted(set(mc) - set(ids))}")
        for p, c in cases:
            x = mc.get(c.get("id"))
            if x and x["sha256"] != sha256_file(p):
                errors.append(f"manifest sha256 stale for {c['id']}")
        for fx in m.get("fixtures", []):
            fp = sd / fx["path"]
            if not fp.exists() or sha256_file(fp) != fx["sha256"]:
                errors.append(f"manifest fixture {fx['path']} missing or changed")
        if m.get("counts", {}).get("total") != n:
            errors.append("manifest counts.total stale")
    return errors, notes, good, (by_class, by_media, by_split, matrix, flags, total)


def cmd_validate(sd):
    errors, notes, good, (by_class, by_media, by_split, matrix, flags, total) = validate(sd)
    for n in notes:
        print("note:", n)
    for e in errors:
        print("ERROR:", e)
    print(f"{VERSION}: {len(good)} cases, {len(errors)} errors; committed fixtures {total / 1024:.0f} KiB; "
          f"healthy {by_class['healthy']}, abstain-class {by_class['insufficient_evidence'] + by_class['order_edition_ambiguity']}, "
          f"inject {flags['inject_tool_failure']}, outcome {flags['outcome_step']}, audiobook {by_media['audiobook']}")
    print("OK" if not errors else "FAILED")
    return 0 if not errors else 1


def cmd_list(sd):
    for p, c in load_cases(sd):
        flags = ("I" if "inject_tool_failure" in c else "-") + ("O" if "outcome_step" in c else "-") + ("R" if c["provenance"].startswith("reused") else "N")
        print(f"{c['id']:<24} {c['media_type']:<9} {c['truth']['class']:<24} {','.join(c['supported_actions']):<28} {c['split']:<4} {flags} {c['family']}")


def cmd_stats(sd):
    cases = load_cases(sd)
    by_class, by_media, by_split, matrix, flags = counts(cases)
    print(f"suite {VERSION}: {len(cases)} cases")
    print("by split:", dict(by_split))
    print("by media type:", {m: by_media[m] for m in MEDIA})
    print("by class:", {k: by_class[k] for k in CLASSES})
    print("flags:", flags)
    print(f"\n{'class':<26}" + "".join(f"{m:>11}" for m in MEDIA) + f"{'total':>8}")
    for k in CLASSES:
        print(f"{k:<26}" + "".join(f"{matrix[k][m]:>11}" for m in MEDIA) + f"{by_class[k]:>8}")
    fams = Counter(c["family"] for _, c in cases)
    print("\nlargest families:", fams.most_common(6))


def cmd_manifest(sd):
    cases = load_cases(sd)
    by_class, by_media, by_split, matrix, flags = counts(cases)
    fixtures = []
    for sub in ("media", "probes"):
        for p in sorted((sd / "fixtures" / sub).glob("*")):
            fixtures.append({"path": f"fixtures/{sub}/{p.name}", "sha256": sha256_file(p), "bytes": p.stat().st_size})
    for name in ("gen_media.sh", "gen_epub.py", "make_replay.py"):
        p = sd / "fixtures" / name
        fixtures.append({"path": f"fixtures/{name}", "sha256": sha256_file(p), "bytes": p.stat().st_size})
    external = {}
    for _, c in cases:
        fx = c["fixture"]
        if fx["kind"] in ("remote",) or (fx["kind"] == "local" and fx["locator"].startswith("~/")):
            external[fx["locator"]] = {"locator": fx["locator"], "kind": fx["kind"], "sha256": fx["sha256"], "bytes": fx["bytes"]}
    m = {"suite_version": VERSION, "contract": "CONTRACT.md v1 (harness/CONTRACT.md)", "gates": ".agents/context/media-repair-harness-2026-10-19/GATES.md",
         "base_commit": "9285641a", "built_by": "build_cases.py (deterministic)",
         "cases": [{"id": c["id"], "file": f"cases/{p.name}", "sha256": sha256_file(p), "split": c["split"], "media_type": c["media_type"],
                    "class": c["truth"]["class"], "family": c["family"], "supported_actions": c["supported_actions"]} for p, c in cases],
         "fixtures": fixtures, "external_fixtures": sorted(external.values(), key=lambda x: x["locator"]),
         "counts": {"total": len(cases), "by_split": dict(by_split), "by_media_type": {k: by_media[k] for k in MEDIA},
                    "by_class": {k: by_class[k] for k in CLASSES}, "class_by_media": {k: {m: matrix[k][m] for m in MEDIA} for k in CLASSES},
                    "inject_tool_failure": flags["inject_tool_failure"], "outcome_step": flags["outcome_step"], "reused": flags["reused"], "new": flags["new"]}}
    (sd / "manifest.json").write_text(json.dumps(m, indent=1, sort_keys=False) + "\n")
    print(f"manifest.json: {len(cases)} cases, {len(fixtures)} committed files, {len(external)} external fixtures")
    return 0


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("command", choices=["validate", "list", "stats", "manifest"])
    ap.add_argument("--suite-dir", default=str(HERE))
    a = ap.parse_args(argv)
    sd = Path(a.suite_dir).resolve()
    return {"validate": cmd_validate, "list": lambda s: cmd_list(s) or 0, "stats": lambda s: cmd_stats(s) or 0, "manifest": cmd_manifest}[a.command](sd)


if __name__ == "__main__":
    sys.exit(main())
