import { describe, expect, it } from 'vitest';
import {
  ARR_KIND_LABELS,
  FIX_REASON_LABELS,
  fixStatusTone,
  formatBytes,
  onDiskSummary,
} from '../media';

describe('formatBytes', () => {
  it('renders bytes through terabytes', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(-5)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
    expect(formatBytes(1.5 * 1024 ** 3)).toBe('1.5 GB');
    expect(formatBytes(42 * 1024 ** 4)).toBe('42 TB');
  });
});

describe('onDiskSummary', () => {
  it('flags monitored-with-nothing-on-disk as Wanted (T-27)', () => {
    expect(onDiskSummary({ onDiskFileCount: 0, expectedFileCount: 10, monitored: true })).toEqual({
      label: 'Wanted',
      tone: 'warn',
    });
    expect(onDiskSummary({ onDiskFileCount: 0, expectedFileCount: 1, monitored: false })).toEqual({
      label: 'Not on disk',
      tone: 'muted',
    });
  });

  it('distinguishes partial from complete', () => {
    expect(onDiskSummary({ onDiskFileCount: 4, expectedFileCount: 10, monitored: true })).toEqual({
      label: '4/10 on disk',
      tone: 'info',
    });
    expect(onDiskSummary({ onDiskFileCount: 10, expectedFileCount: 10, monitored: true })).toEqual({
      label: '10/10 on disk',
      tone: 'ok',
    });
    expect(onDiskSummary({ onDiskFileCount: 1, expectedFileCount: 1, monitored: true })).toEqual({
      label: 'On disk',
      tone: 'ok',
    });
  });
});

describe('labels and tones', () => {
  it('covers the R-45 reason taxonomy', () => {
    expect(Object.keys(FIX_REASON_LABELS).sort()).toEqual(
      [
        'missing_subtitles',
        'other',
        'wont_play_corrupt',
        'wrong_content',
        'wrong_language',
        'wrong_version_quality',
      ].sort(),
    );
  });

  it('gives terminal fix states distinct tones', () => {
    expect(fixStatusTone('completed')).toBe('ok');
    expect(fixStatusTone('failed')).toBe('danger');
    expect(fixStatusTone('search_triggered')).toBe('info');
    expect(fixStatusTone('pending')).toBe('muted');
  });

  it('never leaks *arr product names into kind labels', () => {
    expect(Object.values(ARR_KIND_LABELS)).toEqual(['TV', 'Movie', 'Music']);
  });
});
