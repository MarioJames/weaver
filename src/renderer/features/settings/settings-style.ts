import * as stylex from '@stylexjs/stylex';
import { cssVar } from '@lobehub/ui/stylex/cssVar.stylex';

/**
 * Settings page: unframed SettingGroup rows like the Bot page (bot-style page/groups),
 * so group titles, row labels and controls share the same insets instead of
 * hugging a bordered panel. Only the failure row keeps a frame: it is content
 * with a retry action (§6.3), never a toast-only error.
 */
export const settingsStyles = stylex.create({
  page: {
    display: 'flex',
    flexDirection: 'column',
    gap: 16,
    minInlineSize: 0,
    maxInlineSize: 960,
  },
  groups: {
    display: 'flex',
    flexDirection: 'column',
    gap: 24,
    minInlineSize: 0,
  },
  outcome: {
    whiteSpace: 'nowrap',
    flexShrink: 0,
  },
  /** A fixed failure row: reading failed, with a retry action. Never just a toast. */
  failure: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 8,
    alignItems: 'center',
    minInlineSize: 0,
    maxInlineSize: 960,
    paddingBlock: 12,
    paddingInline: 16,
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: cssVar.colorBorderSecondary,
    borderRadius: cssVar.borderRadiusLG,
    backgroundColor: cssVar.colorBgContainer,
    color: cssVar.colorErrorText,
    fontSize: cssVar.fontSizeSM,
  },
  minutesInput: {
    inlineSize: '100%',
    maxInlineSize: 360,
  },
  timezoneSelect: {
    inlineSize: '100%',
    maxInlineSize: 360,
  },
});
