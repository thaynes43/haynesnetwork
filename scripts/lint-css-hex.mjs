#!/usr/bin/env node
// CSS token-literal guard (NORMATIVE — CLAUDE.md hard rule 2, ADR-005,
// DESIGN-004 D-04; ported from demo-console). ESLint only sees `.ts/.tsx`; it
// is blind to stylesheets. This guard closes that gap: brand/status color is a
// theme token (CSS var --color-*), never a hard-coded hex literal, so the app
// stays re-skinnable by editing tokens.css alone. Scans apps/**/*.css +
// packages/**/*.css and fails on any `#RGB[A]`/`#RRGGBB[AA]` literal.
//
// The ONE allowed exception is the token *definition* file (tokens.css), where
// the per-theme hex values are actually declared — that is the seam itself.
//
// Run by `pnpm lint:css` and CI's lint-and-typecheck job.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SCAN_DIRS = ['apps', 'packages'];
// `.next` added over the donor: Next build output contains compiled CSS chunks.
const SKIP_DIRS = new Set(['node_modules', 'dist', 'generated', 'Generated', '.next', 'coverage']);
// The only file allowed to hold raw hex: it *defines* the theme tokens.
const ALLOWLIST = new Set(['tokens.css']);
const HEX = /#(?:[0-9a-fA-F]{3,4}){1,2}\b/;

function walk(dir, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(join(dir, entry.name), out);
    } else if (entry.isFile() && entry.name.endsWith('.css')) {
      out.push(join(dir, entry.name));
    }
  }
  return out;
}

const violations = [];
for (const d of SCAN_DIRS) {
  const abs = join(ROOT, d);
  try {
    if (!statSync(abs).isDirectory()) continue;
  } catch {
    continue; // dir absent — nothing to scan
  }
  for (const file of walk(abs, [])) {
    if (ALLOWLIST.has(basename(file))) continue;
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      const m = line.match(HEX);
      if (m)
        violations.push({ file: relative(ROOT, file), line: i + 1, text: line.trim(), hex: m[0] });
    });
  }
}

if (violations.length > 0) {
  console.error(
    'CSS token-literal guard: hard-coded color literals found (CLAUDE.md hard rule 2, ADR-005).\n' +
      'Use a theme token (CSS var --color-*); declare hex values only in tokens.css.\n',
  );
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.hex}  →  ${v.text}`);
  process.exit(1);
}

console.log('CSS token-literal guard OK: no hard-coded hex outside tokens.css.');
