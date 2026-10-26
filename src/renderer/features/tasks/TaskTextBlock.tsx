import { useEffect, useId, useRef, useState } from 'react';
import * as stylex from '@stylexjs/stylex';
import { CopyButton, Markdown } from '@lobehub/ui';
import { Button, Text } from '@lobehub/ui';
import { styles } from './task-detail-style';

export function TaskTextBlock({ title, content, description, clamp, markdown, flat = false }: { title: string; content: string; description?: string; clamp?: number; markdown?: boolean; flat?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(!!clamp && (content.split('\n').length > clamp || content.length > clamp * 100));
  const textRef = useRef<HTMLElement>(null);
  const contentId = useId();
  useEffect(() => { setExpanded(false); }, [content]);
  useEffect(() => {
    const element = textRef.current;
    if (!clamp || !element) return;
    const measure = () => {
      const computed = getComputedStyle(element);
      const fullHeight = element.scrollHeight - parseFloat(computed.paddingTop) - parseFloat(computed.paddingBottom);
      setOverflowing(fullHeight > (parseFloat(computed.lineHeight) || parseFloat(computed.fontSize) * 1.7) * clamp + 1);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [clamp, content, expanded, markdown]);
  return <section {...stylex.props(styles.textBlock, flat && styles.textBlockFlat)} aria-label={title}>
    <div {...stylex.props(styles.textHeader, flat && styles.textHeaderFlat)}>
      <div {...stylex.props(styles.textHeading)}>
        <Text strong>{title}</Text>
        {description && <Text type="secondary" className={stylex.props(styles.description).className}>{description}</Text>}
      </div>
      <CopyButton content={content} size="small" aria-label={`复制${title}`} title={`复制${title}`} />
    </div>
    {markdown ? <div ref={element => { textRef.current = element; }} id={contentId} {...stylex.props(styles.markdown, flat && styles.markdownFlat, clamp !== undefined && !expanded && styles.markdownClamped, clamp !== undefined && styles.summaryLines(clamp))}><Markdown fontSize={14} headerMultiple={0} lineHeight={1.7}>{content}</Markdown></div> : <pre ref={element => { textRef.current = element; }} id={contentId} {...stylex.props(styles.textContent, clamp !== undefined && !expanded && styles.clamped, clamp !== undefined && !expanded && styles.clampLines(clamp))}>{content}</pre>}
    {clamp && overflowing && <div {...stylex.props(styles.textFooter, flat && styles.textFooterFlat)}><Button size="small" type="text" aria-expanded={expanded} aria-controls={contentId} aria-label={`${expanded ? '收起' : '展开'}${title}`} onClick={() => setExpanded(value => !value)}>{expanded ? '收起' : '展开'}</Button></div>}
  </section>;
}
