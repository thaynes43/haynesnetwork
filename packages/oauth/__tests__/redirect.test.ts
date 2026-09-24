// ADR-091 / DESIGN-050 D-05 step 1 — the redirect rule: exact match, except loopback (RFC 8252 §7.3) where the
// port (and the loopback literal) may differ while scheme, path, query and fragment must still match.
import { describe, expect, it } from 'vitest';
import {
  OAuthError,
  checkRegisteredRedirect,
  isLoopbackHost,
  redirectUriMatches,
} from '../src/index';

describe('D-05 step 1 — redirect_uri matching', () => {
  it('non-loopback URIs match byte for byte only', () => {
    const reg = 'https://chatgpt.com/connector/oauth/abc';
    expect(redirectUriMatches(reg, reg)).toBe(true);
    for (const other of [
      'https://chatgpt.com/connector/oauth/abc/',
      'https://chatgpt.com/connector/oauth/ABC',
      'https://chatgpt.com:443/connector/oauth/abc?x=1',
      'https://chatgpt.com.evil.example/connector/oauth/abc',
      'http://chatgpt.com/connector/oauth/abc',
      'https://evil.example/connector/oauth/abc',
    ]) {
      expect(redirectUriMatches(reg, other), other).toBe(false);
    }
  });

  it('loopback ignores the port (Codex and Claude Code bind an ephemeral one)', () => {
    const reg = 'http://127.0.0.1:1455/callback/abc';
    for (const port of ['1', '1455', '53682', '65535']) {
      expect(redirectUriMatches(reg, `http://127.0.0.1:${port}/callback/abc`), port).toBe(true);
    }
    expect(redirectUriMatches('http://127.0.0.1/cb', 'http://127.0.0.1:8080/cb')).toBe(true);
  });

  it('loopback still enforces path, query and fragment, and the scheme', () => {
    const reg = 'http://127.0.0.1:1455/callback/abc?x=1';
    expect(redirectUriMatches(reg, 'http://127.0.0.1:9/callback/abc?x=1')).toBe(true);
    for (const other of [
      'http://127.0.0.1:9/callback/abd?x=1',
      'http://127.0.0.1:9/callback/abc',
      'http://127.0.0.1:9/callback/abc?x=2',
      'http://127.0.0.1:9/callback/abc?x=1#f',
      'https://127.0.0.1:9/callback/abc?x=1',
    ]) {
      expect(redirectUriMatches(reg, other), other).toBe(false);
    }
  });

  it('the three loopback literals are interchangeable; nothing else counts as loopback', () => {
    for (const host of ['127.0.0.1', 'localhost', '[::1]']) {
      expect(redirectUriMatches('http://localhost:1/cb', `http://${host}:2/cb`), host).toBe(true);
    }
    expect(isLoopbackHost('[::1]')).toBe(true);
    for (const host of [
      '127.0.0.2',
      '0.0.0.0',
      'localhost.evil.example',
      'evil.example',
      '[::2]',
    ]) {
      expect(isLoopbackHost(host), host).toBe(false);
      expect(redirectUriMatches('http://localhost:1/cb', `http://${host}:2/cb`), host).toBe(false);
    }
  });

  it('a registered loopback URI never widens to a non-loopback request (and vice versa)', () => {
    expect(redirectUriMatches('http://localhost:1/cb', 'http://evil.example:1/cb')).toBe(false);
    expect(redirectUriMatches('https://evil.example/cb', 'http://localhost/cb')).toBe(false);
    expect(redirectUriMatches('not a url', 'http://localhost/cb')).toBe(false);
  });

  it('checkRegisteredRedirect picks among up to five registered URIs, and refuses a missing or unknown one', () => {
    const client = { redirectUris: ['https://a.example/cb', 'http://127.0.0.1:1/cb'] };
    expect(checkRegisteredRedirect(client, 'http://127.0.0.1:777/cb')).toBe(
      'http://127.0.0.1:777/cb',
    );
    expect(checkRegisteredRedirect(client, 'https://a.example/cb')).toBe('https://a.example/cb');
    for (const uri of [undefined, '', 'https://b.example/cb']) {
      expect(() => checkRegisteredRedirect(client, uri)).toThrow(OAuthError);
      try {
        checkRegisteredRedirect(client, uri);
      } catch (e) {
        expect((e as OAuthError).code).toBe('invalid_redirect_uri');
      }
    }
  });
});
