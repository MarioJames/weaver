import { existsSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import type { ChannelLogin, ChannelLoginRef, StartChannelLoginInput, SubmitChannelLoginCodeInput } from '../../shared/contracts/channels';
import { object } from '../../shared/validation';
import { startOwnedScope, confirmScopeAbsent, type OwnedScope } from '../adapters/cli/scope';
import { findEngineExecutable, runCapture } from '../engines/probe';
import { OpenCodeAccounts } from '../engines/opencode-accounts';
import { RpcError } from '../rpc';
import type { ChannelBinding } from './runtime';
import { grokCredential, nativeCredentialsReady, nativeEnvironment, officialEngines, writeNativeConfig, nativeFile } from './native';

interface LoginWork { engine?:string; codeSubmitted?:boolean; submitting?:boolean; job:ChannelLogin; scope?:OwnedScope; closed?:Promise<number|null>; done?:boolean; work?:Promise<void>; cleanup?:Promise<void>; helper?:OpenCodeAccounts; finished?:boolean }
export interface ChannelLoginOptions {
 initialize?:(channel:string)=>ChannelBinding;
 env?:NodeJS.ProcessEnv;
 start?:typeof startOwnedScope;
 find?:typeof findEngineExecutable;
 capture?:typeof runCapture;
 confirmAbsent?:typeof confirmScopeAbsent;
 loginTimeoutMs?:number;
}
const active=(job:ChannelLogin)=>['starting','authorizing','verifying'].includes(job.status);
const safeError=(code:string,message:string)=>new RpcError(code,message);
/** Reject arbitrary OAuth query parameters: a CLI line is untrusted output. */
export function channelVerificationUrl(engine:string,value:string):string|undefined {
 try{
  const url=new URL(value);
  const hosts:Record<string,string[]>={codex:['auth.openai.com'],claude:['claude.ai','claude.com'],grok:['accounts.x.ai','auth.x.ai'],opencode:['opencode.ai'],qoder:['qoder.com','account.qoder.com'],qodercli:['qoder.com','account.qoder.com']};
  if(url.protocol!=='https:'||!hosts[engine]?.includes(url.hostname)||url.port||/^https:\/\/[^/?#]*:[0-9]+(?:[/?#]|$)/.test(value)||url.username||url.password||url.hash||url.href.length>2048)return;
  if(engine==='claude'&&url.hostname==='claude.com'&&url.pathname!=='/cai/oauth/authorize')return;
  // Native browser OAuth flows require these public request parameters, never callback credentials.
  const permitted=new Set(['client_id','response_type','redirect_uri','scope','state','code_challenge','code_challenge_method','device_code','user_code','code','organization_id','login_hint']);
  if((engine==='qoder'||engine==='qodercli')&&url.hostname==='qoder.com'&&url.pathname==='/device/selectAccounts')for(const key of ['challenge','challenge_method','nonce','machine_id','machine_token'])permitted.add(key);
  if([...url.searchParams.keys()].some(key=>!permitted.has(key)))return;
  if(url.searchParams.has('code')&&!(engine==='claude'&&url.searchParams.get('code')==='true')&&!/^[A-Z0-9-]{4,32}$/.test(url.searchParams.get('code')!))return;
  if(url.searchParams.has('device_code'))return;
  return url.href;
 }catch{return;}
}
function parse(value:unknown,reference:boolean):StartChannelLoginInput|ChannelLoginRef {
 const v=object(value);const keys=reference?['channel','id']:['channel'];
 if(Object.keys(v).some(k=>!keys.includes(k))||typeof v.channel!=='string'||!/^[a-z][a-z0-9_]{0,63}$/.test(v.channel)||reference&&(typeof v.id!=='string'||!/^[0-9a-f-]{36}$/.test(v.id)))throw safeError('INVALID_REQUEST','登录参数无效');
 return v as unknown as ChannelLoginRef;
}
/** In-memory jobs own only their native login process, never a source account or model run. */
export class ChannelLogins {
 private jobs=new Map<string,LoginWork>();
 private closing=false;
 constructor(private binding:(id:string)=>ChannelBinding,private options:ChannelLoginOptions={}){}
 private selected(channel:string):ChannelBinding {
  let b=this.binding(channel);const engine=b.engineKind??b.channel.engine;
  if(b.channel.kind!=='subscription'||!officialEngines.has(engine))throw safeError('LOGIN_UNAVAILABLE','仅官方订阅账号支持原生登录');
  if(!b.secret.authDir&&this.options.initialize)b=this.options.initialize(channel);
  if(!b.secret.authDir)throw safeError('LOGIN_UNAVAILABLE','官方账号私有目录服务不可用');
  return b;
 }
 async start(value:StartChannelLoginInput):Promise<ChannelLogin>{
  const {channel}=parse(value,false);
  if(this.closing)throw safeError('LOGIN_UNAVAILABLE','服务正在关闭');
  const current=this.jobs.get(channel);
  if(current?.job.error?.code==='LOGIN_CLEANUP')throw safeError('LOGIN_CLEANUP','上次登录进程未确认停止，请检查服务进程状态后重试');
  if(current&&!current.finished)return structuredClone(current.job);
  const b=this.selected(channel),engine=b.engineKind??b.channel.engine;
  if(nativeCredentialsReady(engine,b.secret)||!existsSync(join(b.secret.authDir!,'.weaver-login-pending'))&&['auth.json','.credentials.json','.auth/user','opencode.db'].some(name=>nativeFile(b.secret.authDir!,name,Number.MAX_SAFE_INTEGER)))throw safeError('CHANNEL_ALREADY_AUTHENTICATED','该账号已存在原生认证；请新建独立账号登录，避免改变运行任务身份');
  const item:LoginWork={job:{channel,id:randomUUID(),status:'starting'}};
  this.jobs.set(channel,item);item.work=this.run(item,b);
  return structuredClone(item.job);
 }
 hasActive(channel:string):boolean{const item=this.jobs.get(channel);return !!item&&!item.finished;}
 private ref(value:ChannelLoginRef):LoginWork {
  const input=parse(value,true) as ChannelLoginRef;const item=this.jobs.get(input.channel);
  if(!item||item.job.id!==input.id)throw safeError('NOT_FOUND','登录记录不存在，请重新开始登录');
  return item;
 }
 get(value:ChannelLoginRef):ChannelLogin{return structuredClone(this.ref(value).job);}
 async cancel(value:ChannelLoginRef):Promise<ChannelLogin>{
  const item=this.ref(value);
  if(active(item.job)){
   item.job.status='cancelled';
   try{await this.stop(item);await item.helper?.close();await item.work;}catch{this.fail(item,'LOGIN_CLEANUP','无法确认登录进程已停止，请重新读取状态');}
  }
  return structuredClone(item.job);
 }
 async submitCode(value:SubmitChannelLoginCodeInput):Promise<ChannelLogin>{
  const v=object(value);
  if(Object.keys(v).some(key=>!['channel','id','code'].includes(key)))throw safeError('INVALID_REQUEST','授权码参数无效');
  const item=this.ref({channel:v.channel as string,id:v.id as string});
  const b=this.selected(item.job.channel);
  if(item.engine!=='claude'||(b.engineKind??b.channel.engine)!=='claude'||item.job.status!=='authorizing'||!item.job.acceptsCode||!item.scope?.stdin||item.done||item.submitting||item.codeSubmitted)throw safeError('LOGIN_CODE_UNAVAILABLE','此登录当前不接受授权码');
  if(typeof v.code!=='string'||v.code.length>4096||! /^[\x21-\x22\x24-\x7e]+#[\x21-\x22\x24-\x7e]+$/.test(v.code))throw safeError('INVALID_REQUEST','请粘贴完整的官方授权码（含 # 后的部分），不能包含空格或换行，最多 4096 字符');
  item.submitting=true;
  try{
   await new Promise<void>((resolve,reject)=>{item.scope!.stdin!.write(v.code+'\n',error=>error?reject(error):resolve());});
   item.codeSubmitted=true;item.job.acceptsCode=false;
   return structuredClone(item.job);
  }catch{throw safeError('LOGIN_CODE_WRITE','授权码未能发送，请读取登录状态后重试');}
  finally{item.submitting=false;}
 }
 private fail(item:LoginWork,code:string,message:string):void{item.job.status='failed';item.job.error={code,message};}
 private stop(item:LoginWork):Promise<void>{
  if(!item.scope)return Promise.resolve();
  if(item.cleanup)return item.cleanup;
  item.cleanup=(async()=>{
   const scope=item.scope!;let timer:ReturnType<typeof setTimeout>|undefined;
   let killTimer:ReturnType<typeof setTimeout>|undefined;
   try{
    if(!item.done){scope.kill('SIGTERM');killTimer=setTimeout(()=>scope.kill('SIGKILL'),1500);}
    await Promise.race([item.closed,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(safeError('LOGIN_CLEANUP','无法确认登录进程已停止')),12000);})]);
   }finally{if(timer)clearTimeout(timer);if(killTimer)clearTimeout(killTimer);}

   if(await (this.options.confirmAbsent??confirmScopeAbsent)(scope.unit)!==true)throw safeError('LOGIN_CLEANUP','无法确认登录进程树已停止');
  })();return item.cleanup;
 }
 private async verify(engine:string,root:string,env:NodeJS.ProcessEnv,executable:string,item:LoginWork):Promise<boolean>{
  if(!nativeCredentialsReady(engine,{authDir:root},true))return false;
  if(engine==='opencode'){
   const helper=new OpenCodeAccounts({env});item.helper=helper;
   try{const snapshot=await helper.list();return snapshot.consoleManagedProviders.includes('opencode-go')&&snapshot.orgs.some(org=>org.active);}finally{await helper.close();item.helper=undefined;}
  }
  if(engine==='grok'){
   const credential=grokCredential(root);if(!credential)return false;
   // OIDC discovers the provider's own read-only identity endpoint; no model request is sent.
   const request=async(url:string,headers?:Record<string,string>)=>{
    const response=await fetch(url,{headers,redirect:'error',signal:AbortSignal.timeout(15000)});
    if(!response.ok||!response.body)throw 0;
    const reader=response.body.getReader();let data='';try{for(;;){const part=await reader.read();if(part.done)break;if(data.length+part.value.length>65536)throw 0;data+=Buffer.from(part.value).toString('utf8');}}finally{await reader.cancel().catch(()=>{});}return JSON.parse(data);
   };
   const discovery=await request('https://auth.x.ai/.well-known/openid-configuration');
   if(discovery.issuer!=='https://auth.x.ai')return false;
   const endpoint=new URL(discovery.userinfo_endpoint);
   if(endpoint.origin!=='https://auth.x.ai'||endpoint.username||endpoint.password||endpoint.hash||endpoint.search)return false;
   const identity=await request(endpoint.href,{authorization:`Bearer ${credential.token}`});return identity.sub===credential.subject;
  }
  const args=engine==='codex'?['login','status']:engine==='claude'?['auth','status','--json']:['--config-dir',root,'status','--output','json'];
  const r=await (this.options.capture??runCapture)(executable,args,15000,65536,env);
  if(r.code!==0||r.error||r.overflow||r.timedOut)return false;
  if(engine==='codex')return /logged in using chatgpt/i.test(r.stdout+'\n'+r.stderr);
  const status=JSON.parse(r.stdout);
  return engine==='claude'?status.loggedIn===true&&status.authMethod==='claude.ai'&&typeof status.email==='string':status.logged_in===true&&typeof (status.username??status.email)==='string';
 }
 private async run(item:LoginWork,b:ChannelBinding):Promise<void>{
  const {job}=item,engine=b.engineKind??b.channel.engine,root=b.secret.authDir!;item.engine=engine;
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{
   writeNativeConfig(root,'.weaver-login-pending','pending\n');
   const env=nativeEnvironment(engine,root,this.options.env??process.env);
   const executable=await (this.options.find??findEngineExecutable)(engine==='qoder'?'qodercli':engine,env.PATH??'');
   if(!executable)throw safeError('ENGINE_NOT_INSTALLED','未找到原生 CLI，请安装后重试');
   if(!active(job)||this.closing)return;
   const args=engine==='codex'?['login','--device-auth']:engine==='claude'?['auth','login','--claudeai']:engine==='grok'?['--leader-socket',join(root,'leader.sock'),'login','--device-auth']:engine==='opencode'?['console','login','https://opencode.ai/console','--pure']:['--config-dir',root,'login'];
   const scope=(this.options.start??startOwnedScope)({command:[executable,...args],cwd:root,env,stdin:null,keepStdinOpen:true,unit:`dev-weaver-channel-login-${randomUUID()}`});
   item.scope=scope;
   item.closed=new Promise(resolve=>{scope.on('error',()=>{this.fail(item,'LOGIN_PROCESS','原生登录启动失败，请检查 CLI 安装后重试');scope.kill('SIGKILL');});scope.once('close',(code:number|null)=>{item.done=true;resolve(code);});});
   let output='';let size=0;
   const read=(chunk:Buffer)=>{
    size+=chunk.length;if(size>128*1024){this.fail(item,'LOGIN_OUTPUT_LIMIT','原生登录输出超过上限，请重试');void this.stop(item).catch(()=>{});return;}
    output=(output+stripVTControlCharacters(chunk.toString())).slice(-8192);
    if(!active(job))return;
    for(const candidate of output.match(/https:\/\/[^\s<>"']+/g)??[]){const url=channelVerificationUrl(engine,candidate);if(url){job.verificationUrl=url;job.status='authorizing';}}
    // Native 0.164.0 prints a multiline label, including an expiry annotation.
    const code=engine==='grok'&&job.verificationUrl&&new URL(job.verificationUrl).pathname==='/oauth2/device'
     ? new URL(job.verificationUrl).searchParams.get('user_code')??undefined
     : output.match(/(?:2\. Enter this one-time code \(expires in 15 minutes\)|Enter (?:the )?code:|(?:user|device|verification) code:)[ \t]*\n?[ \t]*([A-Z0-9]{4,12}(?:-[A-Z0-9]{4,12})?)(?=\s)/i)?.[1];
    if(engine==='grok'&&job.verificationUrl)delete job.userCode;
    if(code&&/^[A-Z0-9]{4,12}(?:-[A-Z0-9]{4,12})?$/.test(code)&&job.verificationUrl)job.userCode=code;
    if(engine==='claude'&&job.verificationUrl&&!item.codeSubmitted){
     const url=new URL(job.verificationUrl);
     job.acceptsCode=url.pathname==='/cai/oauth/authorize'&&url.searchParams.get('redirect_uri')==='https://platform.claude.com/oauth/code/callback'&&/Paste code here(?: if prompted)? >/.test(output);
    }
   };
   scope.stdout.on('data',read);scope.stderr.on('data',read);
   timer=setTimeout(()=>{if(active(job)){this.fail(item,'LOGIN_TIMEOUT','登录超时，已停止原生登录；请重试或刷新账号状态');void this.stop(item).catch(()=>this.fail(item,'LOGIN_CLEANUP','无法确认登录进程已停止，请重新读取状态'));}},this.options.loginTimeoutMs??600000);
   const code=await item.closed;await this.stop(item);
   if(!active(job))return;
   if(code!==0)throw 0;
   job.status='verifying';
   const verified=await this.verify(engine,root,env,executable,item);
   if(!active(job))return;
   if(!verified){this.fail(item,'LOGIN_NOT_READY','未确认官方原生认证已就绪，请重试；若凭据已写入，请新建独立账号或检查认证是否过期');return;}
   rmSync(join(root,'.weaver-login-pending'),{force:true});
   job.status='succeeded';job.identity={label:`${engine==='qodercli'?'qoder':engine} 官方账号`};
  }catch(error){if(active(job)){if(error instanceof RpcError&&error.code==='ENGINE_NOT_INSTALLED')this.fail(item,error.code,error.message);else this.fail(item,'LOGIN_FAILED','原生登录未完成，请检查 CLI 与网络后重试');}}
  finally{
   if(timer)clearTimeout(timer);
   try{await this.stop(item);}catch{this.fail(item,'LOGIN_CLEANUP','无法确认登录进程树已停止，请重新读取状态');}
   item.finished=true;
  }
 }
 async close():Promise<void>{
  this.closing=true;
  await Promise.all([...this.jobs.values()].map(async item=>{if(active(item.job))await this.cancel({channel:item.job.channel,id:item.job.id});else await item.work;}));
  if([...this.jobs.values()].some(item=>item.job.error?.code==='LOGIN_CLEANUP'))throw safeError('LOGIN_CLEANUP','无法确认全部原生登录进程已停止');
 }
}
