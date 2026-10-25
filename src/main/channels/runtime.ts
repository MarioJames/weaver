import { nativeCredentialsReady, nativeEnvironment, channelEnvironment } from './native';
import { qoderApiModels } from './qoder';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync, rmSync, renameSync, lstatSync } from 'node:fs';
import { join, isAbsolute, basename } from 'node:path';
import type { Channel, ChannelSecret } from '../../shared/contracts/channels';

export interface ChannelBinding { channel: Channel; secret: ChannelSecret; /** Resolved policy engine kind (channel.engine may be an alias). */ engineKind?: string }
export interface ChannelRun { allowedModels?: string[]; channelStateDir: string; channelProfilePath?: string; env: NodeJS.ProcessEnv; configFiles: string[]; argv: string[] }
export { CHANNEL_AUTH_ENV_PATTERNS, channelEnvironment, isChannelCredentialVariable } from './native';
export function cleanupChannelRun(run: {channelStateDir?:string;channelProfilePath?:string}): void {
 if(run.channelProfilePath&&/^weaver-channel-[a-zA-Z0-9_-]+\.config\.toml$/.test(basename(run.channelProfilePath)))rmSync(run.channelProfilePath,{force:true});
 if(run.channelStateDir&&/^channel-[a-zA-Z0-9_-]+$/.test(basename(run.channelStateDir)))rmSync(run.channelStateDir,{recursive:true,force:true});
}
const scalar = (value: string) => JSON.stringify(value);
/** The same native patch contract applies at save and at launch. */
export function parseDshConfig(config: string): unknown[] {
 let patch:unknown;try{patch=parseYaml(config,{logLevel:'error'});}catch{throw new Error('dsh 渠道 YAML 配置无法解析');}
 if(!Array.isArray(patch))throw new Error('dsh 原生配置必须是 patch 列表');
 return patch;
}

function toml(text: string | undefined): Record<string, any> {
 if(!text)return {};try{return parseToml(text);}catch{throw new Error('渠道原生 TOML 配置无法解析，请修正后重试');}
}
function json(text: string | undefined): Record<string, any> {
 if (!text) return {};
 try { const value = JSON.parse(text); if (!value || typeof value !== 'object' || Array.isArray(value)) throw 0; return value; }
 catch { throw new Error('渠道原生 JSON 配置无法解析，请修正后重试'); }
}
/** Compiles credentials only into private native files. Never return secrets in argv. */
export function prepareChannelRun(input: ChannelBinding & { model: string; purpose?: 'models'|'quota'; stateDir: string; env?: NodeJS.ProcessEnv }): ChannelRun {
 const { channel: c, secret: s } = input;
 const engine = input.engineKind ?? c.engine;
 if (!c.enabled) throw new Error('渠道已停用');
 if ((engine === 'pi' || engine === 'dsh') && c.kind !== 'api') throw new Error('该引擎仅支持 API 渠道');
 if(c.kind==='subscription'&&!nativeCredentialsReady(engine,s))throw new Error('官方账号认证目录缺失、凭据未就绪或已过期，请在账号页新建独立账号登录后重试');
 mkdirSync(input.stateDir, { recursive: true, mode: 0o700 });
 const run = mkdtempSync(join(input.stateDir, 'channel-')); chmodSync(run, 0o700);
 const env = channelEnvironment(input.env ?? process.env);
 const files: string[] = [];
 const put = (name: string, body: string) => { const file = join(run, name); writeFileSync(file, body, { mode: 0o600 }); chmodSync(file, 0o600); files.push(file); return file; };
 const root = c.kind === 'subscription' || engine==='qoder' || engine==='qodercli' ? s.authDir : run;
 if (!root || !isAbsolute(root) || !existsSync(root) || !lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink()) throw new Error('渠道缺少可用的独立认证目录，请重新导入或登录');
 if (c.kind === 'api' && !s.apiKey && !s.config && !(s.authDir && (engine==='qoder'||engine==='qodercli'))) throw new Error('API 渠道缺少凭据或原生配置，请配置后重试');
 Object.assign(env,nativeEnvironment(engine,root,env));
 const argv: string[] = [];
 let channelProfilePath:string|undefined;let allowedModels:string[]|undefined;
 switch (engine) {
  case 'codex': {
   env.CODEX_HOME = root;
   const config = toml(s.config);
   if (c.kind === 'subscription') {
    if (!existsSync(join(root, 'auth.json'))) throw new Error('Codex 渠道未导入文件认证；keyring 登录需重新认证');
    if(config.model_provider && config.model_provider!=='openai')throw new Error('官方订阅渠道不能使用第三方 model_provider，请创建 API 渠道');
    config.model_provider='openai';config.cli_auth_credentials_store='file';config.forced_login_method='chatgpt';
    if(input.purpose==='models')break;
    const profile=`weaver-${basename(run)}`;
    const file=join(root,`${profile}.config.toml`);writeFileSync(file,stringifyToml(config),{mode:0o600});chmodSync(file,0o600);files.push(file);channelProfilePath=file;argv.push('--profile',profile);
    break;
   }
   if(c.protocol==='anthropic'||c.protocol==='openai')throw new Error('Codex API 渠道需要 OpenAI Responses 协议');
   const provider = c.provider ?? config.model_provider ?? 'weaver';
   config.model_provider=provider;config.model=input.model;
   const definition={...config.model_providers?.[provider],name:config.model_providers?.[provider]?.name??provider,...(c.baseUrl?{base_url:c.baseUrl}:{}),wire_api:'responses',requires_openai_auth:false,...(s.apiKey?{experimental_bearer_token:s.apiKey}:{})};
   if(!definition.base_url)definition.base_url='https://api.openai.com/v1';
   if(s.apiKey)delete definition.env_key;
   config.model_providers={[provider]:definition};
   put('config.toml',stringifyToml(config));put('auth.json','{}');break;
  }
  case 'claude': {
   env.CLAUDE_CONFIG_DIR = root;
   const config = json(s.config);
   if (c.kind === 'subscription') {
    if (!existsSync(join(root, '.credentials.json'))) throw new Error('Claude 渠道需在独立目录登录；无法复制系统 keychain');
    if(config.env?.ANTHROPIC_API_KEY||config.env?.ANTHROPIC_AUTH_TOKEN||config.env?.ANTHROPIC_BASE_URL)throw new Error('官方订阅渠道不能带第三方 API 认证设置');
   } else config.env = { ...config.env, ...(s.apiKey ? { ANTHROPIC_API_KEY: s.apiKey } : {}), ...(c.baseUrl ? { ANTHROPIC_BASE_URL: c.baseUrl } : {}) };
   argv.push('--settings', put('settings.json', JSON.stringify(config)), '--setting-sources', ''); break;
  }
  case 'grok': {
   env.GROK_HOME = root; argv.push('--leader-socket',join(root,'leader.sock'));
   const config=toml(s.config);
   if (c.kind === 'subscription') {
    if (!existsSync(join(root, 'auth.json'))) throw new Error('Grok 渠道缺少官方认证');
    if(Object.values(config.model??{}).some((model:any)=>model.env_key||model.base_url))throw new Error('官方 Grok 订阅渠道不能带 API 路由设置');
    const file=join(root,'config.toml');const staged=join(root,`${basename(run)}.config.tmp`);writeFileSync(staged,stringifyToml(config),{mode:0o600});chmodSync(staged,0o600);renameSync(staged,file);files.push(file);break;
   }
   if (s.apiKey) env.WEAVER_CHANNEL_KEY = s.apiKey;
   config.models={...config.models,default:input.model};
   const definition={...config.model?.[input.model],model:config.model?.[input.model]?.model??input.model,...(s.apiKey?{env_key:'WEAVER_CHANNEL_KEY'}:{}),...(c.baseUrl?{base_url:c.baseUrl}:{}),api_backend:c.protocol?(c.protocol==='anthropic'?'messages':c.protocol==='openai-responses'?'responses':'chat_completions'):(config.model?.[input.model]?.api_backend??'chat_completions')};
   if(!definition.base_url)definition.base_url='https://api.x.ai/v1';
   config.model={[input.model]:definition};
   put('config.toml',stringifyToml(config));break;
  }
  case 'qoder': case 'qodercli': {
   env.QODER_CONFIG_DIR = root; argv.push('--config-dir', root);
   if(!existsSync(join(root,'.auth','user'))&&!existsSync(join(root,'.models')))throw new Error('Qoder 渠道需导入原生登录或 /model 向导创建的 BYOK 配置');
   if(c.kind==='api'){allowedModels=qoderApiModels(root);if(input.purpose!=='models'&&!allowedModels.includes(input.model))throw new Error('Qoder API 渠道仅允许已验证的原生 BYOK modelID；auto 和官方订阅模型不能使用该渠道');}
   if(s.config)argv.push('--settings',put('settings.json',JSON.stringify(json(s.config))));
   break;
  }
  case 'opencode': {
   for (const [key, dir] of Object.entries({ XDG_CONFIG_HOME: 'config', XDG_DATA_HOME: 'data', XDG_STATE_HOME: 'state', XDG_CACHE_HOME: 'cache' })) { env[key] = join(root, dir); mkdirSync(env[key]!, { recursive: true, mode: 0o700 }); }
   env.OPENCODE_DB = join(root, 'opencode.db');
   env.OPENCODE_CONFIG_DIR = run;
   env.OPENCODE_DISABLE_PROJECT_CONFIG = '1';
   const config = json(s.config);
   if (c.kind === 'api') config.enabled_providers = [c.provider ?? input.model.split('/')[0]!];
   if (c.kind === 'api' && s.apiKey) { const provider = c.provider ?? input.model.split('/')[0]!; config.provider = { ...config.provider, [provider]: { ...config.provider?.[provider], npm: config.provider?.[provider]?.npm ?? (c.protocol === 'anthropic' ? '@ai-sdk/anthropic' : c.protocol === 'openai-responses' ? '@ai-sdk/openai' : '@ai-sdk/openai-compatible'), options: { ...config.provider?.[provider]?.options, apiKey: s.apiKey, ...(c.baseUrl ? { baseURL: c.baseUrl } : {}) } } }; }
   if(c.kind==='api'&&input.purpose!=='models'){
    const provider=c.provider??input.model.split('/')[0]!;const model=input.model.startsWith(`${provider}/`)?input.model.slice(provider.length+1):input.model;
    config.provider??={};config.provider[provider]??={};config.provider[provider].models={...config.provider[provider].models,[model]:config.provider[provider].models?.[model]??{name:model}};
   }
   env.OPENCODE_CONFIG = put('opencode.json', JSON.stringify(config).replace(/\{(?=(?:env|file):)/g,'\\u007b'));
   if (c.kind === 'api') env.OPENCODE_AUTH_CONTENT = '{}';
   else if (!existsSync(env.OPENCODE_DB)) throw new Error('OpenCode 渠道缺少持久官方账号数据库，请重新导入');
   break;
  }
  case 'pi': {
   env.PI_CODING_AGENT_DIR = root;
   const config = json(s.config);
   if (s.apiKey) { const provider = c.provider ?? input.model.split('/')[0]!; config.providers = { ...config.providers, [provider]: { ...config.providers?.[provider], baseUrl: c.baseUrl ?? config.providers?.[provider]?.baseUrl, api: c.protocol ? (c.protocol === 'anthropic' ? 'anthropic-messages' : c.protocol === 'openai-responses' ? 'openai-responses' : 'openai-completions') : (config.providers?.[provider]?.api ?? 'openai-completions'), apiKey: s.apiKey.replaceAll('$',()=> '$$').replace(/^!/, '$!'), models: config.providers?.[provider]?.models ?? (input.purpose==='models'?[]:[{ id: input.model.replace(`${provider}/`, ''), name: input.model }]) } }; }
   put('models.json', JSON.stringify(config)); put('auth.json', '{}'); break;
  }
  case 'dsh': {
   env.DSH_HOME = root;
   if(!s.apiKey)throw new Error('dsh 渠道缺少独立 API key，请导入原生凭据后重试');
   if (c.provider && c.provider !== 'deepseek' && c.provider !== 'deepseek-official') throw new Error('dsh 目前仅接入 deepseek-official 原生 API provider');
   if (c.protocol && c.protocol !== 'anthropic') throw new Error('dsh deepseek-official 仅支持 Anthropic Messages 协议');
   if (s.config) { const patch=parseDshConfig(s.config);argv.push('--patch', put('channel.yml', stringifyYaml(patch))); }
   if (s.apiKey) {
    const credential = put('.credentials.yaml', `version: 1\nrefs:\n  DEEPSEEK_API_KEY: ${scalar(s.apiKey)}\nrecords: {}\n`);
    argv.push('--patch', put('credentials.yml', `- id: credentials\n  disabled: false\n  config:\n    path: ${scalar(credential)}\n- id: llm-deepseek\n  config:\n    apiKeyEnv: DEEPSEEK_API_KEY\n    baseURL: ${scalar(c.baseUrl ?? 'https://api.deepseek.com/anthropic')}\n`));
   }
   break;
  }
  default: throw new Error('该渠道引擎尚未接入配置覆写');
 }
 return { ...(allowedModels?{allowedModels}:{}),channelStateDir:run,...(channelProfilePath?{channelProfilePath}:{}),env, configFiles: files, argv };
}
