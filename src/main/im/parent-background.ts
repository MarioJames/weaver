import { randomUUID } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, realpathSync, rmdirSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { join, isAbsolute } from 'node:path';
import { embeddedApp } from '../embedded';
import type { AsyncRunner } from '../owner-host';
import { abortReason, ConfirmedParentCancellation, ParentTurnNotSubmitted, parentEnv, parentError, prepareParentAgentInput, PARENT_TEXT_MAX, type ParentAgentFailureReason, type ParentAgentInput, type ParentAgentSession } from './parent-agent';
import { hostWire, type HostFrame } from './parent-host-wire';
import { HOST_STARTUP_MS } from './parent-identity';
import { bootIdentity, cleanupHostRecord, inspectHostUnit, processStart, readHostRecords, resourceError, resourceRun, saveHostRecord, type HostRecord } from './parent-host-resources';

interface HostInternals { runner?: AsyncRunner; hostCommand?: readonly string[]; startupMs?: number }
const live = new Set<string>();
const closingEpochs = new Set<string>();
let recoveryQueue = Promise.resolve();
function privateDirectory(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const info = lstatSync(dir);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) throw resourceError();
}
function hostCommand(): readonly string[] {
  if (embeddedApp()) return [process.execPath];
  const entry = process.argv[1];
  if (!entry || !isAbsolute(entry) || !entry.endsWith('.mjs')) throw parentError('engine', 'Bot host requires the current bundled Weaver executable');
  return [process.execPath, realpathSync(entry)];
}
const ENGINE_TITLES: Record<string, string> = { claude: 'Claude', codex: 'Codex', opencode: 'OpenCode', pi: 'Pi', grok: 'Grok', qodercli: 'Qoder', dsh: 'DSH' };
function botTitle(at: string, engine: string): string {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit' }).formatToParts(new Date(at));
  return `${parts.find(p => p.type === 'month')!.value}${parts.find(p => p.type === 'day')!.value}｜FEA｜飞书 Bot·${ENGINE_TITLES[engine] ?? engine}`;
}
const HOST_FAILURE_REASONS: ReadonlySet<ParentAgentFailureReason> = new Set(['invalid_input', 'engine_missing', 'auth', 'protocol', 'engine', 'closed', 'aborted']);
function hostReason(value: unknown): ParentAgentFailureReason {
  return typeof value === 'string' && HOST_FAILURE_REASONS.has(value as ParentAgentFailureReason) ? value as ParentAgentFailureReason : 'engine';
}

/**
 * Background is mandatory: the host always runs as a direct systemd user
 * service, never through a Herdr lane or pane. No terminal or tab is kept.
 * Only close() confirms full unit reclamation.
 */
export async function createBackgroundParentAgent(input: ParentAgentInput, options: { dataDir: string; signal?: AbortSignal }, internals: HostInternals = {}): Promise<ParentAgentSession> {
  const prepared = prepareParentAgentInput(input);
  if (!isAbsolute(options.dataDir) || /[\x00-\x1f\x7f]/.test(options.dataDir)) throw resourceError();
  // A revoked startup intent never reaches recovery: no journal is touched and no process is created.
  if (options.signal?.aborted) throw abortReason(options.signal);
  const root = join(options.dataDir, 'im-host');
  privateDirectory(root);
  // Serialize recovery and intent creation, while independent live sessions remain untouched.
  const before = recoveryQueue;
  let release!: () => void;
  recoveryQueue = new Promise<void>(resolve => { release = resolve; });
  await before;
  // Recovery itself is cancellable: a revoke that arrived while orphaned journals
  // were being reclaimed must not continue into a useless fresh launch.
  if (options.signal?.aborted) { release(); throw abortReason(options.signal); }
  let dir = '', record!: HostRecord;
  try {
    for (const previous of readHostRecords(root)) {
      if (live.has(previous.record.epoch)) { if (previous.record.closing || closingEpochs.has(previous.record.epoch)) throw resourceError(); continue; }
      if (previous.record.boot === bootIdentity() && processStart(previous.record.ownerPid) === previous.record.ownerStart) throw resourceError();
      await cleanupHostRecord(previous.dir, previous.record, internals.runner);
    }
    const epoch = randomUUID(); dir = join(root, epoch);
    privateDirectory(dir);
    const endpoint = join(dir, 's');
    if (Buffer.byteLength(endpoint) > 100) { rmdirSync(dir); throw parentError('invalid_input', 'Bot host private socket path is too long'); }
    const createdAt = new Date().toISOString();
    // New records are always background: no lane, no server, no allocating.
    record = { version: 1, epoch, unit: `weaver-im-host-${epoch}.service`, createdAt, ownerPid: process.pid, ownerStart: processStart(process.pid)!, boot: bootIdentity(), endpoint, label: botTitle(createdAt, prepared.engineKind), launchMode: 'background', launched: false };
    saveHostRecord(dir, record); live.add(epoch);
  } finally { release(); }

  let socket: Socket | undefined, wire: ReturnType<typeof hostWire> | undefined, closing = false, unavailableNow = false;
  let signalUnavailable!: () => void;
  const unavailable = new Promise<void>(resolve => { signalUnavailable = resolve; });
  let nextId = 1;
  let active: { id: number; cancelRequested?: boolean; submitted?: boolean; delta?: (text: string) => void; resolve(text: string): void; reject(error: Error): void; detach(): void; timer: ReturnType<typeof setTimeout> } | undefined;
  let readyResolve!: () => void, readyReject!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  // Attach immediately so launch failures cannot create an unhandled ready rejection.
  void ready.catch(() => {});
  let readySettled = false;
  const detachStartupSignal = () => options.signal?.removeEventListener('abort', onStartupAbort);
  const noteReadySettled = () => { readySettled = true; detachStartupSignal(); };
  const onStartupAbort = () => {
    if (readySettled || closing || unavailableNow) return;
    // Revoke the startup intent on private launch cancellation: reject pending readiness
    // with the abort reason, tear down the socket, and let the outer catch close the exact
    // owned host record. No replacement process is created; normal ready sends are unaffected.
    noteReadySettled();
    readyReject(abortReason(options.signal!));
    lost();
  };
  const lost = () => {
    if (unavailableNow) return;
    unavailableNow = true; signalUnavailable();
    const error = parentError('engine', 'Bot host control is unavailable');
    readyReject(error);
    noteReadySettled();
    if (active) { const turn = active; active = undefined; clearTimeout(turn.timer); turn.detach(); turn.reject(error); }
    socket?.destroy();
  };
  if (options.signal) {
    if (options.signal.aborted) onStartupAbort();
    else options.signal.addEventListener('abort', onStartupAbort, { once: true });
  }
  const server = createServer(connection => {
    if (socket || closing || unavailableNow) { connection.destroy(); return; }
    socket = connection;
    connection.on('close', lost);
    let greeted = false, initialized = false;
    wire = hostWire(connection, record.epoch, frame => {
      if (closing || unavailableNow) return;
      if (frame.type === 'hello' && frame.id === 0 && !greeted && Number.isSafeInteger(frame.pid)) {
        greeted = true;
        void (async () => {
          const info = await inspectHostUnit(record, internals.runner);
          if (!info || Number(info.MainPID) !== frame.pid) throw resourceError();
          record.invocation = info.InvocationID; record.cgroup = info.ControlGroup;
          record.mainPid = Number(info.MainPID); record.mainStart = processStart(record.mainPid);
          saveHostRecord(dir, record);
          if (closing || unavailableNow) return;
          initialized = true;
          wire!.send({ type: 'init', id: 0, input: prepared, env: parentEnv() });
        })().catch(lost);
        return;
      }
      if (frame.type === 'ready' && frame.id === 0 && initialized) { initialized = false; readyResolve(); noteReadySettled(); return; }
      if (frame.type === 'failed' && frame.id === 0) { readyReject(parentError(hostReason(frame.reason), 'Bot host failed to start')); noteReadySettled(); lost(); return; }
      const turn = active;
      if (!turn || frame.id !== turn.id) { if (frame.id >= nextId) lost(); return; } // Old turn frames cannot cross the slot boundary.
      if (frame.type === 'prepared') {
        if (turn.submitted) { lost(); return; }
        if (!turn.cancelRequested) { turn.submitted = true; wire!.send({ type: 'submit', id: turn.id }); }
        return;
      }
      if (frame.type === 'not-submitted' && (turn.submitted || !turn.cancelRequested) || frame.type === 'cancelled' && (!turn.submitted || !turn.cancelRequested)) { lost(); return; }
      if ((frame.type === 'delta' || frame.type === 'result' || frame.type === 'error') && !turn.submitted) { lost(); return; }
      if (frame.type === 'delta' && typeof frame.text === 'string') {
        try { turn.delta?.(frame.text); } catch { lost(); }
        return;
      }
      if (!['result', 'cancelled', 'not-submitted', 'error'].includes(frame.type)) { lost(); return; }
      active = undefined; clearTimeout(turn.timer); turn.detach();
      if (frame.type === 'result' && typeof frame.text === 'string') turn.resolve(frame.text);
      else if (frame.type === 'not-submitted') turn.reject(new ParentTurnNotSubmitted());
      else if (frame.type === 'cancelled') turn.reject(new ConfirmedParentCancellation());
      else turn.reject(parentError(hostReason(frame.reason), 'Bot host turn failed'));
    }, lost);
  });
  let closePromise: Promise<void> | undefined;
  const close = async (): Promise<void> => {
    if (closePromise) return closePromise;
    closing = true; record.closing = true; closingEpochs.add(record.epoch); lost();
    closePromise = (async () => {
      await new Promise<void>(resolve => server.close(() => resolve()));
      await cleanupHostRecord(dir, record, internals.runner);
      live.delete(record.epoch); closingEpochs.delete(record.epoch);
    })().catch(error => { closePromise = undefined; throw error; });
    // A failed close keeps its exact record and live ownership: a new factory must not clean or replace it.
    return closePromise;
  };
  const session: ParentAgentSession = {
    unavailable,
    async send(text, signal, onDelta) {
      if (typeof text !== 'string' || !text.trim() || text.length > PARENT_TEXT_MAX) throw parentError('invalid_input', 'Invalid parent message');
      if (signal?.aborted) throw abortReason(signal);
      if (closing || unavailableNow || !wire) throw parentError('closed', 'Bot host is unavailable');
      if (active) throw parentError('engine', 'Another parent turn is active');
      const id = nextId++;
      return new Promise<string>((resolve, reject) => {
        const abort = () => { if (active?.id !== id) return; active.delta = undefined; active.cancelRequested = true; try { wire!.send({ type: 'abort', id }); } catch { lost(); } };
        active = { id, delta: onDelta, resolve, reject, detach: () => signal?.removeEventListener('abort', abort), timer: setTimeout(lost, 16 * 60_000) };
        signal?.addEventListener('abort', abort, { once: true });
        try { wire!.send({ type: 'prepare', id, text }); if (signal?.aborted) abort(); } catch { lost(); }
      });
    },
    close,
  };
  // Outer startup budget covers the native engine handshake plus the hidden Master
  // identity turn, with a small margin. Tests override via internals.startupMs.
  const timer = setTimeout(lost, internals.startupMs ?? HOST_STARTUP_MS);
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(record.endpoint, () => { chmodSync(record.endpoint, 0o600); resolve(); }); });
    // A private launch cancellation that arrived before the host process was spawned
    // revokes the startup intent without creating the process; later arrivals reject
    // the pending readiness and the outer catch closes the exact owned resources.
    if (options.signal?.aborted) throw abortReason(options.signal);
    record.launched = true; saveHostRecord(dir, record);
    // Direct background launch: no Herdr lane, pane or tab. StandardInput is null
    // so the host never depends on a terminal; logs go to the journal. The socket
    // ExecCondition keeps a delayed launch from starting after its record is gone.
    const command = [
      'systemd-run', '--user', '--collect', `--unit=${record.unit}`, '--service-type=exec',
      '-p', `ExecCondition=/usr/bin/test -S ${JSON.stringify(record.endpoint.replace(/%/g, '%%').replace(/\$/g, () => '$$'))}`, '-p', 'StandardInput=null', '-p', 'StandardOutput=journal', '-p', 'StandardError=journal', '-p', 'ExitType=main', '-p', 'KillMode=control-group', '-p', 'Restart=no', '-p', 'RemainAfterExit=no', '-p', 'SendSIGKILL=yes', '-p', 'TimeoutStopSec=3s', '-p', 'MemoryHigh=8G', '-p', 'MemoryMax=10G', `--working-directory=${prepared.workspace}`, '--',
      ...(internals.hostCommand ?? hostCommand()), '__weaver-im-parent-host', record.endpoint, record.epoch,
    ];
    const launched = await resourceRun('systemd-run', command.slice(1), internals.runner);
    if (launched.code !== 0) throw resourceError();
    await ready;
    noteReadySettled();
    return session;
  } catch (error) {
    await close();
    throw error;
  } finally { clearTimeout(timer); detachStartupSignal(); }
}
