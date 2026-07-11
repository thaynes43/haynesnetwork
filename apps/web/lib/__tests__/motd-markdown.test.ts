// DESIGN-004 D-17 — the MOTD sanitized-markdown renderer. Two layers under test:
//   • parseMotdMarkdown / parseInline — the pure AST (subset coverage + edge cases);
//   • <MotdMarkdown> via renderToStaticMarkup — the SAFETY property (React-element-only output:
//     admin-authored HTML/script arrives escaped; only http(s) hrefs become anchors; links carry
//     target=_blank rel="noopener noreferrer").
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MotdMarkdown, parseInline, parseMotdMarkdown, safeMotdHref } from '../motd-markdown';

const html = (message: string) => renderToStaticMarkup(createElement(MotdMarkdown, { message }));

describe('safeMotdHref', () => {
  it('accepts absolute http/https URLs', () => {
    expect(safeMotdHref('https://github.com/thaynes43')).toBe('https://github.com/thaynes43');
    expect(safeMotdHref('http://example.com/a?b=c')).toBe('http://example.com/a?b=c');
  });
  it('rejects every other scheme and non-URLs', () => {
    expect(safeMotdHref('javascript:alert(1)')).toBeNull();
    expect(safeMotdHref('data:text/html,<script>1</script>')).toBeNull();
    expect(safeMotdHref('vbscript:x')).toBeNull();
    expect(safeMotdHref('/relative/path')).toBeNull();
    expect(safeMotdHref('not a url')).toBeNull();
  });
});

describe('parseInline', () => {
  it('plain text is a single text node (back-compat: plain MOTDs render unchanged)', () => {
    expect(parseInline('Welcome to haynesnetwork!')).toEqual([
      { kind: 'text', text: 'Welcome to haynesnetwork!' },
    ]);
  });

  it('parses [text](url) links', () => {
    expect(parseInline('file issues [on my GitHub](https://github.com/x/y/issues) please')).toEqual(
      [
        { kind: 'text', text: 'file issues ' },
        {
          kind: 'link',
          href: 'https://github.com/x/y/issues',
          children: [{ kind: 'text', text: 'on my GitHub' }],
        },
        { kind: 'text', text: ' please' },
      ],
    );
  });

  it('a link with an unsafe scheme stays literal text (no anchor)', () => {
    const nodes = parseInline('[click](javascript:alert(1))');
    expect(nodes.every((n) => n.kind === 'text')).toBe(true);
    expect(nodes.map((n) => (n.kind === 'text' ? n.text : '')).join('')).toBe(
      '[click](javascript:alert(1))',
    );
  });

  it('parses **bold**, *italic*, _italic_ and `code`', () => {
    expect(parseInline('**b** *i* _j_ `c`')).toEqual([
      { kind: 'strong', children: [{ kind: 'text', text: 'b' }] },
      { kind: 'text', text: ' ' },
      { kind: 'em', children: [{ kind: 'text', text: 'i' }] },
      { kind: 'text', text: ' ' },
      { kind: 'em', children: [{ kind: 'text', text: 'j' }] },
      { kind: 'text', text: ' ' },
      { kind: 'code', text: 'c' },
    ]);
  });

  it('nesting: bold inside a link label; a link inside bold', () => {
    expect(parseInline('[**hot**](https://x.dev)')).toEqual([
      {
        kind: 'link',
        href: 'https://x.dev/',
        children: [{ kind: 'strong', children: [{ kind: 'text', text: 'hot' }] }],
      },
    ]);
    expect(parseInline('**see [docs](https://x.dev)**')).toEqual([
      {
        kind: 'strong',
        children: [
          { kind: 'text', text: 'see ' },
          { kind: 'link', href: 'https://x.dev/', children: [{ kind: 'text', text: 'docs' }] },
        ],
      },
    ]);
  });

  it('code content is literal — markers inside backticks do not format', () => {
    expect(parseInline('`**not bold** [x](https://y.z)`')).toEqual([
      { kind: 'code', text: '**not bold** [x](https://y.z)' },
    ]);
  });

  it('autolinks a bare pasted URL and keeps trailing punctuation as text', () => {
    expect(parseInline('see https://github.com/thaynes43/haynesnetwork/issues.')).toEqual([
      { kind: 'text', text: 'see ' },
      {
        kind: 'link',
        href: 'https://github.com/thaynes43/haynesnetwork/issues',
        children: [{ kind: 'text', text: 'https://github.com/thaynes43/haynesnetwork/issues' }],
      },
      { kind: 'text', text: '.' },
    ]);
  });

  it('does not italicize snake_case or arithmetic asterisks', () => {
    expect(parseInline('run db_migrate_all now')).toEqual([
      { kind: 'text', text: 'run db_migrate_all now' },
    ]);
    expect(parseInline('2 * 3 * 4')).toEqual([{ kind: 'text', text: '2 * 3 * 4' }]);
  });
});

describe('parseMotdMarkdown (blocks)', () => {
  it('single paragraph with a hard break on a single newline', () => {
    expect(parseMotdMarkdown('line one\nline two')).toEqual([
      {
        kind: 'paragraph',
        children: [
          { kind: 'text', text: 'line one' },
          { kind: 'break' },
          { kind: 'text', text: 'line two' },
        ],
      },
    ]);
  });

  it('blank line splits paragraphs', () => {
    expect(parseMotdMarkdown('para one\n\npara two').map((b) => b.kind)).toEqual([
      'paragraph',
      'paragraph',
    ]);
  });

  it('a run of "- " lines becomes a list', () => {
    expect(parseMotdMarkdown('- first\n- **second**')).toEqual([
      {
        kind: 'list',
        items: [
          [{ kind: 'text', text: 'first' }],
          [{ kind: 'strong', children: [{ kind: 'text', text: 'second' }] }],
        ],
      },
    ]);
  });
});

describe('<MotdMarkdown> rendered output (safety + wire shape)', () => {
  it('renders a markdown link as a new-tab anchor with rel noopener noreferrer', () => {
    expect(html('file issues [on my GitHub](https://github.com/x/y/issues)')).toBe(
      '<p>file issues <a href="https://github.com/x/y/issues" target="_blank" rel="noopener noreferrer">on my GitHub</a></p>',
    );
  });

  it('escapes admin-authored HTML — no injection surface (ADR-027 property preserved)', () => {
    const out = html('<script>alert(1)</script> <img src=x onerror=alert(1)> **safe**');
    expect(out).not.toContain('<script>');
    expect(out).not.toContain('<img');
    expect(out).toContain('&lt;script&gt;');
    expect(out).toContain('<strong>safe</strong>');
  });

  it('never emits an anchor for a non-http(s) target', () => {
    expect(html('[x](javascript:alert(1)) and [y](data:text/html,hi)')).not.toContain('<a ');
  });

  it('plain text round-trips as one clean paragraph', () => {
    expect(html('New app added: Immich')).toBe('<p>New app added: Immich</p>');
  });

  it('paragraphs, breaks and lists render as p/br/ul/li', () => {
    const out = html('head\nline\n\n- a\n- b');
    expect(out).toBe('<p>head<br/>line</p><ul><li>a</li><li>b</li></ul>');
  });
});
