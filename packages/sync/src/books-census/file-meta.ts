// DESIGN-028 amendment 2026-10-06 (the Books Census, issues #744 and #781) — what a held book file says about itself.
// Read-only and cheap by construction: a file is opened read-only and read with positioned reads of the few blocks
// that hold its metadata (an EPUB's zip directory and OPF, a MOBI's first record, an ID3 tag, an MP4 `moov` atom),
// never streamed whole. Nothing here writes, and nothing parses more than MAX_BLOCK bytes at once.
//
//   EPUB          OPF `dc:title`, `dc:language`, the calibre / EPUB 3 series name, and a text sample (the first spine
//                 documents, at most TEXT_SAMPLE_WORDS words) for the language guess in ./language.ts
//   MOBI / AZW3   EXTH 503 (updated title), else the MOBI full name; EXTH 524 (language), else the header locale
//   MP3           ID3v2 TALB (album) and TIT2 (track title), TLAN (language); v2.2, v2.3 and v2.4 frames
//   M4B / M4A     `moov/udta/meta/ilst` ©alb (album) and ©nam (title)
// Anything else (a PDF) is `unsupported`; a file that cannot be parsed is `unreadable` with the reason.
import { open, type FileHandle } from 'node:fs/promises';
import { inflateRawSync } from 'node:zlib';

/** What a held file says about itself. */
export interface FileMeta {
  /** How the file was read. */
  status: 'read' | 'unsupported' | 'unreadable' | 'missing';
  /** The file's own title (EPUB `dc:title`, MOBI title, the album tag); null when it has none. */
  title: string | null;
  /** Other titles the file carries (an audiobook's track title, ID3 TIT2 / MP4 ©nam): album tags are often the series. */
  altTitles: string[];
  /** The language the file declares (`dc:language`, EXTH 524 or the MOBI locale, ID3 TLAN); null when none. */
  language: string | null;
  /** The series name the file declares (calibre:series, belongs-to-collection); null when none. */
  series: string | null;
  /** A plain-text sample of the book's first documents (EPUB only), for the text language guess. */
  textSample: string | null;
  /** Why the file could not be read. */
  error?: string;
}

const MAX_BLOCK = 16 * 1024 * 1024;
/** The text sample stops at this many words. */
export const TEXT_SAMPLE_WORDS = 3000;
/** At most this many spine documents are read for the sample. */
const TEXT_SAMPLE_DOCS = 12;

const empty = (status: FileMeta['status'], error?: string): FileMeta => ({
  status,
  title: null,
  altTitles: [],
  language: null,
  series: null,
  textSample: null,
  ...(error ? { error } : {}),
});

/** The file kind a path's extension names (lowercase), or null. */
export function fileKind(path: string): 'epub' | 'mobi' | 'mp3' | 'mp4' | 'other' {
  const ext = /\.([A-Za-z0-9]+)$/.exec(path)?.[1]?.toLowerCase() ?? '';
  if (ext === 'epub') return 'epub';
  if (ext === 'mobi' || ext === 'azw3' || ext === 'azw') return 'mobi';
  if (ext === 'mp3') return 'mp3';
  if (ext === 'm4b' || ext === 'm4a' || ext === 'mp4') return 'mp4';
  return 'other';
}

/** Read what a held file says about itself. Never throws: a failure is `unreadable` / `missing`. */
export async function readFileMeta(path: string): Promise<FileMeta> {
  const kind = fileKind(path);
  if (kind === 'other') return empty('unsupported');
  let fh: FileHandle;
  try {
    fh = await open(path, 'r');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'ENOENT' || code === 'ENOTDIR'
      ? empty('missing')
      : empty('unreadable', (error as Error).message);
  }
  try {
    const size = (await fh.stat()).size;
    if (kind === 'epub') return await readEpub(fh, size);
    if (kind === 'mobi') return await readMobi(fh, size);
    if (kind === 'mp3') return await readId3(fh, size);
    return await readMp4(fh, size);
  } catch (error) {
    return empty('unreadable', error instanceof Error ? error.message : String(error));
  } finally {
    await fh.close().catch(() => {});
  }
}

async function readAt(fh: FileHandle, position: number, length: number): Promise<Buffer> {
  if (length < 0 || length > MAX_BLOCK) throw new Error(`block of ${length} bytes refused`);
  const buf = Buffer.alloc(length);
  let done = 0;
  while (done < length) {
    const { bytesRead } = await fh.read(buf, done, length - done, position + done);
    if (bytesRead === 0) break;
    done += bytesRead;
  }
  return done === length ? buf : buf.subarray(0, done);
}

// ---------------------------------------------------------------------------------------------------------------------
// XML text helpers (OPF and XHTML are read with patterns, not a parser: the fields are flat and the files are ours to
// misread only as "no title")
// ---------------------------------------------------------------------------------------------------------------------

const ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  rsquo: '’',
  lsquo: '‘',
  ldquo: '“',
  rdquo: '”',
  mdash: '—',
  ndash: '–',
  hellip: '…',
};

/** Decode XML/HTML character references and the common named entities. */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, ref: string) => {
    if (ref[0] === '#') {
      const code =
        ref[1] === 'x' || ref[1] === 'X' ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000
        ? String.fromCodePoint(code)
        : whole;
    }
    return ENTITIES[ref.toLowerCase()] ?? whole;
  });
}

const clean = (s: string | null | undefined): string | null => {
  const out = decodeEntities(
    (s ?? '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]*>/g, ''),
  )
    .replace(/\s+/g, ' ')
    .trim();
  return out.length > 0 ? out : null;
};

/** The first element's text whose (possibly prefixed) name is `name`. */
function firstElement(xml: string, name: string): string | null {
  const m = new RegExp(
    `<(?:[A-Za-z0-9_-]+:)?${name}\\b[^>]*>([\\s\\S]*?)</(?:[A-Za-z0-9_-]+:)?${name}>`,
    'i',
  ).exec(xml);
  return m ? clean(m[1]) : null;
}

/** An attribute's value inside one tag. */
function attr(tag: string, name: string): string | null {
  const m = new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i').exec(tag);
  return m ? decodeEntities(m[2] ?? m[3] ?? '') : null;
}

/** Plain text of an XHTML document: scripts, styles and tags out, entities decoded. */
export function xhtmlText(xml: string): string {
  return decodeEntities(
    xml.replace(/<(script|style|head)\b[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]*>/g, ' '),
  )
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------------------------------------------------------------------------------------------------------------------
// EPUB (a zip): the end-of-central-directory record, the directory, then single entries by their local header
// ---------------------------------------------------------------------------------------------------------------------

interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  size: number;
  localOffset: number;
}

async function zipDirectory(fh: FileHandle, size: number): Promise<Map<string, ZipEntry>> {
  const tailLength = Math.min(size, 65_557);
  const tail = await readAt(fh, size - tailLength, tailLength);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i -= 1) {
    if (tail.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('not a zip: no end-of-central-directory record');
  const entries = tail.readUInt16LE(eocd + 10);
  const cdSize = tail.readUInt32LE(eocd + 12);
  const cdOffset = tail.readUInt32LE(eocd + 16);
  if (cdOffset === 0xffffffff || cdSize === 0xffffffff) throw new Error('zip64 is not read');
  const cd = await readAt(fh, cdOffset, cdSize);
  const out = new Map<string, ZipEntry>();
  let p = 0;
  for (let n = 0; n < entries && p + 46 <= cd.length; n += 1) {
    if (cd.readUInt32LE(p) !== 0x02014b50) throw new Error('corrupt zip directory');
    const nameLength = cd.readUInt16LE(p + 28);
    const extraLength = cd.readUInt16LE(p + 30);
    const commentLength = cd.readUInt16LE(p + 32);
    const flags = cd.readUInt16LE(p + 8);
    const rawName = cd.subarray(p + 46, p + 46 + nameLength);
    const name = flags & 0x800 ? rawName.toString('utf8') : rawName.toString('latin1');
    out.set(name, {
      name,
      method: cd.readUInt16LE(p + 10),
      compressedSize: cd.readUInt32LE(p + 20),
      size: cd.readUInt32LE(p + 24),
      localOffset: cd.readUInt32LE(p + 42),
    });
    p += 46 + nameLength + extraLength + commentLength;
  }
  return out;
}

async function zipRead(fh: FileHandle, entry: ZipEntry): Promise<Buffer> {
  const header = await readAt(fh, entry.localOffset, 30);
  if (header.length < 30 || header.readUInt32LE(0) !== 0x04034b50)
    throw new Error(`bad local header: ${entry.name}`);
  const start = entry.localOffset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
  const data = await readAt(fh, start, entry.compressedSize);
  if (entry.method === 0) return data;
  if (entry.method === 8) return inflateRawSync(data, { maxOutputLength: MAX_BLOCK });
  throw new Error(`zip method ${entry.method} is not read`);
}

/** Resolve a manifest href against the OPF's folder (zip paths, `/`-separated, URL-escaped). */
function zipPath(base: string, href: string): string {
  const parts = (base ? `${base}/` : '')
    .concat(decodeURIComponent(href.split('#')[0] ?? ''))
    .split('/');
  const out: string[] = [];
  for (const part of parts) {
    if (part === '..') out.pop();
    else if (part !== '.' && part !== '') out.push(part);
  }
  return out.join('/');
}

async function readEpub(fh: FileHandle, size: number): Promise<FileMeta> {
  const dir = await zipDirectory(fh, size);
  let opfPath: string | null = null;
  const container = dir.get('META-INF/container.xml');
  if (container) {
    const xml = (await zipRead(fh, container)).toString('utf8');
    const tag = /<rootfile\b[^>]*>/i.exec(xml)?.[0];
    opfPath = tag ? attr(tag, 'full-path') : null;
  }
  if (!opfPath || !dir.has(opfPath))
    opfPath = [...dir.keys()].find((k) => k.toLowerCase().endsWith('.opf')) ?? null;
  if (!opfPath) return empty('unreadable', 'no OPF package document');
  const opf = (await zipRead(fh, dir.get(opfPath)!)).toString('utf8');
  const metadata =
    /<(?:[A-Za-z0-9_-]+:)?metadata\b[\s\S]*?<\/(?:[A-Za-z0-9_-]+:)?metadata>/i.exec(opf)?.[0] ??
    opf;
  const title = firstElement(metadata, 'title');
  const language = firstElement(metadata, 'language');
  let series: string | null = null;
  for (const tag of metadata.match(/<(?:[A-Za-z0-9_-]+:)?meta\b[^>]*>/gi) ?? []) {
    if ((attr(tag, 'name') ?? '').toLowerCase() === 'calibre:series')
      series = clean(attr(tag, 'content'));
  }
  const collection =
    /<(?:[A-Za-z0-9_-]+:)?meta\b[^>]*property\s*=\s*["']belongs-to-collection["'][^>]*>([\s\S]*?)<\//i.exec(
      metadata,
    );
  series ??= collection ? clean(collection[1]) : null;

  // The text sample: spine order, the manifest's XHTML documents, until TEXT_SAMPLE_WORDS words.
  const base = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/')) : '';
  const manifest = new Map<string, string>();
  for (const tag of opf.match(/<(?:[A-Za-z0-9_-]+:)?item\b[^>]*>/gi) ?? []) {
    const id = attr(tag, 'id');
    const href = attr(tag, 'href');
    const type = (attr(tag, 'media-type') ?? '').toLowerCase();
    if (id && href && (type.includes('html') || /\.x?html?$/i.test(href)))
      manifest.set(id, zipPath(base, href));
  }
  const spine = (opf.match(/<(?:[A-Za-z0-9_-]+:)?itemref\b[^>]*>/gi) ?? [])
    .map((tag) => attr(tag, 'idref'))
    .filter((id): id is string => id !== null && manifest.has(id))
    .map((id) => manifest.get(id)!);
  const sample: string[] = [];
  let count = 0;
  for (const path of spine.slice(0, TEXT_SAMPLE_DOCS)) {
    const entry = dir.get(path);
    if (!entry || entry.size > MAX_BLOCK) continue;
    let text: string;
    try {
      text = xhtmlText((await zipRead(fh, entry)).toString('utf8'));
    } catch {
      continue;
    }
    const words = text.split(' ').filter((w) => w.length > 0);
    sample.push(words.slice(0, TEXT_SAMPLE_WORDS - count).join(' '));
    count += Math.min(words.length, TEXT_SAMPLE_WORDS - count);
    if (count >= TEXT_SAMPLE_WORDS) break;
  }
  return {
    status: 'read',
    title,
    altTitles: [],
    language,
    series,
    textSample: sample.join(' ').trim() || null,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// MOBI / AZW3 (a PalmDB): record 0 holds the PalmDOC and MOBI headers, the full name and the EXTH block
// ---------------------------------------------------------------------------------------------------------------------

/** Windows primary-language ids of a MOBI locale, for the ones the estate meets. */
const MOBI_LANGUAGES: Readonly<Record<number, string>> = {
  6: 'da',
  7: 'de',
  9: 'en',
  10: 'es',
  11: 'fi',
  12: 'fr',
  13: 'he',
  16: 'it',
  17: 'ja',
  19: 'nl',
  20: 'no',
  21: 'pl',
  22: 'pt',
  25: 'ru',
  29: 'sv',
  31: 'tr',
};

async function readMobi(fh: FileHandle, size: number): Promise<FileMeta> {
  const head = await readAt(fh, 0, Math.min(size, 78 + 8 * 2));
  if (head.length < 86) throw new Error('not a PalmDB file');
  const type = head.subarray(60, 68).toString('latin1');
  if (type !== 'BOOKMOBI') throw new Error(`PalmDB type ${type} is not BOOKMOBI`);
  const r0 = head.readUInt32BE(78);
  const r1 = head.readUInt32BE(86);
  const length = Math.min((r1 > r0 ? r1 : size) - r0, 256 * 1024);
  const rec = await readAt(fh, r0, length);
  if (rec.length < 132 || rec.subarray(16, 20).toString('latin1') !== 'MOBI')
    throw new Error('no MOBI header');
  const mobiLength = rec.readUInt32BE(20);
  const encoding = rec.readUInt32BE(28);
  const decode = (b: Buffer): string =>
    encoding === 65001 ? b.toString('utf8') : b.toString('latin1');
  const nameOffset = rec.readUInt32BE(84);
  const nameLength = rec.readUInt32BE(88);
  const fullName =
    nameOffset + nameLength <= rec.length
      ? clean(decode(rec.subarray(nameOffset, nameOffset + nameLength)))
      : null;
  const locale = rec.readUInt32BE(92);
  let title: string | null = null;
  let language: string | null = null;
  const exthFlags = rec.readUInt32BE(128);
  const exth = 16 + mobiLength;
  if (
    exthFlags & 0x40 &&
    exth + 12 <= rec.length &&
    rec.subarray(exth, exth + 4).toString('latin1') === 'EXTH'
  ) {
    const count = rec.readUInt32BE(exth + 8);
    let p = exth + 12;
    for (let n = 0; n < count && p + 8 <= rec.length; n += 1) {
      const t = rec.readUInt32BE(p);
      const len = rec.readUInt32BE(p + 4);
      if (len < 8 || p + len > rec.length) break;
      const value = clean(decode(rec.subarray(p + 8, p + len)));
      if (t === 503 && value) title = value;
      if (t === 524 && value) language = value;
      p += len;
    }
  }
  language ??= MOBI_LANGUAGES[locale & 0xff] ?? null;
  return {
    status: 'read',
    title: title ?? fullName,
    altTitles: title && fullName && fullName !== title ? [fullName] : [],
    language,
    series: null,
    textSample: null,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// ID3v2 (MP3)
// ---------------------------------------------------------------------------------------------------------------------

const syncsafe = (b: Buffer, at: number): number =>
  ((b[at]! & 0x7f) << 21) |
  ((b[at + 1]! & 0x7f) << 14) |
  ((b[at + 2]! & 0x7f) << 7) |
  (b[at + 3]! & 0x7f);

/** An ID3 text frame's value: its encoding byte, then the text (UTF-16 with or without BOM, Latin-1 or UTF-8). */
export function id3Text(body: Buffer): string | null {
  if (body.length < 2) return null;
  const enc = body[0];
  const raw = body.subarray(1);
  let text: string;
  if (enc === 1 || enc === 2) {
    let b = raw;
    let le = enc === 1;
    if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) {
      le = true;
      b = b.subarray(2);
    } else if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) {
      le = false;
      b = b.subarray(2);
    }
    const even = b.subarray(0, b.length - (b.length % 2));
    text = le ? even.toString('utf16le') : Buffer.from(even).swap16().toString('utf16le');
  } else {
    text = enc === 3 ? raw.toString('utf8') : raw.toString('latin1');
  }
  return clean(text.split('\u0000')[0]);
}

async function readId3(fh: FileHandle, size: number): Promise<FileMeta> {
  const header = await readAt(fh, 0, Math.min(size, 10));
  if (header.length < 10 || header.subarray(0, 3).toString('latin1') !== 'ID3')
    return empty('read');
  const major = header[3]!;
  const tagSize = syncsafe(header, 6);
  const hasExtended = (header[5]! & 0x40) !== 0;
  const end = Math.min(10 + tagSize, size);
  const idLength = major === 2 ? 3 : 4;
  const headerLength = major === 2 ? 6 : 10;
  const want: Readonly<Record<string, 'album' | 'track' | 'language'>> =
    major === 2
      ? { TAL: 'album', TT2: 'track', TLA: 'language' }
      : { TALB: 'album', TIT2: 'track', TLAN: 'language' };
  let p = 10;
  if (hasExtended && major >= 3) {
    const ext = await readAt(fh, p, 4);
    p += major === 4 ? syncsafe(ext, 0) : ext.readUInt32BE(0) + 4;
  }
  const found: { album?: string | null; track?: string | null; language?: string | null } = {};
  for (let frames = 0; p + headerLength <= end && frames < 500; frames += 1) {
    const fhdr = await readAt(fh, p, headerLength);
    if (fhdr.length < headerLength || fhdr[0] === 0) break;
    const id = fhdr.subarray(0, idLength).toString('latin1');
    const frameSize =
      major === 2
        ? (fhdr[3]! << 16) | (fhdr[4]! << 8) | fhdr[5]!
        : major === 4
          ? syncsafe(fhdr, 4)
          : fhdr.readUInt32BE(4);
    if (!/^[A-Z0-9]+$/.test(id) || frameSize <= 0 || p + headerLength + frameSize > end) break;
    const field = want[id];
    if (field && frameSize <= 64 * 1024) {
      found[field] = id3Text(await readAt(fh, p + headerLength, frameSize));
      if (found.album !== undefined && found.track !== undefined && found.language !== undefined)
        break;
    }
    p += headerLength + frameSize;
  }
  return {
    status: 'read',
    title: found.album ?? null,
    altTitles: found.track ? [found.track] : [],
    language: found.language ?? null,
    series: null,
    textSample: null,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// MP4 / M4B: walk the top-level atoms to `moov` (headers only), read it, find ilst's ©alb / ©nam
// ---------------------------------------------------------------------------------------------------------------------

function childAtoms(
  buf: Buffer,
  start: number,
  end: number,
): { type: string; start: number; end: number }[] {
  const out: { type: string; start: number; end: number }[] = [];
  let p = start;
  while (p + 8 <= end) {
    let len = buf.readUInt32BE(p);
    const type = buf.subarray(p + 4, p + 8).toString('latin1');
    let headerLength = 8;
    if (len === 1 && p + 16 <= end) {
      len = Number(buf.readBigUInt64BE(p + 8));
      headerLength = 16;
    } else if (len === 0) len = end - p;
    if (len < headerLength || p + len > end) break;
    out.push({ type, start: p + headerLength, end: p + len });
    p += len;
  }
  return out;
}

async function readMp4(fh: FileHandle, size: number): Promise<FileMeta> {
  let p = 0;
  let moov: Buffer | null = null;
  for (let n = 0; p + 8 <= size && n < 64; n += 1) {
    const h = await readAt(fh, p, 16);
    if (h.length < 8) break;
    let len = h.readUInt32BE(0);
    const type = h.subarray(4, 8).toString('latin1');
    let headerLength = 8;
    if (len === 1 && h.length >= 16) {
      len = Number(h.readBigUInt64BE(8));
      headerLength = 16;
    } else if (len === 0) len = size - p;
    if (len < headerLength) break;
    if (type === 'moov') {
      moov = await readAt(fh, p + headerLength, len - headerLength);
      break;
    }
    p += len;
  }
  if (!moov) return empty('read');
  const find = (
    buf: Buffer,
    start: number,
    end: number,
    path: string[],
  ): { start: number; end: number } | null => {
    if (path.length === 0) return { start, end };
    const [head, ...rest] = path;
    for (const atom of childAtoms(buf, start, end)) {
      if (atom.type !== head) continue;
      // `meta` is a full atom: four bytes of version and flags before its children.
      const from = head === 'meta' ? atom.start + 4 : atom.start;
      const hit = find(buf, from, atom.end, rest);
      if (hit) return hit;
    }
    return null;
  };
  const ilst = find(moov, 0, moov.length, ['udta', 'meta', 'ilst']);
  if (!ilst) return empty('read');
  const values: Record<string, string | null> = {};
  for (const item of childAtoms(moov, ilst.start, ilst.end)) {
    const data = childAtoms(moov, item.start, item.end).find((a) => a.type === 'data');
    if (!data || data.end - data.start < 8) continue;
    values[item.type] = clean(moov.subarray(data.start + 8, data.end).toString('utf8'));
  }
  const album = values['©alb'] ?? null;
  const name = values['©nam'] ?? null;
  return {
    status: 'read',
    title: album ?? name,
    altTitles: album && name ? [name] : [],
    language: null,
    series: null,
    textSample: null,
  };
}
