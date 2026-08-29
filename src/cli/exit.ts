import { stdout } from 'node:process';

/**
 * End the process once the work is done and the output has been written.
 *
 * Node exits when the event loop empties, and after these CLIs finish it does
 * not: a request to an unreachable server leaves the connection attempt on the
 * loop, and the SDK arms a request-timeout timer per call that outlives the
 * request it was guarding. With `timeoutInSeconds: 900` in `client.ts` - the
 * timeout a real repair needs - that turns "server isn't running" into fifteen
 * minutes of a command that has already printed its verdict and looks hung.
 *
 * So we leave deliberately. Draining stdout first matters on Windows, where
 * writes to a TTY are asynchronous and an abrupt exit can take the last lines
 * of output with it - including, on a failed pre-flight, the line that says why.
 */
export async function exitWhenFlushed(code = process.exitCode ?? 0): Promise<never> {
  // A zero-length write's callback fires once everything queued ahead of it has
  // been flushed. `drain` would not do: it is only guaranteed after a write has
  // actually returned false, so waiting on it whenever `writableLength` is
  // nonzero can wait for an event that is never coming.
  await Promise.race([
    new Promise<void>((resolve) => {
      stdout.write('', () => resolve());
    }),
    // Never let tidy shutdown become the reason a command hangs.
    new Promise<void>((resolve) => setTimeout(resolve, 250).unref()),
  ]);

  process.exit(typeof code === 'number' ? code : 0);
}
