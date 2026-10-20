import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MockOwnerHostAdapter } from '../../src/main/adapters/logical';
const input = {ownerId:'owner-1',name:'Demo owner',profileId:'demo'};

test('mock owner lifecycle exposes truthful identity and acknowledgment ownership', () => {
 const adapter = new MockOwnerHostAdapter();
 const host = adapter.spawn(input);
 assert.equal(host.visibility,'logical-demo');assert.equal(host.verified,false);assert.equal(host.ownsHost,true);
 assert.equal(host.session,undefined);
 const message=adapter.send(input.ownerId,'Review this result');
 const result=adapter.deliverResult(input.ownerId,{taskId:'task-1',manifestDigest:'sha256:fixture'});
 assert.equal(message.transport,'mock-memory');assert.equal(result.kind,'result');
 adapter.spawn({...input,ownerId:'owner-2'});
 assert.throws(()=>adapter.acknowledge('owner-2',result.id),/belong/);
 const ack=adapter.acknowledge(input.ownerId,result.id);
 assert.equal(ack.status,'acknowledged');assert.deepEqual(adapter.acknowledge(input.ownerId,result.id),ack);
 assert.equal(adapter.inspect(input.ownerId).messages[0].status,'delivered');
 assert.equal(adapter.close(input.ownerId).state,'closed');
 assert.deepEqual(adapter.close(input.ownerId),adapter.inspect(input.ownerId).host);
 assert.throws(()=>adapter.send(input.ownerId,'late'),/closed/);
 assert.throws(()=>adapter.acknowledge(input.ownerId,message.id),/closed/);
 assert.throws(()=>adapter.deliverResult(input.ownerId,{taskId:'task-2',manifestDigest:'digest'}),/closed/);
});

test('manual owner attachment cannot claim transport or control of external host', () => {
 const adapter=new MockOwnerHostAdapter();
 const host=adapter.attach({...input,session:'existing-visible',pane:'pane-1'});
 assert.equal(host.visibility,'external-unverified');assert.equal(host.verified,false);assert.equal(host.ownsHost,false);
 assert.equal(host.mode,'manual');assert.equal(host.state,'attached');
 assert.throws(()=>adapter.send(input.ownerId,'hello'),/unavailable/);
 assert.throws(()=>adapter.deliverResult(input.ownerId,{taskId:'task-1',manifestDigest:'digest'}),/unavailable/);
 assert.equal(adapter.close(input.ownerId).ownsHost,false);
});

test('owner state is isolated and validation fails before mutation', () => {
 const adapter=new MockOwnerHostAdapter();
 assert.throws(()=>adapter.spawn({...input,name:' '}),/required/);
 assert.throws(()=>adapter.attach({...input,session:'',pane:'1'}),/required/);
 const host=adapter.spawn(input);host.state='closed';
 assert.equal(adapter.inspect(input.ownerId).host.state,'ready');
 assert.throws(()=>adapter.spawn(input),/already exists/);
 assert.throws(()=>adapter.close('missing'),/Unknown owner/);
 assert.throws(()=>adapter.send(input.ownerId,''),/required/);
 const message=adapter.send(input.ownerId,'original');message.status='acknowledged';
 const snapshot=adapter.inspect(input.ownerId);snapshot.messages[0].message='modified';snapshot.messages.length=0;
 assert.equal(adapter.inspect(input.ownerId).messages[0].message,'original');
 assert.equal(adapter.inspect(input.ownerId).messages[0].status,'delivered');
});

test('restored host and inbox preserve acknowledgment and have no aliases', () => {
 const original=new MockOwnerHostAdapter();original.spawn(input);
 const delivery=original.deliverResult(input.ownerId,{taskId:'task-1',manifestDigest:'digest'});
 original.acknowledge(input.ownerId,delivery.id);
 const snapshot=original.inspect(input.ownerId);
 const restored=new MockOwnerHostAdapter();restored.restore(snapshot.host,snapshot.messages);
 assert.deepEqual(restored.inspect(input.ownerId),snapshot);
 snapshot.host.name='changed';snapshot.messages[0].manifestDigest='changed';snapshot.messages.push({...delivery,id:'new'});
 const state=restored.inspect(input.ownerId);
 assert.equal(state.host.name,input.name);assert.equal(state.messages.length,1);assert.equal(state.messages[0].manifestDigest,'digest');
 assert.equal(restored.acknowledge(input.ownerId,delivery.id).status,'acknowledged');
 assert.throws(()=>restored.restore(state.host,state.messages),/already exists/);
 original.close(input.ownerId);
 const closed=new MockOwnerHostAdapter();closed.restore(original.inspect(input.ownerId).host);
 assert.throws(()=>closed.send(input.ownerId,'late'),/closed/);
});

test('restore rejects forged ownership, malformed messages and oversized state atomically', () => {
 const original=new MockOwnerHostAdapter();const host=original.spawn(input);
 const message=original.send(input.ownerId,'demo');
 const invalidHosts=[null,{...host,verified:true},{...host,visibility:'herdr-visible'},{...host,session:'real'},{...host,ownsHost:false},{...host,state:'attached'},{...host,createdAt:'bad'},{...host,ownerId:'x'.repeat(513)},{...host,extra:'data'}];
 for(const invalid of invalidHosts) {
  const target=new MockOwnerHostAdapter();assert.throws(()=>target.restore(invalid as typeof host),/Invalid persisted/);
  target.restore(host);assert.equal(target.inspect(input.ownerId).host.ownerId,input.ownerId);
 }
 for(const messages of [[{...message,ownerId:'another'}],[message,message],[{...message,transport:'herdr'}],[{...message,status:'acknowledged'}],[{...message,message:'x'.repeat(64001)}],Array(10001).fill(message)]) {
  const target=new MockOwnerHostAdapter();assert.throws(()=>target.restore(host,messages as typeof message[]),/Invalid persisted/);
  target.restore(host);
 }
 const manualAdapter=new MockOwnerHostAdapter();const manual=manualAdapter.attach({...input,session:'manual',pane:'1'});
 const target=new MockOwnerHostAdapter();assert.throws(()=>target.restore(manual,[message]),/Invalid persisted/);
 target.restore(manual);assert.throws(()=>target.send(input.ownerId,'hello'),/unavailable/);
});
