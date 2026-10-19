"""Tests for the dev-v1 suite: the validator itself, negative cases it must catch, and truth-vs-recorded-evidence checks.

Run: nice -n 19 python3 -I -m unittest discover -s <suite dir> -p 'test_*.py'    (stdlib only; no ffmpeg needed)
"""
import hashlib, importlib.util, json, shutil, subprocess, sys, tempfile, unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("suite_tool", HERE / "suite.py")
suite = importlib.util.module_from_spec(spec)
spec.loader.exec_module(suite)


def load(cid, sd=HERE):
    return json.loads((sd / "cases" / f"{cid}.json").read_text())


def replay(name):
    return json.loads((HERE / "fixtures" / "probes" / f"{name}.json").read_text())


class CommittedSuite(unittest.TestCase):
    def test_validate_passes(self):
        errors, notes, good, _ = suite.validate(HERE)
        self.assertEqual(errors, [])
        self.assertGreaterEqual(len(good), 40)

    def test_dev_only_no_heldout(self):
        splits = {load(p.stem)["split"] for p in (HERE / "cases").glob("*.json")}
        self.assertEqual(splits, {"dev"})

    def test_manifest_matches_files(self):
        m = json.loads((HERE / "manifest.json").read_text())
        for x in m["cases"]:
            self.assertEqual(hashlib.sha256((HERE / x["file"]).read_bytes()).hexdigest(), x["sha256"], x["id"])
        for x in m["fixtures"]:
            self.assertEqual(hashlib.sha256((HERE / x["path"]).read_bytes()).hexdigest(), x["sha256"], x["path"])
        self.assertEqual(m["counts"]["total"], len(m["cases"]))

    def test_offender_rows_capped(self):
        fam = {}
        for p in (HERE / "cases").glob("*.json"):
            c = load(p.stem)
            fam[c["family"]] = fam.get(c["family"], 0) + 1
        self.assertLessEqual(fam.get("mickey-roadster", 0), 2)
        self.assertLessEqual(fam.get("pokemon-houndour", 0), 2)

    def test_model_visible_text_has_no_labels(self):
        """notes_for_model and evidence must not state the answer (class names / supported actions)."""
        for p in (HERE / "cases").glob("*.json"):
            c = load(p.stem)
            visible = json.dumps([c["context"], c["evidence"]]).lower()
            for word in ("corrupt_file", "identity_mismatch", "decoder_incompatible", "blocklist_and_search", "supported_actions", "metadata_naming"):
                self.assertNotIn(word, visible, f"{c['id']} leaks {word}")

    def test_generated_epubs_are_reproducible(self):
        with tempfile.TemporaryDirectory() as td:
            subprocess.run([sys.executable, "-I", str(HERE / "fixtures" / "gen_epub.py"), td], check=True)
            for f in Path(td).glob("*.epub"):
                self.assertEqual(f.read_bytes(), (HERE / "fixtures" / "media" / f.name).read_bytes(), f.name)

    def test_committed_fixture_budget(self):
        sizes = [p.stat().st_size for p in (HERE / "fixtures" / "media").glob("*")]
        self.assertTrue(all(s <= 200 * 1024 for s in sizes))
        self.assertLessEqual(sum(sizes), 3 * 1024 * 1024)


class TruthMatchesRecordedEvidence(unittest.TestCase):
    """The deterministic classes are re-derived from the recorded tool results, not from the labels."""

    def test_replay_hash_matches_fixture(self):
        for p in (HERE / "fixtures" / "probes").glob("*.json"):
            r = json.loads(p.read_text())
            self.assertEqual(hashlib.sha256((HERE / "fixtures" / "media" / r["fixture"]).read_bytes()).hexdigest(), r["sha256"], r["fixture"])

    def test_corrupt_video_fixtures_show_errors(self):
        self.assertIn("ended prematurely", replay("hl_e02_trunc.mkv")["decode_sample"]["0"]["stderr"])
        self.assertTrue(replay("hl_e02_flip.mkv")["decode_sample"]["0"]["stderr"])
        flip2 = replay("hl_e02_flip2.mkv")["decode_sample"]
        self.assertEqual(flip2["0"]["stderr"], "")          # misleading clean head window
        self.assertTrue(flip2["4"]["stderr"])                # the damage is only found at ss=4
        self.assertTrue(flip2["full"]["stderr"])
        for good in ("hl_e02_good.mkv", "hl_e03.mkv", "qo_main.mkv", "hl_e06_hi10.mkv", "qo_hevc.mkv"):
            d = replay(good)["decode_sample"]
            self.assertTrue(all(v["stderr"] == "" and v["exit_code"] == 0 for v in d.values()), good)

    def test_unreadable_containers_fail_probe(self):
        for n, msg in (("qo_nomoov.mp4", "moov atom not found"), ("lr_trunc.m4b", "moov atom not found"), ("qo_zero.mkv", "EBML header"), ("lr_empty.mp3", "MPEG audio frames")):
            r = replay(n)["ffprobe"]
            self.assertEqual(r["exit_code"], 1, n)
            self.assertIn(msg, r["stderr"], n)

    def test_decoder_cases_are_clean_decodes_outside_profile(self):
        hi10 = replay("hl_e06_hi10.mkv")
        self.assertEqual(hi10["decode_sample"]["full"]["stderr"], "")
        self.assertEqual(hi10["ffprobe"]["streams"][0]["pix_fmt"], "yuv420p10le")
        hevc = replay("qo_hevc.mkv")
        self.assertEqual(hevc["ffprobe"]["streams"][0]["codec_name"], "hevc")
        self.assertEqual(hevc["ffprobe"]["streams"][1]["channels"], 6)
        self.assertEqual(load("tv-decoder-001")["truth"]["class"], "decoder_incompatible")
        self.assertEqual(load("tv-healthy-006")["truth"]["class"], "healthy")  # same fixture, supportive profile

    def test_identity_cases_have_content_that_differs_from_entry(self):
        r = replay("hl_e03.mkv")["ffprobe"]["format"]["tags"]
        self.assertEqual((r["title"], r["episode_sort"]), ("The Salt Wind", "3"))
        self.assertEqual(load("tv-identity-003")["context"]["expected"]["episode"], 4)
        self.assertEqual(replay("po_paper.mkv")["ffprobe"]["format"]["tags"]["title"], "Paper Kingdom")

    def test_audiobook_facts(self):
        good = replay("lr.m4b")["ffprobe"]
        self.assertEqual(len(good["chapters"]), 4)
        self.assertAlmostEqual(float(good["format"]["duration"]), 20.0, places=1)
        wrong = replay("lr_wrong.m4b")["ffprobe"]
        self.assertAlmostEqual(float(wrong["format"]["duration"]), 12.0, places=1)
        self.assertNotEqual([c["title"] for c in wrong["chapters"]], [c["title"] for c in good["chapters"]])
        untitled = replay("lr_untitled.m4b")["ffprobe"]
        self.assertEqual([c["title"] for c in untitled["chapters"]], [c["title"] for c in good["chapters"]])
        self.assertNotIn("album", untitled["format"]["tags"])
        self.assertEqual(replay("lr_blank.m4b")["ffprobe"]["chapters"], [])

    def test_outcome_expectations_follow_post_evidence(self):
        for cid in [p.stem for p in (HERE / "cases").glob("*outcome*.json")]:
            c = load(cid)
            o = c["outcome_step"]
            post = {e["tool"]: e for e in o["inputs"]["post_evidence"]}
            if "epub_inspect" in post:
                ok = json.loads(post["epub_inspect"]["output"])["status"] == "ok"
            elif cid.startswith("movie"):
                ff = json.loads(post["ffprobe"]["output"])
                kinds = {(s["codec_type"], s["codec_name"]) for s in ff["streams"]}
                ok = ("video", "h264") in kinds and any(s["codec_type"] == "audio" and s["channels"] <= 2 for s in ff["streams"]) and json.loads(post["decode_sample"]["output"])["stderr"] == ""
            elif cid.startswith("tv"):
                ff = json.loads(post["ffprobe"]["output"])
                ok = json.loads(post["decode_sample"]["output"])["stderr"] == "" and ff["format"]["tags"].get("episode_sort") == "2"
            else:
                ff = json.loads(post["ffprobe"]["output"])
                ok = abs(float(ff["format"]["duration"]) - 20.0) < 1 and len(ff["chapters"]) == 4 and ff["format"]["tags"].get("title") == "The Lantern Road" and [c["title"] for c in ff["chapters"]][1] == "Chapter 1 Rain"
            self.assertEqual("repaired" if ok else "not_repaired", o["expected"], cid)


class ValidatorCatchesProblems(unittest.TestCase):
    def setUp(self):
        self.td = tempfile.TemporaryDirectory()
        self.sd = Path(self.td.name) / "suite"
        shutil.copytree(HERE, self.sd, ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))

    def tearDown(self):
        self.td.cleanup()

    def mutate(self, cid, fn, new_id=None):
        p = self.sd / "cases" / f"{cid}.json"
        c = json.loads(p.read_text())
        fn(c)
        out = self.sd / "cases" / f"{new_id or cid}.json"
        out.write_text(json.dumps(c, indent=1))

    def errors(self):
        return suite.validate(self.sd)[0]

    def test_baseline_clean(self):
        self.assertEqual(self.errors(), [])

    def test_duplicate_id_and_name_mismatch(self):
        self.mutate("tv-healthy-003", lambda c: None, new_id="tv-healthy-999")
        self.assertTrue(any("does not match file name" in e for e in self.errors()))

    def test_family_spanning_splits(self):
        self.mutate("tv-healthy-003", lambda c: c.update(split="heldout"))
        self.assertTrue(any("spans splits" in e for e in self.errors()))

    def test_fixture_hash_mismatch(self):
        self.mutate("tv-healthy-003", lambda c: c["fixture"].update(sha256="0" * 64))
        self.assertTrue(any("hash mismatch" in e for e in self.errors()))

    def test_inject_tool_must_be_available(self):
        self.mutate("tv-identity-004", lambda c: c.update(inject_tool_failure={"tool": "epub_inspect", "mode": "error"}))
        self.assertTrue(any("not in tools_available" in e for e in self.errors()))

    def test_healthy_must_not_support_write(self):
        self.mutate("tv-healthy-003", lambda c: c.update(supported_actions=["none", "rename"]))
        self.assertTrue(any("healthy" in e for e in self.errors()))

    def test_insufficient_must_only_escalate(self):
        self.mutate("tv-insuff-003", lambda c: c.update(supported_actions=["escalate", "blocklist_and_search"]))
        self.assertTrue(any("insufficient_evidence" in e for e in self.errors()))

    def test_missing_key(self):
        self.mutate("tv-healthy-003", lambda c: c.pop("truth"))
        self.assertTrue(any("missing keys" in e for e in self.errors()))

    def test_secret_pattern(self):
        self.mutate("tv-healthy-003", lambda c: c["context"].update(note="Authorization: Bearer abcdef"))
        self.assertTrue(any("secret" in e for e in self.errors()))

    def test_stale_manifest(self):
        self.mutate("tv-healthy-003", lambda c: c.update(solvable=False))
        self.assertTrue(any("manifest sha256 stale" in e for e in self.errors()))

    def test_minimum_counts(self):
        for p in list((self.sd / "cases").glob("*healthy*.json")):
            p.unlink()
        errs = self.errors()
        self.assertTrue(any("healthy controls" in e for e in errs))

    def test_offender_family_cap(self):
        self.mutate("tv-identity-002", lambda c: c.update(id="tv-identity-902"), new_id="tv-identity-902")
        self.assertTrue(any("offender family" in e for e in self.errors()))


if __name__ == "__main__":
    unittest.main()
