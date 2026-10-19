import { CopyButton } from '@lobehub/ui';
import { Text } from '@lobehub/ui/base-ui';
import { styles } from './task-detail-style';

export function TaskTextBlock({ title, content, description }: { title: string; content: string; description?: string }) {
  return <section className={styles.textBlock} aria-label={title}>
    <div className={styles.textHeader}>
      <div className={styles.textHeading}>
        <Text style={{ fontWeight: 600 }}>{title}</Text>
        {description && <Text type="secondary" className={styles.description}>{description}</Text>}
      </div>
      <CopyButton content={content} size="small" aria-label={`复制${title}`} title={`复制${title}`} />
    </div>
    <pre className={styles.textContent}>{content}</pre>
  </section>;
}
