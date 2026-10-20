"""Live smoke for the evidence collectors.  Runs INSIDE a CPU-limited batch Job (see launch_smoke.py), never in the dev-env pod.

Generates small public synthetic fixtures (lavfi test pattern and sine tones, stdlib zip for EPUBs; no real library media),
runs the collectors on them with the real ffprobe / ffmpeg and prints one JSON document between two marker lines.

    python3 live_smoke.py          # needs ffmpeg and ffprobe on PATH; writes fixtures to $TMPDIR (default /tmp)
"""
import hashlib
import json
import os
import platform
import resource
import shutil
import subprocess
import sys
import tempfile
import time
import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

import evidence  # noqa: E402

BEGIN, END = '===MRH-EVIDENCE-SMOKE-BEGIN===', '===MRH-EVIDENCE-SMOKE-END==='
FF = ['nice', '-n', '19', 'ffmpeg', '-nostdin', '-y', '-hide_banner', '-loglevel', 'error', '-threads', '1']


def limit_fsize():
    resource.setrlimit(resource.RLIMIT_FSIZE, (20_000_000, 20_000_000))  # a runaway encoder fails instead of filling the disk


def ff(args, log):
    r = subprocess.run(FF + args, capture_output=True, preexec_fn=limit_fsize, timeout=120, stdin=subprocess.DEVNULL)
    if r.returncode != 0:
        log.append({'generate_failed': args[-1], 'rc': r.returncode, 'stderr': r.stderr.decode('utf-8', 'replace')[:500]})
    return r.returncode == 0


def encoders():
    out = subprocess.run(['ffmpeg', '-hide_banner', '-encoders'], capture_output=True, timeout=30, stdin=subprocess.DEVNULL).stdout.decode('utf-8', 'replace')
    return 'libx264' in out, 'aac' in out


def chapters_meta(path, tags, chapters):
    lines = [';FFMETADATA1'] + ['%s=%s' % kv for kv in tags.items()]
    for i, (a, b, t) in enumerate(chapters):
        lines += ['[CHAPTER]', 'TIMEBASE=1/1000', 'START=%d' % (a * 1000), 'END=%d' % (b * 1000), 'title=%s' % t]
    Path(path).write_text('\n'.join(lines) + '\n')


XHTML = '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>t</title></head><body><p>%s</p></body></html>'
CONTAINER = ('<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">'
             '<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>')
OPF = ('<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">'
       '<metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Synthetic Test Book</dc:title><dc:creator>Test Author</dc:creator>'
       '<dc:language>en</dc:language><dc:identifier id="id">urn:uuid:00000000-0000-4000-8000-000000000001</dc:identifier></metadata>'
       '<manifest><item id="c1" href="ch1.xhtml" media-type="application/xhtml+xml"/><item id="c2" href="ch2.xhtml" media-type="application/xhtml+xml"/></manifest>'
       '<spine><itemref idref="c1"/><itemref idref="c2"/></spine></package>')


def make_epub(path, drop_ch2=False, bad_ch1=False):
    with zipfile.ZipFile(path, 'w', zipfile.ZIP_DEFLATED) as z:
        z.writestr(zipfile.ZipInfo('mimetype'), 'application/epub+zip', compress_type=zipfile.ZIP_STORED)
        z.writestr('META-INF/container.xml', CONTAINER)
        z.writestr('OEBPS/content.opf', OPF)
        z.writestr('OEBPS/ch1.xhtml', '<html><body><p>unclosed paragraph' if bad_ch1 else XHTML % 'First chapter text of the synthetic test book.')
        if not drop_ch2:
            z.writestr('OEBPS/ch2.xhtml', XHTML % 'Second chapter text of the synthetic test book.')


def sha(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for c in iter(lambda: f.read(1 << 20), b''):
            h.update(c)
    return h.hexdigest()


def main():
    started = time.time()
    work = Path(tempfile.mkdtemp(prefix='mrh-smoke-', dir=os.environ.get('TMPDIR') or '/tmp'))
    log = []
    have_x264, have_aac = encoders()
    venc = ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '40', '-g', '20'] if have_x264 else ['-c:v', 'mpeg4', '-q:v', '12', '-g', '20']
    aenc = ['-c:a', 'aac', '-b:a', '24k'] if have_aac else ['-c:a', 'libmp3lame', '-b:a', '32k']
    gen = {'video_encoder': venc[1], 'audio_encoder': aenc[1]}

    # --- video fixtures: a good clip (12 s, a 3 s silent gap in the audio), a truncated copy and a byte-corrupted copy
    good = work / 'good.mkv'
    ff(['-f', 'lavfi', '-i', 'testsrc2=size=256x192:rate=10:duration=12', '-f', 'lavfi', '-i', 'sine=frequency=330:sample_rate=22050:duration=12',
        '-af', "volume=enable='between(t,6,9)':volume=0"] + venc + ['-pix_fmt', 'yuv420p'] + aenc + ['-ac', '1', '-metadata:s:a:0', 'language=eng',
        '-metadata', 'title=Synthetic Good Clip', str(good)], log)
    size = good.stat().st_size
    trunc = work / 'truncated.mkv'
    trunc.write_bytes(good.read_bytes()[: size * 55 // 100])
    corrupt = work / 'corrupt.mkv'
    data = bytearray(good.read_bytes())
    off = size * 55 // 100
    data[off:off + 2048] = b'\xff' * 2048
    corrupt.write_bytes(bytes(data))

    # --- EPUBs
    make_epub(work / 'good.epub')
    make_epub(work / 'broken-manifest.epub', drop_ch2=True)
    make_epub(work / 'broken-xhtml.epub', bad_ch1=True)
    ep = (work / 'good.epub').read_bytes()
    (work / 'truncated.epub').write_bytes(ep[: len(ep) // 2])

    # --- audiobooks: a two-part book with chapters, and a bad three-part copy
    def part(path, freq, tags, chapters):
        meta = str(path) + '.meta'
        chapters_meta(meta, tags, chapters)
        return ff(['-f', 'lavfi', '-i', 'sine=frequency=%d:sample_rate=22050:duration=20' % freq, '-f', 'ffmetadata', '-i', meta, '-map', '0:a', '-map_metadata', '1',
                   '-map_chapters', '1'] + aenc + ['-ac', '1', '-f', 'ipod', str(path)], log)

    book = work / 'book'
    book.mkdir()
    base = {'album': 'Synthetic Test Book', 'artist': 'Test Author', 'composer': 'Test Narrator', 'date': '2020', 'genre': 'Audiobook'}
    part(book / 'part1.m4b', 180, dict(base, title='Part 1', track='1/2'), [(0, 10, 'Chapter 1'), (10, 20, 'Chapter 2')])
    part(book / 'part2.m4b', 220, dict(base, title='Part 2', track='2/2'), [(0, 10, 'Chapter 3'), (10, 20, 'Chapter 4')])
    bad = work / 'book-bad'  # part 2 has another album tag, a wrong track total and a chapter past the end; part 3 is truncated
    bad.mkdir()
    shutil.copy(book / 'part1.m4b', bad / 'part1.m4b')
    part(bad / 'part2.m4b', 220, dict(base, album='A Different Book', title='Part 2', track='2/3'), [(0, 10, 'Chapter 3'), (10, 21, 'Chapter 4')])
    part(bad / 'part3.m4b', 260, dict(base, title='Part 3', track='3/3'), [(0, 10, 'Chapter 5'), (10, 20, 'Chapter 6')])
    b3 = (bad / 'part3.m4b').read_bytes()
    (bad / 'part3.m4b').write_bytes(b3[: len(b3) // 2])

    fixtures = {}
    for p in sorted(work.rglob('*')):
        if p.is_file() and not p.name.endswith('.meta'):
            fixtures[str(p.relative_to(work))] = {'bytes': p.stat().st_size, 'sha256': sha(p)}

    cases = []  # (label, path, kinds, bounds, which override)
    for name in ('good.mkv', 'truncated.mkv', 'corrupt.mkv'):
        cases.append((name, work / name, ['probe', 'decode', 'frames', 'audio'], None, None))
    cases.append(('good.mkv#full-decode', work / 'good.mkv', ['decode'], {'full_decode': True}, None))
    cases.append(('truncated.mkv#full-decode', work / 'truncated.mkv', ['decode'], {'full_decode': True}, None))
    cases.append(('good.mkv#full-decode-over-byte-cap', work / 'good.mkv', ['decode'], {'full_decode': True, 'full_max_bytes': 1024}, None))
    cases.append(('good.mkv#ffprobe-hidden-from-PATH', work / 'good.mkv', ['probe', 'decode'], None, lambda n: None if n == 'ffprobe' else shutil.which(n)))
    cases.append(('good.mkv#ffmpeg-hidden-from-PATH', work / 'good.mkv', ['decode', 'frames', 'audio'], None, lambda n: None if n == 'ffmpeg' else shutil.which(n)))
    for name in ('good.epub', 'broken-manifest.epub', 'broken-xhtml.epub', 'truncated.epub'):
        cases.append((name, work / name, ['epub'], None, None))
    cases.append(('book/', book, ['audiobook'], None, None))
    cases.append(('book-bad/', bad, ['audiobook'], None, None))

    results = {}
    for label, path, kinds, bounds, which in cases:
        recs = evidence.collect(path, kinds, bounds, which=which)
        results[label] = recs

    def ver(cmd):
        try:
            return subprocess.run(cmd, capture_output=True, timeout=10, stdin=subprocess.DEVNULL).stdout.decode().splitlines()[0]
        except Exception as e:  # noqa: BLE001
            return 'unavailable: %s' % e

    doc = {'label': 'LIVE: collected by the real ffprobe/ffmpeg inside a CPU-limited batch Job on synthetic fixtures; not replay, not real library media',
           'python': platform.python_version(), 'platform': platform.platform(), 'ffmpeg': ver(['ffmpeg', '-version']), 'ffprobe': ver(['ffprobe', '-version']),
           'tesseract': (ver(['tesseract', '--version']) if shutil.which('tesseract') else 'not installed in the Job image'),
           'generation': dict(gen, notes=log), 'fixtures': fixtures, 'elapsed_s': round(time.time() - started, 2), 'results': results}
    shutil.rmtree(work, ignore_errors=True)
    print(BEGIN)
    print(json.dumps(doc, indent=1, sort_keys=True))
    print(END)


if __name__ == '__main__':
    main()
