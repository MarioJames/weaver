import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

import stylex from '@stylexjs/unplugin';
import { defineConfig, type Plugin } from 'vite';

const stylexTokenModules = [
  '@lobehub/ui/stylex/cssVar.stylex',
  '@lobehub/ui/stylex/media.stylex',
] as const;

// @lobehub/ui ships uncompiled defineConsts modules. The official plugin's config
// hook would exclude the whole package from pre-bundling, but consumers only need
// the two public constant files left uncompiled; components stay prebundled.
const stylexPlugin = stylex.vite() as Plugin;
delete stylexPlugin.config;

const { buildStart, transform } = stylexPlugin;
if (typeof buildStart !== 'function' || typeof transform !== 'function') {
  throw new Error('@stylexjs/unplugin/vite did not expose callable buildStart and transform hooks');
}

const require = createRequire(import.meta.url);
stylexPlugin.buildStart = async function (options) {
  await buildStart.call(this, options);
  // Register the token constants after the plugin's own reset and before any app
  // style or dev CSS collection can reference them.
  for (const tokenModule of stylexTokenModules) {
    const filename = require.resolve(tokenModule);
    await Reflect.apply(transform, this, [readFileSync(filename, 'utf8'), filename]);
  }
};

export default defineConfig({
  base: './',
  root: 'src/renderer',
  optimizeDeps: { exclude: [...stylexTokenModules] },
  plugins: [stylexPlugin],
  build: { outDir: '../../dist/renderer', emptyOutDir: true },
});
