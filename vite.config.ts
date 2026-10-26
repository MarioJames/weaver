import { EventEmitter } from 'node:events';
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

// The plugin clears its dev CSS-update interval on `server.httpServer` close, but Weaver runs Vite in
// middleware mode where httpServer is null, so the ref'd interval kept the process alive long after
// shutdown. Give the hook a stand-in that closes together with the Vite server.
const { configureServer } = stylexPlugin;
if (typeof configureServer !== 'function') throw new Error('@stylexjs/unplugin/vite did not expose a callable configureServer hook');
stylexPlugin.configureServer = function (server) {
  if (server.httpServer) return configureServer.call(this, server);
  const httpServer = new EventEmitter();
  const close = server.close.bind(server);
  server.close = async () => { try { await close(); } finally { httpServer.emit('close'); } };
  return configureServer.call(this, new Proxy(server, { get: (target, key) => key === 'httpServer' ? httpServer : Reflect.get(target, key) }));
};

export default defineConfig({
  base: './',
  root: 'src/renderer',
  optimizeDeps: { exclude: [...stylexTokenModules] },
  plugins: [stylexPlugin],
  build: { outDir: '../../dist/renderer', emptyOutDir: true },
});
