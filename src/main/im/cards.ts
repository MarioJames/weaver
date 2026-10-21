import { randomUUID } from 'node:crypto';
export const REPLY_BYTES = 20_000;
const MARKER = '<weaver-actions>';
const STEM = '<weaver-actions';
export interface ReplyAction { label: string; message: string }
/** Hold only a possible marker prefix; control data never reaches the stream. */
export class PublicDeltaFilter {
  private pending = '';
  private hidden = false;
  push(chunk: string): string {
    if (this.hidden) return '';
    this.pending += chunk;
    const start = this.pending.indexOf(STEM);
    if (start >= 0) { const out = this.pending.slice(0, start); this.pending = ''; this.hidden = true; return out; }
    let keep = 0;
    for (let n = 1; n < STEM.length; n++) if (this.pending.endsWith(STEM.slice(0, n))) keep = n;
    const out = this.pending.slice(0, this.pending.length - keep);
    this.pending = this.pending.slice(this.pending.length - keep);
    return out;
  }
  finish(): string { this.pending = ''; return ''; }
}
export function parseReply(value: string): { text: string; actions: ReplyAction[] } {
  const normalized = value.trimEnd();
  const index = normalized.indexOf(STEM);
  let body = index < 0 ? normalized : normalized.slice(0, index);
  if (index < 0) for (let n = MARKER.length - 1; n > 0; n--) if (body.endsWith(MARKER.slice(0, n))) { body = body.slice(0, -n); break; }
  const text = body.trim();
  if (Buffer.byteLength(text) > REPLY_BYTES) throw new Error('IM_REPLY_LIMIT');
  if (index < 0 || !normalized.startsWith(MARKER, index)) return { text, actions: [] };
  const tail = normalized.slice(index + MARKER.length).trim();
  if (tail.length > 9000 || !tail.endsWith('</weaver-actions>')) return { text, actions: [] };
  try {
    const parsed = JSON.parse(tail.slice(0, -'</weaver-actions>'.length));
    if (!parsed || Object.keys(parsed).join() !== 'actions' || !Array.isArray(parsed.actions) || parsed.actions.length > 6) return { text, actions: [] };
    const actions = parsed.actions as ReplyAction[];
    if (actions.some(a => !a || Object.keys(a).sort().join() !== 'label,message' || typeof a.label !== 'string' || !a.label.trim() || a.label.length > 40 || typeof a.message !== 'string' || !a.message.trim() || a.message.length > 1000)) return { text, actions: [] };
    return { text, actions };
  } catch { return { text, actions: [] }; }
}
export function replyCard(text: string, actions: { label: string; nonce: string; actionId: string }[] = []): object {
  return { schema: '2.0', config: { wide_screen_mode: true, streaming_mode: false }, body: { elements: [
    { tag: 'markdown', content: text || '本轮没有可显示的回复。' },
    ...(actions.length ? [{ tag: 'column_set', flex_mode: 'flow', columns: actions.map(a => ({ tag: 'column', width: 'auto', elements: [{ tag: 'button', text: { tag: 'plain_text', content: a.label }, type: 'default', behaviors: [{ type: 'callback', value: { nonce: a.nonce, actionId: a.actionId } }] }] })) }] : []),
  ] } };
}
export function actionIdentity(): string { return randomUUID(); }
