import { useEffect, useState } from 'react';
import * as stylex from '@stylexjs/stylex';
import { Zap } from 'lucide-react';
import { Button, Tag, Text } from '@lobehub/ui';
import { TitleWithTips } from '@lobehub/ui/dashboard';
import type { HelloResult } from '../../../shared/engines';
import { helloRouteKey, startHello, useHelloRun } from '../engines/hello-runs';
import { useNotifyError } from '../../api/notify';
import { TimeText } from '../../ui/TimeText';
import { styles } from '../../ui/styles';
import { tagColor } from '../../format/tag-colors';
import type { Owner } from '../../../shared/contracts/policy';
import { rolesStyles } from './roles-style';

/** Sends one real "say hi" through the route as currently filled in, saved or not. The run outlives this form. */
export function HelloCheck({ id, record, engine, channelLabel }: { id: string; record: Pick<Owner, 'channel' | 'model' | 'effort'>; engine: string; channelLabel?: string }) {
  const runKey = helloRouteKey(id, record);
  const run = useHelloRun(runKey);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!run?.running) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [run?.running]);
  const ready = Boolean(record.channel && engine && record.model.trim() && record.effort.trim());
  const elapsed = run?.running ? Math.max(0, Math.floor((now - run.startedAt) / 1000)) : 0;
  return <div {...stylex.props(styles.stack, styles.divided)}>
    <div {...stylex.props(styles.spread, styles.alignStart)}>
      <div {...stylex.props(styles.tight)}>
        <TitleWithTips title="连通测试" tips="用当前填写的渠道、模型和推理强度发送一条简短问候，检查能否正常回复。不调用工具，不保存会话，会消耗少量额度。连通成功不代表额度可用。" />
        <Text type="secondary" {...stylex.props(styles.meta)}>用当前填写的路由发一条问候，会消耗少量额度。</Text>
      </div>
      <Button icon={Zap} loading={run?.running} disabled={!ready} onClick={() => void startHello(runKey, { channel: record.channel, engine, model: record.model.trim(), effort: record.effort.trim() }, `${channelLabel ?? record.channel} · ${record.model.trim()} · ${record.effort.trim()}`)}>连通测试</Button>
    </div>
    {run?.running && <Text type="secondary" {...stylex.props(styles.meta)} role="status">正在等待 {run.route.split(' · ')[0]} 回复… {elapsed} 秒</Text>}
    {run?.result && !run.running && <ReplyCard result={{ ...run.result, route: run.route }} />}
  </div>;
}

/** The model's answer as a message card: who answered, what it said, how long it took. */
function ReplyCard({ result }: { result: HelloResult & { route: string } }) {
  useNotifyError(!result.ok ? result.error : '', '探测失败');
  if (!result.ok) return null;
  const seconds = result.durationMs ? `${(result.durationMs / 1000).toFixed(1)} 秒` : '';
  return <article role="status" aria-label="连通测试结果" {...stylex.props(rolesStyles.replyCard)} data-ok={result.ok ? 'true' : 'false'}>
    <header {...stylex.props(styles.spread, styles.nowrap)}>
      <span {...stylex.props(styles.row, styles.nowrap)}>
        <Tag size="small" color={result.ok ? tagColor('success') : tagColor('error')}>{result.ok ? '连通成功' : '连通失败'}</Tag>
        <Text strong {...stylex.props(styles.wrap)}>{result.route}</Text>
      </span>
      <Text type="secondary" {...stylex.props(styles.meta, styles.numbers, rolesStyles.replyTime)}>{seconds && `${seconds} · `}<TimeText value={result.checkedAt} /></Text>
    </header>
    <p {...stylex.props(rolesStyles.replyText)}>{result.reply}</p>
    {result.model && <Text type="secondary" {...stylex.props(styles.meta)}>实际应答模型：{result.model}</Text>}
  </article>;
}
