"""Builds suite/cases/*.json (dev-v1) from the specs below, the committed fixtures and their recorded replay files.

Stdlib only. Run: python3 -I build_cases.py   (rewrites cases/ and manifest.json; deterministic)
Truth never comes from a model: see README.md for how each class was built.
"""
import hashlib, json, os, re, sys, zipfile
import xml.etree.ElementTree as ET
from pathlib import Path

SUITE = Path(__file__).resolve().parent
CASES = SUITE / "cases"
MEDIA = SUITE / "fixtures" / "media"
PROBES = SUITE / "fixtures" / "probes"
VERSION = "dev-v1"
BASE = "9285641a"  # origin/main the pinned 2026-10-18 material was read from
HOME = Path.home()
CACHE_EPUB = HOME / ".cache" / "media-repair-actual-epub-1018"
CACHE_SEL = HOME / ".cache" / "media-repair-selection-1018"

NOTES = "A library file is attached to the entry below. From the evidence and tools, decide what is wrong with it, if anything, and which action the evidence supports."
VIDEO_TOOLS = ["ffprobe", "decode_sample", "frame_sample", "audio_sample", "ocr", "arr_lookup"]
EPUB_TOOLS = ["epub_inspect", "arr_lookup"]
AUDIO_TOOLS = ["ffprobe", "audiobook_inspect", "audio_sample", "arr_lookup"]
CLIENT_A = {"definition": "defined test direct-play profile, not a measured client (same shape as the 2026-10-18 a01-a04 profile)",
            "containers": ["matroska,webm", "mp4"], "video": "h264, 8-bit yuv420p, up to 1080p", "audio": "aac, up to 2 channels", "subtitles": "disabled"}
CLIENT_B = dict(CLIENT_A, video="h264 (8-bit or 10-bit) or hevc (8-bit or 10-bit), up to 1080p", audio="aac, ac3 or eac3, up to 6 channels")

written = {}


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def replay(name):
    return json.loads((PROBES / f"{name}.json").read_text())


def jtxt(o):
    return json.dumps(o, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def fx_local(name):
    p = MEDIA / name
    return {"kind": "local", "sha256": sha(p), "bytes": p.stat().st_size, "locator": f"fixtures/media/{name}"}


def fx_cache(path, tilde):
    return {"kind": "local", "sha256": sha(path), "bytes": Path(path).stat().st_size, "locator": tilde}


def fx_none():
    return {"kind": "none", "sha256": None, "bytes": 0, "locator": "none: reported historical observation, no media retrieved"}


def fx_remote(sha_of_record, nbytes, locator):
    return {"kind": "remote", "sha256": sha_of_record, "bytes": nbytes, "locator": locator}


class Ev:
    """Evidence list builder with sequential ids."""

    def __init__(self):
        self.items = []

    def add(self, tool, args, output, status="ok"):
        self.items.append({"id": f"e{len(self.items) + 1}", "tool": tool, "args": args, "status": status, "output": output})
        return self

    def ffprobe(self, name):
        r = replay(name)["ffprobe"]
        return self.add("ffprobe", {"fixture": "file"}, jtxt(r), "ok" if r["exit_code"] == 0 else "error")

    def decode(self, name, ss):
        r = replay(name)["decode_sample"][str(ss)]
        return self.add("decode_sample", {"ss": ss, "t": 4}, jtxt(r), "ok" if r["exit_code"] == 0 else "error")

    def decode_full(self, name):
        r = replay(name)["decode_sample"]["full"]
        return self.add("decode_sample", {"ss": 0, "t": "full"}, jtxt(r), "ok" if r["exit_code"] == 0 else "error")

    def ocr(self, name, t=1.0):
        ft = replay(name)["frame_text"]
        txt = next((x["text"] for x in ft if x["t0"] <= t < x["t1"]), "no text") if isinstance(ft, list) else "no text"
        return self.add("ocr", {"t": t}, txt)

    def arr(self, args, out):
        return self.add("arr_lookup", args, jtxt(out))

    def epub(self, path):
        r = epub_report(path)
        return self.add("epub_inspect", {"fixture": "file"}, jtxt(r), "ok" if r["status"] == "ok" else "error")


def epub_report(path):
    """Read-only structural report; classifies the failing stage so the evidence says why."""
    path = Path(path)
    rep = {"status": "ok", "bytes": path.stat().st_size}
    try:
        z = zipfile.ZipFile(path)
    except Exception as e:
        return {"status": "error", "stage": "zip_open", "bytes": rep["bytes"], "error": f"{type(e).__name__}: {e}"}
    with z:
        bad = z.testzip()
        if bad:
            return {"status": "error", "stage": "zip_crc", "bytes": rep["bytes"], "entries": len(z.namelist()), "error": f"CRC mismatch in member {bad}"}
        names = z.namelist()
        try:
            root = ET.fromstring(z.read("META-INF/container.xml"))
            opf = next(x.attrib["full-path"] for x in root.iter() if x.tag.endswith("rootfile"))
            package = ET.fromstring(z.read(opf))
        except Exception as e:
            return {"status": "error", "stage": "opf_parse", "bytes": rep["bytes"], "entries": len(names), "error": f"{type(e).__name__}: {e}"}
        base = os.path.dirname(opf)
        manifest = {x.attrib["id"]: os.path.normpath(os.path.join(base, x.attrib["href"])) for x in package.iter() if x.tag.endswith("}item")}
        missing = sorted(p for p in manifest.values() if p not in names)
        if missing:
            return {"status": "error", "stage": "manifest", "bytes": rep["bytes"], "entries": len(names), "error": f"manifest references missing member(s): {missing}"}
        spine, heads = [], []
        for x in package.iter():
            if x.tag.endswith("}itemref"):
                txt = re.sub(r"<[^>]+>", " ", z.read(manifest[x.attrib["idref"]]).decode("utf-8", "replace"))
                txt = " ".join(txt.split())
                spine.append(len(txt))
                if len(heads) < 3 and not txt.startswith("Cover"):
                    heads.append(" ".join(txt.split()[:6]))
        rep.update(entries=len(names), opf=opf,
                   dc_title=[x.text for x in package.iter() if x.tag.endswith("}title")],
                   dc_creator=[x.text for x in package.iter() if x.tag.endswith("}creator")],
                   dc_language=[x.text for x in package.iter() if x.tag.endswith("}language")],
                   spine_items=len(spine), spine_characters=sum(spine), spine_heads=heads)
    return rep


def write_case(cid, media, family, klass, source, ref, actions, solvable, ctx, fixture, evidence, tools, prov="new",
               inject=None, outcome=None, target=None):
    ctx = dict(ctx)
    ctx.setdefault("notes_for_model", NOTES)
    truth = {"class": klass, "source": source, "ref": ref}
    if target is not None:
        truth["target"] = target
    case = {"id": cid, "suite_version": VERSION, "split": "dev", "media_type": media, "family": family, "truth": truth,
            "supported_actions": actions, "solvable": solvable, "context": ctx, "fixture": fixture,
            "evidence": evidence.items if isinstance(evidence, Ev) else evidence, "tools_available": tools}
    if inject:
        case["inject_tool_failure"] = inject
    if outcome:
        case["outcome_step"] = outcome
    case["provenance"] = prov
    assert cid not in written, cid
    out = json.dumps(case, indent=1, ensure_ascii=False, sort_keys=False) + "\n"
    (CASES / f"{cid}.json").write_text(out)
    written[cid] = hashlib.sha256(out.encode()).hexdigest()


def rp(name):
    return f"replay fixtures/probes/{name}.json sha256 {sha(PROBES / (name + '.json'))[:12]}"


# ---------------------------------------------------------------- fictional authoritative metadata (construction)
SERIES = {"series": "Harbor Lights", "seriesId": 990001, "aired_order": ["Low Tide", "Lamp Oil", "The Salt Wind", "Night Ferry", "The Glass Harbor", "Gull Rock"],
          "runtime_s": {"1": 8, "2": 8, "3": 8, "4": 8, "5": 8, "6": 6}}
LANTERN_CH = ["Opening Credits", "Chapter 1 Rain", "Chapter 2 Salt", "Chapter 3 Lanterns"]


def sonarr_ep(ep, filename, size=None, order="aired"):
    t = SERIES["aired_order"][ep - 1]
    out = {"app": "sonarr", "series": SERIES["series"], "episode": {"season": 1, "episode": ep, "title": t, "runtime_s": SERIES["runtime_s"][str(ep)]},
           "file": {"relativePath": filename}, "series_order": order}
    if size:
        out["file"]["size"] = size
    return out


def arr_ctx(ep, fid, sid=990001):
    return {"app": "sonarr", "ids": {"seriesId": sid, "episodeId": 990100 + ep, "episodeFileId": fid, "note": "fictional ids"}}


# IDs are assigned per media type in order of creation through this helper so numbering stays dense and stable.
_counters = {}


def nid(media, short):
    k = (media, short)
    _counters[k] = _counters.get(k, 0) + 1
    return f"{media}-{short}-{_counters[k]:03d}"


def build_all():
    CASES.mkdir(exist_ok=True)
    for old in CASES.glob("*.json"):
        old.unlink()

    # ---------------------------------------------------------------- reused documentary (11)
    corpus = [json.loads(l) for l in open(SUITE.parent.parent / "media-repair-benchmark-2026-10-18" / "corpus.jsonl")]
    mt = {"ebook": "epub", "audiobook": "audiobook", "movie": "movie", "tv": "tv"}
    for row in corpus:
        media = mt[row["kind"]]
        mism = row["label"] == "mismatch"
        short = "identity" if mism else "healthy"
        cid = nid(media, short)
        obs = row["input"]["observed"]
        exp = dict(row["input"]["expected"])
        ev = Ev().add("prior_record", {"id": row["id"]}, jtxt({"observed": obs, "evidence_method": obs.get("evidence_method")}))
        write_case(cid, media, row["family"], "identity_mismatch" if mism else "healthy", "human_adjudication",
                   f"{row['source']} (corpus.jsonl row {row['id']}, label_status {row['label_status']}); historical report, not re-decoded media",
                   ["blocklist_and_search"] if mism else ["none"], True,
                   {"title": exp.get("title"), "expected": exp, "arr": {"app": None, "ids": {}}}, fx_none(), ev, [],
                   prov=f"reused from .agents/context/media-repair-benchmark-2026-10-18/corpus.jsonl@{BASE} row {row['id']} (was {row['split']} in 2026-10-18; re-labelled dev because every candidate has already seen it)")

    # ---------------------------------------------------------------- reused: EPUB pair (PR #998) and selection fixtures (PR #999)
    pair = [("pristine-0.epub", "epub-identity", "Anne of Windy Poplars is attached to the Anne of Green Gables entry", "identity_mismatch", ["blocklist_and_search"]),
            ("pristine-1.epub", "epub-healthy", "the intact Anne of Green Gables copy", "healthy", ["none"])]
    exp_anne = {"title": "Anne of Green Gables", "author": "L. M. Montgomery", "language": "en"}
    for fn, short, what, klass, acts in pair:
        p = CACHE_EPUB / fn
        ev = Ev().epub(p).arr({"app": "readarr-like", "work": "Anne of Green Gables"}, {"expected_title": "Anne of Green Gables", "expected_author": "L. M. Montgomery"})
        write_case(nid("epub", short.split("-")[1]), "epub", "anne", klass, "deterministic",
                   f"{what}; parsed OPF titles and spine headings (epub_inspect evidence); independent primary-text proof in media-repair-actual-epub-2026-10-18/IDENTITY.md",
                   acts, True, {"title": "Anne of Green Gables", "expected": exp_anne, "arr": {"app": None, "ids": {}}},
                   fx_cache(p, f"~/.cache/media-repair-actual-epub-1018/{fn}"), ev, EPUB_TOOLS,
                   prov=f"reused from .agents/context/media-repair-actual-epub-2026-10-18@{BASE} (PR #998), private copy in ~/.cache/media-repair-actual-epub-1018 (>200 KiB, not committed)")
    p = CACHE_SEL / "derived-damage.epub"
    ev = Ev().epub(p).arr({"app": "readarr-like", "work": "Anne of Green Gables"}, {"expected_title": "Anne of Green Gables", "expected_author": "L. M. Montgomery"})
    write_case(nid("epub", "corrupt"), "epub", "anne", "corrupt_file", "construction",
               "derived-damage.epub is the 2048-byte head of an intact EPUB (central directory lost); zipfile raises BadZipFile; construction recorded in media-repair-selection-2026-10-18/prepare.py",
               ["blocklist_and_search"], True, {"title": "Anne of Green Gables", "expected": exp_anne, "arr": {"app": None, "ids": {}}},
               fx_cache(p, "~/.cache/media-repair-selection-1018/derived-damage.epub"), ev, EPUB_TOOLS,
               prov=f"reused from .agents/context/media-repair-selection-2026-10-18@{BASE} (PR #999) fixture derived-damage.epub; tiny enough to commit but kept in the private cache with its siblings")
    p = CACHE_SEL / "derived-title.epub"
    ev = Ev().epub(p).arr({"app": "readarr-like", "work": "Anne of Green Gables"}, {"expected_title": "Anne of Green Gables", "expected_author": "L. M. Montgomery"})
    write_case(nid("epub", "identity"), "epub", "anne", "identity_mismatch", "construction",
               "derived-title.epub is the Windy Poplars body with the OPF dc:title rewritten to the expected title (misleading metadata); body headings still read WindyPop; construction in media-repair-selection-2026-10-18/prepare.py",
               ["blocklist_and_search"], True, {"title": "Anne of Green Gables", "expected": exp_anne, "arr": {"app": None, "ids": {}}},
               fx_cache(p, "~/.cache/media-repair-selection-1018/derived-title.epub"), ev, EPUB_TOOLS,
               prov=f"reused from .agents/context/media-repair-selection-2026-10-18@{BASE} (PR #999) fixture derived-title.epub")

    # ---------------------------------------------------------------- reused: AV a01-a04 (PR #1000), remote files
    av = json.load(open(SUITE.parent.parent / "media-repair-av-2026-10-18" / "cases.json"))
    avd = {a["case_id"]: a for a in av}
    def av_evidence(a, with_ocr=False, with_sub=False):
        o = a["observations"]
        ev = Ev().add("ffprobe", {"fixture": "remote"}, jtxt({"streams": o["streams"]}))
        ev.add("decode_sample", {"ss": 0, "t": 4}, jtxt(o["decode"]["primary"]))
        if with_sub:  # only the one short line that the a03 abstention rests on; no song lyrics or longer dialogue are copied
            ev.add("prior_record", {"what": "embedded subtitle sample (one cue)"}, o["subtitle"])
        if with_ocr:
            ev.add("ocr", {"t": 62}, "Happy Hot Diggity Dog Holiday!")
        return ev
    rec = lambda k: hashlib.sha256(json.dumps(avd[k], sort_keys=True).encode()).hexdigest()
    mickey = fx_remote(rec("a01"), 1455149536, "sonarr episodefile 80066 (1455149536 B); sha256 is of the pinned observation record cases.json a01, not of the media")
    write_case(nid("tv", "healthy"), "tv", "mickey-roadster", "healthy", "human_adjudication",
               "title card at 62 s reads the requested first story, transcribed from a viewed frame before any model decision (media-repair-av-2026-10-18/IDENTITY.md); first story only, second story not claimed",
               ["none"], True, {"title": "Mickey and the Roadster Racers: Happy Hot Diggity Dog Holiday! (first story only)", "expected": {"series": "Mickey and the Roadster Racers", "story": "Happy Hot Diggity Dog Holiday!"}, "arr": {"app": "sonarr", "ids": {"episodeFileId": 80066}}},
               mickey, av_evidence(avd["a01"], True), VIDEO_TOOLS, prov=f"reused from .agents/context/media-repair-av-2026-10-18/cases.json@{BASE} a01 (#992 offender family: Mickey, row 1 of 2)")
    write_case(nid("tv", "identity"), "tv", "mickey-roadster", "identity_mismatch", "construction",
               "contrived requested-work swap: the same Mickey evidence presented against a Pokemon entry (IDENTITY.md: 'explicitly contrived requested-work swap', not a recovered incident)",
               ["blocklist_and_search"], True, {"title": "Pokemon: Hour of the Houndour", "expected": {"series": "Pokemon", "episode_title": "Hour of the Houndour"}, "arr": {"app": "sonarr", "ids": {}}},
               mickey, av_evidence(avd["a02"], True), VIDEO_TOOLS, prov=f"reused from .agents/context/media-repair-av-2026-10-18/cases.json@{BASE} a02 (#992 offender family: Mickey, row 2 of 2; contrived)")
    poke = fx_remote(rec("a03"), 839928932, "sonarr episodefile 80065 (839928932 B); sha256 is of the pinned observation record cases.json a03, not of the media")
    write_case(nid("tv", "insuff"), "tv", "pokemon-houndour", "insufficient_evidence", "human_adjudication",
               "IDENTITY.md: a03 supplies ONLY a generic 600 s scene and one battle subtitle; no literal title card exists, so no evidence settles identity; abstention concerns the adequacy of evidence, not a claim the file is wrong",
               ["escalate"], True, {"title": "Pokemon: Hour of the Houndour", "expected": {"series": "Pokemon", "season": 3, "episode": 34}, "arr": {"app": "sonarr", "ids": {"episodeFileId": 80065}}},
               poke, av_evidence(avd["a03"], with_sub=True), VIDEO_TOOLS, prov=f"reused from .agents/context/media-repair-av-2026-10-18/cases.json@{BASE} a03 (#992 offender family: Pokemon, row 1 of 2)")
    zom = fx_remote(rec("a04"), 5555730978, "radarr movie 9830 file 6337 (5555730978 B); sha256 is of the pinned observation record cases.json a04, not of the media")
    ev = av_evidence(avd["a04"]).add("prior_record", {"what": "client profile"}, jtxt(avd["a04"]["observations"]["client"]))
    write_case(nid("movie", "decoder"), "movie", "zom", "decoder_incompatible", "deterministic",
               "deterministic comparison of ffprobe streams (eac3 6 channels) with the defined profile (aac, <=2 channels): refused by the profile although ffmpeg decodes it cleanly (primary range exit 0); profile is a test definition, not a real client",
               ["convert"], True, {"title": "Zom 100: Bucket List of the Dead (2023)", "expected": {"title": "Zom 100: Bucket List of the Dead", "year": 2023, "client_profile": avd["a04"]["observations"]["client"]},
                                   "arr": {"app": "radarr", "ids": {"movieId": 9830, "movieFileId": 6337}}, "question": "Can the defined client direct-play this file?"},
               zom, ev, VIDEO_TOOLS, prov=f"reused from .agents/context/media-repair-av-2026-10-18/cases.json@{BASE} a04, re-framed from identity to the defined-profile compatibility axis it also recorded")

    # ================================================================= NEW: TV (fictional "Harbor Lights")
    tv_ctx = lambda ep, fn, name, extra=None: dict({"title": f"Harbor Lights S01E{ep:02d}", "filename": fn,
                     "expected": {"series": "Harbor Lights", "season": 1, "episode": ep, "episode_title": SERIES["aired_order"][ep - 1], "runtime_s": SERIES["runtime_s"][str(ep)], "language": "en"},
                     "arr": arr_ctx(ep, 990200 + ep)}, **(extra or {}))
    f = "Harbor Lights - S01E03 - The Salt Wind.mkv"
    ev = Ev().ffprobe("hl_e03.mkv").decode("hl_e03.mkv", 0).ocr("hl_e03.mkv").arr({"app": "sonarr", "series": "Harbor Lights", "season": 1, "episode": 3}, sonarr_ep(3, f, 89938))
    write_case(nid("tv", "healthy"), "tv", "hl-e03", "healthy", "construction",
               f"hl_e03.mkv is generated with a S01E03 title card, matching tags and chapters; decode clean; {rp('hl_e03.mkv')}",
               ["none"], True, tv_ctx(3, f, "hl_e03.mkv"), fx_local("hl_e03.mkv"), ev, VIDEO_TOOLS)
    f = "hl.s01e04.1080p.web.h264-grp.mkv"
    ev = Ev().ffprobe("hl_e04_nightferry.mkv").decode("hl_e04_nightferry.mkv", 0).arr({"app": "sonarr", "series": "Harbor Lights", "season": 1, "episode": 4}, sonarr_ep(4, f, 90073))
    write_case(nid("tv", "healthy"), "tv", "hl-e04", "healthy", "construction",
               f"scene-release style filename that looks unreliable, but the content is E04 'Night Ferry' (card, tags, chapters) and decodes clean; {rp('hl_e04_nightferry.mkv')}",
               ["none"], True, tv_ctx(4, f, "hl_e04_nightferry.mkv"), fx_local("hl_e04_nightferry.mkv"), ev, VIDEO_TOOLS)
    f = "Harbor Lights - S01E01 - Low Tide.mkv"
    ev = Ev().ffprobe("hl_e01_multi.mkv").decode("hl_e01_multi.mkv", 0).arr({"app": "sonarr", "series": "Harbor Lights", "season": 1, "episode": 1}, sonarr_ep(1, f, 116257))
    write_case(nid("tv", "healthy"), "tv", "hl-e01", "healthy", "construction",
               f"extra audio track (commentary) and a subtitle stream make the file look unusual; content, tags and chapters are E01 and decode is clean; {rp('hl_e01_multi.mkv')}",
               ["none"], True, tv_ctx(1, f, "hl_e01_multi.mkv"), fx_local("hl_e01_multi.mkv"), ev, VIDEO_TOOLS)
    f = "Harbor Lights - S01E06 - Gull Rock.mkv"
    ev = Ev().ffprobe("hl_e06_hi10.mkv").decode_full("hl_e06_hi10.mkv").arr({"app": "sonarr", "series": "Harbor Lights", "season": 1, "episode": 6}, sonarr_ep(6, f, 68192))
    write_case(nid("tv", "healthy"), "tv", "hl-e06", "healthy", "deterministic",
               f"High10 H.264 is within this client profile (10-bit allowed); clean full decode, so nothing to fix; {rp('hl_e06_hi10.mkv')}",
               ["none"], True, tv_ctx(6, f, "hl_e06_hi10.mkv", {"client_profile": CLIENT_B, "question": "Can the defined client direct-play this file?"}), fx_local("hl_e06_hi10.mkv"), ev, VIDEO_TOOLS)
    f = "Harbor Lights - S01E04 - The Glass Harbor.mkv"
    glass_arr = lambda order, cfg: {"app": "sonarr", "series": "Harbor Lights", "episode_orders": {
        "aired": {"4": "Night Ferry", "5": "The Glass Harbor"}, "dvd": {"4": "The Glass Harbor", "5": "Night Ferry"}}, "library_episode_order": cfg,
        "file_attached_to": {"season": 1, "episode": 4}, "file": {"relativePath": f, "size": 90271}}
    ev = Ev().ffprobe("hl_glass_harbor.mkv").decode("hl_glass_harbor.mkv", 0).ocr("hl_glass_harbor.mkv").arr({"app": "sonarr", "series": "Harbor Lights", "episode": "S01E04"}, glass_arr("dvd", "dvd"))
    write_case(nid("tv", "healthy"), "tv", "hl-order", "healthy", "authoritative_metadata",
               f"the library's configured episode order is DVD, in which S01E04 is 'The Glass Harbor'; the card says 'The Glass Harbor' so the file is right; under aired order it would look wrong (negative control for order confusion); {rp('hl_glass_harbor.mkv')}",
               ["none"], True, tv_ctx(4, f, "hl_glass_harbor.mkv", {"expected": {"series": "Harbor Lights", "season": 1, "episode": 4, "episode_title": "(per library order)", "runtime_s": 8, "language": "en"}}),
               fx_local("hl_glass_harbor.mkv"), ev, VIDEO_TOOLS)
    ev = Ev().ffprobe("hl_glass_harbor.mkv").decode("hl_glass_harbor.mkv", 0).ocr("hl_glass_harbor.mkv").arr({"app": "sonarr", "series": "Harbor Lights", "episode": "S01E04"}, glass_arr("unspecified", None))
    write_case(nid("tv", "order"), "tv", "hl-order", "order_edition_ambiguity", "authoritative_metadata",
               "the file is 'The Glass Harbor' (card). Aired order puts that title at E05, DVD order at E04; the library entry is E04 and the lookup does not say which order the library follows, so neither 'wrong episode' nor 'right episode' is settled; only escalation is supported",
               ["escalate"], True, tv_ctx(4, f, "hl_glass_harbor.mkv", {"expected": {"series": "Harbor Lights", "season": 1, "episode": 4, "episode_title": "(unknown order)", "runtime_s": 8, "language": "en"}}),
               fx_local("hl_glass_harbor.mkv"), ev, VIDEO_TOOLS)

    f = "Harbor Lights - S01E02 - Lamp Oil.mkv"
    # corrupt family hl-e02
    ev = Ev().ffprobe("hl_e02_trunc.mkv").decode("hl_e02_trunc.mkv", 0).arr({"app": "sonarr", "series": "Harbor Lights", "season": 1, "episode": 2}, sonarr_ep(2, f, 90286))
    write_case(nid("tv", "corrupt"), "tv", "hl-e02", "corrupt_file", "deterministic",
               f"hl_e02_trunc.mkv is the first 55% of the good file (head -c); the demuxer reports 'File ended prematurely' in every window and the ss=4 window decodes only 3 of 40 frames; the arr records 90286 B but the file is 49657 B; {rp('hl_e02_trunc.mkv')}",
               ["blocklist_and_search"], True, tv_ctx(2, f, "hl_e02_trunc.mkv"), fx_local("hl_e02_trunc.mkv"), ev, VIDEO_TOOLS)
    ev = Ev().ffprobe("hl_e02_flip.mkv").decode("hl_e02_flip.mkv", 0).arr({"app": "sonarr", "series": "Harbor Lights", "season": 1, "episode": 2}, sonarr_ep(2, f, 90286))
    write_case(nid("tv", "corrupt"), "tv", "hl-e02", "corrupt_file", "deterministic",
               f"2048 bytes overwritten with 0xFF at 55% of the file (gen_media.sh); the head window already shows H.264 cabac decode errors and a demuxer element error; {rp('hl_e02_flip.mkv')}",
               ["blocklist_and_search"], True, tv_ctx(2, f, "hl_e02_flip.mkv"), fx_local("hl_e02_flip.mkv"), ev, VIDEO_TOOLS)
    ev = Ev().ffprobe("hl_e02_flip2.mkv").decode("hl_e02_flip2.mkv", 0).arr({"app": "sonarr", "series": "Harbor Lights", "season": 1, "episode": 2}, sonarr_ep(2, f, 90286))
    write_case(nid("tv", "corrupt"), "tv", "hl-e02", "corrupt_file", "deterministic",
               f"2048 bytes overwritten with 0xAA at 70% of the file; the first 4 s window is CLEAN (misleading), the ss=4 window shows an element-size error and H.264 decode errors (frames 21 of 40); needs decode_sample at ss=4 or a full decode; {rp('hl_e02_flip2.mkv')}",
               ["blocklist_and_search"], True, tv_ctx(2, f, "hl_e02_flip2.mkv"), fx_local("hl_e02_flip2.mkv"), ev, VIDEO_TOOLS)
    ev = Ev().ffprobe("hl_e02_flip2.mkv").decode("hl_e02_flip2.mkv", 0).arr({"app": "sonarr", "series": "Harbor Lights", "season": 1, "episode": 2}, sonarr_ep(2, f, 90286))
    write_case(nid("tv", "insuff"), "tv", "hl-e02", "insufficient_evidence", "construction",
               "twin of the previous case with decode_sample forced to fail: the only collected decode window (ss=0) is clean and ffprobe is clean, so no remaining evidence shows the corruption; the correct answer is to escalate, not to call the file healthy and not to blocklist it",
               ["escalate"], True, tv_ctx(2, f, "hl_e02_flip2.mkv"), fx_local("hl_e02_flip2.mkv"), ev, VIDEO_TOOLS,
               inject={"tool": "decode_sample", "mode": "error"})

    f = "Harbor Lights - S01E06 - Gull Rock.mkv"
    ev = Ev().ffprobe("hl_e06_hi10.mkv").decode_full("hl_e06_hi10.mkv").arr({"app": "sonarr", "series": "Harbor Lights", "season": 1, "episode": 6}, sonarr_ep(6, f, 68192))
    write_case(nid("tv", "decoder"), "tv", "hl-e06", "decoder_incompatible", "deterministic",
               f"ffprobe: H.264 High10 yuv420p10le; the profile allows 8-bit only; a full software decode is clean (exit 0, no stderr), so this is not corruption; {rp('hl_e06_hi10.mkv')}",
               ["convert"], True, tv_ctx(6, f, "hl_e06_hi10.mkv", {"client_profile": CLIENT_A, "question": "Can the defined client direct-play this file?"}), fx_local("hl_e06_hi10.mkv"), ev, VIDEO_TOOLS)

    f = "Harbor Lights - S01E05 - The Salt Wind.mkv"
    ev = Ev().ffprobe("hl_e03.mkv").decode("hl_e03.mkv", 0).ocr("hl_e03.mkv").arr({"app": "sonarr", "series": "Harbor Lights", "season": 1, "episode": 3}, sonarr_ep(3, f, 89938))
    write_case(nid("tv", "naming"), "tv", "hl-e03", "metadata_naming", "authoritative_metadata",
               "the Sonarr entry the file is attached to is E03 'The Salt Wind' and the content (card, tags, chapters, runtime) is E03; only the file name carries a wrong number (E05). The content is right, so the supported fix is metadata-only",
               ["rename"], True, tv_ctx(3, f, "hl_e03.mkv"), fx_local("hl_e03.mkv"), ev, VIDEO_TOOLS)
    f = "Harbor Lights - S01E04 - Night Ferry.mkv"
    ev = Ev().ffprobe("hl_e03.mkv").decode("hl_e03.mkv", 0).ocr("hl_e03.mkv").arr({"app": "sonarr", "series": "Harbor Lights", "season": 1, "episode": 4}, sonarr_ep(4, f, 89938))
    write_case(nid("tv", "identity"), "tv", "hl-e03-as-e04", "identity_mismatch", "deterministic",
               f"the entry is E04 'Night Ferry' but the content (card, tags, chapters) is E03 'The Salt Wind'; wrong release for this entry; {rp('hl_e03.mkv')}",
               ["blocklist_and_search"], True, tv_ctx(4, f, "hl_e03.mkv"), fx_local("hl_e03.mkv"), ev, VIDEO_TOOLS)
    ev = Ev().ffprobe("hl_e03.mkv").decode("hl_e03.mkv", 0).arr({"app": "sonarr", "series": "Harbor Lights", "season": 1, "episode": 4}, sonarr_ep(4, f, 89938))
    write_case(nid("tv", "identity"), "tv", "hl-e03-as-e04", "identity_mismatch", "deterministic",
               "same file and entry as the previous case with frame_sample forced to time out; ffprobe tags and chapters already name 'The Salt Wind' / episode 3, so the remaining evidence supports the mismatch (escalation is also acceptable)",
               ["blocklist_and_search", "escalate"], True, tv_ctx(4, f, "hl_e03.mkv"), fx_local("hl_e03.mkv"), ev, VIDEO_TOOLS,
               inject={"tool": "frame_sample", "mode": "timeout"})
    f = "Harbor Lights - S01E06 - Gull Rock.mkv"
    ev = Ev().ffprobe("hl_generic.mkv").decode("hl_generic.mkv", 0).arr({"app": "sonarr", "series": "Harbor Lights", "season": 1, "episode": 6}, sonarr_ep(6, f, 88720))
    write_case(nid("tv", "insuff"), "tv", "hl-generic", "insufficient_evidence", "construction",
               f"hl_generic.mkv was generated with no title card, no tags and no chapters; it is intact (clean decode) and 8 s against an expected 6 s, but nothing says which episode it is; {rp('hl_generic.mkv')}",
               ["escalate"], True, tv_ctx(6, f, "hl_generic.mkv"), fx_local("hl_generic.mkv"), ev, VIDEO_TOOLS)

    # tv outcome cases: original hl_e02_flip (corrupt); replacement after blocklist_and_search
    f = "Harbor Lights - S01E02 - Lamp Oil.mkv"
    def tv_outcome(repl, expected, why):
        post = Ev().ffprobe(repl).decode_full(repl).ocr(repl).items
        return {"check": "post_replace_verify", "inputs": {"action": "blocklist_and_search", "replacement": fx_local(repl), "replacement_filename": f,
                "expected_entry": {"series": "Harbor Lights", "season": 1, "episode": 2, "episode_title": "Lamp Oil", "runtime_s": 8},
                "post_evidence": post, "pass_rule": "full decode clean AND identity (card/tags) matches the entry AND duration within 1 s of the entry runtime"}, "expected": expected, "why": why}
    for repl, expected, why in (("hl_e02_good.mkv", "repaired", "clean full decode, card/tags S01E02, duration 8.05 s"),
                                ("hl_e02_flip2.mkv", "not_repaired", "replacement still shows demuxer/H.264 errors in the full decode"),
                                ("hl_e03.mkv", "not_repaired", "replacement decodes clean but is S01E03 'The Salt Wind', not E02")):
        ev = Ev().ffprobe("hl_e02_flip.mkv").decode("hl_e02_flip.mkv", 0).arr({"app": "sonarr", "series": "Harbor Lights", "season": 1, "episode": 2}, sonarr_ep(2, f, 90286))
        write_case(nid("tv", "outcome"), "tv", "hl-e02-outcome", "corrupt_file", "deterministic",
                   f"original hl_e02_flip.mkv is corrupt ({rp('hl_e02_flip.mkv')}); outcome truth: replacement {repl} -> {expected} ({why}); {rp(repl)}",
                   ["blocklist_and_search"], True, tv_ctx(2, f, "hl_e02_flip.mkv"), fx_local("hl_e02_flip.mkv"), ev, VIDEO_TOOLS,
                   outcome=tv_outcome(repl, expected, why))

    # ================================================================= NEW: movies (fictional "Quiet Orbit" 2019, theatrical 8 s, extended 12 s)
    mv_arr = lambda fn, size, extra=None: dict({"app": "radarr", "movie": "Quiet Orbit", "year": 2019, "alternate_titles": ["Orbite Silencieuse"],
                     "editions": {"Theatrical": {"runtime_s": 8}, "Extended Cut": {"runtime_s": 12}}, "file": {"relativePath": fn, "size": size}}, **(extra or {}))
    mv_ctx = lambda fn, extra=None: dict({"title": "Quiet Orbit (2019)", "filename": fn, "expected": {"title": "Quiet Orbit", "year": 2019, "aliases": ["Orbite Silencieuse"], "runtime_s": 8, "language": "en"},
                     "arr": {"app": "radarr", "ids": {"movieId": 990301, "movieFileId": 990401, "note": "fictional ids"}}}, **(extra or {}))
    fn = "Orbite.Silencieuse.2019.1080p.WEB.mkv"
    ev = Ev().ffprobe("qo_main.mkv").decode("qo_main.mkv", 0).ocr("qo_main.mkv").arr({"app": "radarr", "movie": "Quiet Orbit"}, mv_arr(fn, 90000))
    write_case(nid("movie", "healthy"), "movie", "qo-main", "healthy", "construction",
               f"file named with a registered alternate title (the Moana/Vaiana shape) but the content card reads QUIET ORBIT, runtime 8.05 s equals the theatrical cut, decode clean; {rp('qo_main.mkv')}",
               ["none"], True, mv_ctx(fn), fx_local("qo_main.mkv"), ev, VIDEO_TOOLS)
    fn = "Quiet Orbit (2019) {edition-Extended Cut}.mkv"
    ev = Ev().ffprobe("qo_ext.mkv").decode("qo_ext.mkv", 0).ocr("qo_ext.mkv").arr({"app": "radarr", "movie": "Quiet Orbit"}, mv_arr(fn, 131135, {"monitored_edition": "Extended Cut"}))
    write_case(nid("movie", "healthy"), "movie", "qo-edition", "healthy", "authoritative_metadata",
               f"the 12 s file is longer than the 8 s theatrical runtime, but the library monitors the Extended Cut (12 s) and the card says EXTENDED CUT; settled by metadata; {rp('qo_ext.mkv')}",
               ["none"], True, mv_ctx(fn, {"expected": {"title": "Quiet Orbit", "year": 2019, "edition": "Extended Cut", "runtime_s": 12, "language": "en"}}), fx_local("qo_ext.mkv"), ev, VIDEO_TOOLS)
    fn = "Quiet Orbit (2019).mkv"
    ev = Ev().ffprobe("qo_ext.mkv").decode("qo_ext.mkv", 0).ocr("qo_ext.mkv").arr({"app": "radarr", "movie": "Quiet Orbit"}, mv_arr(fn, 131135, {"monitored_edition": None, "note": "no edition is flagged as wanted"}))
    write_case(nid("movie", "order"), "movie", "qo-edition", "order_edition_ambiguity", "authoritative_metadata",
               f"12 s file with an EXTENDED CUT card against an entry with no wanted edition: the extended cut is a real edition (12 s per metadata), but whether the library wants it is not recorded, so the longer runtime is neither proof of a wrong file nor of a right one; {rp('qo_ext.mkv')}",
               ["escalate"], True, mv_ctx(fn), fx_local("qo_ext.mkv"), ev, VIDEO_TOOLS)
    fn = "Quiet Orbit (2019).mkv"
    ev = Ev().ffprobe("qo_nomoov.mp4").arr({"app": "radarr", "movie": "Quiet Orbit"}, mv_arr(fn, 91330))
    write_case(nid("movie", "corrupt"), "movie", "qo-corrupt", "corrupt_file", "deterministic",
               f"mp4 written with the moov atom at the end then cut at 70% (gen_media.sh); ffprobe: 'moov atom not found', exit 1; {rp('qo_nomoov.mp4')}",
               ["blocklist_and_search"], True, mv_ctx(fn), fx_local("qo_nomoov.mp4"), ev, VIDEO_TOOLS)
    ev = Ev().ffprobe("qo_zero.mkv").arr({"app": "radarr", "movie": "Quiet Orbit"}, mv_arr(fn, 1200000000))
    write_case(nid("movie", "corrupt"), "movie", "qo-corrupt", "corrupt_file", "deterministic",
               f"zero-length file (0 bytes) where the arr records ~1.2 GB; ffprobe: EBML header parsing failed; {rp('qo_zero.mkv')}",
               ["blocklist_and_search"], True, mv_ctx(fn), fx_local("qo_zero.mkv"), ev, VIDEO_TOOLS)
    ev = Ev().ffprobe("qo_nomoov.mp4").arr({"app": "radarr", "movie": "Quiet Orbit"}, mv_arr(fn, 91330))
    write_case(nid("movie", "corrupt"), "movie", "qo-corrupt", "corrupt_file", "deterministic",
               "same file as the moov case with decode_sample forced to time out; the collected ffprobe error ('moov atom not found') already settles that the container is unreadable, so the remaining evidence supports corrupt_file (escalation also acceptable)",
               ["blocklist_and_search", "escalate"], True, mv_ctx(fn), fx_local("qo_nomoov.mp4"), ev, VIDEO_TOOLS, inject={"tool": "decode_sample", "mode": "timeout"})
    fn = "Quiet Orbit (2019).mkv"
    ev = Ev().ffprobe("qo_hevc.mkv").decode_full("qo_hevc.mkv").arr({"app": "radarr", "movie": "Quiet Orbit"}, mv_arr(fn, 107217))
    write_case(nid("movie", "decoder"), "movie", "qo-hevc", "decoder_incompatible", "deterministic",
               f"HEVC Main10 yuv420p10le + AC-3 5.1 against a profile that allows only 8-bit H.264 and AAC stereo; the full software decode is clean, so the file is intact; {rp('qo_hevc.mkv')}",
               ["convert"], True, mv_ctx(fn, {"client_profile": CLIENT_A, "question": "Can the defined client direct-play this file?", "expected": {"title": "Quiet Orbit", "year": 2019, "runtime_s": 6, "language": "en"}}),
               fx_local("qo_hevc.mkv"), ev, VIDEO_TOOLS)
    fn = "Quiet Orbit (2011).mkv"
    ev = Ev().ffprobe("qo_main.mkv").decode("qo_main.mkv", 0).ocr("qo_main.mkv").arr({"app": "radarr", "movie": "Quiet Orbit"}, mv_arr(fn, 90000))
    write_case(nid("movie", "naming"), "movie", "qo-main", "metadata_naming", "authoritative_metadata",
               f"the Radarr movie the file is attached to is Quiet Orbit (2019) and the content card and 8.05 s runtime match it; only the file name's year (2011) is wrong; {rp('qo_main.mkv')}",
               ["rename"], True, mv_ctx(fn), fx_local("qo_main.mkv"), ev, VIDEO_TOOLS)
    fn = "Quiet Orbit (2019).mkv"
    ev = Ev().ffprobe("po_paper.mkv").decode("po_paper.mkv", 0).ocr("po_paper.mkv").arr({"app": "radarr", "movie": "Quiet Orbit"}, mv_arr(fn, 120841))
    write_case(nid("movie", "identity"), "movie", "po-paper", "identity_mismatch", "deterministic",
               f"card reads PAPER KINGDOM and the container title is 'Paper Kingdom'; the entry is Quiet Orbit (8 s); runtime 11 s matches no Quiet Orbit edition; {rp('po_paper.mkv')}",
               ["blocklist_and_search"], True, mv_ctx(fn), fx_local("po_paper.mkv"), ev, VIDEO_TOOLS)
    ev = Ev().ffprobe("qo_double.mkv").decode("qo_double.mkv", 0).ocr("qo_double.mkv").arr({"app": "radarr", "movie": "Quiet Orbit"}, mv_arr(fn, 172934))
    write_case(nid("movie", "insuff"), "movie", "qo-double", "insufficient_evidence", "construction",
               f"16 s file with the QUIET ORBIT card at 0 s only and a bare second half; no edition is 16 s (theatrical 8, extended 12); it may be a duplicate, a compilation or another cut, and the sampled evidence cannot tell (the Mickey 'second story unverified' shape); {rp('qo_double.mkv')}",
               ["escalate"], True, mv_ctx(fn), fx_local("qo_double.mkv"), ev, VIDEO_TOOLS)
    for repl, expected, why in (("qo_conv_ok.mp4", "repaired", "H.264 8-bit yuv420p + AAC stereo, clean decode, card QUIET ORBIT, duration 6 s"),
                                ("qo_conv_noaudio.mp4", "not_repaired", "video converted but the audio stream was dropped")):
        ev = Ev().ffprobe("qo_hevc.mkv").decode_full("qo_hevc.mkv").arr({"app": "radarr", "movie": "Quiet Orbit"}, mv_arr("Quiet Orbit (2019).mkv", 107217))
        post = Ev().ffprobe(repl).decode_full(repl).ocr(repl).items
        write_case(nid("movie", "outcome"), "movie", "qo-hevc-outcome", "decoder_incompatible", "deterministic",
                   f"original is the decoder-incompatible qo_hevc.mkv ({rp('qo_hevc.mkv')}); outcome truth: converted copy {repl} -> {expected} ({why}); {rp(repl)}",
                   ["convert"], True, mv_ctx("Quiet Orbit (2019).mkv", {"client_profile": CLIENT_A, "question": "Can the defined client direct-play this file?", "expected": {"title": "Quiet Orbit", "year": 2019, "runtime_s": 6, "language": "en"}}),
                   fx_local("qo_hevc.mkv"), ev, VIDEO_TOOLS,
                   outcome={"check": "post_convert_verify", "inputs": {"action": "convert", "replacement": fx_local(repl), "client_profile": CLIENT_A, "post_evidence": post,
                            "pass_rule": "video h264 8-bit yuv420p AND an aac stream with <=2 channels present AND full decode clean AND card matches"}, "expected": expected, "why": why})

    # ================================================================= NEW: audiobooks (fictional "The Lantern Road", 20 s, 4 chapters)
    ab_exp = {"title": "The Lantern Road", "author": "Mira Tolland", "narrator": "Ellis Marr", "duration_s": 20, "chapters": 4, "language": "en"}
    ab_arr = lambda extra=None: dict({"app": "audiobook-metadata", "work": "The Lantern Road", "authors": ["Mira Tolland"], "narrators": ["Ellis Marr"], "runtime_s": 20, "chapter_titles": LANTERN_CH}, **(extra or {}))
    ab_ctx = lambda fn, extra=None: dict({"title": "The Lantern Road (audiobook)", "filename": fn, "expected": ab_exp, "arr": {"app": None, "ids": {}}}, **(extra or {}))
    fn = "The Lantern Road.m4b"
    ev = Ev().ffprobe("lr.m4b").arr({"work": "The Lantern Road"}, ab_arr())
    write_case(nid("audiobook", "healthy"), "audiobook", "lr-main", "healthy", "construction",
               f"m4b with title/author/narrator tags, 4 chapters and 20.0 s of AAC, all equal to the metadata record; decode clean; {rp('lr.m4b')}",
               ["none"], True, ab_ctx(fn), fx_local("lr.m4b"), ev, AUDIO_TOOLS)
    fn = "The Lantern Road (Unabridged) - part 1.mp3"
    ev = Ev().ffprobe("lr.mp3").arr({"work": "The Lantern Road"}, ab_arr())
    write_case(nid("audiobook", "healthy"), "audiobook", "lr-mp3", "healthy", "construction",
               f"a single mp3 with ID3 chapters and a part-style filename (looks like a split set, but tags, 4 chapters and 20.0 s all match); {rp('lr.mp3')}",
               ["none"], True, ab_ctx(fn), fx_local("lr.mp3"), ev, AUDIO_TOOLS)
    fn = "The Lantern Road.m4b"
    ev = Ev().ffprobe("lr_trunc.m4b").arr({"work": "The Lantern Road"}, ab_arr())
    write_case(nid("audiobook", "corrupt"), "audiobook", "lr-corrupt", "corrupt_file", "deterministic",
               f"m4b cut at 50% before its moov atom; ffprobe: 'moov atom not found', exit 1; {rp('lr_trunc.m4b')}",
               ["blocklist_and_search"], True, ab_ctx(fn), fx_local("lr_trunc.m4b"), ev, AUDIO_TOOLS)
    ev = Ev().ffprobe("lr_empty.mp3").arr({"work": "The Lantern Road"}, ab_arr())
    write_case(nid("audiobook", "corrupt"), "audiobook", "lr-corrupt", "corrupt_file", "deterministic",
               f"mp3 whose ID3 tags and chapters were written but no audio frames: ffprobe 'Failed to find two consecutive MPEG audio frames', exit 1 (zero-length audio); expected 20 s; {rp('lr_empty.mp3')}",
               ["blocklist_and_search"], True, ab_ctx("The Lantern Road.mp3"), fx_local("lr_empty.mp3"), ev, AUDIO_TOOLS)
    ev = Ev().ffprobe("lr_trunc.m4b").arr({"work": "The Lantern Road"}, ab_arr())
    write_case(nid("audiobook", "corrupt"), "audiobook", "lr-corrupt", "corrupt_file", "deterministic",
               "same file as the truncated m4b with audiobook_inspect returning partial output; the collected ffprobe error ('moov atom not found') already settles that the file is unreadable (escalation also acceptable)",
               ["blocklist_and_search", "escalate"], True, ab_ctx(fn), fx_local("lr_trunc.m4b"), ev, AUDIO_TOOLS, inject={"tool": "audiobook_inspect", "mode": "partial"})
    ev = Ev().ffprobe("lr_wrong.m4b").arr({"work": "The Lantern Road"}, ab_arr())
    write_case(nid("audiobook", "identity"), "audiobook", "lr-wrong", "identity_mismatch", "deterministic",
               f"album tag says The Lantern Road but the artist is not the author, the 4 chapter titles (Ashes, Embers, Ash Fall) match no chapter of the record, and the duration is 12 s against 20 s; {rp('lr_wrong.m4b')}",
               ["blocklist_and_search"], True, ab_ctx(fn), fx_local("lr_wrong.m4b"), ev, AUDIO_TOOLS)
    ev = Ev().ffprobe("lr_untitled.m4b").arr({"work": "The Lantern Road"}, ab_arr())
    write_case(nid("audiobook", "naming"), "audiobook", "lr-untitled", "metadata_naming", "authoritative_metadata",
               f"tags are blank (no album/artist) but the 4 chapter titles equal the record's chapter list in order and the duration is 20.0 s; content is right, the tags are missing, so the supported fix is metadata-only; {rp('lr_untitled.m4b')}",
               ["rename"], True, ab_ctx(fn), fx_local("lr_untitled.m4b"), ev, AUDIO_TOOLS)
    ev = Ev().ffprobe("lr_blank.m4b").arr({"work": "The Lantern Road"}, ab_arr())
    write_case(nid("audiobook", "insuff"), "audiobook", "lr-blank", "insufficient_evidence", "construction",
               f"no tags and no chapters, intact AAC of 20.0 s equal to the record's runtime; nothing says which book it is (a matching duration alone is not identity); {rp('lr_blank.m4b')}",
               ["escalate"], True, ab_ctx(fn), fx_local("lr_blank.m4b"), ev, AUDIO_TOOLS)
    ev = Ev().ffprobe("lr.m4b").arr({"work": "The Lantern Road"}, ab_arr({"editions": {"Unabridged": {"runtime_s": 20, "narrator": "Ellis Marr"}, "Dramatised": {"runtime_s": 20, "narrator": "Ellis Marr"}}, "wanted_edition": None}))
    write_case(nid("audiobook", "order"), "audiobook", "lr-edition", "order_edition_ambiguity", "authoritative_metadata",
               f"the record lists two editions with the same narrator and the same 20 s runtime and the library has no wanted edition; the tags do not name an edition, so which one this file is (and whether it is the wanted one) is not settled; {rp('lr.m4b')}",
               ["escalate"], True, ab_ctx(fn), fx_local("lr.m4b"), ev, AUDIO_TOOLS)
    for repl, expected, why in (("lr.m4b", "repaired", "ffprobe clean, 20.0 s, 4 chapters equal to the record, tags match"),
                                ("lr_wrong.m4b", "not_repaired", "replacement is readable but is a different recording: 12 s, chapter titles do not match the record")):
        ev = Ev().ffprobe("lr_trunc.m4b").arr({"work": "The Lantern Road"}, ab_arr())
        post = Ev().ffprobe(repl).items
        write_case(nid("audiobook", "outcome"), "audiobook", "lr-outcome", "corrupt_file", "deterministic",
                   f"original lr_trunc.m4b is unreadable ({rp('lr_trunc.m4b')}); outcome truth: replacement {repl} -> {expected} ({why}); {rp(repl)}",
                   ["blocklist_and_search"], True, ab_ctx("The Lantern Road.m4b"), fx_local("lr_trunc.m4b"), ev, AUDIO_TOOLS,
                   outcome={"check": "post_replace_verify", "inputs": {"action": "blocklist_and_search", "replacement": fx_local(repl), "expected_entry": ab_exp, "post_evidence": post,
                            "pass_rule": "ffprobe exit 0 AND duration within 1 s of the record AND chapter titles equal the record's list AND album tag equals the title"}, "expected": expected, "why": why})

    # ================================================================= NEW: EPUB (fictional "The Lantern Road" by Mira Tolland; generated, deterministic)
    ep_exp = {"title": "The Lantern Road", "author": "Mira Tolland", "language": "en"}
    ep_arr = {"app": "readarr-like", "work": "The Lantern Road", "authors": ["Mira Tolland"], "language": "en", "aliases": [], "series": "Lantern Cycle", "series_position": 1}
    ep_ctx = lambda fn, extra=None: dict({"title": "The Lantern Road", "filename": fn, "expected": ep_exp, "arr": {"app": None, "ids": {}}}, **(extra or {}))
    def epcase(short, fam, klass, src, ref, acts, fixt, fn, extra_arr=None, **kw):
        ev = Ev()
        if not kw.pop("no_epub", False):
            ev.epub(MEDIA / fixt)
        ev.arr({"app": "readarr-like", "work": "The Lantern Road"}, dict(ep_arr, **(extra_arr or {})))
        write_case(nid("epub", short), "epub", fam, klass, src, ref, acts, True, ep_ctx(fn, kw.pop("ctx", None)), fx_local(fixt), ev, EPUB_TOOLS, **kw)
    epcase("healthy", "lr-epub", "healthy", "construction", "gen_epub.py lr_good.epub: OPF title/author equal the record, 3 chapters, valid ZIP/manifest/spine", ["none"], "lr_good.epub", "Mira Tolland - The Lantern Road.epub")
    epcase("healthy", "lr-epub-series", "healthy", "construction", "OPF title carries a series prefix and the creator is 'Tolland, Mira'; the body is the real work (chapter headings equal lr_good); odd metadata, correct content", ["none"], "lr_series.epub", "Tolland, Mira - [Lantern Cycle 01] The Lantern Road.epub")
    epcase("healthy", "lamplighter", "healthy", "construction", "a one-chapter 1.7 KB EPUB: tiny, but the entry is the short story 'The Lamplighter's Note' and the OPF/body agree",
           ["none"], "lamplighter_short.epub", "Mira Tolland - The Lamplighter's Note.epub",
           extra_arr={"work": "The Lamplighter's Note", "series": None, "series_position": None},
           ctx={"title": "The Lamplighter's Note", "expected": {"title": "The Lamplighter's Note", "author": "Mira Tolland", "language": "en"}})
    epcase("corrupt", "lr-epub-corrupt", "corrupt_file", "deterministic", "lr_zip_trunc.epub is lr_good cut at 60%; zipfile cannot open it (central directory lost); epub_inspect stage zip_open", ["blocklist_and_search"], "lr_zip_trunc.epub", "The Lantern Road.epub", extra_arr={"file_size_bytes": 3300})
    epcase("corrupt", "lr-epub-corrupt", "corrupt_file", "deterministic", "ZIP is intact but content.opf is not well-formed XML (unterminated tag); epub_inspect stage opf_parse", ["blocklist_and_search"], "lr_opf_broken.epub", "The Lantern Road.epub")
    epcase("corrupt", "lr-epub-corrupt", "corrupt_file", "deterministic", "one byte flipped inside a STORED member (c2.xhtml): the ZIP structure parses but testzip reports a CRC mismatch; epub_inspect stage zip_crc", ["blocklist_and_search"], "lr_crc.epub", "The Lantern Road.epub")
    epcase("corrupt", "lr-epub-corrupt", "corrupt_file", "deterministic", "the manifest and spine reference gone.xhtml, which is not in the archive; epub_inspect stage manifest", ["blocklist_and_search"], "lr_missing_member.epub", "The Lantern Road.epub")
    epcase("insuff", "lr-epub-corrupt", "insufficient_evidence", "construction", "twin of the truncated-ZIP case with epub_inspect forced to fail: the only remaining signal is a size difference (1980 B against the record's 3300 B), which does not by itself show corruption (another edition can be smaller); escalate",
           ["escalate"], "lr_zip_trunc.epub", "The Lantern Road.epub", no_epub=True, extra_arr={"file_size_bytes": 3300, "note": "size of the file in the library differs from the size recorded at grab time (1980 B vs 3300 B)"},
           inject={"tool": "epub_inspect", "mode": "error"})
    epcase("identity", "lr-epub-wrong", "identity_mismatch", "deterministic", "OPF says The Lantern Road / Mira Tolland but the spine headings are 'Chapter 1: Tide Tables / Cedar / Salt and Cedar' (a different fictional book); metadata lies, body decides", ["blocklist_and_search"], "lr_wrongbody.epub", "Mira Tolland - The Lantern Road.epub")
    epcase("naming", "lr-epub-untitled", "metadata_naming", "authoritative_metadata", "OPF title 'Untitled' and creator 'Unknown', but the title page and all chapter headings are The Lantern Road by Mira Tolland and nothing else claims otherwise; content right, metadata missing", ["rename"], "lr_untitled.epub", "Untitled.epub")
    epcase("insuff", "lr-epub-french", "insufficient_evidence", "construction", "OPF title 'La Route des Lanternes', language fr, same creator; the record lists no alias or translation, so whether this is the same work in translation (a different edition) cannot be shown from the evidence", ["escalate"], "lr_french.epub", "Mira Tolland - La Route des Lanternes.epub")
    for repl, expected, why in (("lr_good.epub", "repaired", "valid ZIP/OPF/spine, OPF title and headings equal the record"),
                                ("lr_crc.epub", "not_repaired", "replacement still fails its ZIP CRC check")):
        ev = Ev().epub(MEDIA / "lr_zip_trunc.epub").arr({"app": "readarr-like", "work": "The Lantern Road"}, ep_arr)
        post = Ev().epub(MEDIA / repl).items
        write_case(nid("epub", "outcome"), "epub", "lr-epub-outcome", "corrupt_file", "deterministic",
                   f"original lr_zip_trunc.epub is unreadable; outcome truth: replacement {repl} -> {expected} ({why})",
                   ["blocklist_and_search"], True, ep_ctx("The Lantern Road.epub"), fx_local("lr_zip_trunc.epub"), ev, EPUB_TOOLS,
                   outcome={"check": "post_replace_verify", "inputs": {"action": "blocklist_and_search", "replacement": fx_local(repl), "expected_entry": ep_exp, "post_evidence": post,
                            "pass_rule": "epub_inspect status ok AND dc_title equals the record AND spine headings agree with the title"}, "expected": expected, "why": why})


if __name__ == "__main__":
    build_all()
    print(len(written), "cases written")
