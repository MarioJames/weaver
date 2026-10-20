import { randomUUID } from 'node:crypto';

export interface LogicalAdapter {
 readonly id: string;
 readonly available: boolean;
 readonly capabilities: readonly string[];
}

export interface OwnerHostInput { ownerId: string; name: string; profileId: string }
export interface OwnerAttachInput extends OwnerHostInput { session: string; pane: string }
export interface OwnerHostEvidence extends OwnerHostInput {
 adapter: 'mock-owner';
 mode: 'mock' | 'manual';
 state: 'ready' | 'attached' | 'closed';
 visibility: 'logical-demo' | 'external-unverified';
 verified: false;
 ownsHost: boolean;
 session?: string;
 pane?: string;
 createdAt: string;
 closedAt?: string;
}
export interface OwnerMessage {
 id: string;
 ownerId: string;
 kind: 'message' | 'result';
 message?: string;
 taskId?: string;
 manifestDigest?: string;
 transport: 'mock-memory';
 status: 'delivered' | 'acknowledged';
 createdAt: string;
 acknowledgedAt?: string;
}
export interface OwnerHostAdapter extends LogicalAdapter {
 restore(host: OwnerHostEvidence, messages?: OwnerMessage[]): void;
 spawn(input: OwnerHostInput): OwnerHostEvidence;
 attach(input: OwnerAttachInput): OwnerHostEvidence;
 send(ownerId: string, message: string): OwnerMessage;
 deliverResult(ownerId: string, result: {taskId:string;manifestDigest:string}): OwnerMessage;
 acknowledge(ownerId: string, messageId: string): OwnerMessage;
 close(ownerId: string): OwnerHostEvidence;
 inspect(ownerId: string): {host:OwnerHostEvidence;messages:OwnerMessage[]};
}

/** A visible logical demo identity, never a Herdr session or an AI agent. */
export class MockOwnerHostAdapter implements OwnerHostAdapter {
 readonly id = 'mock-owner';
 readonly available = true;
 readonly capabilities = Object.freeze(['spawn', 'attach', 'message', 'result-delivery', 'acknowledge', 'close', 'inspect']);
 private readonly hosts = new Map<string, OwnerHostEvidence>();
 private readonly messages = new Map<string, OwnerMessage[]>();
 /** Restore only local evidence; this never reconnects to or verifies an external host. */
 restore(host: OwnerHostEvidence, messages: OwnerMessage[] = []): void {
  const fail = (): never => { throw new Error('Invalid persisted owner evidence'); };
  const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
  const text = (value: unknown, max = 512): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
  const date = (value: unknown): value is string => typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value));
  const keys = (value: object, allowed: string[]): boolean => Object.keys(value).every(key => allowed.includes(key));
  if (!record(host) || !keys(host, ['ownerId','name','profileId','adapter','mode','state','visibility','verified','ownsHost','session','pane','createdAt','closedAt'])) fail();
  if (!text(host.ownerId) || !text(host.name) || !text(host.profileId) || host.adapter !== 'mock-owner' || host.verified !== false || !date(host.createdAt)) fail();
  if (host.mode === 'mock') {
   if (host.visibility !== 'logical-demo' || host.ownsHost !== true || !['ready','closed'].includes(host.state) || host.session !== undefined || host.pane !== undefined) fail();
  } else if (host.mode === 'manual') {
   if (host.visibility !== 'external-unverified' || host.ownsHost !== false || !['attached','closed'].includes(host.state) || !text(host.session) || !text(host.pane)) fail();
  } else fail();
  if (host.state === 'closed' ? !date(host.closedAt) : host.closedAt !== undefined) fail();
  if (!Array.isArray(messages) || messages.length > 10000 || (host.mode === 'manual' && messages.length > 0)) fail();
  const ids = new Set<string>();
  for (const message of messages) {
   if (!record(message) || !keys(message, ['id','ownerId','kind','message','taskId','manifestDigest','transport','status','createdAt','acknowledgedAt'])) fail();
   if (!text(message.id) || ids.has(message.id) || message.ownerId !== host.ownerId || message.transport !== 'mock-memory' || !date(message.createdAt)) fail();
   ids.add(message.id);
   if (message.kind === 'message') {
    if (!text(message.message,64000) || message.taskId !== undefined || message.manifestDigest !== undefined) fail();
   } else if (message.kind === 'result') {
    if (!text(message.taskId) || !text(message.manifestDigest) || message.message !== undefined) fail();
   } else fail();
   if (message.status === 'acknowledged') { if (!date(message.acknowledgedAt)) fail(); }
   else if (message.status !== 'delivered' || message.acknowledgedAt !== undefined) fail();
  }
  if (this.hosts.has(host.ownerId)) throw new Error(`Owner already exists: ${host.ownerId}`);
  this.hosts.set(host.ownerId, {...host});
  this.messages.set(host.ownerId, messages.map(message => ({...message})));
 }
 spawn(input: OwnerHostInput): OwnerHostEvidence {
  return this.create(input, {mode:'mock',state:'ready',visibility:'logical-demo',ownsHost:true});
 }
 attach(input: OwnerAttachInput): OwnerHostEvidence {
  this.required(input.session, 'Session'); this.required(input.pane, 'Pane');
  return this.create(input, {mode:'manual',state:'attached',visibility:'external-unverified',ownsHost:false,session:input.session,pane:input.pane});
 }
 send(ownerId: string, message: string): OwnerMessage {
  this.required(message, 'Message');
  return this.deliver(ownerId, {kind:'message',message});
 }
 deliverResult(ownerId: string, result: {taskId:string;manifestDigest:string}): OwnerMessage {
  this.required(result.taskId, 'Task ID'); this.required(result.manifestDigest, 'Manifest digest');
  return this.deliver(ownerId, {kind:'result',taskId:result.taskId,manifestDigest:result.manifestDigest});
 }
 acknowledge(ownerId: string, messageId: string): OwnerMessage {
  this.requireMock(ownerId);
  const message = this.messages.get(ownerId)!.find(candidate => candidate.id === messageId);
  if (!message) throw new Error('Message does not belong to this owner');
  if (message.status !== 'acknowledged') {
   message.status = 'acknowledged'; message.acknowledgedAt = new Date().toISOString();
  }
  return {...message};
 }
 close(ownerId: string): OwnerHostEvidence {
  const host = this.get(ownerId);
  // For manual attachments this closes only our local attachment, never the external session.
  if (host.state !== 'closed') {host.state='closed';host.closedAt=new Date().toISOString();}
  return {...host};
 }
 inspect(ownerId: string): {host:OwnerHostEvidence;messages:OwnerMessage[]} {
  return {host:{...this.get(ownerId)},messages:this.messages.get(ownerId)!.map(message=>({...message}))};
 }
 private required(value: string, label: string): void {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required`);
 }
 private create(input: OwnerHostInput, details: Pick<OwnerHostEvidence,'mode'|'state'|'visibility'|'ownsHost'> & Partial<Pick<OwnerHostEvidence,'session'|'pane'>>): OwnerHostEvidence {
  this.required(input.ownerId,'Owner ID');this.required(input.name,'Owner name');this.required(input.profileId,'Owner profile');
  if (this.hosts.has(input.ownerId)) throw new Error(`Owner already exists: ${input.ownerId}`);
  const host:OwnerHostEvidence={ownerId:input.ownerId,name:input.name,profileId:input.profileId,adapter:'mock-owner',verified:false,createdAt:new Date().toISOString(),...details};
  this.hosts.set(input.ownerId,host);this.messages.set(input.ownerId,[]);
  return {...host};
 }
 private get(ownerId: string): OwnerHostEvidence {
  const host=this.hosts.get(ownerId);
  if (!host) throw new Error(`Unknown owner: ${ownerId}`);
  return host;
 }
 private requireMock(ownerId: string): OwnerHostEvidence {
  const host=this.get(ownerId);
  if (host.state==='closed') throw new Error('Owner is closed');
  if (host.mode!=='mock') throw new Error('External owner messaging is unavailable; manual attachment is unverified');
  return host;
 }
 private deliver(ownerId: string, content: Pick<OwnerMessage,'kind'|'message'|'taskId'|'manifestDigest'>): OwnerMessage {
  this.requireMock(ownerId);
  const message:OwnerMessage={id:randomUUID(),ownerId,...content,transport:'mock-memory',status:'delivered',createdAt:new Date().toISOString()};
  this.messages.get(ownerId)!.push(message);
  return {...message};
 }
}
