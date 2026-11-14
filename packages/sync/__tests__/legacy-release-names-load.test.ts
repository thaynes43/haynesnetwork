// ADR-117 / DESIGN-052 D-29 — the legacy release-name loader's arguments are strict (exactly one of --dry-run /
// --apply, and --dir), and a file missing from --dir is left out, so the load reports it `absent`.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseLegacyLoadArgs, readLegacyLoadFiles } from '../src/scripts/legacy-release-names-load';

describe('legacy-release-names-load arguments', () => {
  it('needs exactly one of --dry-run and --apply, and --dir', () => {
    expect(parseLegacyLoadArgs(['--dry-run', '--dir=/tmp/legacy'])).toEqual({
      apply: false,
      dir: '/tmp/legacy',
    });
    expect(parseLegacyLoadArgs(['--apply', '--dir', '/tmp/legacy'])).toEqual({
      apply: true,
      dir: '/tmp/legacy',
    });
    expect(parseLegacyLoadArgs(['--dir=/tmp/legacy', '--apply', '--apply'])).toEqual({
      apply: true,
      dir: '/tmp/legacy',
    });
    expect(parseLegacyLoadArgs(['--help'])).toBe('help');
    expect(parseLegacyLoadArgs(['--dry-run', '-h'])).toBe('help');
    expect(() => parseLegacyLoadArgs([])).toThrow(/--dry-run or --apply/);
    expect(() => parseLegacyLoadArgs(['--dir=/tmp/legacy'])).toThrow(/--dry-run or --apply/);
    expect(() => parseLegacyLoadArgs(['--dry-run', '--apply', '--dir=/tmp/legacy'])).toThrow(
      /exclusive/,
    );
    expect(() => parseLegacyLoadArgs(['--dry-run'])).toThrow(/--dir is required/);
    expect(() => parseLegacyLoadArgs(['--dry-run', '--dir='])).toThrow(/--dir is required/);
    expect(() => parseLegacyLoadArgs(['--dry-run', '--dir'])).toThrow(/needs a directory/);
    expect(() => parseLegacyLoadArgs(['--dry-run', '--dir', '--apply'])).toThrow(
      /needs a directory/,
    );
    expect(() => parseLegacyLoadArgs(['--dry-run', '--dir=/tmp/legacy', '--force'])).toThrow(
      /unknown argument/,
    );
  });

  it('reads the files present under their exact names and leaves the rest out', () => {
    const dir = mkdtempSync(join(tmpdir(), 'legacy-load-'));
    try {
      writeFileSync(join(dir, 'old-radarr-files.tsv'), 'radarr files');
      writeFileSync(join(dir, 'legacy-sab-full.tsv'), 'sab jobs');
      writeFileSync(join(dir, 'old-sonarr-history.txt'), 'wrong name');
      expect(readLegacyLoadFiles(dir)).toEqual({
        radarrFiles: 'radarr files',
        sabJobs: 'sab jobs',
      });
      expect(() => readLegacyLoadFiles(join(dir, 'missing'))).toThrow(/not a directory/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
