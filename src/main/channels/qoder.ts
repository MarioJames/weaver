import { createHash } from 'node:crypto';
import { lstatSync,readFileSync,readdirSync,existsSync } from 'node:fs';
import { join } from 'node:path';
export const QODER_BYOK_MANIFEST='.weaver-byok-models.json';
const MAX_BYTES=8*1024*1024;
/** Preserve native encrypted caches; never try to decrypt or interpret their payload. */
export function qoderModelFiles(source:string):Record<string,Buffer>{
 const result:Record<string,Buffer>={};let total=0;
 const visit=(relative:string,depth:number)=>{
  const path=join(source,relative);const stat=lstatSync(path);
  if(stat.isSymbolicLink())throw new Error('Qoder 模型目录不能包含符号链接');
  if(stat.isDirectory()){if(depth>2)throw new Error('Qoder 模型目录层级不受支持');for(const name of readdirSync(path))visit(`${relative}/${name}`,depth+1);return;}
  if(!stat.isFile()||stat.size>MAX_BYTES||Object.keys(result).length>=200||(total+=stat.size)>16*1024*1024)throw new Error('Qoder 原生模型材料超出安全复制范围');
  result[relative]=readFileSync(path);
 };
 if(existsSync(join(source,'.models')))visit('.models',0);
 return result;
}
/** Native 1.1.75 prints non-system model IDs in final parentheses; keys >40 chars are truncated. */
export function qoderApiModelDifference(full:string,baseline:string):string[]{
 const before=new Set(baseline.split(/\r?\n/).map(line=>line.trim()));const ids=new Set<string>();
 for(const line of full.split(/\r?\n/).map(line=>line.trim())){
  if(before.has(line)||line==='MODEL'||!line)continue;
  const match=/\(([^()\s]+)\)$/.exec(line);
  if(!match||match[1]!.includes('…')||!(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/).test(match[1]!))throw new Error('Qoder 原生 BYOK modelID 无法完整验证，请用 /model 检查自定义模型后重新导入');
  ids.add(match[1]!);
 }
 return [...ids];
}
export function qoderModelManifest(models:string[],files:Record<string,Buffer>):string{
 return JSON.stringify({models,files:Object.entries(files).filter(([path])=>path.endsWith('/customs')||path==='.auth/machine_id').map(([path,body])=>({path,hash:createHash('sha256').update(body).digest('hex')}))});
}
export function qoderApiModels(root:string):string[]{
 const file=join(root,QODER_BYOK_MANIFEST);
 if(!existsSync(file))throw new Error('Qoder API 渠道尚未验证原生 BYOK modelID，请完成 /model 向导后重新导入');
 const info=lstatSync(file);if(!info.isFile()||info.isSymbolicLink()||info.size>128*1024)throw new Error('Qoder API 模型清单不可用，请重新导入');
 let manifest:any;try{manifest=JSON.parse(readFileSync(file,'utf8'));}catch{throw new Error('Qoder API 模型清单无法解析，请重新导入');}
 if(!Array.isArray(manifest.models)||!manifest.models.length||manifest.models.some((model:unknown)=>typeof model!=='string'||!(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/).test(model)))throw new Error('Qoder 原生 BYOK 尚未验证，请完成 /model 向导后重新导入');
 if(!Array.isArray(manifest.files)||!manifest.files.some((entry:any)=>typeof entry?.path==='string'&&entry.path.endsWith('/customs')))throw new Error('Qoder 原生 BYOK 文件清单不可用');
 for(const entry of manifest.files){
  if(typeof entry.path!=='string'||!(entry.path==='.auth/machine_id'||/^\.models\/[A-Za-z0-9_-]+\/customs$/.test(entry.path)))throw new Error('Qoder BYOK 文件身份不可用');
  const path=join(root,entry.path);if(!existsSync(path))throw new Error('Qoder BYOK 材料已变化，请重新导入');const stat=lstatSync(path);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>MAX_BYTES||createHash('sha256').update(readFileSync(path)).digest('hex')!==entry.hash)throw new Error('Qoder BYOK 材料已变化，请重新导入');
 }
 return manifest.models;
}
