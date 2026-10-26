"""mrh-sampler-4 (tools behaviour v3-remote-2): mrh-sampler-3's bounded read-only sampler with a per-call input quota the CALLER computes for the file, a
measured decoded time, and the audio stream default.  remote_sampler.py (mrh-sampler-1), remote_sampler_v2.py (mrh-sampler-2) and remote_sampler_v3.py
(mrh-sampler-3) are unchanged and still what every earlier tools behaviour sends.

Run inside the target pod through `kubectl exec -i <target> -c <container> -- python3 - <mode> <path> [options]`, the script on stdin.  The receipt is the
LAST stderr line: one JSON object with "receipt": "mrh-sampler-4".  A run that ends without one (killed, crashed, cut) has no receipt, and the harness treats
that as fatal.

Bounds (unchanged from mrh-sampler-3 except the quota): 25 s for the WHOLE invocation (the start stat, the operation and the end stat share one deadline; the
operation stops 2 s early so the end identity check still fits), nice 19, one ffmpeg thread, stdlib only, read-only.  The input quota is `--input-quota-bytes`:
any integer from 8 MiB (the floor, and the default) to 1 TiB; the sampler enforces whatever the caller passes and records it.  It does not choose it: the harness
computes it from the file's own measured data (remote_quota.py) and checks the receipt against it.

Modes:
  stat, list, probe, chapters, frame: exactly as mrh-sampler-3 (probe/chapters/frame read at most the quota, default 8 MiB).
  decode   `-t window` (1 <= window <= 10, default 4), first video and first audio stream.
  audio    `-t window` of ONE audio stream: `--audio-first` maps `0:a:0` (the first audio stream); otherwise `--stream n` is the ABSOLUTE stream index ffprobe
           lists (`-map 0:n`), as in mrh-sampler-3.
  subtitle --stream n --window w: the stream as SRT, `-t w` with 1 <= w <= 10.
  decode, audio and subtitle also record the requested `window_s` and `progress` {out_time_s, frames}: what ffmpeg itself reported as written (`-progress`
  on a private pipe, never stdout), so a window that ran short of the quota is measured, not assumed.

Identity (every file mode): the file is opened ONCE and every byte (the fingerprint, the range server) is read from that descriptor, so a path that is
renamed or replaced during the operation cannot switch the bytes served.  With --expect-size and --expect-mtime-ns the opened file's size and mtime_ns are
compared with them before anything is read (start) and after the operation (end).  A start mismatch reads nothing.  `identity.same_file` says the path still
names the opened file (device and inode) at the end; `source_unchanged` is true only when the opened file's end identity equals its start identity AND the
path still names it.  Bad arguments (argparse included) also end with a receipt (exit_code `error`, `error` "bad arguments: ...").  ffmpeg and ffprobe read
the loopback range server only (`-protocol_whitelist http,tcp`).
"""
import argparse, hashlib, http.server, json, os, re, socket, stat as statmod, subprocess, sys, threading, time

RECEIPT = 'mrh-sampler-4'
LIMIT_S = 25          # the WHOLE invocation: the start stat, the operation and the end stat share it
END_RESERVE_S = 2     # kept back from the operation for the end identity check
DEFAULT_QUOTA = 8388608       # the floor and the default
MAX_QUOTA = 1 << 40           # a sanity bound on what a caller may pass; the caller never passes more than the file size
QUOTA = DEFAULT_QUOTA
LIST_CAP = 500
FINGER = 1048576
started = time.monotonic()
deadline = started + LIMIT_S
receipt = {'receipt': RECEIPT, 'mode': None, 'hostname': socket.gethostname(), 'exit_code': 'error', 'error': None, 'stdout_bytes': 0, 'stderr': '',
           'input_quota_bytes': DEFAULT_QUOTA,
           'bytes_read': 0, 'quota_exhausted': False, 'requests': 0, 'wall_seconds': 0.0, 'timed_out': False, 'source_unchanged': None,
           'window_s': None, 'progress': None,
           'identity': {'expected': None, 'start': None, 'end': None, 'start_ok': None, 'end_ok': None, 'same_file': None}, 'argv': None, 'confined': None}
out = sys.stdout.buffer


def finish(payload=b''):
    out.write(payload)
    out.flush()
    receipt['stdout_bytes'] = len(payload)
    receipt['wall_seconds'] = round(time.monotonic() - started, 3)
    sys.stderr.write('\n' + json.dumps(receipt, sort_keys=True) + '\n')
    sys.stderr.flush()
    os._exit(0)      # never wait for a worker thread that a slow filesystem holds


def ident(st):
    return {'size': st.st_size, 'mtime_ns': st.st_mtime_ns, 'dev': st.st_dev, 'ino': st.st_ino}


class NotConfined(OSError):
    pass


def fd_names(fd, path):
    """The descriptor-bound half of the confinement check: the kernel's name for the OPENED object (/proc/self/fd) must be exactly the requested path,
    which the pre-check proved absolute, normalised, symlink-free and under the root.  A swap between the pre-check and the open (a symlinked component, a
    replaced directory) makes the names differ.  When the name cannot be read (no /proc), confinement cannot be verified: it fails closed."""
    try:
        name = os.readlink('/proc/self/fd/%d' % fd)
    except OSError as e:
        raise NotConfined('confinement cannot be verified (%s); nothing was read' % type(e).__name__)
    if name != path:
        raise NotConfined('the opened object is not the confined path; nothing was read')


def refused(e):
    """A bounded step failed: a confinement failure says so in the receipt (confined false), anything else is an error.  Ends the invocation."""
    receipt['error'] = str(e)
    if str(e).startswith('NotConfined'):
        receipt['confined'] = False
    finish()


def confine(path, is_dir=False):
    """With --root, the pre-check (before anything is opened): the path must be absolute, normalised, free of symlinks in every component and strictly
    under the real root (a listing may name the root itself).  A failure ends the invocation with nothing read (confined false).  `confined` becomes true
    only after the descriptor-bound check (fd_names) on the object actually opened."""
    if a.root is None:
        return
    try:
        value, late = bounded(lambda: (os.path.realpath(a.root), os.path.realpath(path)))     # realpath stats every component: inside the budget too
    except RuntimeError as e:
        receipt['error'] = str(e)
        finish()
    if late:
        receipt.update(exit_code='timeout', timed_out=True, error='confinement not established before the limit; nothing was read')
        finish()
    root, real = value
    ok = (os.path.isabs(path) and os.path.normpath(path) == path and real == path and '\n' not in path and '\0' not in path
          and (real.startswith(root.rstrip('/') + '/') or (is_dir and real == root)))
    if not ok:
        receipt['confined'] = False
        receipt['error'] = 'path not confined under the allowed root (symlink, traversal or outside it); nothing was read'
        finish()


def left(reserve=0.0):
    """Seconds left of the whole-invocation budget, less `reserve` (never below a small floor, so an expired budget times out at once)."""
    return max(0.05, deadline - time.monotonic() - reserve)


def bounded(work, reserve=0.0):
    """Run `work` in a thread for at most what is left of the LIMIT_S budget (less `reserve`).  -> (value, timed_out)."""
    box = {}

    def run():
        try:
            box['value'] = work()
        except Exception as e:  # noqa: BLE001 - reported in the receipt
            box['error'] = '%s: %s' % (type(e).__name__, str(e)[:300])
    t = threading.Thread(target=run, daemon=True)
    t.start()
    t.join(left(reserve))
    if t.is_alive():
        return None, True
    if 'error' in box:
        raise RuntimeError(box['error'])
    return box.get('value'), False


class Parser(argparse.ArgumentParser):
    """Bad arguments end with a receipt too (never a bare usage message)."""

    def error(self, message):
        receipt['error'] = 'bad arguments: %s' % str(message)[:200]
        finish()


p = Parser(allow_abbrev=False)
p.add_argument('mode', choices=['stat', 'list', 'probe', 'chapters', 'decode', 'frame', 'audio', 'subtitle'])
p.add_argument('path')
p.add_argument('--at', type=float, default=0)
p.add_argument('--stream', type=int, default=0)
p.add_argument('--audio-first', action='store_true')
p.add_argument('--window', type=float, default=4)
p.add_argument('--prefix', default='')
p.add_argument('--expect-size', type=int)
p.add_argument('--expect-mtime-ns', type=int)
p.add_argument('--expect-dev', type=int)
p.add_argument('--expect-ino', type=int)
p.add_argument('--root')
p.add_argument('--input-quota-bytes', type=int, default=DEFAULT_QUOTA)
if len(sys.argv) > 1 and sys.argv[1] in ('stat', 'list', 'probe', 'chapters', 'decode', 'frame', 'audio', 'subtitle'):
    receipt['mode'] = sys.argv[1]
if '--' in sys.argv[1:]:
    receipt['error'] = 'bad arguments: option terminator is not supported'
    finish()
a = p.parse_args()
receipt['mode'] = a.mode
receipt['input_quota_bytes'] = a.input_quota_bytes
if not DEFAULT_QUOTA <= a.input_quota_bytes <= MAX_QUOTA:
    receipt['error'] = 'bad arguments: input quota must be an integer from %d to %d bytes' % (DEFAULT_QUOTA, MAX_QUOTA)
    finish()
QUOTA = a.input_quota_bytes
if a.audio_first and a.mode != 'audio':
    receipt['error'] = 'bad arguments: --audio-first is for the audio mode only'
    finish()
if a.mode in ('decode', 'audio', 'subtitle'):
    receipt['window_s'] = a.window
expects = (a.expect_size, a.expect_mtime_ns, a.expect_dev, a.expect_ino)
if not (a.at >= 0 and 0 <= a.stream < 128 and 1 <= a.window <= 10) or len({x is None for x in expects}) != 1:
    receipt['error'] = 'bad arguments: out of range'
    finish()

if a.mode == 'list':
    receipt['listing'] = {'complete': False, 'matching': 0, 'scanned': 0, 'cap': LIST_CAP, 'prefix': a.prefix, 'directory': a.path}
    confine(a.path, is_dir=True)

    def opened_dir():
        """Open the directory ONCE (O_DIRECTORY | O_NOFOLLOW) and list it from that descriptor; with --root, the descriptor must name the confined path."""
        dfd = os.open(a.path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        if a.root is not None:
            fd_names(dfd, a.path)
        return dfd
    try:
        dfd, late = bounded(opened_dir)
    except RuntimeError as e:
        refused(e)
    if late:
        receipt.update(exit_code='timeout', timed_out=True)
        finish()
    if a.root is not None:
        receipt['confined'] = True

    def scan():
        entries, scanned, matching = [], 0, 0
        with os.scandir(dfd) as it:
            for e in it:
                scanned += 1
                if not e.name.startswith(a.prefix):
                    continue
                matching += 1
                if matching > LIST_CAP:
                    continue        # keep scanning: the scan covers the whole directory, only matching entries count toward the cap
                st = e.stat(follow_symlinks=False)
                kind = 'dir' if statmod.S_ISDIR(st.st_mode) else 'file' if statmod.S_ISREG(st.st_mode) else 'symlink' if statmod.S_ISLNK(st.st_mode) else 'other'
                entries.append({'name': e.name, 'type': kind, 'size': st.st_size, 'mtime_ns': st.st_mtime_ns, 'dev': st.st_dev, 'ino': st.st_ino})
        return entries, scanned, matching
    try:
        value, timed_out = bounded(scan)
    except RuntimeError as e:
        receipt['error'] = str(e)
        finish()
    receipt['timed_out'] = timed_out
    if timed_out:
        receipt['exit_code'] = 'timeout'
        finish()
    entries, scanned, matching = value
    entries.sort(key=lambda x: x['name'])
    complete = matching < LIST_CAP
    receipt['listing'].update(complete=complete, matching=matching, scanned=scanned)
    receipt['exit_code'] = 0
    finish(json.dumps({'directory': a.path, 'prefix': a.prefix, 'complete': complete, 'matching': matching, 'scanned': scanned,
                       'entries': entries[:LIST_CAP]}, sort_keys=True).encode())

# every file mode: identity at the start, before anything is read
expected = {'size': a.expect_size, 'mtime_ns': a.expect_mtime_ns, 'dev': a.expect_dev, 'ino': a.expect_ino} if a.expect_size is not None else None
receipt['identity']['expected'] = expected
confine(a.path)


def opened():
    """Open ONCE, never following a final symlink; with --root, the opened descriptor must still name the confined path."""
    fd = os.open(a.path, os.O_RDONLY | os.O_NOFOLLOW | getattr(os, 'O_NOCTTY', 0))
    if a.root is not None:
        fd_names(fd, a.path)            # mandatory with --root; never skipped
    st = os.fstat(fd)
    if not statmod.S_ISREG(st.st_mode):
        raise OSError('not a regular file')
    return fd, st


try:
    value, timed_out = bounded(opened)
except RuntimeError as e:
    refused(e)
if timed_out:
    receipt.update(exit_code='timeout', timed_out=True)
    finish()
fd, st0 = value
if a.root is not None:
    receipt['confined'] = True
receipt['identity']['start'] = ident(st0)
if expected is not None:
    receipt['identity']['start_ok'] = ident(st0) == expected
    if not receipt['identity']['start_ok']:
        receipt['error'] = 'identity mismatch at start; nothing was read'
        finish()


def close_identity():
    """The end check: the opened file's identity now, and whether the path still names that file (device, inode)."""
    try:
        value, late = bounded(lambda: (os.fstat(fd), os.stat(a.path)))
    except RuntimeError as e:
        receipt['error'] = receipt['error'] or str(e)
        receipt['identity']['same_file'] = False      # the path no longer names a file: not the opened one
        receipt['source_unchanged'] = False
        return
    if late:
        receipt['timed_out'] = True
        return
    st1, by_path = value
    same = (by_path.st_dev, by_path.st_ino) == (st0.st_dev, st0.st_ino) and ident(by_path) == ident(st1)
    receipt['identity']['end'] = ident(st1)
    receipt['identity']['same_file'] = same
    receipt['source_unchanged'] = ident(st1) == ident(st0) and same
    if expected is not None:
        receipt['identity']['end_ok'] = ident(st1) == expected and same


if a.mode == 'stat':
    def fingerprint():
        head = os.pread(fd, min(FINGER, st0.st_size), 0)
        tail = os.pread(fd, FINGER, max(0, st0.st_size - FINGER))
        return head, tail
    try:
        value, timed_out = bounded(fingerprint, END_RESERVE_S)
    except RuntimeError as e:
        receipt['error'] = str(e)
        finish()
    if timed_out:
        receipt.update(exit_code='timeout', timed_out=True)
        close_identity()
        finish()
    head, tail = value
    receipt['bytes_read'] = len(head) + len(tail)
    receipt['exit_code'] = 0
    close_identity()
    finish(json.dumps({'size': st0.st_size, 'mtime_ns': st0.st_mtime_ns, 'head_1m_sha256': hashlib.sha256(head).hexdigest(),
                       'tail_1m_sha256': hashlib.sha256(tail).hexdigest(), 'partial_fingerprint_only': True}, sort_keys=True).encode())

state = {'bytes_read': 0, 'quota_exhausted': False, 'requests': 0}
lock = threading.Lock()


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        if self.path != '/sample':
            self.send_error(404)
            return
        match = re.fullmatch(r'bytes=(\d+)-(\d*)', self.headers.get('Range', 'bytes=0-'))
        if not match:
            self.send_error(416)
            return
        start = int(match[1])
        end = min(int(match[2]) if match[2] else st0.st_size - 1, st0.st_size - 1)
        if start > end:
            self.send_error(416)
            return
        with lock:
            state['requests'] += 1
        self.connection.setsockopt(socket.SOL_SOCKET, socket.SO_SNDBUF, 32768)
        self.send_response(206)
        self.send_header('Accept-Ranges', 'bytes')
        self.send_header('Content-Range', 'bytes %d-%d/%d' % (start, end, st0.st_size))
        self.send_header('Content-Length', str(end - start + 1))
        self.end_headers()
        try:
            pos, remaining = start, end - start + 1
            while remaining:
                with lock:
                    n = min(32768, remaining, QUOTA - state['bytes_read'])
                    if n <= 0:
                        state['quota_exhausted'] = True
                        break
                    chunk = os.pread(fd, n, pos)       # from the descriptor opened at the start, never the path again
                    state['bytes_read'] += len(chunk)
                if not chunk:
                    break
                self.wfile.write(chunk)
                pos += len(chunk)
                remaining -= len(chunk)
        except (BrokenPipeError, ConnectionResetError):
            pass
        self.close_connection = True


class Server(http.server.ThreadingHTTPServer):
    daemon_threads = True


server = Server(('127.0.0.1', 0), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
url = 'http://127.0.0.1:' + str(server.server_port) + '/sample'
base = ['nice', '-n', '19']
common = ['-threads', '1', '-probesize', '5000000', '-analyzeduration', '2000000', '-protocol_whitelist', 'http,tcp']
# decode, audio and subtitle report what ffmpeg itself says it wrote (`-progress`, key=value lines) on a private pipe: stdout is the payload and stderr the
# diagnostics, and neither is touched.  The other modes keep mrh-sampler-3's argv exactly.
progress = {'fd': None, 'text': b''}
progress_args = []
if a.mode in ('decode', 'audio', 'subtitle'):
    progress['fd'], write_end = os.pipe()
    progress_args = ['-progress', 'pipe:%d' % write_end, '-nostats']
if a.mode == 'probe':
    cmd = base + ['ffprobe', '-v', 'error'] + common + ['-show_entries', 'format=format_name,duration,size,bit_rate:format_tags:stream=index,codec_name,codec_type,profile,pix_fmt,width,height,channels,channel_layout,sample_rate,duration,bit_rate:stream_tags=language,title', '-of', 'json', url]
elif a.mode == 'chapters':
    cmd = base + ['ffprobe', '-v', 'error'] + common + ['-show_chapters', '-show_entries', 'format=format_name,duration,size,bit_rate:format_tags:stream=index,codec_name,codec_type,channels,sample_rate,duration:stream_tags=language,title', '-of', 'json', url]
else:
    cmd = base + ['ffmpeg', '-nostdin', '-v', 'error'] + progress_args + common + ['-ss', str(a.at), '-i', url, '-threads', '1', '-filter_threads', '1']
    if a.mode == 'decode':
        cmd += ['-t', '%g' % a.window, '-map', '0:v:0', '-map', '0:a:0?', '-sn', '-dn', '-f', 'null', '-']
    elif a.mode == 'frame':
        cmd += ['-map', '0:v:0', '-frames:v', '1', '-vf', 'scale=640:-1', '-c:v', 'png', '-f', 'image2pipe', 'pipe:1']
    elif a.mode == 'audio':
        cmd += ['-t', '%g' % a.window, '-map', '0:a:0' if a.audio_first else '0:' + str(a.stream), '-vn', '-ac', '1', '-ar', '16000', '-f', 'wav', 'pipe:1']
    else:
        cmd += ['-t', '%g' % a.window, '-map', '0:' + str(a.stream), '-vn', '-an', '-f', 'srt', 'pipe:1']
receipt['argv'] = cmd
payload = b''


def drain_progress():
    while True:
        try:
            chunk = os.read(progress['fd'], 4096)
        except OSError:
            return
        if not chunk:
            return
        progress['text'] = (progress['text'] + chunk)[-65536:]


def parse_progress(text):
    """-> {out_time_s, frames} from the last `out_time_us=` / `frame=` lines ffmpeg wrote; a value ffmpeg did not give (N/A) stays None."""
    out_us = frames = None
    for line in text.decode('utf-8', 'replace').splitlines():
        k, _, v = line.partition('=')
        v = v.strip()
        if k == 'out_time_us' and v.lstrip('-').isdigit():
            out_us = int(v)
        elif k == 'frame' and v.isdigit():
            frames = int(v)
    return {'out_time_s': None if out_us is None else round(out_us / 1e6, 6), 'frames': frames}


reader = None
if progress['fd'] is not None:
    reader = threading.Thread(target=drain_progress, daemon=True)
    reader.start()
try:
    r = subprocess.run(cmd, capture_output=True, timeout=left(END_RESERVE_S), pass_fds=(write_end,) if progress['fd'] is not None else ())
    receipt.update(exit_code=r.returncode, stderr=r.stderr.decode(errors='replace')[:8000])
    payload = r.stdout
except subprocess.TimeoutExpired as e:
    receipt.update(exit_code='timeout', timed_out=True, stderr=(e.stderr or b'').decode(errors='replace')[:8000])
    payload = e.stdout or b''
except OSError as e:
    receipt['error'] = '%s: %s' % (type(e).__name__, str(e)[:300])
finally:
    server.shutdown()
    server.server_close()
    if progress['fd'] is not None:
        os.close(write_end)         # the child has ended (or been killed): the reader sees EOF
        reader.join(1.0)
        receipt['progress'] = parse_progress(progress['text'])
receipt.update(state)
close_identity()
finish(payload)
