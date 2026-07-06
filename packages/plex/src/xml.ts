// ADR-017 / DESIGN-007 — a deliberately minimal XML reader for the plex.tv v1 sharing API
// (the python-plexapi "friend" model). Plex's responses are flat, attribute-only element
// trees — `<MediaContainer><User email=… ><Server machineIdentifier=… /></User></MediaContainer>`
// and `<SharedServer id=… ><Section id= key= shared= /></SharedServer>` — with NO text
// content, CDATA, or namespaces. A full XML dependency would be overkill and a supply-chain
// cost; this hand-rolled tokenizer parses exactly that subset. The extracted subset is then
// zod-validated in schemas.ts (BC-04 ACL — external Plex models never leak past the package).

export interface XmlElement {
  tag: string;
  attrs: Record<string, string>;
  children: XmlElement[];
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

/** Decode the XML entities that appear in Plex attribute values (titles with `&`, etc.). */
function decodeEntities(value: string): string {
  return value.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body[0] === '#') {
      const codePoint =
        body[1] === 'x' || body[1] === 'X'
          ? Number.parseInt(body.slice(2), 16)
          : Number.parseInt(body.slice(1), 10);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : whole;
    }
    return NAMED_ENTITIES[body] ?? whole;
  });
}

const ATTR_RE = /([A-Za-z_:][\w.\-:]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

function parseAttrs(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  let m: RegExpExecArray | null;
  ATTR_RE.lastIndex = 0;
  while ((m = ATTR_RE.exec(raw)) !== null) {
    attrs[m[1]!] = decodeEntities(m[2] ?? m[3] ?? '');
  }
  return attrs;
}

// One match = one tag. group1 '/' ⇒ closing tag; group2 = name; group3 = raw attrs; a
// trailing '/' inside group3 (self-close) is detected below.
const TAG_RE = /<(\/?)([A-Za-z_][\w.\-:]*)([^>]*?)(\/?)>/g;

/**
 * Parse a Plex XML document into an element tree. Comments, the `<?xml?>` declaration, and
 * `<!DOCTYPE>` are stripped first; text nodes are ignored (Plex carries all data in
 * attributes). Throws on a malformed/empty document (callers surface PlexParseError).
 */
export function parseXml(input: string): XmlElement {
  const cleaned = input
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<\?[\s\S]*?\?>/g, '')
    .replace(/<!DOCTYPE[^>]*>/gi, '');

  const root: XmlElement = { tag: '#root', attrs: {}, children: [] };
  const stack: XmlElement[] = [root];
  let m: RegExpExecArray | null;
  TAG_RE.lastIndex = 0;
  while ((m = TAG_RE.exec(cleaned)) !== null) {
    const closing = m[1] === '/';
    const tag = m[2]!;
    const rawAttrs = m[3] ?? '';
    const selfClose = m[4] === '/';
    const top = stack[stack.length - 1]!;
    if (closing) {
      // Pop to the matching open tag (tolerant of the well-formed Plex responses).
      if (stack.length > 1) stack.pop();
      continue;
    }
    const el: XmlElement = { tag, attrs: parseAttrs(rawAttrs), children: [] };
    top.children.push(el);
    if (!selfClose) stack.push(el);
  }

  const docRoot = root.children[0];
  if (!docRoot) throw new Error('empty or malformed XML document');
  return docRoot;
}

/** Direct children of `el` with the given tag name. */
export function childrenNamed(el: XmlElement, tag: string): XmlElement[] {
  return el.children.filter((c) => c.tag === tag);
}
