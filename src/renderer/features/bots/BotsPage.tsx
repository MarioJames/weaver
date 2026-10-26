import { useState, type ReactNode } from 'react';
import { Tabs } from '@lobehub/ui';
import { PageHeader, TitleWithTips } from '@lobehub/ui/dashboard';
import type { PolicyDraft } from '../../policy/usePolicyDraft';
import { ImSettings } from './ImSettings';

interface BotChannel {
  key: string;
  label: string;
  render: (policy: PolicyDraft) => ReactNode;
}

const CHANNELS: BotChannel[] = [
  { key: 'feishu', label: '飞书 IM', render: policy => <ImSettings policy={policy} /> },
];

export function BotsPage({ policy }: { policy: PolicyDraft }) {
  const [channel, setChannel] = useState(CHANNELS[0].key);
  return <>
    <PageHeader title={<TitleWithTips title="Bot" tips="配置聊天渠道及 Bot 使用的引擎、模型和推理强度，修改后点击「保存」生效。接入说明见飞书开放平台的企业自建应用文档。" />} />
    <Tabs
      activeKey={channel}
      onChange={setChannel}
      variant="square"
      size="small"
      items={CHANNELS.map(item => ({ key: item.key, label: item.label, children: item.render(policy) }))}
    />
  </>;
}
