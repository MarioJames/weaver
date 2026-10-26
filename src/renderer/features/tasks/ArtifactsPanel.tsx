import * as stylex from '@stylexjs/stylex';
import { Text } from '@lobehub/ui';
import type { Artifact, TaskStatus } from '../../../shared/contracts/tasks';
import { styles } from '../../ui/styles';
import { TaskTextBlock } from './TaskTextBlock';

export function ArtifactsPanel({ artifacts, status }: { artifacts: Artifact[]; status?: TaskStatus }) {
  return <div {...stylex.props(styles.stack)}>{!artifacts.length && <Text type="secondary">{status === 'failed' || status === 'cancelled' ? '没有产物。失败或取消的任务可能保留部分输出。' : '没有产物'}</Text>}{artifacts.map(artifact => <article key={artifact.id} {...stylex.props(styles.stack)}><TaskTextBlock title={artifact.name} description={artifact.mediaType + ' · ' + artifact.content.length.toLocaleString() + ' 字符 · 安全文本预览'} markdown={artifact.mediaType === 'text/markdown' || /\.md$/i.test(artifact.name)} content={artifact.content} /></article>)}</div>;
}
