import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JsonlParser } from '../../src/main/protocol';
import { parseTaskInput, parseWorkerRecord, parseId } from '../../src/shared/validation';
import type { WorkerRecord } from '../../src/shared/contracts/tasks';
test('JSONL survives fragmented UTF-8, CRLF, blank lines, and final unterminated record',() => {
 const records: WorkerRecord[]=[]; const parser=new JsonlParser(record => records.push(record));
 const buffer=Buffer.from('\n'+JSON.stringify({type:'log',message:'你好 👋'})+'\r\n'+JSON.stringify({type:'result',summary:'done'}));
 for (const byte of buffer) parser.push(Buffer.from([byte])); parser.finish();
 assert.deepEqual(records,[{type:'log',message:'你好 👋'},{type:'result',summary:'done'}]);
});
test('rejects malformed, unknown, invalid, and oversized lines',() => {
  for (const line of ['{broken}',JSON.stringify({type:'unknown'}),JSON.stringify({type:'progress',percent:101,message:'x'})]) assert.throws(() => new JsonlParser(() => {}).push(Buffer.from(line+'\n')));
  assert.throws(() => new JsonlParser(() => {}).push(Buffer.alloc(129*1024,65)),/128 KiB/);
});
test('volume is unbounded at the parser: 5000 records and multi-MiB output are accepted',() => {
  const records: WorkerRecord[]=[]; const parser=new JsonlParser(record => records.push(record));
  const line=JSON.stringify({type:'log',message:'x'.repeat(500)})+'\n';
  let bytes=0;
  for(let i=0;i<5000;i++){const chunk=Buffer.from(line);bytes+=chunk.length;parser.push(chunk);}
  assert.ok(bytes>2*1024*1024,`cumulative ${bytes} bytes must exceed the old 2 MiB cap`);
  parser.push(Buffer.from(JSON.stringify({type:'result',summary:'done'})+'\n')); parser.finish();
  assert.equal(records.length,5001); assert.deepEqual(records.at(-1),{type:'result',summary:'done'});
});
test('rejects traversal and unsupported artifact types; preserves text as text',() => {
 for (const name of ['../secret','a/b','a\\b','..','\u0000']) assert.throws(() => parseWorkerRecord({type:'artifact',name,mediaType:'text/plain',content:''}));
 assert.throws(() => parseWorkerRecord({type:'artifact',name:'a.html',mediaType:'text/html',content:'<script/>'}));
 assert.equal(parseWorkerRecord({type:'artifact',name:'safe.txt',mediaType:'text/plain',content:'<script/>'}).type,'artifact');
});
test('validates inputs and task IDs at boundary',() => {
 assert.throws(() => parseTaskInput({title:'',instruction:'x',owner:{}}));
 assert.throws(() => parseId('../../anything'));
 assert.throws(() => parseTaskInput({title:'x',instruction:'y',owner:{name:'x',session:'main',pane:'1',transport:'hidden'}}));
});
test('ID validation errors name the field: missing IDs and non-UUIDs are reported per field',() => {
 assert.throws(() => parseId(undefined),/Missing task ID/);
 assert.throws(() => parseId(''),/Missing task ID/);
 assert.throws(() => parseId('   '),/Missing task ID/);
 assert.throws(() => parseId('../../anything'),/^Error: Invalid task ID: expected a UUID$/);
 assert.throws(() => parseId('a'.repeat(40)),/Invalid task ID: expected a UUID/);
 assert.throws(() => parseId(123),/Invalid task ID: expected a UUID/);
 assert.throws(() => parseId(undefined,'owner ID'),/Missing owner ID/);
 assert.throws(() => parseId('','owner ID'),/Missing owner ID/);
 assert.throws(() => parseId('nope','owner ID'),/^Error: Invalid owner ID: expected a UUID$/);
 assert.throws(() => parseId(undefined,'package ID'),/Missing package ID/);
 assert.throws(() => parseId('zzz','package ID'),/^Error: Invalid package ID: expected a UUID$/);
 assert.throws(() => parseId(undefined,'artifact ID'),/Missing artifact ID/);
 assert.throws(() => parseId('zzz','artifact ID'),/Invalid artifact ID: expected a UUID/);
 assert.throws(() => parseId(undefined,'parent task ID'),/Missing parent task ID/);
 assert.throws(() => parseId('zzz','parent task ID'),/Invalid parent task ID: expected a UUID/);
 // A missing owner reference in tasks.create input names the owner field instead of a generic object error,
 // and owner:null (typeof null === 'object') is a missing reference too, never a TypeError.
 assert.throws(() => parseTaskInput({title:'x',instruction:'y'}),/Missing owner ID/);
 assert.throws(() => parseTaskInput({title:'x',instruction:'y',owner:null}),/^Error: Missing owner ID: pass ownerId, ownerProfileId, parentTaskId, or an owner object$/);
});
