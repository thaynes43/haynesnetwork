"""Turn the raw output of gen_media.sh (ffprobe JSON, decode windows) into one condensed replay file per fixture.

Usage: python3 make_replay.py <job-output-dir> <suite-dir>
The replay files (fixtures/probes/<fixture>.json) are the recorded results of the standard tool calls on each
committed fixture (ffprobe, decode_sample at ss=0/4/8/12 and a full decode, and the construction-known title-card
text by time). A runner without ffmpeg (this pod has none) can replay them; a runner with ffmpeg can re-run the live
tools and compare. Stdlib only.
"""
import hashlib, json, re, sys
from pathlib import Path

CARDS = {  # fixture -> [(t0, t1, text)] known by construction (drawtext schedule in gen_media.sh)
    "hl_e01_multi.mkv": [(0, 2, "HARBOR LIGHTS / S01E01 / LOW TIDE")],
    "hl_e02_good.mkv": [(0, 2, "HARBOR LIGHTS / S01E02 / LAMP OIL")],
    "hl_e02_trunc.mkv": [(0, 2, "HARBOR LIGHTS / S01E02 / LAMP OIL")],
    "hl_e02_flip.mkv": [(0, 2, "HARBOR LIGHTS / S01E02 / LAMP OIL")],
    "hl_e02_flip2.mkv": [(0, 2, "HARBOR LIGHTS / S01E02 / LAMP OIL")],
    "hl_e03.mkv": [(0, 2, "HARBOR LIGHTS / S01E03 / THE SALT WIND")],
    "hl_e04_nightferry.mkv": [(0, 2, "HARBOR LIGHTS / S01E04 / NIGHT FERRY")],
    "hl_e06_hi10.mkv": [(0, 2, "HARBOR LIGHTS / S01E06 / GULL ROCK")],
    "hl_glass_harbor.mkv": [(0, 2, "HARBOR LIGHTS / THE GLASS HARBOR")],
    "qo_main.mkv": [(0, 2, "QUIET ORBIT")],
    "qo_ext.mkv": [(0, 2, "QUIET ORBIT / EXTENDED CUT")],
    "qo_double.mkv": [(0, 2, "QUIET ORBIT")],
    "qo_hevc.mkv": [(0, 2, "QUIET ORBIT")],
    "qo_conv_ok.mp4": [(0, 2, "QUIET ORBIT")],
    "qo_conv_noaudio.mp4": [(0, 2, "QUIET ORBIT")],
    "qo_nomoov.mp4": [(0, 2, "QUIET ORBIT")],
    "po_paper.mkv": [(0, 2, "PAPER KINGDOM")],
}
DROP_TAGS = {"handler_name", "encoder", "duration", "major_brand", "minor_version", "compatible_brands", "vendor_id"}

def tags(d):
    return {k.lower(): v for k, v in (d or {}).items() if k.lower() not in DROP_TAGS}

def norm(s):
    return re.sub(r"0x[0-9a-f]+", "0x0", s).strip()[:700]

def read(p, default=""):
    try:
        return Path(p).read_text()
    except FileNotFoundError:
        return default

def progress(text):
    frames = re.findall(r"^frame=(\d+)", text, re.M)
    out = re.findall(r"^out_time=(\S+)", text, re.M)
    return {"frames": int(frames[-1]) if frames else None, "out_time": out[-1] if out and out[-1] != "N/A" else None}

def main(jobout, suite):
    jobout, suite = Path(jobout), Path(suite)
    media = suite / "fixtures" / "media"
    outdir = suite / "fixtures" / "probes"
    outdir.mkdir(parents=True, exist_ok=True)
    for f in sorted(media.iterdir()):
        n = f.name
        if n.endswith(".epub"):
            continue
        raw = f.read_bytes()
        rc = int(read(jobout / "probes" / f"{n}.probe.rc", "1"))
        err = norm(read(jobout / "probes" / f"{n}.probe.err"))
        probe = {"exit_code": rc, "stderr": err}
        if rc == 0:
            d = json.loads(read(jobout / "probes" / f"{n}.probe.json"))
            fmt = d["format"]
            probe["format"] = {"format_name": fmt.get("format_name"), "duration": fmt.get("duration"), "size": fmt.get("size"),
                               "bit_rate": fmt.get("bit_rate"), "tags": tags(fmt.get("tags"))}
            probe["streams"] = [{k: s[k] for k in ("index", "codec_type", "codec_name", "profile", "pix_fmt", "width", "height",
                                                   "channels", "sample_rate", "bit_rate") if k in s} | {"tags": tags(s.get("tags"))}
                                for s in d["streams"] if s["codec_type"] != "data"]
            probe["chapters"] = [{"start": c["start_time"], "end": c["end_time"], "title": c.get("tags", {}).get("title")} for c in d.get("chapters", [])]
        decode = {}
        for key in ("0", "4", "8", "12", "full"):
            tag = f"ss{key}" if key != "full" else "full"
            drc = int(read(jobout / "decode" / f"{n}.{tag}.rc", "-1"))
            rec = {"exit_code": drc, "stderr": norm(read(jobout / "decode" / f"{n}.{tag}.err"))} | progress(read(jobout / "decode" / f"{n}.{tag}.prog"))
            if key != "full":
                rec |= {"ss": int(key), "t": 4}
            decode[key] = rec
        replay = {"fixture": n, "sha256": hashlib.sha256(raw).hexdigest(), "bytes": len(raw), "tool_version": "ffmpeg/ffprobe 8.1.2 (audiobookshelf 2.37.1 image)",
                  "ffprobe": probe, "decode_sample": decode,
                  "frame_text": [{"t0": a, "t1": b, "text": t} for a, b, t in CARDS.get(n, [])] or "no text visible in any sampled frame (construction: no title card was drawn)"}
        (outdir / f"{n}.json").write_text(json.dumps(replay, indent=1, ensure_ascii=False, sort_keys=True) + "\n")
        print("replay", n, rc)

if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
