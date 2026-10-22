import { useState, type ReactNode } from 'react';
import { Tabs } from '@lobehub/ui/base-ui';
import { PageHeader } from '@lobehub/ui/dashboard';
import type { PolicyDraft } from '../../policy/usePolicyDraft';
import { ImSettings } from './ImSettings';
import { botStyles } from './bot-style';

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
    <PageHeader title="Bot" description="配置聊天渠道及 Bot 使用的引擎、模型和思考力度，修改后点击「保存修改」生效。" />
    <div className={botStyles.surface}>
      <Tabs
        activeKey={channel}
        onChange={setChannel}
        variant="square"
        size="small"
        classNames={{ list: botStyles.tabList, panel: botStyles.tabPanel }}
        items={CHANNELS.map(item => ({ key: item.key, label: item.label, children: item.render(policy) }))}
      />
    </div>
  </>;
}
