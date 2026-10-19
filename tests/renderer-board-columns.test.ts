import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('column styles use theme tokens rather than literal colors', () => {
  const source = readFileSync(new URL('../src/renderer/style.ts', import.meta.url), 'utf8');
  const columns = source.slice(source.indexOf('  columns: css`'), source.indexOf('  taskCard: css`'));
  assert.ok(columns.length > 0);
  assert.doesNotMatch(columns, /#[\da-f]{3,8}\b|\brgba?\s*\(|\bhsla?\s*\(/i);
  for (const token of ['colorFillTertiary', 'colorTextTertiary', 'colorPrimaryBg', 'colorPrimary', 'colorWarningBg', 'colorWarning', 'colorFillQuaternary', 'colorTextQuaternary', 'colorBgContainer']) {
    assert.ok(columns.includes(`cssVar.${token}`), `Missing semantic column token: ${token}`);
  }
});
