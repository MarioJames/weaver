import type { DatabaseSync } from 'node:sqlite';
/** Reconstruct the actual historical policy table shape before exercising older ordered migrations. */
export function policySchema12(db:DatabaseSync):void {
 db.exec(`UPDATE policy_engines SET quota_refresh=(SELECT json_extract(body,'$.quota_refresh') FROM policy_channels WHERE json_extract(body,'$.engine')=policy_engines.id LIMIT 1);
 UPDATE policy_owners SET channel=(SELECT json_extract(body,'$.engine') FROM policy_channels WHERE id=channel) WHERE channel IN (SELECT id FROM policy_channels);
 UPDATE policy_workers SET channel=(SELECT json_extract(body,'$.engine') FROM policy_channels WHERE id=channel) WHERE channel IN (SELECT id FROM policy_channels);
 DROP TABLE policy_channels; DROP TABLE channel_secrets;
 ALTER TABLE policy_owners RENAME COLUMN channel TO engine; ALTER TABLE policy_workers RENAME COLUMN channel TO engine; ALTER TABLE policy_blocks DROP COLUMN channel`);
 for(const row of db.prepare('SELECT revision,body FROM policy_revisions').all() as {revision:number;body:string}[]){
  const value=JSON.parse(row.body);const config=value.config;if(!config?.channels)continue;
  for(const channel of Object.values(config.channels) as any[])if(channel.quota_refresh!==undefined)config.engines[channel.engine].quota_refresh=channel.quota_refresh;
  for(const role of [...Object.values(config.owners),...Object.values(config.workers)] as any[]){role.engine=config.channels[role.channel].engine;delete role.channel;}
  delete config.channels;db.prepare('UPDATE policy_revisions SET body=? WHERE revision=?').run(JSON.stringify(value),row.revision);
 }
}
