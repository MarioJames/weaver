import test from 'node:test';
import assert from 'node:assert/strict';
import { runForegroundShutdown } from '../../src/cli/commands/web';

// Boundary tests for the `weaver web` foreground signal wiring. They drive the real helper with a minimal
// runtime double that honors the WeaverRuntime contract (`done` settles before `close()` settles) over real
// process signal listeners — no server, no socket, no CLI framework. A close failure must come out as a
// non-zero exit code without an unhandled rejection, and a done-first resolution must never be reported early
// as success.

interface ShutdownHarness {
  runtime: { done: Promise<void>; close(): Promise<void> };
  closeCount: () => number;
  resolveDone: () => void;
  settleClose: (outcome: 'ok' | 'fail') => Promise<void>;
  closeStarted: Promise<void>;
}

/** A runtime double whose close() resolves done first and settles only when the test releases it. */
function harness(): ShutdownHarness {
  let resolveDone!: () => void;
  let releaseClose!: () => void;
  let closeOutcome: 'ok' | 'fail' = 'ok';
  let closes = 0;
  let closeStartedResolve!: () => void;
  const closeStarted = new Promise<void>(resolve => { closeStartedResolve = resolve; });
  const done = new Promise<void>(resolve => { resolveDone = resolve; });
  return {
    runtime: {
      done,
      close() {
        closes++;
        closeStartedResolve();
        resolveDone(); // runtime contract: done settles before close() settles
        return new Promise<void>((resolve, reject) => {
          releaseClose = () => { closeOutcome === 'ok' ? resolve() : reject(new Error('IM_SHUTDOWN_CANARY')); };
        });
      },
    },
    closeCount: () => closes,
    resolveDone,
    closeStarted,
    settleClose: async outcome => {
      closeOutcome = outcome;
      releaseClose();
      await new Promise<void>(resolve => setImmediate(resolve));
    },
  };
}

test('repeated signals start exactly one close and a clean shutdown exits 0 without leftover listeners', async () => {
  const h = harness();
  const sigintBefore = process.listenerCount('SIGINT');
  const sigtermBefore = process.listenerCount('SIGTERM');
  const finished = runForegroundShutdown(h.runtime);
  // Listeners are installed synchronously before the helper's first await.
  assert.equal(process.listenerCount('SIGINT'), sigintBefore + 1);
  assert.equal(process.listenerCount('SIGTERM'), sigtermBefore + 1);
  // A process-group stop delivers one signal per process: every copy joins the same drain.
  process.emit('SIGINT');
  process.emit('SIGTERM');
  process.emit('SIGTERM');
  assert.equal(h.closeCount(), 1);
  await h.settleClose('ok');
  assert.equal(await finished, 0);
  assert.equal(process.listenerCount('SIGINT'), sigintBefore);
  assert.equal(process.listenerCount('SIGTERM'), sigtermBefore);
});

test('a close failure after done resolves is non-zero, never a fake success, and no rejection goes unhandled', async () => {
  const h = harness();
  const sigintBefore = process.listenerCount('SIGINT');
  let unhandled = 0;
  const onUnhandled = () => { unhandled++; };
  process.on('unhandledRejection', onUnhandled);
  try {
    const finished = runForegroundShutdown(h.runtime);
    process.emit('SIGINT');
    process.emit('SIGINT');
    await h.closeStarted;
    assert.equal(h.closeCount(), 1);
    // done has settled now, but close has not: a naive `await done; return 0` would already have succeeded.
    await new Promise<void>(resolve => setImmediate(resolve));
    const settledEarly = await Promise.race([finished.then(() => true), new Promise<boolean>(resolve => setImmediate(() => resolve(false)))]);
    assert.equal(settledEarly, false);
    await h.settleClose('fail');
    assert.equal(await finished, 1);
    assert.equal(unhandled, 0);
    assert.equal(process.listenerCount('SIGINT'), sigintBefore);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('signals received while no close was requested keep the process waiting, then one signal closes once', async () => {
  const h = harness();
  const finished = runForegroundShutdown(h.runtime);
  // Without a signal the helper must not close anything on its own.
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(h.closeCount(), 0);
  process.emit('SIGTERM');
  assert.equal(h.closeCount(), 1);
  await h.settleClose('ok');
  assert.equal(await finished, 0);
});
