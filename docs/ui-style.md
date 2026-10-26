# 渲染层页面风格规范

适用范围：整个渲染层（`src/renderer`），包括任务、账号与渠道、引擎、父/子 Agent、工作代理、定时任务、Bot 和设置页。主题由 `@lobehub/ui` 6 的静态 CSS 变量提供，`main.tsx` 通过 `setLobeTheme` 固定为浅色 + slate 中性色 + geekblue 操作色；本规范不覆盖主题定义。

## 运行与构建

- Node 最低版本为 22.22.0，与 `@lobehub/ui` 6.9 的 `engines` 一致；`package.json` 与 `README.md` 都以此为准。
- Vite 通过 `@stylexjs/unplugin` 的 `stylex.vite()` 编译 StyleX，完整接线见仓库根目录的 `vite.config.ts`。`@lobehub/ui` 的组件保持预构建，只把它发布的两个未编译常量文件 `@lobehub/ui/stylex/cssVar.stylex`、`@lobehub/ui/stylex/media.stylex` 放入 `optimizeDeps.exclude`。配置会删除官方插件自带的 `config` hook（它会把整个包移出预构建），并包装官方 `buildStart`：先等待原 hook 完成，再用 `createRequire(import.meta.url).resolve` 定位这两个常量文件，按原文件源码和文件名在相同插件上下文调用原 `transform` 预注册。常量因此在应用样式和首次开发态 CSS 收集之前完成 `defineConsts`，浏览器不会在运行时执行 `stylex.defineConsts` 而报错；UI 根入口仍预构建，不受影响。
- 测试脚本在 tsx 之后注册 `scripts/register-stylex.mjs`：`node --import tsx --import ./scripts/register-stylex.mjs --test 'tests/**/*.test.ts'`。`registerHooks` 的 `load` 先调用 `nextLoad`，再重新读取原始文件源码，交给 esbuild 编译 TS/TSX，最后由官方 StyleX Babel 插件转换；测试里的样式断言用 `tests/renderer/style-helpers.ts` 输出的编译结果。

## 依赖与入口

- `@lobehub/ui` 6 已移除 `/base-ui`：组件一律从 `@lobehub/ui` 根入口导入；受控表单从 `@lobehub/ui/form` 导入；控制台外壳从 `@lobehub/ui/dashboard` 导入。
- 不再安装或使用 `antd`、`antd-style`、`createStaticStyles`、`createStyles`。样式只写 `@stylexjs/stylex`。
- 全局样式在 `main.tsx` 按顺序导入：`./app/style.css`（首个 CSS，声明 cascade layer）、`@lobehub/ui/theme.css`、`@lobehub/ui/style.css`、`@lobehub/ui/global.css`。
- `app/style.css` 只保留文档级 reset（`html`/`body`/`#root` 尺寸、`fieldset` 归零、内容区滚动条预留），并放在 `@layer reset`；业务样式不得写回全局 CSS。
- Provider 与主题在 `main.tsx` 装配。v6 的主题状态挂在 `document.documentElement` 的 `data-theme`/`data-neutral-color`/`data-primary-color` 属性上，`theme.css` 提供对应的 `--lobe-*` 静态变量；不需要再套 `ThemeProvider`，局部换肤用 `ThemeScope`：

```tsx
import './app/style.css';
import '@lobehub/ui/theme.css';
import '@lobehub/ui/style.css';
import '@lobehub/ui/global.css';
import { ConfigProvider, setLobeTheme } from '@lobehub/ui';
import { zhCn } from '@lobehub/ui/i18n';
import { motion } from 'motion/react';

setLobeTheme({ appearance: 'light', neutralColor: 'slate', primaryColor: 'geekblue' });

<ConfigProvider locale="zh-CN" motion={motion} resources={zhCn} enableCustomFonts={false}>
  <App />
</ConfigProvider>;
```

  `motion` 是 `ConfigProvider` 的必填 prop；文案由 `resources` 提供，不要另套 `I18nProvider`。

## StyleX 写法

样式文件只使用 StyleX，并优先引用 `@lobehub/ui` 的主题常量：

```ts
import * as stylex from '@stylexjs/stylex';
import { cssVar } from '@lobehub/ui/stylex/cssVar.stylex';
import { media } from '@lobehub/ui/stylex/media.stylex';

export const exampleStyles = stylex.create({
  root: {
    display: 'flex',
    gap: 12,
    padding: 16,
    color: cssVar.colorText,
    backgroundColor: cssVar.colorBgContainer,
    borderBlockEndWidth: 1,
    borderBlockEndStyle: 'solid',
    borderBlockEndColor: cssVar.colorBorderSecondary,
  },
  title: {
    fontSize: { default: 14, [media.sm]: 12 },
  },
});
```

- 在宿主元素上展开 `{...stylex.props(exampleStyles.root)}`；组合多个样式用 `stylex.props(a, b, condition && c)`，不拼字符串、不写类名兼容层。
- 条件样式用 StyleX 的条件对象（如 `':hover'`、`':focus-visible'`、`'@media ...'`），不要用后代选择器模拟状态。父级折叠/选中状态由组件 prop 或 `useConsoleShell()` 等现有上下文决定要渲染哪个元素。
- 样式值走 `cssVar`；颜色、圆角、阴影、字体不写裸 hex/rgba。间距与尺寸可以写数值，保持 4 的倍数节奏。
- 用 StyleX 支持的长写属性：背景色写 `backgroundColor`（或 `backgroundImage`），边框写 `borderWidth` + `borderStyle` + `borderColor`。`background`、`border`、`animation` 等简写不被 StyleX 支持，编译时会被丢弃。
- 只在运行时测量得到的尺寸需要动态样式：

```ts
const dynamicStyles = stylex.create({
  width: (inlineSize: number) => ({ inlineSize }),
});

<div {...stylex.props(dynamicStyles.width(measuredWidth))} />;
```

- 不写静态 `style={{ … }}`；测量值、CSS 变量驱动的进度等动态值也通过 StyleX 函数样式或组件现有 prop 传入。
- `stylex.create` 的键名保持描述性 camelCase；一个特性私有的样式留在该特性的 `*-style.ts`，两个以上页面共用的构件提升到 `ui/`。

## 共享构件

| 位置 | 内容 |
| --- | --- |
| `src/renderer/ui/resource-style.ts` | 页面骨架样式对象：`page`、`toolbar`、`list`、`rowActions`、`modal`/`modalBody`/`modalFooter`、`headerStatus` |
| `src/renderer/ui/styles.ts` | 版式微助手样式对象：`stack`/`tight`/`row`/`spread`/`nowrap`/`alignStart`/`meta`/`error`/`warn`/`wrap`/`numbers`/`srOnly`；`agentLabel` + `agentName` 负责品牌图标与省略名 |
| `src/renderer/format/channel-label.ts` | 渠道显示名：`channelName`（列表行用，短格式）、`channelLabel`（选择器用，`label · engine` 格式），停用后缀 `（渠道停用）` 只在此定义 |
| `src/renderer/format/tag-colors.ts` | 标签语义色（唯一事实源） |

共享样式现在导出 StyleX 样式对象，调用方统一用 `{...stylex.props(styles.stack)}` 或 `{...stylex.props(resourceStyles.list)}`，不再把样式对象直接当 `className` 字符串使用。`agentLabel` 已由后代选择器改为 `agentLabel` 容器 + `agentName` 文本两层，以保留单行省略效果。

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

- 行内网格列模板属于特性私有（渠道页 `channelStyles.row`，四列：身份 / 连接状态 / 额度 / 操作；Agent 页为主从分栏 + SortableList，各自保留），用 StyleX 网格/弹性属性表达。
- 行内操作沿用 v6 `Button` / `ActionIcon` 的 `size`、`type`、`danger` 与图标组合；行内开关用 `NamedSwitch`。具体组件 API 以安装的 6.x 声明为准。
- 操作列容器用 `resourceStyles.rowActions`；状态/说明文字用 `styles.meta`（次级）与 `styles.warn`（警告），错误用 `Text type="danger" role="alert"`。

## 弹窗

- 表单弹窗（编辑器、登录）宽 640；确认弹窗（删除、草稿切换）用默认宽度。
- 高内容弹窗统一挂 `resourceStyles.modal` + `modalBody` + `modalFooter`（视口高度钳制 + 滚动包含 + 页脚换行），在宿主组件上用 `stylex.props` 展开，`classNames.body` / `classNames.footer` 传对应 className。
- 危险确认的 ok 按钮 `danger: true`；确认弹窗用内置 `okText/onOk/confirmLoading` 页脚，只有多选择的弹窗才自定义 `footer`。
- 编辑/导入表单必须保留 `data-channels-scroll` 属性：`App.tsx` 的弹窗焦点管理依赖它。

## 空状态与加载

- 空状态一律 `Empty`（`@lobehub/ui` 根入口），必须给下一步动作按钮，不能只写"暂无数据"。
- 首次加载用 `Skeleton` 的文本/块占位；轮询与静默刷新不触发骨架。

## 关系可见性

- 渠道行显示引用它的角色（`channelUsers`）；子 Agent 编辑器显示「被父 Agent 引用」（`roles-view.ts` 的 `ownerUsersOf`）。新增跨页引用时优先复用这两个纯函数，引用展示用文本即可。

## 其他约定

- aria-label、`role="alert"`/`role="status"` 与 label 关联结构受 renderer 测试固定，重构时保持等价。
- 标签颜色继续由 `tag-colors.ts` 的语义表决定；v6 `Tag` 仍支持 gray/processing/success/warning/error/volcano/orange/purple/geekblue/magenta/cyan 这些预设与系统色。
- `SortableList` 拖拽手柄等第三方要求的运行时内联值仍走对应组件 prop；业务静态样式不得借内联样式绕过 StyleX。

## 新增页面

所有现有页面都已完成 StyleX 迁移，新页面按上述骨架组织，并直接复用 `ui/resource-style.ts` 与 `ui/styles.ts`。不要重新引入 `className` 样式表、内联静态样式或第二套样式方案；确需新增共享构件时提升到 `ui/`，特性私有的样式留在对应 `*-style.ts`。
