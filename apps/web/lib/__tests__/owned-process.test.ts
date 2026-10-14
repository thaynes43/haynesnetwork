import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createOwnedProcessRunner } from '../../e2e/support/owned-process';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));

class Child extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  kill = vi.fn(() => true);
}

const createRunner = () => createOwnedProcessRunner({
  command: process.execPath, args: ['--import', 'tsx', 'fixture.ts'], env: { NODE_ENV: 'test' }, label: 'fixture command',
});
const observe = (run: Promise<void>) => run.then(
  () => ({ error: undefined }),
  (error: Error) => ({ error }),
);

describe('fixture-owned process', () => {
  let child: Child;
  beforeEach(() => {
    vi.useFakeTimers();
    child = new Child();
    vi.mocked(spawn).mockReset().mockReturnValue(child as unknown as ReturnType<typeof spawn>);
  });
  afterEach(() => { vi.useRealTimers(); });

  it('waits for close even after the process has exited', async () => {
    const runner = createRunner();
    let completed = false;
    const result = observe(runner.run()).then((value) => { completed = true; return value; });
    child.emit('exit', 0, null);
    await Promise.resolve();
    expect(completed).toBe(false);
    child.emit('close', 0, null);
    expect((await result).error).toBeUndefined();
    await runner.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels the owned child and holds scope teardown until actual close', async () => {
    const runner = createRunner();
    const result = observe(runner.run());
    let disposed = false;
    const disposing = runner.dispose().then(() => { disposed = true; });
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(child.kill.mock.calls).toEqual([['SIGTERM'], ['SIGKILL']]);
    expect(disposed).toBe(false);
    child.emit('close', null, 'SIGKILL');
    await disposing;
    expect((await result).error?.message).toContain('scope closed');
    expect(disposed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('holds command rejection until close after its deadline', async () => {
    const runner = createRunner();
    let completed = false;
    const result = observe(runner.run()).then((value) => { completed = true; return value; });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(child.kill.mock.calls).toEqual([['SIGTERM']]);
    expect(completed).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(child.kill.mock.calls).toEqual([['SIGTERM'], ['SIGKILL']]);
    expect(completed).toBe(false);
    child.emit('close', null, 'SIGKILL');
    expect((await result).error?.message).toContain('exceeded 30 seconds');
    await runner.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('refuses a late command from a disposed test callback', async () => {
    const runner = createRunner();
    await runner.dispose();
    await expect(runner.run()).rejects.toThrow('scope closed');
    expect(spawn).not.toHaveBeenCalled();
  });

  it('preserves a spawn error and waits for its close event', async () => {
    const runner = createRunner();
    const error = new Error('spawn failed');
    let completed = false;
    const result = observe(runner.run()).then((value) => { completed = true; return value; });
    child.emit('error', error);
    await Promise.resolve();
    expect(completed).toBe(false);
    child.emit('close', -2, null);
    expect((await result).error).toBe(error);
    await runner.dispose();
  });

  it.each([[1, null], [null, 'SIGTERM']] as const)('preserves failure exit %s / signal %s', async (code, signal) => {
    const runner = createRunner();
    const result = observe(runner.run());
    child.emit('close', code, signal);
    expect((await result).error?.message).toContain(`exit ${String(code)}, signal ${String(signal)}`);
    await runner.dispose();
  });

  it('preserves output errors and closes the child before finishing', async () => {
    const runner = createRunner();
    const result = observe(runner.run());
    const error = new Error('stdout failed');
    child.stdout.emit('error', error);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    child.emit('close', null, 'SIGTERM');
    expect((await result).error).toBe(error);
    await runner.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('bounds both failure output streams', async () => {
    const runner = createRunner();
    const result = observe(runner.run());
    child.stdout.emit('data', Buffer.alloc(100_000, 'x'));
    child.stderr.emit('data', Buffer.alloc(100_000, 'y'));
    child.emit('close', 1, null);
    const message = (await result).error!.message;
    expect(message).toContain('failed (exit 1, signal null)');
    expect(message).toContain('\nx');
    expect(message).toContain('\ny');
    expect(message.length).toBeLessThan(2 * 64 * 1024 + 100);
    await runner.dispose();
  });
});
