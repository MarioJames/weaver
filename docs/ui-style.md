# 渲染层页面风格规范（资源页）

适用范围：账号与渠道（`features/channels`）、父/子 Agent（`features/roles`），以及后续接入的其余资源管理页。主题 token（slate 中性色 + geekblue 操作色）由 `main.tsx` 与品牌规范（`docs/assets/brand/README.md`）决定，本规范不覆盖。

## 共享构件

| 位置 | 内容 |
| --- | --- |
| `src/renderer/ui/resource-style.ts` | 页面骨架类：`page`、`toolbar`、`list`、`rowActions`、`modal`/`modalBody`/`modalFooter`、`headerStatus` |
| `src/renderer/ui/styles.ts` | 版式微助手：`stack`/`tight`/`row`/`spread`/`nowrap`/`alignStart`/`meta`/`error`/`warn`/`wrap` 等 |
| `src/renderer/format/channel-label.ts` | 渠道显示名：`channelName`（列表行用，短格式）、`channelLabel`（选择器用，`label · engine` 格式），停用后缀 `（渠道停用）` 只在此定义 |
| `src/renderer/format/tag-colors.ts` | 标签语义色（唯一事实源） |

归属规则不变：一个特性私有的样式留在该特性的 `*-style.ts`；两个以上页面共用的构件提升到 `ui/`。

## 页面骨架

```
PageHeader / PolicyHeader（标题 + 描述 + 主操作）
├─ toolbar（筛选 NamedSelect + 次要操作，resourceStyles.toolbar）
├─ 提示层（Alert 错误 / notice / 导入结果，依次堆叠）
└─ 列表（resourceStyles.list 边框容器）或 Empty 空状态
```

- 编辑存量策略的页面（父/子 Agent）用 `PolicyHeader` 承载保存状态与保存/放弃按钮；逐操作即存即生效的页面（账号与渠道）用 `PageHeader` + 每行操作。这是行为差异，不是风格差异，保持各自入口。
- 列表容器：一个带边框圆角的纵向容器（`resourceStyles.list`），行间用 `border-block-start` 分隔；不在容器外再包卡片。

## 列表行

- 行内网格列模板属于特性私有（渠道页 `channelStyles.row`，四列：身份 / 连接状态 / 额度 / 操作；Agent 页为主从分栏 + SortableList，各自保留）。
- 行内操作统一 `size="small" type="text"` + lucide 图标（编辑 `Pencil`、删除 `Trash2` + `danger`、登录 `LogIn`、恢复派发 `Play`）；行内开关用 `NamedSwitch size="small"`。
- 操作列容器用 `resourceStyles.rowActions`；状态/说明文字用 `styles.meta`（次级）与 `styles.warn`（警告），错误用 `Text type="danger" role="alert"`。

## 弹窗

- 表单弹窗（编辑器、登录）宽 640；确认弹窗（删除、草稿切换）用默认宽度。
- 高内容弹窗统一挂 `resourceStyles.modal` + `modalBody` + `modalFooter`（视口高度钳制 + 滚动包含 + 页脚换行）。
- 危险确认的 ok 按钮 `danger: true`；确认弹窗用内置 `okText/onOk/confirmLoading` 页脚，只有多选择的弹窗才自定义 `footer`。
- 编辑/导入表单必须保留 `data-channels-scroll` 属性：`App.tsx` 的弹窗焦点管理依赖它。

## 空状态与加载

- 空状态一律 `Empty`（`@lobehub/ui` 顶层），必须给下一步动作按钮，不能只写"暂无数据"。
- 首次加载用 `Skeleton.Text animated`；轮询与静默刷新不触发骨架。

## 关系可见性

- 渠道行显示引用它的角色（`channelUsers`）；子 Agent 编辑器显示「被父 Agent 引用」（`roles-view.ts` 的 `ownerUsersOf`）。新增跨页引用时优先复用这两个纯函数，引用展示用文本即可。

## 其他约定

- 禁止内联 `style={{…}}`：一律落到对应 `*-style.ts` 的类里。唯一例外是 SortableList 拖拽手柄的 `touchAction: 'none'`——静态渲染测试只能看见内联样式（见 `renderer-labels.test.ts`），类里的 `touch-action` 是给真实浏览器的双保险。
- 组件只从 `@lobehub/ui/base-ui`（表单从 `@lobehub/ui/base-ui/form`）导入；`Empty`/`SortableList` 等少数组件只在顶层桶提供。
- aria-label、`role="alert"`/`role="status"` 与 label 关联结构受 renderer 测试固定，重构时保持等价。

## 后续接入

定时任务、Bot、设置页目前仍持有各自的列表与弹窗写法；接入时按上述骨架替换空状态、行操作与弹窗类即可，不需要一次性重排布局。
