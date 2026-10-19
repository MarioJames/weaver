import { build } from 'esbuild';
import { mkdir, copyFile, chmod, rm } from 'node:fs/promises';
await rm('dist/main', { recursive: true, force: true });
await mkdir('dist/workers', { recursive: true });
await copyFile('scripts/mock-worker.mjs', 'dist/workers/mock-worker.mjs');
await build({
  entryPoints: ['src/cli/main.ts'],
  outfile: 'dist/cli/main.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  external: ['vite'],

});
await chmod('dist/cli/main.mjs', 0o755);
