import { Text } from '@lobehub/ui/base-ui';
import type { Artifact } from '../../shared/types';
import { styles } from '../style';

export function ArtifactsPanel({ artifacts }: { artifacts: Artifact[] }) {
  return <div className={styles.stack}>{!artifacts.length && <Text type="secondary">暂无产物。失败或取消的任务可能保留部分输出。</Text>}{artifacts.map(artifact => <article key={artifact.id} className={styles.stack}><Text style={{ fontWeight: 600 }}>{artifact.name}</Text><Text type="secondary">{artifact.mediaType} · {artifact.content.length.toLocaleString()} 字符 · 安全文本预览</Text><pre className={styles.clip}>{artifact.content}</pre></article>)}</div>;
}
