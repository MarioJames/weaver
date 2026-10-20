import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JsonlParser } from '../src/main/protocol';
import { parseTaskInput, parseWorkerRecord, parseId } from '../src/shared/validation';
import type { WorkerRecord } from '../src/shared/contracts/tasks';
test('JSONL survives fragmented UTF-8, CRLF, blank lines, and final unterminated record',() => {
 const records: WorkerRecord[]=[]; const parser=new JsonlParser(record => records.push(record));
 const buffer=Buffer.from('\n'+JSON.stringify({type:'log',message:'你好 👋'})+'\r\n'+JSON.stringify({type:'result',summary:'done'}));
 for (const byte of buffer) parser.push(Buffer.from([byte])); parser.finish();
 assert.deepEqual(records,[{type:'log',message:'你好 👋'},{type:'result',summary:'done'}]);
});
test('rejects malformed, unknown, invalid, and oversized records',() => {
 for (const line of ['{broken}',JSON.stringify({type:'unknown'}),JSON.stringify({type:'progress',percent:101,message:'x'})]) assert.throws(() => new JsonlParser(() => {}).push(Buffer.from(line+'\n')));
 assert.throws(() => new JsonlParser(() => {}).push(Buffer.alloc(129*1024,65)),/128 KiB/);
 assert.throws(() => new JsonlParser(() => {}).push(Buffer.alloc(3*1024*1024)),/2 MiB/);
 assert.throws(() => {const p=new JsonlParser(() => {}); p.push(Buffer.from((JSON.stringify({type:'log',message:''})+'\n').repeat(1001)));},/1000/);
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
