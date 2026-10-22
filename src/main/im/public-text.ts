/**
 * IM 公开文本流的段落边界 helper：同一 turn 内协议上独立的公开段落之间补足到空一行。
 *
 * 不变量：同一消息内 token 原样连接，不按 chunk 加段、不做正则重排；
 * 已有换行不删；空串不消耗挂起边界；实例只活在单 turn 内，用完即弃。
 */
export class PublicTextBoundary {
  private emitted = false;
  private trailingNewlines = 0;
  private pendingBoundary = false;

  /**
   * 声明一个新的协议段落开始（新 assistant message / 新 text part / 新 item）。
   * 只有之前已输出过可见文本时才挂起分隔；首段与空段之后调用无效果。
   */
  noteBoundary(): void {
    if (this.emitted) this.pendingBoundary = true;
  }

  /**
   * 包装下一个非空公开 chunk：如有挂起的段落边界则在前面补足换行到空一行，
   * 然后记录本次输出的尾部换行状态。空串原样返回且不消耗挂起边界。
   * 挂起边界下单个换行独占 chunk 时先原样输出并保留挂起，由下个 chunk 再判定，
   * 避免与下个 chunk 的前导换行叠加；不缓存正文。
   */
  format(chunk: string): string {
    if (!chunk) return chunk;
    let out = chunk;
    if (this.pendingBoundary && this.emitted) {
      if (chunk === '\n') {
        this.observe(out);
        return out;
      }
      const need = Math.max(0, 2 - this.trailingNewlines - countLeadingNewlines(chunk));
      if (need > 0) out = '\n'.repeat(need) + chunk;
      this.pendingBoundary = false;
    }
    this.observe(out);
    return out;
  }

  private observe(text: string): void {
    if (!text) return;
    this.emitted = true;
    if (isOnlyNewlines(text)) {
      this.trailingNewlines = Math.min(2, this.trailingNewlines + text.length);
    } else {
      this.trailingNewlines = countTrailingNewlines(text);
    }
  }
}

function isOnlyNewlines(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    if (value[i] !== '\n') return false;
  }
  return value.length > 0;
}

function countLeadingNewlines(value: string): number {
  let count = 0;
  for (let i = 0; i < value.length && count < 2; i++) {
    if (value[i] === '\n') count++;
    else break;
  }
  return count;
}

function countTrailingNewlines(value: string): number {
  let count = 0;
  for (let i = value.length - 1; i >= 0 && count < 2; i--) {
    if (value[i] === '\n') count++;
    else break;
  }
  return count;
}
