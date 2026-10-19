export function importRows(existing, rows) {
  const items = [...existing];
  const errors = [];
  const acceptedIds = new Set(existing.map(item => item.id));

  for (const [index, row] of rows.entries()) {
    let reason;
    if (row === null || typeof row !== 'object' || Array.isArray(row)) {
      reason = 'Row must be a non-null object; arrays are not allowed';
    } else if (typeof row.id !== 'string' || row.id.trim().length === 0) {
      reason = 'id must be a non-empty string; whitespace-only values are not allowed';
    } else if (typeof row.title !== 'string' || row.title.trim().length === 0) {
      reason = 'title must be a non-empty string; whitespace-only values are not allowed';
    } else if (acceptedIds.has(row.id)) {
      reason = 'Duplicate id';
    }

    if (reason) {
      errors.push({ index, reason });
      continue;
    }

    items.push(row);
    acceptedIds.add(row.id);
  }

  return { items, errors };
}
