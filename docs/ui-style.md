# 渲染层工程规范

状态：工程约定，2026-10-26。产品层的页面骨架、信息架构、交互模型和视觉规则以 [design-language.md](design-language.md) 为准；本文只保留实现这些规则所需的工程写法。两者冲突时以 design-language.md 为准，并同步修改本文。

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

## 页面与交互

页面骨架、列表行、检查器、弹窗、反馈、保存模型、空态与加载、关系展示不在本文重复定义，统一按 design-language.md：

| 主题 | 章节 |
| --- | --- |
| 导航、路由、页面骨架、响应式 | §3.1–§3.4 |
| 工作台、任务检查器、父/子 Agent、账号与渠道、定时任务、Bot 与设置 | §4 |
| 表面、几何、状态色、身份、时间、动效 | §5 |
| 保存模型、反馈、加载与空态、焦点与键盘 | §6 |
| 共享构件职责 | §7 |

工程上仍需遵守：

- 页面只通过 `router.ts` 生成和解析 hash；跨页跳转用 `<a href>`（`EntityLink` 已封装），不用回调传递「打开某条记录」。
- 长表单或高内容弹窗挂 `resourceStyles.modal` + `modalBody` + `modalFooter`（视口高度钳制 + 滚动包含 + 页脚换行），在宿主组件上用 `stylex.props` 展开，`classNames.body` / `classNames.footer` 传对应 className。
- 编辑/导入表单保留 `data-channels-scroll` 属性：`App.tsx` 的弹窗焦点管理依赖它。
- 新增页面先复用 `ui/` 的 `MasterDetail`、`Pane`、`SelectableList`、`SettingGroup`、`SettingRow`、`SaveBar`、`EntityLink` 等构件，不在特性目录重写第二套骨架；确需新增共享构件时提升到 `ui/`，特性私有的样式留在对应 `*-style.ts`。

## 共享构件

| 位置 | 内容 |
| --- | --- |
| `src/renderer/ui/` | 骨架、窗格、列表、设置行、保存条、实体链接、状态徽标、时间文本等共享构件；职责清单见 design-language.md §7 |
| `src/renderer/ui/styles.ts` | 版式微助手样式对象：`stack`/`tight`/`row`/`spread`/`nowrap`/`alignStart`/`meta`/`error`/`warn`/`wrap`/`numbers`/`srOnly` |
| `src/renderer/format/channel-label.ts` | 渠道显示名：`channelName`（列表行用，短格式）、`channelLabel`（选择器用，`label · engine` 格式），停用后缀 `（渠道停用）` 只在此定义 |
| `src/renderer/format/tag-colors.ts` | 标签语义色（唯一事实源） |

共享样式导出 StyleX 样式对象，调用方统一用 `{...stylex.props(styles.stack)}` 展开；不把样式对象直接当 `className` 字符串使用。

## 其他约定

- aria-label、`role="alert"`/`role="status"` 与 label 关联结构受 renderer 测试固定，重构时保持等价。
- 标签颜色继续由 `tag-colors.ts` 的语义表决定；v6 `Tag` 仍支持 gray/processing/success/warning/error/volcano/orange/purple/geekblue/magenta/cyan 这些预设与系统色。
- `SortableList` 拖拽手柄等第三方要求的运行时内联值仍走对应组件 prop；业务静态样式不得借内联样式绕过 StyleX。
- 所有现有页面都已完成 StyleX 迁移。不要重新引入 `className` 样式表、内联静态样式或第二套样式方案。
