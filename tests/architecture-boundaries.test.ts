import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import test from 'node:test';

// Dependency direction guard. Layers are the first directory under src/.
//   shared   -> shared only
//   renderer -> renderer, shared
//   cli      -> cli, shared, plus the main modules in CLI_MAIN_ALLOWED
//   main     -> main, shared (never renderer or cli)
// Violations that already existed when the guard was introduced are pinned in LEGACY_VIOLATIONS.
// Every entry must still exist (stale entries fail the test), so the list can only shrink.

const SRC = resolve(import.meta.dirname, '../src');
const LAYERS = ['shared', 'renderer', 'cli', 'main'] as const;
type Layer = typeof LAYERS[number];

const ALLOWED: Record<Layer, readonly Layer[]> = {
  shared: ['shared'],
  renderer: ['renderer', 'shared'],
  cli: ['cli', 'shared'],
  main: ['main', 'shared'],
};

/** cli -> main imports that are part of the rule, not legacy debt (module paths without extension, relative to src). */
const CLI_MAIN_ALLOWED = new Set(['main/local-ipc', 'main/runtime', 'main/embedded']);

/** "<importing file> -> <imported module>", both relative to src and without extension. */
const LEGACY_VIOLATIONS = new Set<string>([]);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx|mts)$/.test(entry.name) && !entry.name.endsWith('.d.ts') ? [path] : [];
  });
}

function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(line => !/^\s*\/\//.test(line)).join('\n');
}

/** Module specifiers from `import/export ... from`, side-effect `import '..'`, dynamic `import('..')` and inline `import('..').T` types. */
export function specifiers(text: string): string[] {
  const code = stripComments(text);
  const found: string[] = [];
  const patterns = [/\bfrom\s*['"]([^'"\n]+)['"]/g, /\bimport\s*['"]([^'"\n]+)['"]/g, /\bimport\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g];
  for (const pattern of patterns) for (const match of code.matchAll(pattern)) found.push(match[1]);
  return found;
}

function layerOf(path: string): Layer | undefined {
  const top = relative(SRC, path).split(sep)[0];
  return (LAYERS as readonly string[]).includes(top) ? top as Layer : undefined;
}

function scan() {
  const edges: { from: string; to: string }[] = [];
  const outside: string[] = [];
  for (const file of sourceFiles(SRC)) {
    const from = relative(SRC, file).split(sep).join('/');
    for (const spec of specifiers(readFileSync(file, 'utf8'))) {
      if (!spec.startsWith('.')) continue;
      const target = resolve(dirname(file), spec.replace(/\?.*$/, '')).replace(/\.(ts|tsx|mts|mjs|js)$/, '');
      if (relative(SRC, target).startsWith('..')) { outside.push(`${from} -> ${spec}`); continue; }
      edges.push({ from, to: relative(SRC, target).split(sep).join('/') });
    }
  }
  return { edges, outside };
}

function violation(edge: { from: string; to: string }): boolean {
  const fromLayer = layerOf(join(SRC, edge.from));
  const toLayer = layerOf(join(SRC, edge.to));
  assert.ok(fromLayer, `${edge.from} is not inside a known layer (${LAYERS.join(', ')})`);
  assert.ok(toLayer, `${edge.from} imports ${edge.to}, which is not inside a known layer`);
  if (ALLOWED[fromLayer].includes(toLayer)) return false;
  return !(fromLayer === 'cli' && CLI_MAIN_ALLOWED.has(edge.to));
}

test('the specifier scanner sees static, side-effect, dynamic and inline type imports and ignores comments', () => {
  const sample = [
    "import a from './a';", "import type { B } from '../b';", "export * from './c';", "import './d.css';",
    "const e = await import('./e');", "type F = import('../f').F;", "// import x from './ignored';", "/* import('./ignored2') */",
    "import react from 'react';",
  ].join('\n');
  assert.deepEqual(specifiers(sample).sort(), ['../b', '../f', './a', './c', './d.css', './e', 'react'].sort());
});

test('src imports respect the layer dependency direction', () => {
  const { edges, outside } = scan();
  assert.deepEqual(outside, [], 'src must not import files outside src');
  const found = new Set(edges.filter(violation).map(edge => `${edge.from} -> ${edge.to}`));
  const added = [...found].filter(entry => !LEGACY_VIOLATIONS.has(entry)).sort();
  assert.deepEqual(added, [], 'new cross-layer imports; move the shared piece into src/shared instead of extending LEGACY_VIOLATIONS');
});

test('every pinned legacy violation still exists so the list only shrinks', () => {
  const found = new Set(scan().edges.filter(violation).map(edge => `${edge.from} -> ${edge.to}`));
  const stale = [...LEGACY_VIOLATIONS].filter(entry => !found.has(entry)).sort();
  assert.deepEqual(stale, [], 'remove these entries from LEGACY_VIOLATIONS');
});

test('the cli-to-main exceptions are real imports', () => {
  const used = new Set(scan().edges.filter(edge => edge.from.startsWith('cli/') && edge.to.startsWith('main/')).map(edge => edge.to));
  assert.deepEqual([...CLI_MAIN_ALLOWED].filter(target => !used.has(target)).sort(), []);
  assert.deepEqual([...used].filter(target => !CLI_MAIN_ALLOWED.has(target)).sort(), []);
});

// The application layer holds the use cases; it never reaches back into the entry points that call it.
const APPLICATION_FORBIDDEN = new Set(['main/commands', 'main/runtime', 'main/http', 'main/local-ipc', 'main/embedded', 'main/rpc']);

test('main/application does not import transport, runtime or the command handler', () => {
  const bad = scan().edges
    .filter(edge => edge.from.startsWith('main/application/') && (edge.to.startsWith('main/transport/') || APPLICATION_FORBIDDEN.has(edge.to)))
    .map(edge => `${edge.from} -> ${edge.to}`);
  assert.deepEqual(bad, []);
});

test('only the runtime and transport entry points import the command handler module', () => {
  const importers = scan().edges.filter(edge => edge.to === 'main/commands').map(edge => edge.from.replace(/\.ts$/, '')).sort();
  assert.deepEqual(importers, ['main/runtime', 'main/transport/handlers']);
});
