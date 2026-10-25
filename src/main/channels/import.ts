import { roleChannels } from '../../shared/policy/channels';
import { qoderModelFiles,qoderApiModelDifference,qoderModelManifest,QODER_BYOK_MANIFEST } from './qoder';
import { remapImportedBlocks } from './import-blocks';
import { findEngineExecutable,runCapture } from '../engines/probe';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
import { parse as parseYaml } from 'yaml';
import { parse as parseJsonc, type ParseError } from 'jsonc-parser';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, dirname, relative, isAbsolute } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import type { Channel, ChannelSecret, ImportChannelsResult, ImportChannelsInput } from '../../shared/contracts/channels';
import { PolicyStore } from '../policy/store';
import { ChannelStore } from './store';
import { ChannelService } from './service';
import { channelEnvironment } from './runtime';
import { claudeCredentialsReady, nativeCredentialsReady } from './native';
import { OpenCodeAccounts } from '../engines/opencode-accounts';
import { openCodeConsoleDbPath } from '../quota/opencode-console';

function read(file: string, limit=512*1024): string | undefined {
 if (!existsSync(file)) return;
 const stat = lstatSync(file); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit) throw new Error('导入来源必须为读取上限内的普通配置文件');
 return readFileSync(file, 'utf8');
}
function jsonc(text: string): string {
 const errors: ParseError[]=[];
 const value=parseJsonc(text,errors,{allowTrailingComma:true});
 if(errors.length)throw new Error('原生 JSONC 配置无法解析，来源未改动');
 return JSON.stringify(value);
}
function toml(text: string): Record<string, any> {
 try{return parseToml(text);}catch{throw new Error('原生 TOML 配置无法解析，来源未改动');}
}
function object(text: string | undefined): Record<string, any> {
 if (!text) return {};
 try { const value = JSON.parse(text); if (!value || typeof value !== 'object' || Array.isArray(value)) throw 0; return value; } catch { throw new Error('原生 JSON 配置无法解析，来源未改动'); }
}
const hash = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 24);
function openCodeReferences(value:any,source:string,env:NodeJS.ProcessEnv):any {
 if(Array.isArray(value))return value.map(entry=>openCodeReferences(entry,source,env));
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,entry])=>[key,openCodeReferences(entry,source,env)]));
 if(typeof value!=='string')return value;
 let expanded=value.replace(/\{env:([^}]+)\}/g,(_token,name:string)=>{const result=env[name];if(!result)throw new Error('OpenCode 原生配置引用的环境变量不可用，请提供独立配置后重试');return result;});
 expanded=expanded.replace(/\{file:([^}]+)\}/g,(_token,name:string)=>{
  const target=resolve(source,name);const rel=relative(source,target);
  if(name.startsWith('~/')||rel.startsWith('..')||isAbsolute(rel))throw new Error('OpenCode 文件引用必须位于导入来源目录内，请改为独立渠道配置');
  if(!existsSync(target))throw new Error('OpenCode 原生配置引用的文件不存在，请修正后重试');
  const canonical=realpathSync(target);const canonicalRelative=relative(source,canonical);if(canonicalRelative.startsWith('..')||isAbsolute(canonicalRelative))throw new Error('OpenCode 文件引用不能逃出导入来源目录');
  const body=read(target);if(body===undefined)throw new Error('OpenCode 原生配置引用的文件不存在，请修正后重试');
  return body.trim();
 });
 return expanded;
}
/** Pi's config-value template syntax; command-valued credentials are never executed during import. */
function piValue(value:string,env:NodeJS.ProcessEnv):string|undefined {
 if(value.startsWith('!'))throw new Error('Pi 命令型凭据不会在迁移中执行，请先提供独立 API key');
 let missing=false;
 const resolved=value.replace(/\$(\$|!|\{[^}]*\}|[A-Za-z_][A-Za-z0-9_]*)/g,(token,part:string)=>{
  if(part==='$'||part==='!')return part;
  const name=part.startsWith('{')?part.slice(1,-1):part;
  if(!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))return token;
  const result=env[name];if(!result){missing=true;return '';}return result;
 });
 return missing?undefined:resolved;
}
function jwtSubject(value: unknown): string | undefined {
 if(typeof value!=='string'||value.length>32768)return;
 try{const claims=JSON.parse(Buffer.from(value.split('.')[1]??'', 'base64url').toString('utf8'));return typeof claims.sub==='string'&&claims.sub?claims.sub:undefined;}catch{return;}
}
export interface ChannelImportOptions { listQoderModels?: (root:string,env:NodeJS.ProcessEnv)=>Promise<string>; identifyAccount?: (engine:string,root:string,env:NodeJS.ProcessEnv)=>Promise<string|undefined>; root: string; env?: NodeJS.ProcessEnv; accountsFactory?: (env: NodeJS.ProcessEnv) => Pick<OpenCodeAccounts, 'list' | 'switchAccount' | 'close'> }
interface Candidate { models?: string[]; selected?: boolean; channel: Channel; secret: ChannelSecret; identity: string; modelProvider?: string; authFiles?: Record<string, string | Buffer>; database?: string; account?: { accountID: string; orgID: string } }
/** Read-only source import. Stable identities preserve credentials refreshed in managed roots on repeated imports. */
export class NativeChannelImporter {
 constructor(private policy: PolicyStore, private secrets: ChannelStore, private options: ChannelImportOptions) {}
 async import(input: ImportChannelsInput): Promise<ImportChannelsResult> {
  if(input.replaceExisting!==undefined&&typeof input.replaceExisting!=='boolean')throw new Error('replaceExisting 必须为布尔值');
  const snapshot = this.policy.snapshot();
  if (input.revision !== snapshot.revision) throw new Error('Policy revision conflict');
  if (input.sourceDir && !input.engine) throw new Error('自定义来源目录需要指定引擎');
  const env = this.options.env ?? process.env;
  const candidates: Candidate[] = [];
  const failures=new Map<string,string>();
  const notFound=new Set<string>();
  const counts={added:0,existing:0,updated:0};
  const initialIds=new Set(Object.keys(snapshot.config.channels));
  const originalRoles=new Map([...Object.values(snapshot.config.owners),...Object.values(snapshot.config.workers)].map(role=>[role,[...roleChannels(role)]]));
  const temporary: string[]=[];
  const createdTargets:string[]=[];let committed=false;
  try {
  const requested=input.engine ? (snapshot.config.engines[input.engine]?.kind??input.engine) : undefined;
  for (const engine of requested ? [requested==='qodercli'?'qoder':requested] : ['codex','claude','grok','qoder','opencode','pi','dsh']) {
   if (!['codex','claude','grok','qoder','opencode','pi','dsh'].includes(engine)) throw new Error('不支持该导入引擎');
   const engineId=input.engine&&snapshot.config.engines[input.engine]?input.engine:Object.keys(snapshot.config.engines).find(id=>snapshot.config.engines[id]!.kind===(engine==='qoder'?'qodercli':engine));
   if(!engineId)continue;
   const before=candidates.length;
   try {
   const home = env.HOME ?? homedir();
   const defaults: Record<string,string> = { codex: env.CODEX_HOME ?? join(home,'.codex'), claude: env.CLAUDE_CONFIG_DIR ?? join(home,'.claude'), grok: env.GROK_HOME ?? join(home,'.grok'), qoder: env.QODER_CONFIG_DIR ?? join(home,'.qoder'), pi: env.PI_CODING_AGENT_DIR ?? join(home,'.pi','agent'), dsh: env.DSH_HOME ?? join(home,'.dsh'), opencode: env.OPENCODE_CONFIG_DIR ?? join(env.XDG_CONFIG_HOME ?? join(home,'.config'),'opencode') };
   const source = resolve(input.sourceDir ?? defaults[engine]!);
   if (!existsSync(source)) {notFound.add(engineId);continue;}
   const canonical = realpathSync(source);
   const add = (kind: Channel['kind'], identity: string, secret: ChannelSecret, extra: Partial<Candidate> = {}, provider?: string) => candidates.push({ channel: { engine:engineId, kind, label: `${engine} ${provider ?? (kind === 'api' ? 'API' : `官方订阅 ${hash(identity).slice(0,8)}`)}`, enabled: true, ...(provider ? {provider}: {}) }, identity: `${engineId}:${canonical}:${identity}`, secret, ...extra });
   if (engine === 'codex' || engine === 'grok') {
    const auth = read(join(source,'auth.json'));
    const nativeFiles = ['config.toml',...(engine==='codex'?readdirSync(source).filter(name=>name.endsWith('.config.toml')):[])];
    if(auth){const value=object(auth);const key=value.OPENAI_API_KEY??value.apiKey;
      if(typeof key==='string'&&key)add('api','api-auth',{apiKey:key},{selected:true});
      else if(Object.keys(value).length){let identity:string|undefined;if(engine==='codex')identity=value.tokens?.account_id??jwtSubject(value.tokens?.id_token)??jwtSubject(value.tokens?.access_token);else{const matches=Object.entries(value).filter(([key,raw]:[string,any])=>key.startsWith('https://auth.x.ai::')&&raw?.auth_mode==='oidc');if(matches.length===1){const entry=matches[0]![1] as any;identity=jwtSubject(entry.id_token)??jwtSubject(entry.key)??entry.account_id??entry.user_id;if(identity)identity+=`:${entry.team_id??''}`;}}if(!identity)throw new Error(`${engine} 原生登录缺少稳定账号身份，请在独立目录重新登录`);add('subscription',`official:${identity}`,{}, {authFiles:{'auth.json':auth}});}
    }
    for(const file of nativeFiles){
      const text=read(join(source,file));if(!text)continue;const config=toml(text);
      const definitions=engine==='codex'?config.model_providers:config.model;
      for(const [provider,raw] of Object.entries(definitions??{}) as [string,any][]){
        const keyName=typeof raw.env_key==='string'?raw.env_key:undefined;
        const apiKey=keyName?env[keyName]:undefined;
        const token=typeof raw.experimental_bearer_token==='string'?raw.experimental_bearer_token:undefined;
        if(!apiKey&&!token)continue;
        const selected=engine==='codex'?file==='config.toml'&&config.model_provider===provider:config.models?.default===provider;
        const native=engine==='codex'?{model_provider:provider,model_providers:{[provider]:raw}}:{models:{default:provider},model:{[provider]:raw}};
        add('api',`provider:${file}:${provider}`,{config:stringifyToml(native),...(apiKey?{apiKey}:{})},{modelProvider:provider,selected},provider);
      }
    }
   } else if (engine === 'claude') {
    const credentials=read(join(source,'.credentials.json'));
    {
      const local=read(join(source,'.claude.json'),16*1024*1024);
      const metadata=object(local??(source===resolve(defaults.claude!)?read(join(home,'.claude.json'),16*1024*1024):undefined));
      const account=metadata.oauthAccount;
      const identity=typeof account?.accountUuid==='string'?`${account.accountUuid}:${account.organizationUuid??''}`:undefined;
      if(!identity&&credentials&&Object.keys(object(credentials)).length)throw new Error('Claude 原生登录缺少稳定 oauthAccount 身份，需在独立目录重新登录后导入');
      if(identity)add('subscription',`official:${identity}`,{}, {authFiles:{'.credentials.json':credentials??'{}','.claude.json':JSON.stringify({oauthAccount:account})}});
    }
    const config=object(read(join(source,'settings.json'))); const key=config.env?.ANTHROPIC_API_KEY??config.env?.ANTHROPIC_AUTH_TOKEN;
    if(typeof key==='string'&&key) add('api','api',{config:JSON.stringify({env:config.env}),apiKey:key});
   } else if(engine==='pi') {
    const config=object(read(join(source,'models.json'))); const auth=object(read(join(source,'auth.json')));
    for(const [provider,raw] of Object.entries(config.providers??{}) as [string,any][]){
      const entry=auth[provider];const reference=entry?.type==='api_key'?entry.key:raw.apiKey;
      const apiKey=typeof reference==='string'?piValue(reference,env):undefined;
      add('api',`provider:${provider}`,{config:JSON.stringify({providers:{[provider]:raw}}),...(apiKey?{apiKey}:{})},{modelProvider:provider},provider);
    }
   } else if(engine==='qoder') {
    const settings=object(read(join(source,'settings.json')));
    const user=join(source,'.auth','user');const machine=join(source,'.auth','machine_id');
    if(existsSync(user)&&existsSync(machine)){
      // Qoder owns this opaque format. Never parse, decrypt or serialize it as JSON.
      for(const file of [user,machine]){const info=lstatSync(file);if(!info.isFile()||info.isSymbolicLink()||info.size>512*1024)throw new Error('Qoder 认证来源必须为有界普通文件');}
      const authFiles={'.auth/user':readFileSync(user),'.auth/machine_id':readFileSync(machine),'settings.json':JSON.stringify({security:{auth:settings.security?.auth??{}}})};
      const identityRoot=join(this.options.root,`.identity-${randomUUID()}`);mkdirSync(identityRoot,{recursive:true,mode:0o700});
      let identity:string|undefined;let apiFiles:Record<string,string|Buffer>|undefined;let apiSettings:Record<string,any>|undefined;let apiModels:string[]=[];let apiVerified=false;
      try{
       for(const [name,body]of Object.entries(authFiles)){mkdirSync(dirname(join(identityRoot,name)),{recursive:true,mode:0o700});writeFileSync(join(identityRoot,name),body,{mode:0o600});}
       const isolated={...channelEnvironment(env),QODER_CONFIG_DIR:identityRoot};
       if(this.options.identifyAccount)identity=await this.options.identifyAccount(engine,identityRoot,isolated);
       else{const executable=await findEngineExecutable('qodercli',env.PATH??'');if(!executable)throw new Error('未找到 Qoder，无法验证原生账号身份');const result=await runCapture(executable,['--config-dir',identityRoot,'status','--output','json'],15000,65536,isolated);if(result.code!==0||result.error||result.timedOut||result.overflow)throw new Error('Qoder 独立账号身份验证失败，请重新登录');const status=object(result.stdout);if(status.logged_in===true){const stable=status.username??status.email;if(typeof stable==='string'&&stable)identity=stable;}}
       const models=qoderModelFiles(source);const hasCustoms=Object.keys(models).some(path=>path.endsWith('/customs'));
       if(hasCustoms||settings.providers){
        apiSettings={security:{auth:settings.security?.auth??{}},...(settings.providers?{providers:settings.providers}:{})};
        apiFiles={...authFiles,...models,'settings.json':JSON.stringify(apiSettings)};
        for(const [name,body]of Object.entries(apiFiles)){mkdirSync(dirname(join(identityRoot,name)),{recursive:true,mode:0o700});writeFileSync(join(identityRoot,name),body,{mode:0o600});}
        const baseline=join(this.options.root,`.baseline-${randomUUID()}`);mkdirSync(baseline,{recursive:true,mode:0o700});
        try{
         for(const [name,body]of Object.entries({...authFiles,...models})){if(name.endsWith('/customs'))continue;mkdirSync(dirname(join(baseline,name)),{recursive:true,mode:0o700});writeFileSync(join(baseline,name),body,{mode:0o600});}
         const listing=async(root:string)=>{const selected={...channelEnvironment(env),QODER_CONFIG_DIR:root};if(this.options.listQoderModels)return this.options.listQoderModels(root,selected);const executable=await findEngineExecutable('qodercli',env.PATH??'');if(!executable)throw new Error('未找到 Qoder');const result=await runCapture(executable,['--config-dir',root,'--list-models'],15000,256*1024,selected);if(result.code!==0||result.error||result.timedOut||result.overflow)throw new Error('Qoder 原生 BYOK 模型验证失败');return result.stdout;};
         apiModels=qoderApiModelDifference(await listing(identityRoot),await listing(baseline));apiVerified=apiModels.length>0&&hasCustoms;if(!apiVerified)apiModels=[];
        }catch{apiModels=[];apiVerified=false;}finally{rmSync(baseline,{recursive:true,force:true});}
        apiFiles[QODER_BYOK_MANIFEST]=qoderModelManifest(apiModels,{...models,'.auth/machine_id':authFiles['.auth/machine_id']});
       }
      }finally{rmSync(identityRoot,{recursive:true,force:true});}
      if(!identity)throw new Error('Qoder 原生登录缺少稳定账号身份，请在独立目录重新登录');
      add('subscription',`official:${identity}`,{}, {selected:true,authFiles});
      if(apiFiles)add('api',`byok:${identity}`,{config:JSON.stringify(apiSettings)},{models:apiModels,authFiles:apiFiles,channel:{engine:engineId,kind:'api',enabled:apiVerified,label:`qoder BYOK ${hash(identity).slice(0,8)}${apiVerified?'':'（需原生验证）'}`,provider:'native_byok'}});
    }
   } else if(engine==='dsh') {
    const credentialText=read(join(source,'.credentials.yaml'));
    let stored:unknown;
    if(credentialText){try{const credential=parseYaml(credentialText,{logLevel:'silent'});stored=credential?.refs?.DEEPSEEK_API_KEY;}catch{throw new Error('dsh 原生凭据 YAML 无法解析');}}
    const apiKey=typeof stored==='string'?stored:env.DEEPSEEK_API_KEY;
    if(apiKey)add('api','deepseek',{apiKey},{modelProvider:'deepseek',selected:true},'deepseek-official');
   } else {
    const config=openCodeReferences(object(jsonc(read(join(source,'opencode.json'))??read(join(source,'opencode.jsonc'))??'{}')),canonical,env);
    const data=env.XDG_DATA_HOME??join(home,'.local','share');
    const auth=object(read(join(data,'opencode','auth.json')));
    for(const [provider,raw] of Object.entries(config.provider??{}) as [string,any][]) { const credential=auth[provider];const explicit=typeof raw.options?.apiKey==='string'?raw.options.apiKey:undefined;const apiKey=explicit??(credential?.type==='api'&&typeof credential.key==='string'?credential.key:undefined);add('api',`provider:${provider}`,{config:JSON.stringify({provider:{[provider]:raw}}),...(apiKey?{apiKey}:{})},{modelProvider:provider},provider); }
    const database=input.sourceDir?join(source,'opencode.db'):openCodeConsoleDbPath(env);
    if(existsSync(database)) {
     const info=lstatSync(database);if(!info.isFile()||info.isSymbolicLink())throw new Error('OpenCode 数据库来源必须为普通文件');
     const enumeration=join(this.options.root,`.enumerate-${randomUUID()}`);mkdirSync(enumeration,{recursive:true,mode:0o700});
     temporary.push(enumeration);
     let orgs: {accountID:string;orgID:string;active?:boolean;accountEmail?:string;orgName?:string}[];
     {
      const sourceDb=new DatabaseSync(database,{readOnly:true});try {await backup(sourceDb,join(enumeration,'opencode.db'));} finally {sourceDb.close();}
      const isolated={...channelEnvironment(env),OPENCODE_DB:join(enumeration,'opencode.db'),XDG_CONFIG_HOME:join(enumeration,'config'),XDG_DATA_HOME:join(enumeration,'data'),XDG_STATE_HOME:join(enumeration,'state'),XDG_CACHE_HOME:join(enumeration,'cache')};
      const native=this.options.accountsFactory?.(isolated)??new OpenCodeAccounts({env:isolated});
      try {orgs=(await native.list()).orgs;} finally {await native.close();}
     }
     const seen=new Set<string>();
     for(const org of [...orgs].sort((a,b)=>Number(b.active)-Number(a.active))) { const repeated=seen.has(org.accountID);seen.add(org.accountID); add('subscription',`account:${org.accountID}:${org.orgID}`,{}, {database:join(enumeration,'opencode.db'),account:org,modelProvider:'opencode-go',selected:org.active===true, channel:{engine:engineId,kind:'subscription',label:`opencode ${org.accountEmail??org.accountID} / ${org.orgName??org.orgID}${repeated?'（需独立登录）':''}`.slice(0,120),enabled:!repeated}}); }
    }
   }
   if(candidates.length===before)notFound.add(engineId);
   } catch(error) {
    candidates.splice(before);
    const message=`${engine} 来源无法导入；请检查原生登录、配置格式和读取权限，单独选择该引擎重试`;
    if(input.engine){if(error&&typeof error==='object'&&'code' in error)throw new Error(`${engine} 来源读取或原生账号验证失败，请检查目录权限与登录后重试`);throw error;}
    failures.set(engineId,message);
   }
  }
  if(!candidates.length)throw new Error(failures.size?[...failures.values()].join('；'):'未找到可导入的原生账号或 API 配置，请检查所选来源目录与原生登录');
  const staged: string[]=[];
  const pendingSecrets=new Map<string,ChannelSecret>();
  const accepted:Candidate[]=[];
  try {
   for(const candidate of candidates) {
    const stagingBefore=staged.length,targetsBefore=createdTargets.length;
    try {
    const id=`import_${hash(candidate.identity)}`;
    const existingSecret=this.secrets.getSecret(id);
    const claudeSubscription=snapshot.config.engines[candidate.channel.engine]?.kind==='claude'&&candidate.channel.kind==='subscription';
    if(claudeSubscription&&existingSecret&&!input.replaceExisting&&!nativeCredentialsReady('claude',existingSecret))throw new Error('Claude 托管账号凭据不可用，请独立登录、选择有效来源或勾选更新后重试');
    if(existingSecret&&snapshot.config.channels[id]&&!input.replaceExisting){counts.existing++;accepted.push(candidate);continue;}
    if(claudeSubscription&&!(existingSecret&&!input.replaceExisting)&&!claudeCredentialsReady(object(candidate.authFiles?.['.credentials.json']?.toString())))throw new Error('Claude 未找到可用 OAuth 登录凭据，请重新登录或选择已登录目录后导入');
    // Policy rollback retains private credentials; restore metadata without recopying stale native auth.
    const preserveExisting=existingSecret&&!input.replaceExisting;
    const secret=preserveExisting?existingSecret:{...candidate.secret};
    if(!preserveExisting&&(candidate.channel.kind==='subscription'&&candidate.channel.enabled||candidate.channel.kind==='api'&&candidate.authFiles)) {
     mkdirSync(this.options.root,{recursive:true,mode:0o700});
     const target=join(this.options.root,input.replaceExisting?`${id}-${randomUUID()}`:id);const stage=join(this.options.root,`.stage-${id}`); if(existsSync(stage)) throw new Error('存在未完成的账号导入现场，请先核实归属');mkdirSync(stage,{mode:0o700});staged.push(stage);
     for(const [name,body] of Object.entries(candidate.authFiles??{})){mkdirSync(dirname(join(stage,name)),{recursive:true,mode:0o700});writeFileSync(join(stage,name),body,{mode:0o600});}
     if(candidate.database) {
      const db=new DatabaseSync(candidate.database,{readOnly:true});try {await backup(db,join(stage,'opencode.db'));} finally {db.close();}chmodSync(join(stage,'opencode.db'),0o600);
      if(candidate.channel.enabled) {
       const isolated={...channelEnvironment(env),OPENCODE_DB:join(stage,'opencode.db'),XDG_CONFIG_HOME:join(stage,'config'),XDG_DATA_HOME:join(stage,'data'),XDG_STATE_HOME:join(stage,'state'),XDG_CACHE_HOME:join(stage,'cache')};
       const native=this.options.accountsFactory?.(isolated)??new OpenCodeAccounts({env:isolated});
       try { const listed=await native.list(); const active=listed.orgs.find(org=>org.active); const switched=await native.switchAccount({accountID:candidate.account!.accountID,orgID:candidate.account!.orgID,expectedActive:active?{accountID:active.accountID,orgID:active.orgID}:null});if(!switched.consoleManagedProviders.includes('opencode-go')||!switched.orgs.some(org=>org.active&&org.accountID===candidate.account!.accountID&&org.orgID===candidate.account!.orgID))throw new Error('OpenCode 官方组织凭据复验未完成，请在独立根重新登录'); } finally {await native.close();}
      }
     }
     if(existsSync(target))throw new Error('目标账号根已存在但没有导入记录，请先核实归属');renameSync(stage,target);createdTargets.push(target);staged.splice(staged.indexOf(stage),1);secret.authDir=target;
    }
    if(candidate.channel.kind==='subscription'){const previous=snapshot.config.channels[`default_${candidate.channel.engine}`];if(previous?.quota_refresh!==undefined)candidate.channel.quota_refresh=previous.quota_refresh;}
    snapshot.config.channels[id]??=candidate.channel;
    for(const role of [...Object.values(snapshot.config.owners),...Object.values(snapshot.config.workers)]) {
     // Only an untouched legacy singleton is eligible for automatic source selection.
     // An explicit worker pool is user-owned, even when it contains a default account.
     const original=originalRoles.get(role)!;if(original.length!==1||!original[0]!.startsWith('default_'))continue;
     const currentId=roleChannels(role)[0]!;
     const current=snapshot.config.channels[currentId];if(current?.engine!==candidate.channel.engine||!candidate.channel.enabled)continue;
     const provider=role.model.includes('/')?role.model.split('/')[0]:undefined;
     const rebind=()=>{if('channels' in role)role.channels=[...new Set(role.channels.map(channel=>channel===currentId?id:channel))];else role.channel=id;};
     if(candidate.models){if(candidate.models.includes(role.model))rebind();continue;}
     if(provider){if(candidate.modelProvider===provider&&(candidate.selected||currentId===original[0]))rebind();}
     else if(candidate.selected||!candidate.modelProvider&&candidate.channel.kind==='subscription'&&currentId===original[0])rebind();
    }
    pendingSecrets.set(id,secret);counts[initialIds.has(id)?input.replaceExisting?'updated':'existing':'added']++;accepted.push(candidate);
    }catch(error){
     for(const path of staged.splice(stagingBefore))rmSync(path,{recursive:true,force:true});
     for(const path of createdTargets.splice(targetsBefore))rmSync(path,{recursive:true,force:true});
     if(input.engine){if(error&&typeof error==='object'&&'code' in error)throw new Error('原生账号私有配置建立或身份验证失败，请检查目录权限与登录后重试');throw error;}
     failures.set(candidate.channel.engine,snapshot.config.engines[candidate.channel.engine]?.kind==='claude'&&error instanceof Error?error.message:`${candidate.channel.engine} 来源账号复验失败；其他可用来源已保留，请单独选择该引擎重试`);
    }
   }
   candidates.splice(0,candidates.length,...accepted);
   if(!candidates.length)throw new Error([...failures.values()].join('；'));
  } finally {for(const stage of staged)rmSync(stage,{recursive:true,force:true});}
  const subscriptions=new Map<string,Set<string>>();
  for(const candidate of candidates){if(candidate.channel.kind!=='subscription'||!candidate.channel.enabled)continue;const id=`import_${hash(candidate.identity)}`;const set=subscriptions.get(candidate.channel.engine)??new Set<string>();set.add(id);subscriptions.set(candidate.channel.engine,set);}
  const roleChanges=[...originalRoles].flatMap(([role,before])=>before.length===1&&roleChannels(role).length===1?[{before:before[0]!,after:roleChannels(role)[0]!}]:[]);
  snapshot.blocks=remapImportedBlocks(snapshot.config,snapshot.blocks,roleChanges,subscriptions);
  if(pendingSecrets.size)this.policy.transaction(()=>{
   this.policy.save({revision:input.revision,config:snapshot.config,blocks:snapshot.blocks});
   for(const [id,secret] of pendingSecrets)this.secrets.putSecret(id,secret);
  });
  committed=true;
  const result=new ChannelService(this.policy,this.secrets).get();
  for(const [id,channel] of Object.entries(result.policy.config.channels)){
   const detail=failures.get(channel.engine);if(detail)result.configurations[id]!.detail=detail;
  }
  return {...result,importResult:{...counts,notFound:[...notFound],failures:[...failures].map(([engine,message])=>({engine,message}))}};
  } finally {for(const dir of temporary)rmSync(dir,{recursive:true,force:true});if(!committed)for(const dir of createdTargets)rmSync(dir,{recursive:true,force:true});}
 }
}
