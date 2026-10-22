import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, closeSync, fsyncSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { constants } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { TaskStore } from '../store';

/** The private file the CLI builds `--owner-file` from: no public owner field carries it. */
export interface OwnerCredentialFile { version:1; ownerId:string; token:string }
interface StoredDigest { version:1; ownerId:string; digest:string }
export class OwnerIdentityError extends Error {
 constructor(readonly code:'UNAUTHORIZED'|'PERSISTENCE_ERROR',message:string){super(message);}
}
const UUID=/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const TOKEN=/^[0-9a-f]{64}$/;
const DIGEST=/^[0-9a-f]{64}$/;
const MAX_CREDENTIAL_BYTES=4096;
const keyFor=(ownerId:string)=>`owner.credential.v1.${ownerId}`;
const hash=(token:string)=>createHash('sha256').update(token,'utf8').digest();
const sameDigest=(left:Buffer,right:Buffer)=>left.length===right.length&&timingSafeEqual(left,right);
const uid=()=>process.getuid?.();

/** The command context marker travels with the cloned args object and never enters JSON, receipts or queryable data. */
const OWNER_SCOPE=Symbol('weaver.ownerScope');
export function setOwnerScope(args:Record<string,unknown>,ownerId:string):void{Object.defineProperty(args,OWNER_SCOPE,{value:ownerId,enumerable:false});}
export function ownerScopeOf(args:Record<string,unknown>):string|undefined{return (args as Record<PropertyKey,unknown>)[OWNER_SCOPE] as string|undefined;}
export const ownerReceiptKey=(ownerId:string,commandId:string)=>`local-owner:${ownerId}:${commandId}`;

/** Server-managed credentials for explicit owner command context. The digest lives in the existing kv store; the token only in its private file. */
export class OwnerIdentity {
 readonly directory:string;
 constructor(private readonly store:TaskStore){this.directory=resolve(dirname(store.path),'owner-credentials');}
 credentialPath(ownerId:string):string{return join(this.directory,`${ownerId}.json`);}
 /** Reuses a valid credential across repeated attaches and restarts, otherwise atomically writes a fresh private one. */
 ensure(ownerId:string):OwnerCredentialFile & {credentialPath:string}{
  if(!UUID.test(ownerId))throw new OwnerIdentityError('PERSISTENCE_ERROR','Invalid owner ID for a credential file');
  const path=this.credentialPath(ownerId);
  const stored=this.store.getValue<StoredDigest>(keyFor(ownerId));
  const existing=this.readFile(path);
  if(stored&&this.validDigest(stored,ownerId)&&existing&&existing.ownerId===ownerId&&sameDigest(hash(existing.token),Buffer.from(stored.digest,'hex'))){
   this.privateDirectory();
   return {...existing,credentialPath:path};
  }
  const token=randomBytes(32).toString('hex');
  const value:OwnerCredentialFile={version:1,ownerId,token};
  this.privateDirectory();
  this.writeFile(path,value);
  this.store.putValue(keyFor(ownerId),{version:1,ownerId,digest:hash(token).toString('hex')} satisfies StoredDigest);
  return {...value,credentialPath:path};
 }
 /** A malformed, missing or mismatched credential is always an authentication failure; it never falls back to the local administrator. */
 verify(ownerIdValue:unknown,tokenValue:unknown):string{
  if(typeof ownerIdValue!=='string'||!UUID.test(ownerIdValue)||typeof tokenValue!=='string'||!TOKEN.test(tokenValue))throw new OwnerIdentityError('UNAUTHORIZED','Owner credentials are invalid');
  const ownerId=ownerIdValue;
  const stored=this.store.getValue<StoredDigest>(keyFor(ownerId));
  if(!stored||!this.validDigest(stored,ownerId))throw new OwnerIdentityError('UNAUTHORIZED','Owner credentials are invalid');
  const file=this.readFile(this.credentialPath(ownerId));
  if(!file||file.ownerId!==ownerId||!TOKEN.test(file.token))throw new OwnerIdentityError('UNAUTHORIZED','Owner credentials are invalid');
  const expected=Buffer.from(stored.digest,'hex');
  const presented=hash(tokenValue);
  const persisted=hash(file.token);
  if(!sameDigest(expected,presented)||!sameDigest(persisted,presented))throw new OwnerIdentityError('UNAUTHORIZED','Owner credentials are invalid');
  return ownerId;
 }
 private validDigest(value:StoredDigest,ownerId:string):boolean{return value.version===1&&value.ownerId===ownerId&&typeof value.digest==='string'&&DIGEST.test(value.digest);}
 private privateDirectory():void{
  mkdirSync(this.directory,{recursive:true,mode:0o700});
  const info=lstatSync(this.directory);
  if(!info.isDirectory()||info.isSymbolicLink()||(uid()!==undefined&&info.uid!==uid()))throw new OwnerIdentityError('PERSISTENCE_ERROR','Owner credential directory is unsafe');
  if((info.mode&0o777)!==0o700)chmodSync(this.directory,0o700);
 }
 /** Same private-file boundary as readPrivateFile, synchronously because command handlers are synchronous. */
 private readFile(path:string):OwnerCredentialFile|undefined{
  let fd:number|undefined;
  try{
   fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
   const info=fstatSync(fd);
   if(!info.isFile()||(uid()!==undefined&&info.uid!==uid())||(info.mode&0o077)!==0||info.size>MAX_CREDENTIAL_BYTES)return undefined;
   const parsed=JSON.parse(readFileSync(fd,'utf8')) as Partial<OwnerCredentialFile>;
   if(!parsed||parsed.version!==1||typeof parsed.ownerId!=='string'||!UUID.test(parsed.ownerId)||typeof parsed.token!=='string'||!TOKEN.test(parsed.token))return undefined;
   return {version:1,ownerId:parsed.ownerId,token:parsed.token};
  }catch{return undefined;}
  finally{if(fd!==undefined)try{closeSync(fd);}catch{}}
 }
 private writeFile(path:string,value:OwnerCredentialFile):void{
  const temporary=join(this.directory,`.${value.ownerId}.${randomBytes(8).toString('hex')}.tmp`);
  let fd:number|undefined;
  try{
   fd=openSync(temporary,'wx',0o600);
   writeFileSync(fd,JSON.stringify(value));
   fsyncSync(fd);
   closeSync(fd);fd=undefined;
   renameSync(temporary,path);
   chmodSync(path,0o600);
  }catch(error){
   if(fd!==undefined)try{closeSync(fd);}catch{}
   try{unlinkSync(temporary);}catch{}
   throw error instanceof OwnerIdentityError?error:new OwnerIdentityError('PERSISTENCE_ERROR',`Could not write the owner credential file: ${error instanceof Error?error.message:String(error)}`);
  }
 }
}
