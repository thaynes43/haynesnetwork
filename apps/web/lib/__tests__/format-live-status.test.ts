// fix/live-status-precedence — the LIVE-STATE-WINS precedence rule (the owner v0.55.0 report: a comic whose
// wall badge shows a live 9% download but whose Wanted-detail row read a stale "Missing"). These prove the
// pure decision the Wanted detail + the wall overlay both consume: a live signal OVERRIDES the reconciled
// snapshot on load, the comic leg is reachable from a book_requests ref by its kapowarr_volume_id, and
// "Missing" is reserved for exactly no-live-activity + snapshot-missing.
import { describe, expect, it } from 'vitest';
import type { BookRequestStatus } from '@hnet/db';
import type { CardActivityStage } from '@/components/cards';
import {
  effectiveFormatStatus,
  formatActivityId,
  formatLiveWins,
  type FormatLiveStatus,
} from '@/lib/format-live-status';

const live = (
  present: boolean,
  stage: CardActivityStage | null,
  pending = false,
): FormatLiveStatus => ({ present, stage, pending });
const NO_LIVE: FormatLiveStatus = { present: false, stage: null, pending: false };

describe('formatLiveWins — live overrides the reconciled snapshot', () => {
  it('a live downloading grab WINS over a stale "missing" snapshot (the owner bug)', () => {
    expect(formatLiveWins('missing', live(true, 'downloading'))).toBe(true);
  });

  it('every present in-flight stage wins over any snapshot', () => {
    for (const stage of ['searching', 'downloading', 'importing', 'failed'] as CardActivityStage[]) {
      expect(formatLiveWins('missing', live(true, stage))).toBe(true);
      expect(formatLiveWins('wanted', live(true, stage))).toBe(true);
    }
  });

  it('a completed-live signal wins immediately (show landed without waiting for the hourly reconcile)', () => {
    expect(formatLiveWins('missing', live(true, 'completed'))).toBe(true);
  });

  it('withholds "Missing" while the first poll is still pending (no stale-Missing flash)', () => {
    expect(formatLiveWins('missing', live(false, null, true))).toBe(true);
  });

  it('a genuinely-missing format with NO live activity keeps the snapshot (Missing is allowed here)', () => {
    expect(formatLiveWins('missing', NO_LIVE)).toBe(false);
  });

  it('a settled snapshot (landed / wanted / grabbed) with no live signal renders the snapshot', () => {
    for (const status of ['landed', 'wanted', 'grabbed', 'requested'] as BookRequestStatus[]) {
      expect(formatLiveWins(status, NO_LIVE)).toBe(false);
      // …and a non-missing snapshot is NOT withheld during pending (only the contradictory "missing" is).
      expect(formatLiveWins(status, live(false, null, true))).toBe(false);
    }
  });
});

describe('effectiveFormatStatus — the live-aware hero collapse', () => {
  it('an active grab maps away from "missing" so the hero never reads Missing mid-download', () => {
    expect(effectiveFormatStatus('missing', live(true, 'downloading'))).toBe('grabbed');
    expect(effectiveFormatStatus('missing', live(true, 'searching'))).toBe('grabbed');
    expect(effectiveFormatStatus('missing', live(true, 'importing'))).toBe('grabbed');
  });

  it('completed-live maps to landed (the hero shows Have it immediately)', () => {
    expect(effectiveFormatStatus('missing', live(true, 'completed'))).toBe('landed');
  });

  it('a live failure keeps the snapshot (a failed grab is not an active grab)', () => {
    expect(effectiveFormatStatus('missing', live(true, 'failed'))).toBe('missing');
  });

  it('withholds missing while pending; stands on the snapshot when idle', () => {
    expect(effectiveFormatStatus('missing', live(false, null, true))).toBe('grabbed');
    expect(effectiveFormatStatus('missing', NO_LIVE)).toBe('missing');
    expect(effectiveFormatStatus('wanted', NO_LIVE)).toBe('wanted');
  });
});

describe('formatActivityId — every format reachable from a book_requests ref', () => {
  it('the COMIC leg is reachable from a request ref by its kapowarr_volume_id', () => {
    expect(formatActivityId('comic', { llBookId: null, kapowarrVolumeId: '811' })).toBe('kapowarr:811');
  });

  it('the book/audiobook legs key off the LazyLibrarian book id, per format', () => {
    expect(formatActivityId('ebook', { llBookId: 'gb-tog', kapowarrVolumeId: null })).toBe(
      'books:ll:gb-tog:ebook',
    );
    expect(formatActivityId('audiobook', { llBookId: 'gb-tog', kapowarrVolumeId: null })).toBe(
      'books:ll:gb-tog:audiobook',
    );
  });

  it('an unrouted leg has no live key (the snapshot stands)', () => {
    expect(formatActivityId('comic', { llBookId: null, kapowarrVolumeId: null })).toBeNull();
    expect(formatActivityId('ebook', { llBookId: null, kapowarrVolumeId: null })).toBeNull();
  });
});
