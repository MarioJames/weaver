import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { ChannelSecret } from '../../shared/contracts/channels';
/** Shared by direct process launch and the Herdr shell launch boundary. Constants are safe shell case patterns. */
export const CHANNEL_AUTH_ENV_PATTERNS = ['ANTHROPIC_*','OPENAI_*','AZURE_OPENAI_*','XAI_*','GROK_*','CODEX_*','CLAUDE_*','QODER_*','OPENCODE_*','PI_CODING_AGENT_DIR','DSH_*','DEEPSEEK_*','GOOGLE_API_KEY','GEMINI_API_KEY','WEAVER_CHANNEL_KEY','*API_KEY','*APIKEY','*ACCESS_TOKEN','*REFRESH_TOKEN','*AUTH_TOKEN','*BEARER_TOKEN','*CLIENT_SECRET','ELECTRON_RUN_AS_NODE'] as const;
export function isChannelCredentialVariable(name:string): boolean {
 return CHANNEL_AUTH_ENV_PATTERNS.some(pattern=>pattern.startsWith('*')?name.endsWith(pattern.slice(1)):pattern.endsWith('*')?name.startsWith(pattern.slice(0,-1)):name===pattern);
}
/** Authentication and routing variables must never leak from another account. */
export function channelEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
 const env = { ...source };
 for (const name of Object.keys(env)) if (isChannelCredentialVariable(name)) delete env[name];
 return env;
}

export const officialEngines = new Set(['codex','claude','grok','opencode','qoder','qodercli']);
export function nativeFile(root: string, name: string, limit=512*1024): boolean {
 try { const s=lstatSync(join(root,name));return s.isFile()&&!s.isSymbolicLink()&&s.size>0&&s.size<=limit; } catch { return false; }
}
export function nativeJson(root: string, name: string): any {
 if(!nativeFile(root,name))return {};
 try { const v=JSON.parse(readFileSync(join(root,name),'utf8'));return v&&typeof v==='object'&&!Array.isArray(v)?v:{}; } catch { return {}; }
}
export function jwtClaims(value: unknown): any {
 if(typeof value!=='string'||value.length>32768)return {};
 try{return JSON.parse(Buffer.from(value.split('.')[1]??'','base64url').toString('utf8'));}catch{return {};}
}
export function grokCredential(root:string, verifying=false): {token:string;subject:string}|undefined {
 const entries=Object.entries(nativeJson(root,'auth.json')).filter(([key,v]:[string,any])=>key.startsWith('https://auth.x.ai::')&&v?.auth_mode==='oidc');
 if(entries.length!==1)return;
 const value=entries[0]![1] as any;const token=value.key??value.access_token;
 const claims=jwtClaims(value.id_token??token);const access=jwtClaims(token);
 const subject=claims.sub??value.account_id??value.user_id;
 const issuer=value.oidc_issuer??claims.iss;
 const expiry=typeof value.expires_at==='number'?(value.expires_at<1e12?value.expires_at*1000:value.expires_at):typeof value.expires_at==='string'?Date.parse(value.expires_at):typeof access.exp==='number'?access.exp*1000:NaN;
 if(typeof token!=='string'||!token||typeof subject!=='string'||!subject||issuer!=='https://auth.x.ai'||!Number.isFinite(expiry)||expiry<=Date.now()&&(verifying||typeof value.refresh_token!=='string'||!value.refresh_token))return;
 return {token,subject};
}
/** Local Claude OAuth material; this does not verify the grant with Anthropic. */
export function claudeCredentialsReady(value:any, verifying=false):boolean {
 const v=value?.claudeAiOauth;
 return typeof v?.accessToken==='string'&&!!v.accessToken&&(!v.expiresAt||v.expiresAt>Date.now()||!verifying&&typeof v.refreshToken==='string'&&!!v.refreshToken);
}
/** Local materials may be refreshed by the native CLI. Strict login verification also requires current access. */
export function nativeCredentialsReady(engine:string, secret:ChannelSecret, verifying=false): boolean {
 const root=secret.authDir;
 if(!root||!isAbsolute(root)||!verifying&&existsSync(join(root,'.weaver-login-pending')))return false;
 try {const s=lstatSync(root);if(!s.isDirectory()||s.isSymbolicLink())return false;}catch{return false;}
 switch(engine){
  case 'codex': {const v=nativeJson(root,'auth.json');const claims=jwtClaims(v.tokens?.access_token);return (!claims.exp||claims.exp>Date.now()/1000||!verifying&&typeof v.tokens?.refresh_token==='string'&&!!v.tokens.refresh_token)&&(v.auth_mode===undefined||v.auth_mode==='chatgpt')&&!v.OPENAI_API_KEY&&!v.personal_access_token&&!v.agent_identity&&!v.bedrock_api_key&&!v.bedrock_access_keys&&typeof v.tokens?.access_token==='string'&&!!v.tokens.access_token&&(!!v.tokens.account_id||!!jwtClaims(v.tokens.id_token).sub);}
  case 'claude': return claudeCredentialsReady(nativeJson(root,'.credentials.json'),verifying);
  case 'grok': return !!grokCredential(root,verifying);
  case 'qoder': case 'qodercli': return nativeFile(root,'.auth/user')&&nativeFile(root,'.auth/machine_id');
  case 'opencode': {
   // SQLite account stores contain business data; the config-file size bound does not apply.
   try{const file=lstatSync(join(root,'opencode.db'));if(!file.isFile()||file.isSymbolicLink()||file.size===0)return false;}catch{return false;}
   let db:DatabaseSync|undefined;
   try{db=new DatabaseSync(join(root,'opencode.db'),{readOnly:true});const row=db.prepare('SELECT active_account_id, active_org_id FROM account_state WHERE id=1').get();return typeof row?.active_account_id==='string'&&!!row.active_account_id&&typeof row.active_org_id==='string'&&!!row.active_org_id;}catch{return false;}finally{db?.close();}
  }
  default:return false;
 }
}
/** The login and inference boundaries use the same credential-stripped native environment. */
export function nativeEnvironment(engine:string,root:string,source:NodeJS.ProcessEnv):NodeJS.ProcessEnv {
 const env=channelEnvironment(source);
 if(engine==='codex')env.CODEX_HOME=root;
 if(engine==='claude'){env.CLAUDE_CONFIG_DIR=root;env.CLAUDE_SECURESTORAGE_CONFIG_DIR=root;env.ANTHROPIC_CONFIG_DIR=join(root,'anthropic');}
 if(engine==='grok')env.GROK_HOME=root;
 if(engine==='qoder'||engine==='qodercli')env.QODER_CONFIG_DIR=root;
 if(engine==='opencode'){
  for(const [key,dir] of Object.entries({XDG_CONFIG_HOME:'config',XDG_DATA_HOME:'data',XDG_STATE_HOME:'state',XDG_CACHE_HOME:'cache'})){env[key]=join(root,dir);mkdirSync(env[key]!,{recursive:true,mode:0o700});}
  env.OPENCODE_DB=join(root,'opencode.db');env.OPENCODE_CONFIG_DIR=join(root,'config');env.OPENCODE_DISABLE_PROJECT_CONFIG='1';
 }
 return env;
}
export function writeNativeConfig(root:string,name:string,body:string):void {
 const staged=join(root,`.${name}-${randomUUID()}.tmp`);writeFileSync(staged,body,{mode:0o600,flag:'wx'});chmodSync(staged,0o600);renameSync(staged,join(root,name));
}
