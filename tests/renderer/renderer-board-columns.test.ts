import assert from 'node:assert/strict';
import test from 'node:test';
import { taskStyles as styles } from '../../src/renderer/features/tasks/task-style';
import { styleCss, styleTokenValues } from './style-helpers';

const taskStyleUrl = new URL('../../src/renderer/features/tasks/task-style.ts', import.meta.url);
type StyleArg = Parameters<typeof styleCss>[1];
const cssOf = (...style: StyleArg[]) => styleCss(taskStyleUrl, ...style);

test('lane styles use theme tokens rather than literal colors and carry no accent bar or header border', () => {
  const lanes = cssOf(styles.columns, styles.column, styles.columnHead);
  assert.doesNotMatch(lanes, /#[\da-f]{3,8}\b|\brgba?\s*\(|\bhsla?\s*\(/i);
  assert.doesNotMatch(lanes, /border-(?:top|right|bottom|left|block-start|block-end|inline-start|inline-end)\b|--column-accent/);
  const tokens = styleTokenValues(lanes);
  for (const token of ['var(--lobe-color-fill-tertiary)', 'var(--lobe-color-text-secondary)', 'var(--lobe-color-info)', 'var(--lobe-color-primary)', 'var(--lobe-color-warning)', 'var(--lobe-color-fill-quaternary)', 'var(--lobe-color-text-tertiary)']) {
    assert.ok(tokens.includes(token), `Missing semantic lane token: ${token}`);
  }
  assert.match(cssOf(styles.columns), /align-items:stretch/);
  const head = cssOf(styles.columnHead);
  assert.match(head, /color:var\(--column-text\)/);
  assert.doesNotMatch(head, /border|background/);
  assert.ok(styleTokenValues(cssOf(styles.taskCard)).includes('var(--lobe-color-bg-container)'));
});

test('the card title is a plain text block, not a two-column flex layout', () => {
  const title = cssOf(styles.cardTitle);
  assert.doesNotMatch(title, /display:\s*(?:flex|inline-flex|grid)/);
  assert.match(title, /-webkit-line-clamp:2/);
  assert.doesNotMatch(cssOf(styles.cardTag), /display:\s*(?:flex|inline-flex|grid)/);
});

test('generated lane CSS has visible semantic mixes and scrolls below 1180px', () => {
  const css = cssOf(styles.columns, styles.column, styles.boardScrollHint);
  assert.match(css, /color-mix\(in srgb,\s*var\(--[\w-]+\) 8%,\s*transparent\)/);
  assert.match(css, /color-mix\(in srgb,\s*var\(--[\w-]+\) 10%,\s*transparent\)/);
  assert.match(css, /@media\s*\(max-width:\s*1179px\)[^{]*\{[^}]*grid-template-columns:repeat\(4,\s*minmax\(240px,\s*1fr\)\)/);
  const tokens = styleTokenValues(css);
  assert.ok(tokens.includes('var(--lobe-color-info)'));
  assert.ok(tokens.includes('var(--lobe-color-warning)'));
});
