import type { ReactNode } from 'react';
import * as stylex from '@stylexjs/stylex';
import { Text } from '@lobehub/ui';
import { botStyles } from './bot-style';

export function BotChannel({ channel, title, desc, children }: { channel: string; title: string; desc: ReactNode; children: ReactNode }) {
  return <section aria-label={title} data-bot-channel={channel} {...stylex.props(botStyles.channel)}>
    <header {...stylex.props(botStyles.channelHeader)}>
      <Text fontSize={12} className={stylex.props(botStyles.wrap).className}>{desc}</Text>
    </header>
    <div data-bot-rows="" {...stylex.props(botStyles.rows)}>{children}</div>
  </section>;
}

export function BotSetting({ label, desc, htmlFor, error, role, children }: { label: string; desc: ReactNode; htmlFor: string; error?: string; role?: 'alert'; children: ReactNode }) {
  return <div data-bot-row={htmlFor} {...stylex.props(botStyles.row)} role={role}>
    <div data-bot-field="" {...stylex.props(botStyles.fieldCell)}>
      <label htmlFor={htmlFor}><Text strong>{label}</Text></label>
      <Text fontSize={12} className={stylex.props(botStyles.wrap).className}>{desc}</Text>
    </div>
    <div data-bot-control="" {...stylex.props(botStyles.controlCell)}>
      <div {...stylex.props(botStyles.controlStack)}>
        <div {...stylex.props(botStyles.controlRow)}>{children}</div>
        {error && <p id={`${htmlFor}-error`} role="alert" className={stylex.props(botStyles.error).className}>{error}</p>}
      </div>
    </div>
  </div>;
}
