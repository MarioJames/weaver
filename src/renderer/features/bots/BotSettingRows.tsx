import type { ReactNode } from 'react';
import { Text } from '@lobehub/ui/base-ui';
import { botStyles } from './bot-style';

export function BotChannel({ channel, title, desc, children }: { channel: string; title: string; desc: ReactNode; children: ReactNode }) {
  return <section aria-label={title} data-bot-channel={channel} className={botStyles.channel}>
    <header className={botStyles.channelHeader}>
      <Text fontSize={12} className={botStyles.wrap}>{desc}</Text>
    </header>
    <div data-bot-rows="" className={botStyles.rows}>{children}</div>
  </section>;
}

export function BotSetting({ label, desc, htmlFor, error, role, children }: { label: string; desc: ReactNode; htmlFor: string; error?: string; role?: 'alert'; children: ReactNode }) {
  return <div data-bot-row={htmlFor} className={botStyles.row} role={role}>
    <div data-bot-field="" className={botStyles.fieldCell}>
      <label htmlFor={htmlFor}><Text strong>{label}</Text></label>
      <Text fontSize={12} className={botStyles.wrap}>{desc}</Text>
    </div>
    <div data-bot-control="" className={botStyles.controlCell}>
      <div className={botStyles.controlStack}>
        <div className={botStyles.controlRow}>{children}</div>
        {error && <p id={`${htmlFor}-error`} role="alert" className={botStyles.error}>{error}</p>}
      </div>
    </div>
  </div>;
}
