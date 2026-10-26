import * as stylex from '@stylexjs/stylex';
import { ActionIcon, Progress, Skeleton, Text, Tooltip } from '@lobehub/ui';
import { RefreshCw } from 'lucide-react';
import type { EngineQuotaRecord, QuotaEngine, QuotaWindow } from '../../../shared/contracts/quota';
import { quotaPercentText, quotaProgressPercent, quotaRecordStale, quotaRecoveryText, quotaRetryMs, quotaStatusText, quotaCountText, quotaVisibleWindows, quotaThirdParty } from '../quota/quota-view';
import { styles } from '../../ui/styles';
import { TimeText } from '../../ui/TimeText';
import { engineStyles } from './engines-style';

export function QuotaSummary({ engine, record, now, busy, policyBusy, feedback, onRefresh, recovery, refreshLabel }: { engine: QuotaEngine; record?: EngineQuotaRecord; now: number; busy: QuotaEngine | null; policyBusy: boolean; feedback?: { text: string; error: boolean }; onRefresh: () => void; recovery?: string; refreshLabel?: string }) {
  const retry = quotaRetryMs(record, now);
  const stale = record ? quotaRecordStale(record, now) : true;
  const tone = record?.status === 'exhausted' || record?.status === 'error' ? 'warning' : 'secondary';
  return <section aria-label={`${engine} 额度`} {...stylex.props(styles.tight)}>
    <div {...stylex.props(styles.spread)}>
      <Text type={tone}>{record ? quotaStatusText(record, stale) : '读取中'}</Text>
      <Tooltip title={retry > 0 ? `冷却中，${Math.ceil(retry / 1000)} 秒后可刷新` : '刷新额度'}>
        <ActionIcon size="small" icon={RefreshCw} aria-label={refreshLabel ?? `刷新 ${engine} 额度`} loading={busy === engine} disabled={busy !== null || policyBusy || retry > 0} onClick={onRefresh} />
      </Tooltip>
    </div>
    {!record ? <Skeleton.Text rows={1} /> : <>
      {quotaVisibleWindows(record).map(window => <QuotaWindowRow key={window.id} window={window} />)}
      {!record.windows.length && <Text type="secondary" className={stylex.props(styles.meta).className}>{record.detail}</Text>}
      {(recovery ?? quotaRecoveryText(record)) && record.status !== 'unknown' && <Text type="secondary" className={stylex.props(styles.meta).className}>{recovery ?? quotaRecoveryText(record)}</Text>}
      <Text type="secondary" className={stylex.props(styles.meta).className}>{record.observedAt ? <>{stale ? '已过期 · ' : ''}<TimeText value={record.observedAt} now={now} /> 观测</> : record.checkedAt ? <><TimeText value={record.checkedAt} now={now} /> 检查</> : '尚未刷新'}</Text>
    </>}
    {feedback && !feedback.error && !(record && quotaThirdParty(record)) && <Text role="status" type={feedback.error ? 'danger' : 'secondary'} className={stylex.props(styles.meta).className}>{feedback.text}</Text>}
  </section>;
}

function QuotaWindowRow({ window }: { window: QuotaWindow }) {
  const percent = quotaProgressPercent(window);
  const amount = window.unit === 'percent' ? `已用 ${quotaPercentText(window.usedPercent)}` : `剩余 ${quotaCountText(window.remaining, window.unit)} / ${quotaCountText(window.total, window.unit)}`;
  return <div {...stylex.props(engineStyles.quotaWindow)}>
    <div {...stylex.props(styles.spread)}>
      <Text className={stylex.props(styles.meta).className}>{window.label}{window.scope === 'model' && window.model ? ` · ${window.model}` : ''}</Text>
      <Text className={stylex.props(styles.meta, styles.numbers).className}>{amount}</Text>
    </div>
    {percent !== null && <Progress size="small" percent={percent} showInfo={false} status={percent >= 100 ? 'exception' : undefined} aria-label={`${window.label} 已用比例`} />}
    {window.resetsAt && <Text type="secondary" className={stylex.props(styles.meta).className}><TimeText value={window.resetsAt} /> 重置</Text>}
  </div>;
}
