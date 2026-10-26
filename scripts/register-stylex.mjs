import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { transformSync as transformEsbuild } from 'esbuild';
import { transformSync } from '@babel/core';
import stylexBabelPlugin from '@stylexjs/babel-plugin';

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workspacePrefix = `${workspaceRoot}${path.sep}`;
const CODE_EXTENSION = /\.(?:[cm]?js|jsx|[cm]?ts|tsx)$/;
const THEME_FILE = /\.stylex\.(?:js|mjs|cjs|ts|mts|cts)$/;

function shouldTransform(filePath) {
  if (THEME_FILE.test(filePath)) return true;
  return filePath.startsWith(workspacePrefix) && CODE_EXTENSION.test(filePath);
}

function esbuildLoader(filePath) {
  if (/\.tsx$/.test(filePath)) return 'tsx';
  if (/\.jsx$/.test(filePath)) return 'jsx';
  if (/\.(?:ts|mts|cts)$/.test(filePath)) return 'ts';
  return 'js';
}

function transformSource(source, filename) {
  if (!shouldTransform(filename) || !source.includes('stylex')) return null;
  const js = transformEsbuild(source, {
    format: 'esm',
    jsx: 'automatic',
    loader: esbuildLoader(filename),
    target: 'node22',
  }).code;
  const result = transformSync(js, {
    babelrc: false,
    configFile: false,
    filename,
    plugins: [[stylexBabelPlugin, {
      dev: false,
      runtimeInjection: false,
      unstable_moduleResolution: { type: 'commonJS', rootDir: workspaceRoot },
    }]],
    sourceMaps: 'inline',
  });
  return result?.code ?? null;
}

function load(url, context, nextLoad) {
  const result = nextLoad(url, context);
  if (!url.startsWith('file:')) return result;
  const parsed = new URL(url);
  parsed.search = '';
  parsed.hash = '';
  const filename = fileURLToPath(parsed);
  if (!shouldTransform(filename)) return result;
  const code = transformSource(readFileSync(filename, 'utf8'), filename);
  return code == null ? result : { ...result, source: code, format: 'module' };
}

registerHooks({ load });
