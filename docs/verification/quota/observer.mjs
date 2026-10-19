import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {homedir} from 'node:os';
const base='/tmp/weaver-quota-16z1usfq/browser';
const home=process.env.HOME||homedir();
const files={codex:join(process.env.CODEX_HOME||join(home,'.codex'),'auth.json'),claude:join(process.env.CLAUDE_CONFIG_DIR||join(home,'.claude'),'.credentials.json'),grok:join(home,'.grok/auth.json'),formalPolicy:join(process.env.XDG_DATA_HOME||join(home,'.local/share'),'weaver/policy.v1.json')};
function bytes(file){try{return readFileSync(file)}catch(e){return e.code==='ENOENT'?null:undefined}}
const before=Object.fromEntries(Object.entries(files).map(([id,file])=>[id,bytes(file)]));
const calls=[];const original=globalThis.fetch;
globalThis.fetch=async function(url,options){const entry={url:String(url),method:options?.method||'GET',startedAt:new Date().toISOString()};calls.push(entry);try{const result=await original.call(this,url,options);entry.status=result.status;return result}catch(e){entry.failed=true;throw e}finally{writeFileSync(join(base,'real-provider-calls.json'),JSON.stringify(calls,null,2))}};
process.on('exit',()=>{const result={};for(const [id,file] of Object.entries(files)){const after=bytes(file);result[id]={checked:before[id]!==undefined&&after!==undefined,existedBefore:before[id]!==null&&before[id]!==undefined,existedAfter:after!==null&&after!==undefined,unchanged:before[id]===null?after===null:Buffer.isBuffer(before[id])&&Buffer.isBuffer(after)&&before[id].equals(after)}}writeFileSync(join(base,'native-and-formal-policy-integrity.json'),JSON.stringify({storedSecrets:false,storedFingerprints:false,files:result},null,2))});
