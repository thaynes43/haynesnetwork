// DESIGN-004 D-17 — the MOTD's sanitized-markdown renderer. The stored `motd.message` string is
// interpreted as a MINIMAL markdown subset — links `[text](https://…)`, **bold**, _italic_/*italic*,
// `code`, `- ` bullet lists, line breaks (blank line = new paragraph) and bare-URL autolinking — and
// rendered STRAIGHT TO REACT ELEMENTS. There is no HTML parsing, no HTML pass-through, and no
// `dangerouslySetInnerHTML` anywhere: the parser only ever emits text nodes and a fixed set of
// elements (<p>/<ul>/<li>/<a>/<strong>/<em>/<code>/<br>), so admin-authored `<script>`/HTML arrives
// as literal escaped text — the "no injection surface" property of ADR-027 is preserved by
// construction, with zero new dependencies. Links are confined to http(s): any other scheme renders
// as plain text. Plain-text messages contain none of the markers and render unchanged (back-compat).
import { Fragment, type ReactElement, type ReactNode } from 'react';

/** Inline nodes — the full set of things that can appear inside a paragraph or list item. */
export type MotdInline =
  | { kind: 'text'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'link'; href: string; children: MotdInline[] }
  | { kind: 'strong'; children: MotdInline[] }
  | { kind: 'em'; children: MotdInline[] }
  | { kind: 'break' };

/** Block nodes — a message is a sequence of paragraphs and simple bullet lists. */
export type MotdBlock =
  { kind: 'paragraph'; children: MotdInline[] } | { kind: 'list'; items: MotdInline[][] };

/** Normalize a candidate link target: only absolute http/https URLs qualify (anything else — js:,
 *  data:, relative paths, garbage — is rejected and the source text stays literal). */
export function safeMotdHref(raw: string): string | null {
  try {
    const url = new URL(raw);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

/** A successful inline match: the node plus how many source chars it consumed. */
interface InlineHit {
  node: MotdInline;
  consumed: number;
}

/** One inline pattern: a regex plus a builder for the node it produces (null ⇒ the rule declines —
 *  e.g. an unsafe link target — and the scanner treats the matched char as literal text). */
interface InlineRule {
  re: RegExp;
  /** Rules that produce links are skipped inside link labels (links never nest). */
  producesLink?: boolean;
  build: (m: RegExpExecArray, allowLinks: boolean) => InlineHit | null;
}

/** Trailing characters that read as sentence punctuation, not part of a bare URL. */
const TRAILING_PUNCT = /[.,;:!?'")\]]+$/;

// Ordered by precedence at equal match positions: code (literal content) beats everything, an
// explicit [text](url) link beats emphasis, ** beats *, and bare-URL autolink runs last.
const INLINE_RULES: InlineRule[] = [
  {
    // `code` — content is literal (no nested formatting, no linking).
    re: /`([^`\n]+)`/,
    build: (m) => ({ node: { kind: 'code', text: m[1] ?? '' }, consumed: m[0].length }),
  },
  {
    // [text](url) — http(s) only; the label is recursively parsed (bold/italic/code inside a label
    // work) with links disabled so links never nest.
    re: /\[([^\]\n]+)\]\(([^)\s]+)\)/,
    producesLink: true,
    build: (m) => {
      const href = safeMotdHref(m[2] ?? '');
      if (!href) return null;
      return {
        node: { kind: 'link', href, children: parseInline(m[1] ?? '', false) },
        consumed: m[0].length,
      };
    },
  },
  {
    // **bold** — content recursively parsed (links/italic/code inside bold work).
    re: /\*\*((?:[^*\n]|\*(?!\*))+)\*\*/,
    build: (m, allowLinks) => ({
      node: { kind: 'strong', children: parseInline(m[1] ?? '', allowLinks) },
      consumed: m[0].length,
    }),
  },
  {
    // *italic* — the content must not start/end with whitespace (so "2 * 3 * 4" stays literal).
    re: /\*([^\s*][^*\n]*?)\*/,
    build: (m, allowLinks) => {
      const body = m[1] ?? '';
      return body.trim() === body
        ? { node: { kind: 'em', children: parseInline(body, allowLinks) }, consumed: m[0].length }
        : null;
    },
  },
  {
    // _italic_ — word-bounded so snake_case_identifiers stay literal.
    re: /(?<![\w_])_([^\s_][^_\n]*?)_(?![\w_])/,
    build: (m, allowLinks) => {
      const body = m[1] ?? '';
      return body.trim() === body
        ? { node: { kind: 'em', children: parseInline(body, allowLinks) }, consumed: m[0].length }
        : null;
    },
  },
  {
    // Bare-URL autolink — a pasted https://… becomes clickable even without link syntax (exactly
    // the "URL sitting in the middle of a sentence" case), minus trailing sentence punctuation
    // (which stays literal text after the link).
    re: /https?:\/\/[^\s<>]+/,
    producesLink: true,
    build: (m) => {
      const trimmed = m[0].replace(TRAILING_PUNCT, '');
      const href = safeMotdHref(trimmed);
      if (!href) return null;
      return {
        node: { kind: 'link', href, children: [{ kind: 'text', text: trimmed }] },
        consumed: trimmed.length,
      };
    },
  },
];

/** Append literal text, merging with a preceding text node so the AST stays canonical. */
function pushText(out: MotdInline[], text: string): void {
  if (text === '') return;
  const last = out[out.length - 1];
  if (last?.kind === 'text') last.text += text;
  else out.push({ kind: 'text', text });
}

/** Parse ONE line (no newlines) of inline markdown into nodes. The earliest match wins; rule order
 *  breaks position ties. A rule that declines (unsafe href, whitespace-wrapped emphasis) yields one
 *  literal char and the scan continues — nothing is ever dropped. */
export function parseInline(line: string, allowLinks = true): MotdInline[] {
  const out: MotdInline[] = [];
  let rest = line;
  while (rest.length > 0) {
    let bestIndex = -1;
    let bestRule: InlineRule | null = null;
    let bestMatch: RegExpExecArray | null = null;
    for (const rule of INLINE_RULES) {
      if (!allowLinks && rule.producesLink) continue;
      const m = rule.re.exec(rest);
      if (m && (bestIndex === -1 || m.index < bestIndex)) {
        bestIndex = m.index;
        bestRule = rule;
        bestMatch = m;
      }
    }
    if (!bestRule || !bestMatch) {
      pushText(out, rest);
      break;
    }
    pushText(out, rest.slice(0, bestIndex));
    const hit = bestRule.build(bestMatch, allowLinks);
    if (hit) {
      out.push(hit.node);
      rest = rest.slice(bestIndex + hit.consumed);
    } else {
      // Declined match: emit one literal char and rescan from the next position.
      pushText(out, rest.slice(bestIndex, bestIndex + 1));
      rest = rest.slice(bestIndex + 1);
    }
  }
  return out;
}

/** Parse a whole MOTD message into blocks: blank lines split paragraphs, a run of `- ` lines forms
 *  a bullet list, single newlines inside a paragraph become hard breaks. */
export function parseMotdMarkdown(message: string): MotdBlock[] {
  const blocks: MotdBlock[] = [];
  for (const chunk of message.split(/\n[ \t]*\n+/)) {
    const lines = chunk
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l !== '');
    if (lines.length === 0) continue;
    if (lines.every((l) => /^- +\S/.test(l))) {
      blocks.push({ kind: 'list', items: lines.map((l) => parseInline(l.replace(/^- +/, ''))) });
      continue;
    }
    const children: MotdInline[] = [];
    lines.forEach((l, i) => {
      if (i > 0) children.push({ kind: 'break' });
      children.push(...parseInline(l));
    });
    blocks.push({ kind: 'paragraph', children });
  }
  return blocks;
}

function renderInlines(nodes: MotdInline[]): ReactNode {
  return nodes.map((n, i) => {
    switch (n.kind) {
      case 'text':
        return <Fragment key={i}>{n.text}</Fragment>;
      case 'code':
        return <code key={i}>{n.text}</code>;
      case 'strong':
        return <strong key={i}>{renderInlines(n.children)}</strong>;
      case 'em':
        return <em key={i}>{renderInlines(n.children)}</em>;
      case 'break':
        return <br key={i} />;
      case 'link':
        return (
          <a key={i} href={n.href} target="_blank" rel="noopener noreferrer">
            {renderInlines(n.children)}
          </a>
        );
    }
  });
}

/** Render a MOTD message (markdown subset) as React elements — see the header comment for the
 *  safety argument. Used by BOTH the dashboard banner and the /admin/motd live preview, so the
 *  preview is the real rendering by construction. */
export function MotdMarkdown({ message }: { message: string }): ReactElement {
  const blocks = parseMotdMarkdown(message);
  return (
    <>
      {blocks.map((block, i) =>
        block.kind === 'list' ? (
          <ul key={i}>
            {block.items.map((item, j) => (
              <li key={j}>{renderInlines(item)}</li>
            ))}
          </ul>
        ) : (
          <p key={i}>{renderInlines(block.children)}</p>
        ),
      )}
    </>
  );
}
