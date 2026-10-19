import{test}from'node:test';import{strict as a}from'node:assert';import{importRows}from'./importer.mjs';test('preserves existing and reports invalid rows',()=>{const r=importRows([{id:'a',title:'old'}],[{id:'b',title:'new'},null,{id:'a',title:'override'}]);a.deepEqual(r.items,[{id:'a',title:'old'},{id:'b',title:'new'}]);a.equal(r.errors.length,2)});

function assertErrors(errors, indexes, reasonPattern) {
  a.deepEqual(errors.map(error => error.index), indexes);
  for (const error of errors) {
    a.deepEqual(Object.keys(error).sort(), ['index', 'reason']);
    a.equal(typeof error.reason, 'string');
    a.ok(error.reason.trim().length > 0);
    a.match(error.reason, reasonPattern);
  }
}

test('rejects non-object rows and arrays without stopping later valid rows', () => {
  const arrayRow = Object.assign([], { id: 'array', title: 'invalid' });
  const functionRow = Object.assign(() => {}, { id: 'function', title: 'invalid' });
  const invalidRows = [null, undefined, [], arrayRow, 'text', 0, false, 1n, Symbol('row'), functionRow];
  const validRow = { id: 'valid', title: 'accepted' };
  const result = importRows([], [...invalidRows, validRow]);

  a.deepEqual(result.items, [validRow]);
  assertErrors(result.errors, invalidRows.map((_, index) => index), /object|array/i);
});

test('rejects missing, non-string, empty and whitespace-only ids', () => {
  const invalidIds = [undefined, null, 0, false, {}, [], new String('id'), '', ' ', '\t', '\r\n', '\u00a0'];
  const rows = invalidIds.map(id => ({ id, title: 'valid title' }));
  rows.push({ title: 'missing id' });
  const validRow = { id: 'valid', title: 'accepted after invalid ids' };
  const result = importRows([], [...rows, validRow]);

  a.deepEqual(result.items, [validRow]);
  assertErrors(result.errors, rows.map((_, index) => index), /id.*(string|empty|blank|whitespace)/i);
});

test('rejects missing, non-string, empty and whitespace-only titles', () => {
  const invalidTitles = [undefined, null, 0, false, {}, [], new String('title'), '', ' ', '\t', '\r\n', '\u00a0'];
  const rows = invalidTitles.map((title, index) => ({ id: `invalid-${index}`, title }));
  rows.push({ id: 'missing-title' });
  const validRow = { id: 'valid', title: 'accepted after invalid titles' };
  const result = importRows([], [...rows, validRow]);

  a.deepEqual(result.items, [validRow]);
  assertErrors(result.errors, rows.map((_, index) => index), /title.*(string|empty|blank|whitespace)/i);
});

test('rejects existing ids without overwriting or reordering existing items', () => {
  const existing = [{ id: 'z', title: 'first' }, { id: 'a', title: 'second', extra: 42 }];
  const newRow = { id: 'b', title: 'new' };
  const result = importRows(existing, [
    { id: 'a', title: 'replacement' },
    newRow,
    { id: 'z', title: 'another replacement' },
  ]);

  a.deepEqual(result.items, [...existing, newRow]);
  assertErrors(result.errors, [0, 2], /duplicate/i);
});

test('rejects batch duplicates while preserving first accepted rows and later valid rows', () => {
  const first = { id: 'same', title: 'first', extra: { retained: true } };
  const later = { id: 'later', title: 'later valid row' };
  const result = importRows([], [
    first,
    { id: 'same', title: 'replacement' },
    later,
    { id: 'same', title: 'second replacement' },
    { id: 'later', title: 'later replacement' },
  ]);

  a.deepEqual(result.items, [first, later]);
  assertErrors(result.errors, [1, 3, 4], /duplicate/i);
});

test('invalid rows do not reserve an id for subsequent valid rows', () => {
  const validRow = { id: 'retry', title: 'accepted' };
  const result = importRows([], [
    { id: 'retry', title: ' \t\n' },
    { id: 'retry', title: 17 },
    validRow,
    { id: 'retry', title: 'duplicate after acceptance' },
  ]);

  a.deepEqual(result.items, [validRow]);
  assertErrors(result.errors.slice(0, 2), [0, 1], /title/i);
  assertErrors(result.errors.slice(2), [3], /duplicate/i);
});

test('preserves valid strings, extra fields, input order and special ids', () => {
  const field = Symbol('extra field');
  const existing = [{ id: 'plain', title: 'existing' }];
  const rows = [
    { id: ' plain ', title: ' \tvalid title\n', count: 0, enabled: false, optional: undefined, data: { tags: ['keep'] }, [field]: 'kept' },
    { id: '__proto__', title: 'prototype name', extra: null },
    { id: 'constructor', title: 'constructor name' },
    { id: 'toString', title: 'method name' },
    { id: 'PLAIN', title: 'case-sensitive id' },
  ];
  const result = importRows(existing, rows);

  a.deepEqual(result.items, [...existing, ...rows]);
  a.equal(result.items[1].id, ' plain ');
  a.equal(result.items[1].title, ' \tvalid title\n');
  a.ok(Object.hasOwn(result.items[1], 'optional'));
  a.equal(result.items[1][field], 'kept');
  a.deepEqual(result.errors, []);
});

test('handles empty existing items, empty rows and wholly empty input', () => {
  a.deepEqual(importRows([], []), { items: [], errors: [] });
  const existing = [{ id: 'existing', title: 'retained' }];
  a.deepEqual(importRows(existing, []), { items: existing, errors: [] });
  const rows = [{ id: 'new', title: 'accepted' }];
  a.deepEqual(importRows([], rows), { items: rows, errors: [] });
});

test('does not mutate frozen input arrays, rows or nested fields', () => {
  const existing = Object.freeze([
    Object.freeze({ id: 'old', title: 'retained', data: Object.freeze({ value: 1 }) }),
  ]);
  const rows = Object.freeze([
    Object.freeze({ id: ' new ', title: ' new title ', tags: Object.freeze(['keep']) }),
    Object.freeze({ id: 'old', title: 'replacement' }),
    Object.freeze({ id: 'invalid', title: '' }),
    Object.freeze([]),
    null,
  ]);
  const beforeExisting = structuredClone(existing);
  const beforeRows = structuredClone(rows);
  const result = importRows(existing, rows);

  a.deepEqual(result.items, [existing[0], rows[0]]);
  assertErrors(result.errors.slice(0, 1), [1], /duplicate/i);
  assertErrors(result.errors.slice(1, 2), [2], /title/i);
  assertErrors(result.errors.slice(2), [3, 4], /object|array/i);
  a.deepEqual(existing, beforeExisting);
  a.deepEqual(rows, beforeRows);
});
