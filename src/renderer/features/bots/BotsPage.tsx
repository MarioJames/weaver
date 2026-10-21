import { PageHeader } from '@lobehub/ui/dashboard';
import type { PolicyDraft } from '../../policy/usePolicyDraft';
import { settingsStyles } from '../settings/settings-style';
import { ImSettings } from './ImSettings';

export function BotsPage({ policy }: { policy: PolicyDraft }) {
  return <>
    <PageHeader title="Bot" description="配置聊天渠道及 Bot 使用的引擎、模型和思考力度，修改后点击「保存修改」生效。" />
    <div className={settingsStyles.surface}>
      <ImSettings policy={policy} />
    </div>
  </>;
}
