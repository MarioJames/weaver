import { randomUUID } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, realpathSync, rmdirSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { join, isAbsolute } from 'node:path';
import { embeddedApp } from '../embedded';
import { allocateHerdrLane, type AsyncRunner } from '../owner-host';
import { abortReason, ConfirmedParentCancellation, ParentTurnNotSubmitted, parentEnv, parentError, prepareParentAgentInput, PARENT_TEXT_MAX, type ParentAgentFailureReason, type ParentAgentInput, type ParentAgentSession } from './parent-agent';
import { hostWire, type HostFrame } from './parent-host-wire';
import { bootIdentity, cleanupHostRecord, herdrServer, inspectHostUnit, processStart, readHostRecords, resourceError, resourceRun, saveHostRecord, type HostRecord } from './parent-host-resources';

interface HostInternals { runner?: AsyncRunner; hostCommand?: readonly string[]; startupMs?: number }
const live = new Set<string>();
const closingEpochs = new Set<string>();
let recoveryQueue = Promise.resolve();
const quote = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`;
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
const ENGINE_TITLES: Record<string, string> = { claude: 'Claude', codex: 'Codex', opencode: 'OpenCode', pi: 'Pi', grok: 'Grok', qodercli: 'Qoder' };
function botTitle(at: string, engine: string): string {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit' }).formatToParts(new Date(at));
  return `${parts.find(p => p.type === 'month')!.value}${parts.find(p => p.type === 'day')!.value}｜FEA｜飞书 Bot·${ENGINE_TITLES[engine] ?? engine}`;
}
const HOST_FAILURE_REASONS: ReadonlySet<ParentAgentFailureReason> = new Set(['invalid_input', 'engine_missing', 'auth', 'protocol', 'engine', 'closed', 'aborted']);
function hostReason(value: unknown): ParentAgentFailureReason {
  return typeof value === 'string' && HOST_FAILURE_REASONS.has(value as ParentAgentFailureReason) ? value as ParentAgentFailureReason : 'engine';
}

/** Herdr is mandatory: no direct fallback. Only close() confirms full unit/tab reclamation. */
export async function createHerdrParentAgent(input: ParentAgentInput, options: { dataDir: string }, internals: HostInternals = {}): Promise<ParentAgentSession> {
  const prepared = prepareParentAgentInput(input);
  if (!isAbsolute(options.dataDir) || /[\x00-\x1f\x7f]/.test(options.dataDir)) throw resourceError();
  const root = join(options.dataDir, 'im-host');
  privateDirectory(root);
  // Serialize recovery and intent creation, while independent live sessions remain untouched.
  const before = recoveryQueue;
  let release!: () => void;
  recoveryQueue = new Promise<void>(resolve => { release = resolve; });
  await before;
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
    record = { version: 1, epoch, unit: `weaver-im-host-${epoch}.service`, createdAt, ownerPid: process.pid, ownerStart: processStart(process.pid)!, boot: bootIdentity(), endpoint, label: botTitle(createdAt, prepared.engineKind), launched: false };
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
  const lost = () => {
    if (unavailableNow) return;
    unavailableNow = true; signalUnavailable();
    const error = parentError('engine', 'Bot host control is unavailable');
    readyReject(error);
    if (active) { const turn = active; active = undefined; clearTimeout(turn.timer); turn.detach(); turn.reject(error); }
    socket?.destroy();
  };
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
      if (frame.type === 'ready' && frame.id === 0 && initialized) { initialized = false; readyResolve(); return; }
      if (frame.type === 'failed' && frame.id === 0) { readyReject(parentError(hostReason(frame.reason), 'Bot host failed to start')); lost(); return; }
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
  const timer = setTimeout(lost, internals.startupMs ?? 30_000);
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(record.endpoint, () => { chmodSync(record.endpoint, 0o600); resolve(); }); });
    record.server = await herdrServer(internals.runner); saveHostRecord(dir, record);
    record.allocating = true; saveHostRecord(dir, record);
    record.lane = await allocateHerdrLane({ workspace: prepared.workspace, label: record.label, asyncRunner: internals.runner, receipt: lane => { record.lane = lane; saveHostRecord(dir, record); } });
    saveHostRecord(dir, record);
    record.allocating = false; record.launched = true; saveHostRecord(dir, record);
    const command = [
      'systemd-run', '--user', '--collect', `--unit=${record.unit}`, '--service-type=exec', '--pipe', '--wait',
      '-p', `ExecCondition=/usr/bin/test -S ${JSON.stringify(record.endpoint.replace(/%/g, '%%').replace(/\$/g, () => '$$'))}`, '-p', 'ExitType=main', '-p', 'KillMode=control-group', '-p', 'Restart=no', '-p', 'RemainAfterExit=no', '-p', 'SendSIGKILL=yes', '-p', 'TimeoutStopSec=3s', '-p', 'MemoryHigh=8G', '-p', 'MemoryMax=10G', `--working-directory=${prepared.workspace}`, '--',
      ...(internals.hostCommand ?? hostCommand()), '__weaver-im-parent-host', record.endpoint, record.epoch,
    ];
    const launched = await resourceRun('herdr', ['--session', 'default', 'pane', 'run', record.lane.paneId!, `exec ${command.map(quote).join(' ')}`], internals.runner);
    if (launched.code !== 0 || /"error"\s*:/.test(launched.stdout)) throw resourceError();
    await ready;
    return session;
  } catch (error) {
    await close();
    throw error;
  } finally { clearTimeout(timer); }
}
