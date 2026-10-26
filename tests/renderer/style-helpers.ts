import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { transformSync as transformEsbuild } from 'esbuild';
import * as stylex from '@stylexjs/stylex';
import type { StyleXStyles } from '@stylexjs/stylex';
import stylexBabelPlugin, { type Rule } from '@stylexjs/babel-plugin';

const { transformSync: transformBabel } = createRequire(import.meta.url)('@babel/core') as {
  transformSync: (code: string, options: Record<string, unknown>) => { metadata?: { stylex?: Rule[] } } | null;
};

type StyleArg = StyleXStyles;

const workspaceRoot = fileURLToPath(new URL('../../', import.meta.url));

function compile(filename: string, loader: 'js' | 'ts'): Rule[] {
  const js = transformEsbuild(readFileSync(filename, 'utf8'), { format: 'esm', loader, target: 'node22' }).code;
  const result = transformBabel(js, {
    babelrc: false,
    configFile: false,
    filename,
    plugins: [[stylexBabelPlugin, {
      dev: false,
      runtimeInjection: false,
      unstable_moduleResolution: { type: 'commonJS', rootDir: workspaceRoot },
    }]],
  });
  return (result?.metadata?.stylex ?? []) as Rule[];
}

/** The class names a browser receives for a compiled StyleX style. */
export function styleClass(...styles: StyleArg[]): string {
  return stylex.props(...styles).className ?? '';
}

/** CSS emitted by the official StyleX compiler for rules in one style module. */
export function styleCss(moduleUrl: URL, ...styles: StyleArg[]): string {
  const filename = fileURLToPath(moduleUrl);
  const names = styleClass(...styles).split(/\s+/).filter(Boolean);
  const rules = compile(filename, 'ts').filter(([, style]) =>
    names.some(name => style.ltr.includes(`.${name}`) || style.rtl?.includes(`.${name}`)));
  return stylexBabelPlugin.processStylexRules(rules);
}

/** Semantic Lobe theme values behind the hashed variables used by compiled CSS. */
export function styleTokenValues(css: string): string[] {
  const themeFile = fileURLToPath(import.meta.resolve('@lobehub/ui/stylex/cssVar.stylex'));
  const values = new Map(compile(themeFile, 'js').map(([key, style]) => [`--${key}`, style.constVal == null ? undefined : String(style.constVal)]));
  return [...new Set([...css.matchAll(/var\((--[\w-]+)\)/g)].map(match => values.get(match[1]) ?? match[1]))];
}
