import { useEffect, useRef, useState } from 'react';
import { Activity } from 'lucide-react';
import * as stylex from '@stylexjs/stylex';
import { Button, Descriptions, Skeleton, Tag, Text } from '@lobehub/ui';
import type { FreeWorkerStatus } from '../../../shared/contracts/monitoring';
import type { FreeProbe } from './useFreeProbe';
import { PROBE_HISTORY_SHOWN, lastProbeOf, nextProbeText, probeDurationText, probeNoteText, probeStateView, recentProbes, type ProbeHistoryRecord } from './probe-view';
import { TimeText } from '../../ui/TimeText';
import { statusTagColor, tagColor } from '../../format/tag-colors';
import { styles } from '../../ui/styles';
import { probeStyles } from './free-probe-style';

const outcomeTag = (record: ProbeHistoryRecord) => <Tag size="small" color={record.probe.ok ? tagColor('success') : tagColor('error')}>{record.probe.ok ? '成功' : '失败'}</Tag>;

/** The history, newest first: outcome, when, how long, and what the failure or the policy change said. */
export function ProbeHistory({ status }: { status: FreeWorkerStatus | undefined }) {
  const rows = recentProbes(status);
  if (!rows.length) return null;
  return <ol {...stylex.props(probeStyles.history)} aria-label={`最近 ${PROBE_HISTORY_SHOWN} 次探测`}>
    {rows.map(record => {
      const note = probeNoteText(record);
      return <li key={`${record.at}:${record.level}`} {...stylex.props(probeStyles.entry)}>
        {outcomeTag(record)}
        <span {...stylex.props(probeStyles.entryMeta, styles.numbers)}><TimeText value={record.at} /><span>{probeDurationText(record.probe.ms)}</span></span>
        {note && <span {...stylex.props(probeStyles.entryNote)}>{note}</span>}
      </li>;
    })}
  </ol>;
}

/**
 * Probe state of one free-channel sub agent: the tag and why, the latest result, the next probe, and an immediate probe.
 * The probe uses the saved route, so it is offered only once the sub agent takes part in probing.
 */
export function FreeProbePanel({ worker, probe }: { worker: string; probe: FreeProbe }) {
  const root = useRef<HTMLElement>(null);
  const [columns, setColumns] = useState(2);
  useEffect(() => {
    const element = root.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const measure = () => setColumns(element.getBoundingClientRect().width < 460 ? 1 : 2);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const { status } = probe;
  const entry = status?.workers.find(item => item.worker === worker);
  const state = probeStateView(entry);
  const last = lastProbeOf(entry);
  const running = probe.probing.has(worker);
  const waiting = !status && !probe.unavailable;
  const reason = entry?.probed && entry.availability.status === 'blocked' ? entry.availability.reason : undefined;
  const items = [
    { key: 'state', label: '当前状态', span: columns, children: <span {...stylex.props(probeStyles.state)}>
      <Tag color={statusTagColor(state.tone)}>{state.label}</Tag>
      {state.detail && <Text type="secondary">{state.detail}</Text>}
    </span> },
    ...(reason ? [{ key: 'reason', label: '暂停原因', span: columns, children: <Text className={stylex.props(styles.wrap).className}>{reason}</Text> }] : []),
    { key: 'last', label: '最近探测', children: last ? <span {...stylex.props(probeStyles.last)}>
      <span {...stylex.props(styles.row, styles.numbers)}>{outcomeTag(last)}<TimeText value={last.at} /><Text type="secondary">{probeDurationText(last.probe.ms)}</Text></span>
      {last.probe.error && <Text type="secondary" className={stylex.props(styles.meta).className} ellipsis={{ rows: 2, tooltip: last.probe.error }}>{last.probe.error}</Text>}
    </span> : <Text type="secondary">暂无记录</Text> },
    { key: 'next', label: '下次探测', children: <span {...stylex.props(styles.numbers)}>{nextProbeText(entry, status?.schedule)}</span> },
  ];
  return <section ref={root} aria-label="探测状态" {...stylex.props(styles.stack, styles.divided, probeStyles.panel)}>
    <div {...stylex.props(styles.spread, styles.alignStart)}>
      <div {...stylex.props(styles.tight)}>
        <Text strong>探测状态</Text>
        {running
          ? <Text type="secondary" className={stylex.props(styles.meta).className} role="status">正在向 {worker} 发送问候，最长等待约 2 分钟…</Text>
          : <Text type="secondary" className={stylex.props(styles.meta).className}>按设置的间隔向免费渠道发送简短问候，保持额度并发现故障。立即探测同样会消耗少量额度。</Text>}
      </div>
      <Button icon={Activity} loading={running} disabled={!entry?.probed || probe.unavailable && !status} aria-label={`立即探测 ${worker}`} onClick={() => void probe.probeNow(worker)}>立即探测</Button>
    </div>
    {waiting ? <div role="status" aria-label="正在读取探测状态"><Skeleton.Text animated rows={3} /></div>
      : !status && probe.unavailable ? <Text type="secondary">探测状态暂时读取不到，稍后会自动重试。</Text>
        : <div {...stylex.props(styles.stack)}>
          <Descriptions className={stylex.props(probeStyles.descriptions).className} classNames={{ label: stylex.props(probeStyles.descriptionsLabel).className, content: stylex.props(probeStyles.descriptionsContent).className }} colon={false} column={columns} items={items} />
          {recentProbes(entry).length > 1 && <div {...stylex.props(styles.tight)}>
            <Text strong className={stylex.props(styles.meta).className}>最近 {PROBE_HISTORY_SHOWN} 次探测</Text>
            <ProbeHistory status={entry} />
          </div>}
        </div>}
  </section>;
}
