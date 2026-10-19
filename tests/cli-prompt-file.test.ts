import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startOwnedScope } from '../src/main/adapters/cli/scope';
import { startCliAgent } from '../src/main/adapters/cli';

test('read-only prompt descriptor delivers full unicode stdin to a child',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'weaver-prompt-'));const previous=process.env.PATH;
 writeFileSync(join(dir,'systemd-run'),'#!/bin/sh\nwhile [ "$1" != "--" ]; do shift; done\nshift\nexec "$@"\n',{mode:0o700});
 writeFileSync(join(dir,'systemctl'),'#!/bin/sh\necho ActiveState=inactive\n',{mode:0o700});
 process.env.PATH=dir+':'+previous;
 const prompt='完整提示\\n\n'+ '你好🌍\n'.repeat(10000);const promptPath=join(dir,'prompt.txt');writeFileSync(promptPath,prompt,{mode:0o600});
 try{
 const result=join(dir,'received');
 const scope=startOwnedScope({command:[process.execPath,'-e',`require('fs').writeFileSync(${JSON.stringify(result)},require('fs').readFileSync(0))`],cwd:dir,env:{...process.env},stdin:prompt,stdinPath:promptPath,unit:'weaver-cli-fake-prompt'});
 const errors:unknown[]=[];scope.on('error',e=>errors.push(e));
 const code=await new Promise(resolve=>scope.once('close',resolve));assert.equal(code,0);assert.deepEqual(errors,[]);assert.equal(readFileSync(result,'utf8'),prompt);
 assert.throws(()=>startOwnedScope({command:['unused'],cwd:dir,env:{},stdin:'x',stdinPath:join(dir,'missing'),unit:'unused'}),/Prompt delivery failed/);
 }finally{process.env.PATH=previous;rmSync(dir,{recursive:true,force:true});}
});

test('qoder fake emits first-output only after a normalized vendor event',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'weaver-qoder-'));const previous=process.env.PATH;
 writeFileSync(join(dir,'systemd-run'),'#!/bin/sh\nwhile [ "$1" != "--" ]; do shift; done\nshift\nexec "$@"\n',{mode:0o700});
 writeFileSync(join(dir,'systemctl'),'#!/bin/sh\necho ActiveState=inactive\n',{mode:0o700});
 writeFileSync(join(dir,'qodercli'),`#!${process.execPath}\nconst fs=require('fs');fs.writeFileSync(${JSON.stringify(join(dir,'received'))},fs.readFileSync(0));fs.writeFileSync(1,JSON.stringify({type:'error',message:'fixture vendor error'})+'\\n');process.exitCode=42;`,{mode:0o700});
 process.env.PATH=dir+':'+previous;
 try{
 const agent=startCliAgent({engine:'qodercli',model:'fixture',effort:'high',workspace:dir,stateDir:join(dir,'state'),instruction:'完整 frozen prompt'});
 let first=0;let error='';agent.on('error',()=>{});agent.on('first-output',()=>first++);agent.on('vendor-error',message=>error=message);
 assert.equal(first,0);await new Promise(resolve=>agent.once('close',resolve));assert.equal(first,1);assert.match(error,/fixture vendor error/);assert.equal(readFileSync(join(dir,'received'),'utf8'),'完整 frozen prompt');
 }finally{process.env.PATH=previous;rmSync(dir,{recursive:true,force:true});}
});

test('unterminated stderr limit is detected before child exit and secrets are redacted',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'weaver-stderr-'));const previous=process.env.PATH;
 writeFileSync(join(dir,'systemd-run'),'#!/bin/sh\nwhile [ "$1" != "--" ]; do shift; done\nshift\nexec "$@"\n',{mode:0o700});
 writeFileSync(join(dir,'systemctl'),'#!/bin/sh\necho ActiveState=inactive\n',{mode:0o700});
 writeFileSync(join(dir,'qodercli'),`#!${process.execPath}\nconst fs=require('fs');fs.readFileSync(0);fs.writeFileSync(2,'Rate limit exceeded api_key=fixture-secret-value');setTimeout(()=>process.exit(42),80);`,{mode:0o700});
 process.env.PATH=dir+':'+previous;
 try{
 const agent=startCliAgent({engine:'qodercli',model:'fixture',effort:'high',workspace:dir,stateDir:join(dir,'state'),instruction:'fixture'});
 let closed=false;let observed=false;agent.on('error',()=>{});agent.on('close',()=>closed=true);
 agent.on('vendor-error',(message,failure)=>{assert.equal(closed,false);assert.equal(failure.kind,'rate_limit');assert.doesNotMatch(message,/fixture-secret-value/);observed=true;});
 await new Promise(resolve=>agent.once('close',resolve));assert.equal(observed,true);
 }finally{process.env.PATH=previous;rmSync(dir,{recursive:true,force:true});}
});
