import { spawn } from 'node:child_process';

type Command = { command: string; args: string[]; env: NodeJS.ProcessEnv; label: string };

/** A fixture-owned command. Cancellation finishes only after the actual child closes. */
export function createOwnedProcessRunner({ command, args, env, label }: Command) {
  const scope = new AbortController();
  let active: { closed: Promise<void> } | undefined;

  return {
    async run(): Promise<void> {
      if (scope.signal.aborted) throw scope.signal.reason;
      if (active) throw new Error(`${label} is already running`);
      await new Promise<void>((resolve, reject) => {
        const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
        let acknowledgeClose!: () => void;
        const closed = new Promise<void>((done) => { acknowledgeClose = done; });
        active = { closed };
        const outputLimit = 64 * 1024;
        let stdout: Buffer = Buffer.alloc(0);
        let stderr: Buffer = Buffer.alloc(0);
        let commandError: Error | undefined;
        let stopReason: Error | undefined;
        let forcedStop: ReturnType<typeof setTimeout> | undefined;
        const retain = (output: Buffer, chunk: Buffer): Buffer =>
          output.length === outputLimit ? output : Buffer.concat([output, chunk.subarray(0, outputLimit - output.length)]);
        const stop = (reason: Error) => {
          if (stopReason) return;
          stopReason = reason;
          child.kill('SIGTERM');
          forcedStop = setTimeout(() => child.kill('SIGKILL'), 1_000);
        };
        const cancel = () => stop(scope.signal.reason as Error);
        scope.signal.addEventListener('abort', cancel, { once: true });
        const deadline = setTimeout(() => stop(new Error(`${label} exceeded 30 seconds`)), 30_000);
        child.stdout.on('data', (chunk: Buffer) => { stdout = retain(stdout, chunk); });
        child.stderr.on('data', (chunk: Buffer) => { stderr = retain(stderr, chunk); });
        const outputError = (error: Error) => {
          commandError ??= error;
          stop(error);
        };
        child.stdout.on('error', outputError);
        child.stderr.on('error', outputError);
        child.on('error', (error) => { commandError ??= error; });
        child.once('close', (code, signal) => {
          clearTimeout(deadline);
          clearTimeout(forcedStop);
          scope.signal.removeEventListener('abort', cancel);
          active = undefined;
          acknowledgeClose();
          if (commandError) reject(commandError);
          else if (stopReason) reject(new Error(`${stopReason.message}:\n${stdout.toString()}\n${stderr.toString()}`, { cause: stopReason }));
          else if (code === 0 && signal === null) resolve();
          else reject(new Error(`${label} failed (exit ${String(code)}, signal ${String(signal)}):\n${stdout.toString()}\n${stderr.toString()}`));
        });
      });
    },
    async dispose(): Promise<void> {
      scope.abort(new Error(`${label} scope closed`));
      await active?.closed;
    },
  };
}
