import * as stylex from '@stylexjs/stylex';
import { cssVar } from '@lobehub/ui/stylex/cssVar.stylex';

/** 看板视图：单行工具条、四列等宽画布、卡片、检查器覆盖层。列的区分只用整列浅底色，列顶不加强调线。 */
export const boardStyles = stylex.create({
  /** 工具条一行：搜索 + 工作目录多选 + 父 Agent 多选 + 清除筛选。 */
  toolbar: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 8,
    alignItems: 'center',
    minInlineSize: 0,
  },
  search: {
    flex: '2 1 200px',
    minInlineSize: 140,
  },
  select: {
    flex: '1 1 140px',
    minInlineSize: 120,
  },
  /** 四列画布：列等宽，各自纵向滚动。 */
  columns: {
    display: 'flex',
    flex: '1 1 0',
    gap: 12,
    minBlockSize: 0,
    minInlineSize: 0,
  },
  column: (tone: 'queued' | 'running' | 'review' | 'closed') => ({
    display: 'flex',
    flex: '1 1 0',
    flexDirection: 'column',
    minBlockSize: 0,
    minInlineSize: 0,
    overflow: 'hidden',
    borderRadius: cssVar.borderRadiusLG,
    backgroundColor:
      tone === 'queued'
        ? cssVar.colorFillQuaternary
        : tone === 'running'
          ? cssVar.colorInfoBg
          : tone === 'review'
            ? cssVar.colorWarningBg
            : cssVar.colorBgLayout,
  }),
  columnHead: {
    display: 'flex',
    flex: 'none',
    gap: 8,
    alignItems: 'center',
    paddingBlock: 12,
    paddingInline: 12,
  },
  columnTitle: (tone: 'queued' | 'running' | 'review' | 'closed') => ({
    display: 'flex',
    gap: 8,
    alignItems: 'baseline',
    minInlineSize: 0,
    fontSize: 14,
    fontWeight: 600,
    color:
      tone === 'running'
        ? cssVar.colorInfoText
        : tone === 'review'
          ? cssVar.colorWarningText
          : tone === 'closed'
            ? cssVar.colorTextTertiary
            : cssVar.colorTextSecondary,
    fontVariantNumeric: 'tabular-nums',
  }),
  columnCount: {
    color: 'inherit',
    fontVariantNumeric: 'tabular-nums',
  },
  /** 列内滚动区：常驻滚动条，展开折叠不引起宽度跳动。 */
  lane: {
    flex: '1 1 0',
    minBlockSize: 0,
    overflowX: 'hidden',
    overflowY: 'auto',
    scrollbarGutter: 'stable',
    paddingBlockEnd: 12,
    paddingInline: 8,
  },
  laneRow: {
    marginBlockEnd: 8,
  },
  groupToggle: {
    display: 'flex',
    gap: 4,
    alignItems: 'center',
    inlineSize: '100%',
    minInlineSize: 0,
    paddingBlock: 6,
    paddingInline: 4,
    borderWidth: 0,
    borderRadius: cssVar.borderRadiusSM,
    backgroundColor: 'transparent',
    color: 'inherit',
    fontFamily: 'inherit',
    fontSize: 'inherit',
    cursor: 'pointer',
  },
  moreRow: {
    display: 'flex',
    justifyContent: 'center',
    paddingBlock: 8,
    whiteSpace: 'nowrap',
  },
  /** 卡片：状态/健康徽标 + 标题（最多两行），子 Agent 芯片，一句话底部。 */
  card: {
    position: 'relative',
    display: 'block',
    minInlineSize: 0,
    inlineSize: '100%',
    paddingBlock: 8,
    paddingInline: 12,
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: cssVar.colorBorderSecondary,
    borderRadius: cssVar.borderRadius,
    backgroundColor: cssVar.colorBgContainer,
    textDecoration: 'none',
    color: 'inherit',
    textAlign: 'start',
    fontFamily: 'inherit',
    fontSize: 'inherit',
    cursor: 'pointer',
  },
  cardHead: {
    display: 'flex',
    gap: 8,
    alignItems: 'flex-start',
    minInlineSize: 0,
  },
  cardLink: {
    flex: '1 1 0',
    minInlineSize: 0,
    textDecoration: 'none',
    color: 'inherit',
  },
  cardBadges: {
    display: 'flex',
    flex: '1 1 auto',
    gap: 8,
    alignItems: 'center',
    minInlineSize: 0,
    maxInlineSize: '100%',
    overflow: 'hidden',
    marginBlockEnd: 4,
  },
  /** 卡片健康徽标：只在异常时出现，紧凑单 Tag，固定不挤压图标区。 */
  cardHealth: {
    display: 'inline-flex',
    flex: 'none',
    maxInlineSize: '100%',
  },
  cardTitleText: {
    display: '-webkit-box',
    minInlineSize: 0,
    overflow: 'hidden',
    WebkitLineClamp: 2,
    WebkitBoxOrient: 'vertical',
    fontWeight: 500,
    overflowWrap: 'anywhere',
  },
  cardIcons: {
    display: 'inline-flex',
    flex: 'none',
    gap: 4,
    alignItems: 'center',
  },
  attentionMark: {
    display: 'inline-flex',
    color: cssVar.colorWarningText,
  },
  pinButton: {
    display: 'inline-flex',
    flex: 'none',
    alignItems: 'center',
    justifyContent: 'center',
    inlineSize: 24,
    blockSize: 24,
    padding: 0,
    borderWidth: 0,
    borderRadius: cssVar.borderRadiusSM,
    backgroundColor: 'transparent',
    color: cssVar.colorTextSecondary,
    cursor: 'pointer',
  },
  cardWorker: {
    display: 'flex',
    marginBlockStart: 8,
    minInlineSize: 0,
  },
  cardFooter: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 4,
    marginBlockStart: 8,
    color: cssVar.colorTextSecondary,
    fontSize: cssVar.fontSizeSM,
    fontVariantNumeric: 'tabular-nums',
  },
  /** 底部每段各自不拆行：换行只发生在段之间，分隔符跟随前一段，不出现在行首。 */
  cardFooterSeg: {
    minInlineSize: 0,
    maxInlineSize: '100%',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  cardHost: {
    fontWeight: 500,
  },
  emptyColumn: {
    paddingBlock: 16,
    paddingInline: 12,
    color: cssVar.colorTextSecondary,
    fontSize: cssVar.fontSizeSM,
  },
  /** 检查器覆盖层：右侧 560 不透明浮层，看板保持原宽不重排。 */
  overlay: {
    position: 'absolute',
    insetBlockStart: 0,
    insetBlockEnd: 0,
    insetInlineEnd: 0,
    zIndex: 2,
    display: 'flex',
    flexDirection: 'column',
    inlineSize: 'min(560px, 100%)',
    minBlockSize: 0,
    overflow: 'hidden',
    borderInlineStartWidth: 1,
    borderInlineStartStyle: 'solid',
    borderInlineStartColor: cssVar.colorBorderSecondary,
    backgroundColor: cssVar.colorBgContainer,
  },
  overlayBody: {
    flex: '1 1 0',
    minBlockSize: 0,
    overflowX: 'hidden',
    overflowY: 'auto',
    scrollbarGutter: 'stable',
  },
  overlayBack: {
    display: 'flex',
    paddingBlock: 8,
    paddingInline: 12,
  },
  boardWrap: {
    position: 'relative',
    display: 'flex',
    flexDirection: 'column',
    flex: '1 1 0',
    gap: 12,
    minBlockSize: 0,
    minInlineSize: 0,
  },
  boardScroll: {
    display: 'flex',
    flexDirection: 'column',
    flex: '1 1 0',
    minBlockSize: 0,
    minInlineSize: 0,
  },
});
