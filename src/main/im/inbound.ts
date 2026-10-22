import type { NormalizedMessage } from '@larksuite/channel';

export type InboundResult =
  | { kind: 'ok'; text: string }
  | { kind: 'feedback'; notice: string }
  | { kind: 'silent' };

export const INBOUND_FEEDBACK =
  '仅支持非空且不超过 16KB 的文本或富文本正文，图片/文件暂不支持。';

const PLACEHOLDERS = new Set(['[rich text message]', '[unsupported message]']);

function stripAttachments(content: string): string {
  return content
    .replace(/<file[^>]*\/?>/g, '')
    .replace(/<folder[^>]*\/?>/g, '')
    .replace(/<audio[^>]*\/?>/g, '')
    .replace(/<video[^>]*\/?>/g, '')
    .replace(/<sticker[^>]*\/?>/g, '')
    .replace(/!\[image\]\(.*?\)/g, '')
    .trim();
}

export function extractInboundText(message: NormalizedMessage): InboundResult {
  if (message.rawContentType !== 'text' && message.rawContentType !== 'post') return { kind: 'silent' };
  const raw = message.raw as
    | { message?: { message_type?: unknown; content?: unknown } }
    | undefined;
  if (raw?.message?.message_type !== message.rawContentType) return { kind: 'silent' };
  if (typeof raw.message.content !== 'string') return { kind: 'silent' };
  if (message.rawContentType === 'text') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.message.content);
    } catch {
      return { kind: 'silent' };
    }
    const text = (parsed as { text?: unknown } | null | undefined)?.text;
    if (typeof text !== 'string') return { kind: 'feedback', notice: INBOUND_FEEDBACK };
    if (!text.trim()) return { kind: 'feedback', notice: INBOUND_FEEDBACK };
    if (Buffer.byteLength(text) > 16_000) return { kind: 'feedback', notice: INBOUND_FEEDBACK };
    return { kind: 'ok', text };
  }
  const content = message.content;
  if (typeof content !== 'string') return { kind: 'feedback', notice: INBOUND_FEEDBACK };
  const trimmed = content.trim();
  if (!trimmed || PLACEHOLDERS.has(trimmed)) return { kind: 'feedback', notice: INBOUND_FEEDBACK };
  if (!stripAttachments(trimmed)) return { kind: 'feedback', notice: INBOUND_FEEDBACK };
  if (Buffer.byteLength(content) > 16_000) return { kind: 'feedback', notice: INBOUND_FEEDBACK };
  return { kind: 'ok', text: content };
}
