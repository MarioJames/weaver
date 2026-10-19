import { useEffect, useId, useRef, useState } from 'react';
import { CopyButton } from '@lobehub/ui';
import { Button, Text } from '@lobehub/ui/base-ui';
import { styles } from './task-detail-style';

export function TaskTextBlock({ title, content, description, clamp }: { title: string; content: string; description?: string; clamp?: number }) {
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(!!clamp && (content.split('\n').length > clamp || content.length > clamp * 100));
  const textRef = useRef<HTMLPreElement>(null);
  const contentId = useId();
  useEffect(() => { setExpanded(false); }, [content]);
  useEffect(() => {
    const element = textRef.current;
    if (!clamp || !element) return;
    const measure = () => {
      const computed = getComputedStyle(element);
      const fullHeight = element.scrollHeight - parseFloat(computed.paddingTop) - parseFloat(computed.paddingBottom);
      setOverflowing(fullHeight > parseFloat(computed.lineHeight) * clamp + 1);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [clamp, content, expanded]);
  return <section className={styles.textBlock} aria-label={title}>
    <div className={styles.textHeader}>
      <div className={styles.textHeading}>
        <Text style={{ fontWeight: 600 }}>{title}</Text>
        {description && <Text type="secondary" className={styles.description}>{description}</Text>}
      </div>
      <CopyButton content={content} size="small" aria-label={`复制${title}`} title={`复制${title}`} />
    </div>
    <pre ref={textRef} id={contentId} className={`${styles.textContent}${clamp && !expanded ? ` ${styles.clamped}` : ''}`} style={clamp ? { WebkitLineClamp: clamp } : undefined}>{content}</pre>
    {clamp && overflowing && <div className={styles.textFooter}><Button size="small" type="text" aria-expanded={expanded} aria-controls={contentId} onClick={() => setExpanded(value => !value)}>{expanded ? '收起' : '展开'}</Button></div>}
  </section>;
}
