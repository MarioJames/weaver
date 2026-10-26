import * as stylex from '@stylexjs/stylex';
import { cssVar } from '@lobehub/ui/stylex/cssVar.stylex';

/** Shared chrome for resource pages (账号与渠道, 父/子 Agent): page frame, toolbar, bordered list, row actions and modal shells. Anything one feature owns stays in that feature's style file. */
export const resourceStyles = stylex.create({
  /** Page column under the header: one gap rhythm for every block the page stacks. */
  page: {
    display: 'flex',
    flex: 'none',
    flexDirection: 'column',
    gap: 20,
    minInlineSize: 0,
  },
  /** Filter and secondary actions between the header and the list. */
  toolbar: {
    display: 'flex',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 12,
    marginBlockEnd: 16,
  },
  /** One bordered container holding the resource rows. */
  list: {
    flex: 'none',
    display: 'flex',
    flexDirection: 'column',
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: cssVar.colorBorderSecondary,
    borderRadius: cssVar.borderRadiusLG,
    backgroundColor: cssVar.colorBgContainer,
    overflow: 'hidden',
  },
  /** Actions on one row: the enable switch and the row's text buttons. */
  rowActions: {
    display: 'flex',
    gap: 8,
    alignItems: 'center',
    flexWrap: 'wrap',
  },
  /** Tall modal shell: never grows past the viewport, its body scrolls. */
  modal: {
    maxBlockSize: 'calc(100dvh - 32px)',
    minBlockSize: 0,
  },
  modalBody: {
    minBlockSize: 0,
    overflow: 'auto',
    overscrollBehavior: 'contain',
  },
  modalFooter: {
    flexWrap: 'wrap',
  },
  /** The save-state text in a policy page header keeps one width so the actions beside it never shift. */
  headerStatus: {
    flexShrink: 0,
    inlineSize: 126,
  },
});
