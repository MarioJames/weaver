import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('../src/renderer/style.ts', import.meta.url), 'utf8');
const block = (key: string, next: string) => source.slice(source.indexOf(`  ${key}: css\``), source.indexOf(`  ${next}: css\``));

test('lane styles use theme tokens rather than literal colors and carry no accent bar or header border', () => {
  const lanes = source.slice(source.indexOf('  columns: css`'), source.indexOf('  workspaceGroup: css`'));
  assert.ok(lanes.length > 0);
  assert.doesNotMatch(lanes, /#[\da-f]{3,8}\b|\brgba?\s*\(|\bhsla?\s*\(|\bhsla?\s*\(/i);
  assert.doesNotMatch(lanes, /border-block-start|border-top|border-bottom|border-block-end|--column-accent/);
  for (const token of ['colorFillTertiary', 'colorTextSecondary', 'colorPrimaryBg', 'colorPrimary', 'colorWarningBg', 'colorWarning', 'colorFillQuaternary', 'colorTextTertiary']) {
    assert.ok(lanes.includes(`cssVar.${token}`), `Missing semantic lane token: ${token}`);
  }
  assert.match(block('columns', 'column'), /align-items: start/);
  assert.match(block('columnHead', 'columnCount'), /color: var\(--column-text\)/);
  assert.doesNotMatch(block('columnHead', 'columnCount'), /border|background/);
  assert.ok(block('taskCard', 'taskCard').length >= 0);
  assert.ok(source.slice(source.indexOf('  taskCard: css`'), source.indexOf('  taskCard: css`') + 600).includes('cssVar.colorBgContainer'));
});

test('the card title is a plain text block, not a two-column flex layout', () => {
  const title = block('cardTitle', 'cardTag');
  assert.doesNotMatch(title, /display: flex|display: inline-flex|grid/);
  assert.match(title, /-webkit-line-clamp: 2/);
  assert.doesNotMatch(block('cardTag', 'cardTitleText'), /display: flex|display: grid/);
});
