import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { trackPoolClose } from '../src/postgres-pool';

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

class DeferredPool extends EventEmitter {
  ended = deferred();
  end = vi.fn(() => this.ended.promise);
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('test pool cleanup before embedded PostgreSQL stops', () => {
  it.each(['end-first', 'remove-first'])('waits for both the end promise and every actual removal: %s', async (order) => {
    const pool = new DeferredPool();
    const close = trackPoolClose(pool);
    const first = {}, second = {};
    pool.emit('connect', first);
    pool.emit('connect', second);
    const stopPostgres = vi.fn();
    const stopped = close().then(stopPostgres);
    if (order === 'end-first') pool.ended.resolve();
    pool.emit('remove', first);
    await vi.advanceTimersByTimeAsync(0);
    expect(stopPostgres).not.toHaveBeenCalled();
    pool.emit('remove', second);
    await vi.advanceTimersByTimeAsync(0);
    if (order === 'remove-first') {
      expect(stopPostgres).not.toHaveBeenCalled();
      pool.ended.resolve();
    }
    await stopped;
    expect(stopPostgres).toHaveBeenCalledOnce();
    expect(pool.listenerCount('connect')).toBe(0);
    expect(pool.listenerCount('remove')).toBe(0);
  });

  it('tracks a pending connection that opens after end begins', async () => {
    const pool = new DeferredPool();
    const close = trackPoolClose(pool);
    const stopPostgres = vi.fn();
    const stopped = close().then(stopPostgres);
    const pendingClient = {};
    pool.emit('connect', pendingClient);
    pool.ended.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(stopPostgres).not.toHaveBeenCalled();
    pool.emit('remove', pendingClient);
    await stopped;
    expect(stopPostgres).toHaveBeenCalledOnce();
  });

  it('keeps an already-disconnecting client until its actual removal', async () => {
    const pool = new DeferredPool();
    const close = trackPoolClose(pool);
    const disconnectingClient = {};
    pool.emit('connect', disconnectingClient);
    // A pool's count can already exclude this client while its socket is still closing.
    pool.ended.resolve();
    const stopPostgres = vi.fn();
    const stopped = close().then(stopPostgres);
    await vi.advanceTimersByTimeAsync(0);
    expect(stopPostgres).not.toHaveBeenCalled();
    pool.emit('remove', disconnectingClient);
    await stopped;
  });

  it('closes an unused pool and reuses one cleanup promise', async () => {
    const pool = new DeferredPool();
    const close = trackPoolClose(pool);
    const first = close();
    expect(close()).toBe(first);
    pool.ended.resolve();
    await first;
    expect(pool.end).toHaveBeenCalledOnce();
  });

  it('preserves a genuine end failure and does not stop PostgreSQL', async () => {
    const pool = new DeferredPool();
    const close = trackPoolClose(pool);
    const stopPostgres = vi.fn();
    const error = new Error('connection cleanup failed');
    const rejected = expect(close().then(stopPostgres)).rejects.toBe(error);
    pool.ended.reject(error);
    await rejected;
    expect(stopPostgres).not.toHaveBeenCalled();
    expect(pool.listenerCount('connect')).toBe(0);
    expect(pool.listenerCount('remove')).toBe(0);
  });

  it('does not install an error listener or hide unexpected pool errors', () => {
    const pool = new DeferredPool();
    trackPoolClose(pool);
    const error = new Error('unexpected connection failure');
    expect(pool.listenerCount('error')).toBe(0);
    expect(() => pool.emit('error', error)).toThrow(error);
  });

  it.each(['missing-remove', 'pending-end'])('fails within 15 seconds if cleanup stays incomplete: %s', async (caseName) => {
    const pool = new DeferredPool();
    const close = trackPoolClose(pool);
    if (caseName === 'missing-remove') {
      pool.emit('connect', {});
      pool.ended.resolve();
    }
    const stopPostgres = vi.fn();
    const rejected = expect(close().then(stopPostgres)).rejects.toThrow('cleanup deadline');
    await vi.advanceTimersByTimeAsync(15_000);
    await rejected;
    expect(stopPostgres).not.toHaveBeenCalled();
    expect(pool.listenerCount('connect')).toBe(0);
    expect(pool.listenerCount('remove')).toBe(0);
  });
});
