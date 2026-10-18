import { build } from 'esbuild';
import { mkdir, copyFile, chmod } from 'node:fs/promises';
await build({entryPoints:['src/main/main.ts','src/main/preload.ts'],outdir:'dist/main',outExtension:{'.js':'.cjs'},bundle:true,platform:'node',format:'cjs',external:['electron'],target:'node22'});
await mkdir('dist/workers', {recursive:true});
await copyFile('scripts/mock-worker.mjs', 'dist/workers/mock-worker.mjs');

await build({entryPoints:['src/cli/main.ts'],outfile:'dist/cli/main.mjs',bundle:true,platform:'node',format:'esm',target:'node22'});
await chmod('dist/cli/main.mjs',0o755);
