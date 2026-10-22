import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import { lstatSync } from 'node:fs';
import path from 'node:path';
import { ConfirmedParentCancellation, ParentAgentError, createParentAgent, type ParentAgentFailureReason, type ParentAgentInput, type ParentAgentSession } from './parent-agent';
import { hostWire } from './parent-host-wire';

const HOST_FAILURE_REASONS: ReadonlySet<ParentAgentFailureReason> = new Set(['invalid_input', 'engine_missing', 'auth', 'protocol', 'engine', 'closed', 'aborted']);
function hostFailureReason(error: unknown): ParentAgentFailureReason {
  return error instanceof ParentAgentError && HOST_FAILURE_REASONS.has(error.reason) ? error.reason : 'engine';
}

/** Internal same-release entry. No business store, web server or model turn is created here. */
export async function runParentHost(args: readonly string[]): Promise<number> {
  const [endpoint, epoch] = args;
  if (args.length !== 2 || !endpoint || !path.isAbsolute(endpoint) || Buffer.byteLength(endpoint) > 100 || !/^[0-9a-f-]{36}$/.test(epoch ?? '')) return 1;
  try {
    const dir = lstatSync(path.dirname(endpoint));
    const socket = lstatSync(endpoint);
    if (!dir.isDirectory() || dir.isSymbolicLink() || (dir.mode & 0o077) !== 0 || dir.uid !== process.getuid?.() || !socket.isSocket() || (socket.mode & 0o077) !== 0 || socket.uid !== dir.uid) return 1;
  } catch { return 1; }
  return new Promise<number>(resolve => {
    const socket = connect(endpoint);
    let session: ParentAgentSession | undefined, initializing = false, stopping = false, lastId = 0;
    let active: { id: number; abort: AbortController; text: string; submitted: boolean } | undefined;
    let inFlight: Promise<string> | undefined;
    let initPromise: Promise<ParentAgentSession> | undefined;
    const timer = setTimeout(() => shutdown(), 30_000);
    const shutdown = () => {
      if (stopping) return;
      stopping = true; clearTimeout(timer); active?.abort.abort();
      socket.destroy();
      process.stdin.off('end', shutdown); process.stdin.off('close', shutdown); process.stdin.off('error', shutdown); process.off('SIGHUP', shutdown);
      // Awaiting the engine teardown (and a racing init) before resolving keeps the
      // process.exit in run.ts from truncating session.close() and orphaning the engine.
      // close() itself is bounded, so this wait cannot hang the host.
      void (async () => {
        try {
          if (initPromise) {
            try { session ??= await initPromise; } catch { /* startup failure carries its own frame */ }
          }
          await session?.close().catch(() => {});
        } finally { resolve(0); }
      })();
    };
    // An engine failure surfaces as `unavailable` while its send rejection still carries the
    // classified reason. Tearing down the socket first would drop that error frame and leave
    // the service with a generic engine failure, so an in-flight turn emits its terminal frame
    // first (the existing send settlement path) and only then shuts down. Idle shutdown is immediate.
    const shutdownForUnavailable = () => {
      const pending = inFlight;
      if (!pending || !active) { shutdown(); return; }
      pending.then(() => shutdown(), () => shutdown());
    };
    process.stdin.resume();
    process.stdin.on('end', shutdown); process.stdin.on('close', shutdown); process.stdin.on('error', shutdown); process.on('SIGHUP', shutdown);
    socket.on('close', shutdown);
    const wire = hostWire(socket, epoch, frame => {
      if (stopping) return;
      if (frame.type === 'init' && frame.id === 0 && !initializing) {
        initializing = true;
        if (!frame.env || typeof frame.env !== 'object' || Array.isArray(frame.env) || !Object.entries(frame.env).every(([key, value]) => key.length <= 256 && typeof value === 'string')) { shutdown(); return; }
        const env = frame.env as NodeJS.ProcessEnv;
        // Executable discovery uses this process' PATH; authentication stays only in child env.
        if (typeof env.PATH === 'string') process.env.PATH = env.PATH;
        initPromise = createParentAgent(frame.input as ParentAgentInput, {
          launch: (command, cwd, extra) => spawn(command[0], command.slice(1), { cwd, env: { ...env, ...extra }, stdio: ['pipe', 'pipe', 'pipe'] }),
        });
        void initPromise.then(value => {
          session = value;
          // A racing shutdown awaits initPromise and owns the close; skip the extra close here.
          if (stopping) return;
          clearTimeout(timer);
          void value.unavailable?.then(shutdownForUnavailable);
          wire.send({ id: 0, type: 'ready' });
        }, error => {
          if (stopping) return;
          // Startup failures carry only the fixed reason; vendor text and paths stay in this process.
          try { wire.send({ id: 0, type: 'failed', reason: hostFailureReason(error) }); socket.end(); } catch { /* socket is already gone */ }
          setTimeout(shutdown, 250);
        });
        return;
      }
      if (frame.type === 'close') { shutdown(); return; }
      if (frame.type === 'abort') {
        if (active?.id === frame.id) {
          if (!active.submitted) { active = undefined; wire.send({ type: 'not-submitted', id: frame.id }); }
          else active.abort.abort();
        } else if (frame.id > lastId) shutdown();
        return;
      }
      if (frame.type === 'prepare') {
        if (!session || active || frame.id <= lastId || typeof frame.text !== 'string') { shutdown(); return; }
        lastId = frame.id;
        active = { id: frame.id, text: frame.text, abort: new AbortController(), submitted: false };
        wire.send({ type: 'prepared', id: frame.id });
        return;
      }
      if (frame.type === 'submit' && frame.id <= lastId && (!active || active.id !== frame.id)) return;
      if (frame.type !== 'submit' || !session || !active || active.id !== frame.id || active.submitted) { shutdown(); return; }
      const turn = active;
      // The submission mark and the actual call form one synchronous critical section.
      turn.submitted = true;
      const pending = session.send(turn.text, turn.abort.signal, delta => {
        if (!stopping && active === turn && !turn.abort.signal.aborted) wire.send({ type: 'delta', id: turn.id, text: delta });
      });
      inFlight = pending;
      void pending.then(text => {
        if (active === turn) inFlight = undefined;
        if (!stopping && active === turn) { active = undefined; wire.send({ type: 'result', id: turn.id, text }); }
      }, error => {
        if (active === turn) inFlight = undefined;
        if (!stopping && active === turn) {
          active = undefined;
          wire.send(error instanceof ConfirmedParentCancellation ? { type: 'cancelled', id: turn.id } : { type: 'error', id: turn.id, reason: hostFailureReason(error) });
        }
      }).catch(shutdown);
    }, shutdown);
    socket.once('connect', () => wire.send({ id: 0, type: 'hello', pid: process.pid }));
  });
}
