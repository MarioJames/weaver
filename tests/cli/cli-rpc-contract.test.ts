import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import test from 'node:test';
import { CLI_CATALOG } from '../../src/cli/catalog';
import { RPC_METHODS } from '../../src/shared/contracts/rpc';
import { RpcError, parseRpcBody } from '../../src/main/rpc';
import { createRpcHandlers, type RpcHost } from '../../src/main/transport/handlers';

/** Explicit public RPC methods and arity, including channel CRUD and identity-scoped quota refresh. */
const FROZEN_ARITY: Record<string, number> = {
  startChannelLogin:1,getChannelLogin:1,submitChannelLoginCode:1,cancelChannelLogin:1,getChannels:0,saveChannel:1,deleteChannel:1,importChannels:1,refreshChannelQuota:1,
  getImSettings: 0, saveImSettings: 1, reconnectIm: 0,
  command: 1, getPolicy: 0, policyHistory: 0, policyRollback: 1, validatePolicy: 1, savePolicy: 1, previewRoute: 1, scanEngines: 0,
  listEngineModels: 1, getQuota: 0, refreshQuota: 1, getStall: 0, workerProbe: 1, workerProbeStatus: 0, sayHi: 1, sayHiResult: 1, startEngineCleanup: 1, getEngineCleanup: 1,
  listTasks: 0, getTask: 1, createTask: 1, startTask: 1, cancelTask: 1, capabilities: 0, serverInfo: 0,
  janitorSweep: 1, janitorStatus: 0,
};

test('the RPC contract keeps the public method allowlist and arity', () => {
  assert.deepEqual(Object.fromEntries(Object.entries(RPC_METHODS).map(([method, spec]) => [method, spec.arity])), FROZEN_ARITY);
  for (const [method, arity] of Object.entries(FROZEN_ARITY)) {
    assert.deepEqual(parseRpcBody({ method, args: Array(arity).fill({}) }), { method, args: Array(arity).fill({}) });
    assert.throws(() => parseRpcBody({ method, args: Array(arity + 1).fill({}) }), (error: unknown) => error instanceof RpcError && error.message === 'Invalid argument arity');
  }
  for (const method of ['nope', '__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
    assert.throws(() => parseRpcBody({ method, args: [] }), (error: unknown) => error instanceof RpcError && error.message === 'Unknown method');
  }
});

test('every RPC method in the contract has a handler and no handler is extra', () => {
  const host = {} as RpcHost;
  assert.deepEqual(Object.keys(createRpcHandlers(host)).sort(), Object.keys(RPC_METHODS).sort());
});

test('CLI catalog rows that call RPC directly take method, arity and mutation from the contract', () => {
  const direct = CLI_CATALOG.filter(item => item.rpc).map(item => [item.command, item.rpc!.method, item.rpc!.arity, item.mutation]);
  assert.deepEqual(direct, [
    ['workers.probe', 'workerProbe', 1, true], ['workers.probe-status', 'workerProbeStatus', 0, false],
    ['policy.get', 'getPolicy', 0, false], ['policy.validate', 'validatePolicy', 1, false], ['policy.save', 'savePolicy', 1, true],
    ['policy.preview', 'previewRoute', 1, false], ['policy.history', 'policyHistory', 0, false], ['policy.rollback', 'policyRollback', 1, true],
    ['channels.login.start','startChannelLogin',1,true], ['channels.login.get','getChannelLogin',1,false], ['channels.login.cancel','cancelChannelLogin',1,true],
    ['channels.list','getChannels',0,false], ['channels.save','saveChannel',1,true], ['channels.delete','deleteChannel',1,true], ['channels.import','importChannels',1,true], ['channels.quota','refreshChannelQuota',1,true],
    ['engines.scan', 'scanEngines', 0, false], ['engines.models', 'listEngineModels', 1, false],
    ['janitor.sweep', 'janitorSweep', 1, true], ['janitor.status', 'janitorStatus', 0, false],
    ['quota.get', 'getQuota', 0, false], ['quota.refresh', 'refreshQuota', 1, true],
  ]);
  const cliCommands = Object.values(RPC_METHODS).flatMap(spec => ('cli' in spec ? [spec.cli] : []));
  assert.deepEqual([...cliCommands].sort(), direct.map(row => row[0]).sort());
});

/** Static value imports reachable from a module (type-only and dynamic imports excluded). */
function staticModules(entry: string): Set<string> {
  const seen = new Set<string>();
  const resolveSpec = (from: string, spec: string) => [`${resolve(dirname(from), spec)}.ts`, `${resolve(dirname(from), spec)}/index.ts`].find(existsSync);
  const walk = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    const text = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(line => !/^\s*\/\//.test(line)).join('\n');
    const specs = [
      ...[...text.matchAll(/(?:^|\n)\s*(?:import|export)\s+(?!type\b)[^'"\n;]*?from\s*['"](\.[^'"]+)['"]/g)].map(match => match[1]!),
      ...[...text.matchAll(/(?:^|\n)\s*import\s*['"](\.[^'"]+)['"]/g)].map(match => match[1]!),
    ];
    for (const spec of specs) { const next = resolveSpec(file, spec); if (next) walk(next); }
  };
  walk(entry);
  return seen;
}

test('client commands do not statically load the server runtime', () => {
  const src = resolve(import.meta.dirname, '../../src');
  const loaded = [...staticModules(resolve(src, 'cli/main.ts'))].map(file => relative(src, file).split('\\').join('/'));
  assert.deepEqual(loaded.filter(file => file.startsWith('main/')).sort(), ['main/embedded.ts', 'main/local-ipc.ts']);
  assert.match(readFileSync(resolve(src, 'cli/commands/web.ts'), 'utf8'), /await import\('\.\.\/\.\.\/main\/runtime'\)/);
});
