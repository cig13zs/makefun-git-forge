// The entry <-> env lifecycle. The harness starts this program beside its env, this process answers the
// whole trial as a server, and the env is what tells it when to stop.
//
//   1. MAKEFUN_ENV_URL names the env's origin. Without it there is nothing to register with, so exit 1.
//   2. Listen on an ephemeral port: the kernel picks one, and 8080 is never bound because the env owns it.
//   3. POST the bound port to the env's /register. The first register wins; 409 means another entry
//      already took it, which is not this process's to fix, so it keeps waiting like any other.
//   4. Poll GET /done. The env answers at once with {"done":false} while the suite runs, so this is a
//      short poll with a capped backoff, never a held request, and the process never exits early.
//   5. Close the server and exit 0 once the env says done; the env then writes the export that is scored.

import { createApp } from './app.ts';

const envUrl = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (envUrl === '') {
  process.stderr.write('[entry] MAKEFUN_ENV_URL is not set: there is no env to register with\n');
  process.exit(1);
}

/** How long one register or done call may take before it is abandoned and retried. */
const CALL_TIMEOUT_MS = 30_000;
/** The first and the longest wait between retries. */
const RETRY_START_MS = 200;
const RETRY_CEIL_MS = 1_500;

/** The wait after `attempt` failed calls: exponential, capped. */
function retryDelay(attempt: number): number {
  return Math.min(RETRY_CEIL_MS, RETRY_START_MS * 2 ** Math.min(attempt, 8));
}

/** A promise that settles after `ms`. */
function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Tell the env which port this process bound, retrying until it accepts. 200 is the normal answer and
 * 409 means a first register already won; 400 and 405 are contract errors and end the program; any
 * other answer, or a network error, is retried because the env may still be coming up.
 */
async function register(port: number): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await fetch(`${envUrl}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      });
      if (response.status === 200 || response.status === 409) return;
      if (response.status === 400 || response.status === 405) {
        throw new Error(`register answered HTTP ${response.status}: ${await response.text()}`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('register answered HTTP ')) throw err;
    }
    await pause(retryDelay(attempt));
  }
}

/** Poll the env until it says the trial is over. This never returns before then. */
async function waitUntilDone(): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await fetch(`${envUrl}/done`, { signal: AbortSignal.timeout(CALL_TIMEOUT_MS) });
      if (response.ok) {
        const body = (await response.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch {
      // Not answering, or too slow: either way the trial is not over, so poll again.
    }
    await pause(retryDelay(attempt));
  }
}

/** The whole life of the process: bind, register, serve, and stop when the env says so. */
async function run(): Promise<void> {
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('the server did not bind an ephemeral TCP port');
  process.stdout.write(`[entry] listening on port ${address.port}\n`);

  await register(address.port);
  process.stdout.write('[entry] registered; waiting for the env\n');

  await waitUntilDone();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  process.stdout.write('[entry] done\n');
}

try {
  await run();
  process.exit(0);
} catch (err) {
  process.stderr.write(`[entry] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
