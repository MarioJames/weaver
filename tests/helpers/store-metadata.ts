import type { CommandReceipt, LogicalOwner, WorkPackage } from '../../src/shared/commands';
import type { TaskStore } from '../../src/main/store';

export type StoreMetadata = { owners: LogicalOwner[]; packages: WorkPackage[]; receipts: Record<string, CommandReceipt> };

/** Whole-table view of the owner, package and receipt rows, for assertions and bulk fixtures. */
export function metadataOf(store: TaskStore): StoreMetadata {
  const receipts = store.db.prepare('SELECT key,body FROM receipts').all();
  return {
    owners: store.listOwners(),
    packages: store.db.prepare('SELECT body FROM packages ORDER BY rowid').all().map(row => JSON.parse(String(row.body)) as WorkPackage),
    receipts: Object.fromEntries(receipts.map(row => [String(row.key), JSON.parse(String(row.body)) as CommandReceipt])),
  };
}

/** Replaces the owner, package and receipt rows with exactly this content, in one transaction. */
export function setMetadataOf(store: TaskStore, meta: StoreMetadata): void {
  const put = (table: string, column: string, key: string, value: unknown) => store.db.prepare(`INSERT INTO ${table} (${column},body) VALUES (?,?) ON CONFLICT DO UPDATE SET body=excluded.body`).run(key, JSON.stringify(value));
  store.transaction(() => {
    for (const table of ['owners', 'packages', 'receipts']) store.db.exec(`DELETE FROM ${table}`);
    for (const owner of meta.owners) put('owners', 'id', owner.id, owner);
    for (const pkg of meta.packages) put('packages', 'id', pkg.id, pkg);
    for (const [key, value] of Object.entries(meta.receipts)) put('receipts', 'key', key, value);
  });
}
