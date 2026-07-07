import { describe, expect, it } from 'vitest';
import {
  WEBHOOK_SECRET_ENV,
  parseSeerrWebhook,
  parseTautulliWebhook,
  parserForSource,
} from '../webhook-sources';

describe('per-source secret env map (DESIGN-012 D-03)', () => {
  it('maps each source to its own env var', () => {
    expect(WEBHOOK_SECRET_ENV).toEqual({
      maintainerr: 'MAINTAINERR_WEBHOOK_SECRET',
      seerr: 'SEERR_WEBHOOK_SECRET',
      tautulli: 'TAUTULLI_WEBHOOK_SECRET',
    });
  });

  it('dispatches to a parser per source', () => {
    expect(parserForSource('seerr')).toBe(parseSeerrWebhook);
    expect(parserForSource('tautulli')).toBe(parseTautulliWebhook);
  });
});

describe('parseSeerrWebhook (Overseerr default template, DESIGN-012 D-02)', () => {
  it('maps the default payload to type/title/body + attribution + media ids', () => {
    const parsed = parseSeerrWebhook({
      notification_type: 'MEDIA_APPROVED',
      event: 'Request Approved',
      subject: 'The Matrix (1999)',
      message: 'Your request was approved',
      media: { media_type: 'movie', tmdbId: '603', tvdbId: '', status: 'PROCESSING' },
      request: {
        request_id: '42',
        requestedBy_email: 'Fan@Example.com',
        requestedBy_username: 'fan',
      },
      extra: [],
    });
    expect(parsed).toMatchObject({
      type: 'MEDIA_APPROVED',
      title: 'The Matrix (1999)',
      body: 'Your request was approved',
      tmdbId: 603,
      tvdbId: null,
      mediaType: 'movie',
      requesterEmail: 'Fan@Example.com',
      // dedupe key folds the notification type + request id so each lifecycle event is one row.
      sourceEventId: 'MEDIA_APPROVED:42',
    });
  });

  it('maps a tv request to tvdb + the tv media-type hint', () => {
    const parsed = parseSeerrWebhook({
      notification_type: 'MEDIA_PENDING',
      subject: 'Severance',
      media: { media_type: 'tv', tmdbId: '95396', tvdbId: '371980' },
      request: { request_id: '7', requestedBy_email: 'a@b.com' },
    });
    expect(parsed).toMatchObject({ mediaType: 'tv', tmdbId: 95396, tvdbId: 371980 });
  });

  it('tolerates a test notification with empty media/request (no ids, unattributed)', () => {
    const parsed = parseSeerrWebhook({
      notification_type: 'TEST_NOTIFICATION',
      subject: 'Test',
      message: 'Ping',
      media: { media_type: '', tmdbId: '', tvdbId: '' },
      request: { request_id: '', requestedBy_email: '' },
    });
    expect(parsed).toMatchObject({
      type: 'TEST_NOTIFICATION',
      tmdbId: null,
      tvdbId: null,
      mediaType: null,
      requesterEmail: null,
      sourceEventId: null,
    });
  });

  it('rejects a non-object body (→ 400)', () => {
    expect(parseSeerrWebhook('nope')).toBeNull();
    expect(parseSeerrWebhook(['a'])).toBeNull();
  });
});

describe('parseTautulliWebhook (designed template, DESIGN-012 D-02)', () => {
  it('reads our controlled field names + best-effort email attribution', () => {
    const parsed = parseTautulliWebhook({
      event_type: 'playback.start',
      subject: 'Dune (2021)',
      message: 'ada started playing Dune',
      user: 'ada',
      user_email: 'ada@example.com',
      media_type: 'movie',
      tmdb_id: '438631',
      tvdb_id: '',
      source_event_id: 'playback.start:9001:1782950000',
    });
    expect(parsed).toMatchObject({
      type: 'playback.start',
      title: 'Dune (2021)',
      body: 'ada started playing Dune',
      tmdbId: 438631,
      tvdbId: null,
      mediaType: 'movie',
      requesterEmail: 'ada@example.com',
      sourceEventId: 'playback.start:9001:1782950000',
    });
  });

  it('normalizes an episode media_type to the tv hint', () => {
    const parsed = parseTautulliWebhook({ event_type: 'playback.stop', media_type: 'episode' });
    expect(parsed?.mediaType).toBe('tv');
  });

  it('falls back to defaults + null dedupe when fields are absent', () => {
    const parsed = parseTautulliWebhook({});
    expect(parsed).toMatchObject({
      type: 'tautulli_event',
      title: 'Tautulli notification',
      body: '',
      sourceEventId: null,
    });
  });

  it('rejects a non-object body (→ 400)', () => {
    expect(parseTautulliWebhook(42)).toBeNull();
  });
});
