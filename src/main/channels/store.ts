import type { DatabaseSync } from 'node:sqlite';
import type { ChannelSecret } from '../../shared/contracts/channels';
import { transact } from '../storage/transaction';
export class ChannelStore {
 constructor(private db: DatabaseSync) {}
 get connection(): unknown { return this.db; }
 getSecret(id: string): ChannelSecret | undefined { const row=this.db.prepare('SELECT body FROM channel_secrets WHERE id=?').get(id) as {body:string}|undefined;return row ? JSON.parse(row.body) as ChannelSecret : undefined; }
 putSecret(id: string, secret: ChannelSecret): void { transact(this.db,()=>this.db.prepare('INSERT INTO channel_secrets(id,body) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(id,JSON.stringify(secret))); }
 deleteSecret(id: string): void { transact(this.db,()=>this.db.prepare('DELETE FROM channel_secrets WHERE id=?').run(id)); }
}
