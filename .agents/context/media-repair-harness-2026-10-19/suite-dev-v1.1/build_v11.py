#!/usr/bin/env python3
"""Derive the dev-v1.1 case files from the frozen dev-v1 cases (stdlib only, deterministic).

  build_v11.py            write cases/*.json here from ../suite/cases/*.json
  build_v11.py --check    rebuild in memory and fail if cases/ differs (used by the tests)

Source of the rules: orders/media-repair-harness-1019/RULINGS-v1.1.md (C1, C2, C3, C5, C6; dev split only) and
../ADJUDICATION-dev-v1.md (rulings 2 to 13 and the cross-cutting rulings).  Only case JSON changes: labels, supported
sets, context, tools_available and the evidence that a ruling adds.  Fixture bytes, fixture objects, ids, families and
provenance are never touched (the tests compare them with dev-v1).  Every changed case carries a `corrections` list
whose entries start with the rule id.  A case no rule touches differs from its dev-v1 file only in `suite_version`.
"""
import argparse
import copy
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
V1 = HERE.parent / "suite" / "cases"
OUT = HERE / "cases"
ADJ = "ADJUDICATION-dev-v1.md"
WRITE = {"blocklist_and_search", "remap", "rename", "convert"}
EXPECTED_TOC = ["Chapter 1: Rain", "Chapter 2: Salt", "Chapter 3: Lanterns"]  # lr_good.epub, suite/fixtures/gen_epub.py (and epub-healthy-004's spine_heads)

# C6-fn (filename bias): defective classes whose entry name is the plain form get the style mix the healthy controls have.
FN_CLASSES = ("corrupt_file", "decoder_incompatible", "identity_mismatch")
FN_KEEP = {  # the filename is evidence in these cases (it names the content, not the entry) or already varied
    "tv-identity-003": "the name carries the content's episode title, which is evidence",
    "tv-identity-004": "the name carries the content's episode title, which is evidence",
    "epub-identity-005": "already in the 'Author - Title' style the healthy controls use",
}
FN_PATTERN = ["odd1", "std", "odd2", "std", "std"]  # 2 of 5 odd (the healthy controls with a name are 5 of 12)


def dumps(c):
    return json.dumps(c, indent=1, ensure_ascii=False, sort_keys=False) + "\n"


def note(c, text):
    c.setdefault("corrections", []).append(text)


def fn_variants(case, old):
    """-> {'odd1': name, 'odd2': name}; the extension of the old name is kept."""
    ext = old[old.rfind("."):]
    mt = case["media_type"]
    if mt == "tv":
        ep = int(old.split(" - ")[1][4:6])
        return {"odd1": f"hl.s01e{ep:02d}.1080p.web.h264-grp{ext}", "odd2": f"Harbor.Lights.S01E{ep:02d}.720p.WEB-DL.AAC2.0.H.264-GRP{ext}"}
    if mt == "movie":
        odd2 = "Quiet Orbit (2019) {edition-Theatrical}" + ext if (case["context"].get("expected") or {}).get("runtime_s") == 8 else "Quiet.Orbit.2019.720p.WEB-DL.x264-GRP" + ext
        return {"odd1": "Quiet.Orbit.2019.1080p.BluRay.x264-GRP" + ext, "odd2": odd2}
    if mt == "epub":
        return {"odd1": "Tolland, Mira - [Lantern Cycle 01] The Lantern Road" + ext, "odd2": "Mira Tolland - The Lantern Road" + ext}
    if ext == ".mp3":
        return {"odd1": "The Lantern Road (Unabridged) - part 1" + ext, "odd2": "Mira Tolland - The Lantern Road (Unabridged)" + ext}
    return {"odd1": "Mira Tolland - The Lantern Road (Unabridged)" + ext, "odd2": "The Lantern Road [Ellis Marr]" + ext}


def build():
    v1 = {}
    for p in sorted(V1.glob("*.json")):
        v1[p.stem] = (p.read_bytes().decode(), json.loads(p.read_text()))
    out = {cid: copy.deepcopy(c) for cid, (_, c) in v1.items()}
    for c in out.values():
        c["suite_version"] = "dev-v1.1"

    # ---- C2 first: it decides which healthy cases keep their label ----------------------------------------------
    for cid, c in out.items():
        if c["truth"]["class"] == "healthy" and not c["tools_available"] and all(e["tool"] == "prior_record" for e in c["evidence"]):
            old_ref = c["truth"]["ref"]
            c["truth"] = {"class": "insufficient_evidence", "source": "human_adjudication",
                          "ref": old_ref + " | C2 (evaluator correction 2026-10-20): relabelled from healthy. The model sees only a title or identity record and has no tool "
                                           "(tools_available is empty), so no integrity check of the file exists in the case; the only supported answer is to escalate"}
            c["supported_actions"] = ["escalate"]
            note(c, "C2: healthy -> insufficient_evidence; supported_actions [none] -> [escalate]; source human_adjudication (empty tools_available and a single prior_record identity record, no integrity check)")

    # ---- C1: the managing app ---------------------------------------------------------------------------------------
    works = sorted({c["context"]["title"].replace(" (audiobook)", "") for c in out.values() if c["media_type"] in ("epub", "audiobook")})
    book_id = {w: "ll-99%04d" % (500 + i) for i, w in enumerate(works)}
    for cid, c in sorted(out.items()):
        arr = c["context"]["arr"]
        if c["media_type"] in ("epub", "audiobook"):
            work = c["context"]["title"].replace(" (audiobook)", "")
            fmt = "ebook" if c["media_type"] == "epub" else "audiobook"
            c["context"]["arr"] = {"app": "lazylibrarian", "ids": {"bookId": book_id[work], "format": fmt, "note": "fictional ids"}}
            msgs = ["context.arr.app null -> lazylibrarian with synthetic ids"]
            for e in c["evidence"]:
                if e["tool"] != "arr_lookup":
                    continue
                before = e["args"].get("app")
                e["args"] = {"app": "lazylibrarian", **{k: v for k, v in e["args"].items() if k != "app"}}
                if isinstance(e["output"], str):
                    for old in ('"app":"readarr-like"', '"app":"audiobook-metadata"'):
                        e["output"] = e["output"].replace(old, '"app":"lazylibrarian"')
                msgs.append("arr_lookup %s app %r -> 'lazylibrarian'" % (e["id"], before))
            note(c, "C1: " + "; ".join(msgs))
        elif arr["app"] is None and set(c["supported_actions"]) & WRITE:
            if c["media_type"] == "movie":
                c["context"]["arr"] = {"app": "radarr", "ids": {"movieId": 990311, "movieFileId": 990411, "note": "fictional ids; the real library ids are not used"}}
            else:
                c["context"]["arr"] = {"app": "sonarr", "ids": {"seriesId": 990011, "episodeId": 990111, "episodeFileId": 990211, "note": "fictional ids; the real library ids are not used"}}
            note(c, "C1: context.arr.app null -> %s with synthetic ids (the truth needs a managed write)" % c["context"]["arr"]["app"])

    # ---- C3, C6 per-case rulings ----------------------------------------------------------------------------------------
    c = out["epub-healthy-005"]
    c["truth"]["class"] = "metadata_naming"
    c["truth"]["ref"] += " | C3 (evaluator correction 2026-10-20): a series prefix in dc:title is a metadata naming issue the library would normalise, not a clean file; a decision of healthy/none is also accepted"
    c["accepted_classes"] = ["metadata_naming", "healthy"]
    c["supported_actions"] = ["rename", "none", "escalate"]
    note(c, "C3: truth.class healthy -> metadata_naming; accepted_classes [metadata_naming, healthy]; supported_actions [none] -> [rename, none, escalate]")

    c = out["epub-insuff-002"]
    c["truth"] = {"class": "identity_mismatch", "source": "human_adjudication",
                  "ref": "OPF dc:language is fr and the title and chapter headings are French, while the entry expects language en and the record lists no translation or alias. "
                         "A French edition where English is expected is a wrong-language release (%s ruling 2, evaluator 2026-10-20). Earlier basis: " % ADJ + c["truth"]["ref"]}
    c["supported_actions"] = ["blocklist_and_search", "escalate"]
    note(c, "C6-2: insufficient_evidence -> identity_mismatch (wrong-language release); supported_actions [escalate] -> [blocklist_and_search, escalate]")

    c = out["epub-identity-005"]
    c["context"]["arr"]["expected_toc"] = list(EXPECTED_TOC)
    note(c, "C6-3: context.arr.expected_toc added: the expected book's chapters from the construction recipe (lr_good.epub, gen_epub.py); label unchanged")

    for cid, text in (("epub-identity-004", "C6-4: supported_actions [blocklist_and_search] -> [blocklist_and_search, escalate] (abstaining for a human on one subtle string is acceptable, a false healthy is not)"),
                      ("epub-identity-001", "C6-5: supported_actions [blocklist_and_search] -> [blocklist_and_search, escalate] (an omnibus can legitimately contain the novel)"),
                      ("movie-identity-001", "C6-7: supported_actions [blocklist_and_search] -> [blocklist_and_search, escalate] (release name only)"),
                      ("tv-identity-001", "C6-8: supported_actions [blocklist_and_search] -> [blocklist_and_search, escalate]; remap is NOT supported (nothing shows the other slot is missing)")):
        out[cid]["supported_actions"] = ["blocklist_and_search", "escalate"]
        note(out[cid], text)
    note(out["epub-identity-002"], "C6-6: context.arr app/ids added (synthetic, read-only stub): done by the same change as C1; label unchanged")

    c = out["audiobook-order-001"]
    c["accepted_classes"] = ["order_edition_ambiguity", "healthy"]
    c["supported_actions"] = ["escalate", "none"]
    note(c, "C6-11: accepted_classes [order_edition_ambiguity, healthy]; supported_actions [escalate] -> [escalate, none] (no wanted edition is stated)")
    c = out["audiobook-insuff-001"]
    c["accepted_classes"] = ["insufficient_evidence", "metadata_naming"]
    note(c, "C6-12: accepted_classes [insufficient_evidence, metadata_naming]; supported_actions unchanged")
    c = out["movie-insuff-001"]
    c["accepted_classes"] = ["insufficient_evidence", "order_edition_ambiguity"]
    note(c, "C6-13: accepted_classes [insufficient_evidence, order_edition_ambiguity]; supported_actions unchanged")

    # ---- C6-fn: filename bias (context.filename, plus the same name in the *arr record's relativePath) ----------------------
    elig = {}
    for cid, c in sorted(out.items()):
        fnm = c["context"].get("filename")
        if c["truth"]["class"] in FN_CLASSES and v1[cid][1]["truth"]["class"] in FN_CLASSES and fnm and cid not in FN_KEEP and c["fixture"]["kind"] == "local":
            elig.setdefault(c["media_type"], []).append(cid)
    fn_plan = {}
    for mt, ids in sorted(elig.items()):
        for i, cid in enumerate(ids):
            style = FN_PATTERN[i % len(FN_PATTERN)]
            if style == "std":
                continue
            c = out[cid]
            old = c["context"]["filename"]
            new = fn_variants(c, old)[style]
            c["context"]["filename"] = new
            hits = 0
            for e in c["evidence"]:
                if isinstance(e.get("output"), str) and old in e["output"]:
                    if e["tool"] != "arr_lookup":
                        raise SystemExit("%s: the old file name also appears in %s evidence" % (cid, e["tool"]))
                    e["output"] = e["output"].replace(old, new)
                    hits += 1
            if old in json.dumps({k: v for k, v in c.items() if k not in ("corrections", "truth", "outcome_step")}, ensure_ascii=False).replace(new, ""):
                raise SystemExit("%s: the old file name %r is still present somewhere in the case" % (cid, old))
            fn_plan[cid] = (old, new, hits)
            note(c, "C6-fn: context.filename %r -> %r (same name in the arr_lookup relativePath: %d record%s); bytes of the fixture unchanged; "
                    "defective cases get the odd and scene-style names the healthy controls have" % (old, new, hits, "" if hits == 1 else "s"))

    # ---- C5: no tool without recorded data ------------------------------------------------------------------------------------
    for cid, c in out.items():
        if "audio_sample" in c["tools_available"]:
            c["tools_available"] = [t for t in c["tools_available"] if t != "audio_sample"]
            note(c, "C5: audio_sample removed from tools_available (no replay data for this case)")
    return v1, out, fn_plan


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--check", action="store_true")
    a = ap.parse_args(argv)
    v1, out, _ = build()
    texts = {cid: dumps(c) for cid, c in out.items()}
    if a.check:
        bad = [cid for cid, t in texts.items() if not (OUT / f"{cid}.json").exists() or (OUT / f"{cid}.json").read_text() != t]
        extra = sorted(p.stem for p in OUT.glob("*.json") if p.stem not in texts)
        print("build_v11 --check:", "OK" if not bad and not extra else "DIFFERS %s extra %s" % (bad, extra))
        return 0 if not bad and not extra else 1
    OUT.mkdir(exist_ok=True)
    for cid, t in texts.items():
        (OUT / f"{cid}.json").write_text(t)
    changed = sum(1 for c in out.values() if c.get("corrections"))
    print("wrote %d cases (%d with corrections)" % (len(texts), changed))
    return 0


if __name__ == "__main__":
    sys.exit(main())
