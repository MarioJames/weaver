import { useEffect, useId, useRef, useState, type CSSProperties } from 'react';
import { CopyButton, Markdown } from '@lobehub/ui';
import { Button, Text } from '@lobehub/ui/base-ui';
import { styles } from './task-detail-style';

export function TaskTextBlock({ title, content, description, clamp, markdown, className }: { title: string; content: string; description?: string; clamp?: number; markdown?: boolean; className?: string }) {
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
  return <section className={`${styles.textBlock} ${className ?? ''}`} aria-label={title}>
    <div className={styles.textHeader}>
      <div className={styles.textHeading}>
        <Text style={{ fontWeight: 600 }}>{title}</Text>
        {description && <Text type="secondary" className={styles.description}>{description}</Text>}
      </div>
      <CopyButton content={content} size="small" aria-label={`复制${title}`} title={`复制${title}`} />
    </div>
    {markdown ? <div ref={element => { textRef.current = element; }} id={contentId} className={`${styles.markdown}${clamp && !expanded ? ` ${styles.markdownClamped}` : ''}`} style={clamp ? { '--summary-lines': clamp } as CSSProperties : undefined}><Markdown>{content}</Markdown></div> : <pre ref={element => { textRef.current = element; }} id={contentId} className={`${styles.textContent}${clamp && !expanded ? ` ${styles.clamped}` : ''}`} style={clamp ? { WebkitLineClamp: clamp } : undefined}>{content}</pre>}
    {clamp && overflowing && <div className={styles.textFooter}><Button size="small" type="text" aria-expanded={expanded} aria-controls={contentId} aria-label={`${expanded ? '收起' : '展开'}${title}`} onClick={() => setExpanded(value => !value)}>{expanded ? '收起' : '展开'}</Button></div>}
  </section>;
}
