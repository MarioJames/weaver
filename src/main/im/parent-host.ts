import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import { lstatSync } from 'node:fs';
import path from 'node:path';
import { ConfirmedParentCancellation, ParentAgentError, createParentAgent, type ParentAgentFailureReason, type ParentAgentInput, type ParentAgentSession } from './parent-agent';
import { hostWire } from './parent-host-wire';
import { imMasterIdentityPrompt } from './bootstrap';
import { HOST_STARTUP_MS, identityTimeoutMs, isMasterReadyText } from './parent-identity';

const HOST_FAILURE_REASONS: ReadonlySet<ParentAgentFailureReason> = new Set(['invalid_input', 'engine_missing', 'auth', 'protocol', 'engine', 'closed', 'aborted']);
function hostFailureReason(error: unknown): ParentAgentFailureReason {
  return error instanceof ParentAgentError && HOST_FAILURE_REASONS.has(error.reason) ? error.reason : 'engine';
}

/** Internal same-release entry. No business store or web server is created here. One hidden identity turn runs before ready, then the host stays resident for real user turns. */
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
    let session: ParentAgentSession | undefined, initializing = false, stopping = false, lastId = 0, ready = false;
    let active: { id: number; abort: AbortController; text: string; submitted: boolean } | undefined;
    let inFlight: Promise<string> | undefined;
    let initPromise: Promise<ParentAgentSession> | undefined;
    let identityAbort: AbortController | undefined;
    let identityPromise: Promise<string> | undefined;
    let identityTimedOut = false;
    let clearIdentityBudget: () => void = () => {};
    // Bounded grace for the hidden identity send to settle once the engine
    // session below starts closing. Never the full identity budget, never unbounded.
    const SHUTDOWN_SETTLE_MS = 5_000;
    const timer = setTimeout(() => shutdown(), HOST_STARTUP_MS);
    const shutdown = () => {
      if (stopping) return;
      stopping = true; clearTimeout(timer); active?.abort.abort(); identityAbort?.abort();
      // Disarm the identity budget first: a late budget expiry must not fire
      // after the session is already being torn down.
      clearIdentityBudget();
      socket.destroy();
      process.off('SIGTERM', shutdown);
      // Close the engine session first so that even a hidden send whose native
      // engine ignores the abort is settled by real process teardown
      // (close rejects in-flight sends), instead of waiting out the identity
      // budget. The hidden send is then only given a bounded grace to settle;
      // a late identity result is discarded and never fakes ready.
      // close() itself is bounded, so this wait cannot hang the host.
      void (async () => {
        try {
          if (initPromise) {
            try { session ??= await initPromise; } catch { /* startup failure carries its own frame */ }
          }
          const closing = session?.close().catch(() => {});
          await Promise.race([identityPromise?.catch(() => {}), new Promise(resolve => setTimeout(resolve, SHUTDOWN_SETTLE_MS))]);
          await closing;
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
    // The host runs with StandardInput=null under its systemd unit: stdin is
    // never a lifecycle signal, so a closed or missing stdin must not shut the
    // host down. SIGHUP (terminal loss) is likewise detached from the service
    // lifetime; SIGTERM, control-socket loss and the explicit close frame still
    // reclaim the engine and all of its descendants. SIGHUP is explicitly
    // ignored so terminal loss can never terminate the background service.
    process.on('SIGHUP', () => {});
    process.on('SIGTERM', shutdown);
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
          if (stopping) return;
          session = value;
          // Hidden Master identity turn: one bounded send with its own AbortSignal and no
          // public delta callback. Only the trimmed marker proves readiness; the process
          // and session then stay resident waiting for real user turns (no heartbeat).
          identityAbort = new AbortController();
          identityTimedOut = false;
          const budget = identityTimeoutMs(env);
          // The identity budget races the hidden send: even if an engine ignores the abort
          // and never settles the cancelled send, the timeout still fails closed as engine
          // (never ready). Shutdown aborts and closes; it does not wait out the budget.
          let onBudgetTimeout!: () => void;
          const budgetExpiry = new Promise<never>((_resolve, reject) => {
            const timer = setTimeout(() => {
              identityTimedOut = true;
              identityAbort?.abort();
              reject(new Error('parent identity timed out'));
            }, budget);
            onBudgetTimeout = () => clearTimeout(timer);
          });
          // Shutdown disarms the budget through this hook; settling the hidden
          // send clears it here so a late expiry can never fire afterwards.
          clearIdentityBudget = () => onBudgetTimeout();
          // Attach a no-op catch so the racing send cannot create an unhandled rejection
          // after the budget already won the race.
          // Internal bootstrap resolves only the newest terminal assistant message so an
          // intermediate progress paragraph never leaks into the strict marker gate; the
          // hidden turn still streams nothing and the marker gate stays strict equality.
          const hidden = value.send(imMasterIdentityPrompt(), identityAbort.signal, undefined, { finalAssistantOnly: true });
          hidden.catch(() => {});
          void budgetExpiry.catch(() => {});
          identityPromise = Promise.race([hidden, budgetExpiry]);
          void identityPromise.then(raw => {
            onBudgetTimeout();
            // A racing shutdown aborts the identity turn and owns the close; a late
            // identity result is safely rejected and never fakes ready.
            if (stopping) return;
            if (!isMasterReadyText(raw)) {
              try { wire.send({ id: 0, type: 'failed', reason: 'protocol' }); socket.end(); } catch { /* socket is already gone */ }
              setTimeout(shutdown, 250);
              return;
            }
            ready = true;
            // A racing shutdown awaits initPromise owns the close; skip the extra close here.
            clearTimeout(timer);
            void value.unavailable?.then(shutdownForUnavailable);
            wire.send({ id: 0, type: 'ready' });
          }, error => {
            onBudgetTimeout();
            if (stopping) return;
            // Identity timeout aborts the hidden send; report it as a bounded engine
            // failure, never as ready. Auth/protocol classification from the send
            // rejection is preserved and never swallowed by a generic unavailable.
            const reason = identityTimedOut ? 'engine' as const : hostFailureReason(error);
            // Startup failures carry only the fixed reason; vendor text and paths stay in this process.
            try { wire.send({ id: 0, type: 'failed', reason }); socket.end(); } catch { /* socket is already gone */ }
            setTimeout(shutdown, 250);
          });
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
        // First user turns are only accepted after the hidden identity turn proved
        // readiness; early or late prepares during init are safely rejected, never queued.
        if (!ready || !session || active || frame.id <= lastId || typeof frame.text !== 'string') { shutdown(); return; }
        lastId = frame.id;
        active = { id: frame.id, text: frame.text, abort: new AbortController(), submitted: false };
        wire.send({ type: 'prepared', id: frame.id });
        return;
      }
      if (frame.type === 'submit' && frame.id <= lastId && (!active || active.id !== frame.id)) return;
      if (frame.type !== 'submit' || !ready || !session || !active || active.id !== frame.id || active.submitted) { shutdown(); return; }
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
