# dsh-status-flair

[English](README.en.md) | 中文

DSH（DeepSeek Harness）Web 运行状态装扮插件。

把对话里那条运行状态（**深度求索中，用时 7秒 ···**）换成自己定义的样子：文案、颜色、字号、图标、扫光节奏。

不重写聊天组件，也不改 DSH 安装目录：外观走注入的 CSS，文案走对 `LocaleRuntime#translate` 的一层包装。

## 它改的是什么

| 层 | 官方来源（DSH 0.2.1-rc.2） | 本插件的做法 |
|---|---|---|
| 文案 | `@deepseek-ai/dsh-client-ui-chat` 的 `chat.deepDiving` / `chat.deepDivingFor` | 包装 `locale.translate`，只拦截这两个 key |
| 颜色 | `.running` 的 `color: var(--dsw-alias-label-deep-diving)` | 在 `[data-chat-running]` 上重设颜色与 `--dsw-alias-label-shimmer` |
| 字号 | `.running` 的 `font-size: calc(var(--dsh-content-font-size) - 2px)` | 覆盖 `font-size`，图标尺寸跟着字号走 |
| 图标 | 60 帧 APNG 当 `mask`（3 秒循环）+ 静态 SVG 降级 | 隐藏两层，容器自身用遮罩画预设图标（内置 SVG / 官方 APNG / 自定义 SVG·PNG） |
| 扫光 | `TextShimmer` 的 `_dsh-row-shimmer-*` 关键帧（1.5s，`steps(48)`，延迟 .3s） | 覆盖 `animation-duration` / `play-state`；0ms 即关闭 |

选择器只用稳定钩子：`[data-chat-running]`、`[data-shimmer]`、`:has(> [data-shimmer])`。构建期哈希类名（`xz4KEq_`、`_1rdzk_`）一律不用。

## 两层设计

- **外观预设（Look）**：颜色、字号、图标、扫光节奏。本身**不保存"是否随机"**。
- **文案预设（TextPreset）**：一组候选文案（命名的一组句子）。也不保存随机策略。
- **选择策略（selection）**：
  - 外观：固定某个预设，或从候选里随机抽；
  - 文案：先固定/随机抽**一组文案**，再在组内按「固定第一条 / 随机 / 顺序轮换」抽一条。

所以"随机外观 + 随机文案"不冲突：每轮先抽外观，再抽文案组，再抽句子；三个随机源互不干扰。文案随机被拆成两层，是这个插件最核心的设计。

**随机时机**：只在"进入新的思考状态"时抽一次，并在这一轮里保持不变。运行行消失即视为本轮结束，下一次重新抽，不会出现思考十几秒文案突然跳变。

## 默认项：直接拿 DSH 的

外观和文案各有一个 `default`（UI 里叫「默认（DSH 自带）」）。

- 外观选 `default` 时，插件**一个 CSS 变量都不设、`<html>` 标记也摘掉**，运行行完全由 DSH 自己渲染。
- 文案选 `default` 时，`translate` 原样放行，直接显示 DSH 自己的 `chat.deepDivingFor`。
- 这个 id 不占预设条目，插件里不复制官方配色/字号/鲸鱼/文案，所以 DSH 升级后默认项自动跟着变。
- 设置页预览会实时读取 `--dsw-alias-label-deep-diving`、`--dsh-content-font-size` 与官方 locale 字符串；默认外观的预览还会从 DSH 注入的样式表里取出官方鲸鱼遮罩（APNG data URL），连动画一起还原。
- **出厂配置只带三套外观预设，不带任何文案组**：首次运行时文案直接由官方运行行提供，需要自定义再新建。

## 细节

- **候选多选**：随机候选是可勾选的下拉（fixed 定位，不会被卡片裁掉），带「全部」摘要与一键全选；只剩一项时不允许取消，避免零候选。
- **预览的 ★**：★ 标在"当前预览实际抽到的那一行"上，外观与文案各一个；选项变化会重新抽样，不再是每次渲染重新随机导致的错位。固定模式另有「固定」小徽章。
- **自定义图标**：内置 6 个 SVG 图标，也可以粘贴 `<svg>…</svg>` 或上传 SVG / 透明 PNG。图标作为遮罩使用，只取 alpha 形状，颜色自动跟随预设配色；上传内容会清掉脚本、事件属性与外部引用。
- **鲸鱼图标**：图标下拉里有「鲸鱼（DSH 原生动画）」。它不复制素材，运行时从 DSH 注入的样式表里取出官方 APNG 遮罩；颜色、字号跟随预设，文字扫光仍由「扫光节奏」控制。鲸鱼自身的摆动速度是 APNG 自带的，CSS 改不了；想换动画就上传自己的 APNG（命名成 `.png` 即可）或改用 SVG。
- **页内草稿**：所有调整先进入页面草稿并即时作用于运行行/预览，只有点「保存修改」才写入配置；「放弃修改」或离开页面会撤回未保存的改动。保存/放弃按钮在顶部和底部各一组，状态行固定占位，不会让页面上下跳。
- **默认项按钮置灰**：默认行保留「编辑 / 复制 / 删除」三个按钮的位置并置灰，★ 与徽章因此和自定义行对齐。

## 占位符

文案里可以写 DSH 原生模板语法：

- `{duration}` —— 替换成 DSH 算好的用时（`7秒` / `7s`，跟着界面语言）；
- 其它 `{name}` 原样保留。

例：`正在深度求索 {duration}` → 「正在深度求索 7秒」，用时每秒更新。

## 语言

插件内置 `zh` / `en` 两套字典，界面语言跟随 DSH 的语言设置。出厂预设名（暖金色 / 梦幻紫 / 终端绿）、图标名、新建文案的默认句都会跟着翻译；用户自己改过的预设名保持原样，不会被翻译覆盖。

## 配置位置

**插件 → 本插件页面**（设置 → 插件 → 状态装扮）。面板直接渲染在插件页上：

- 启用开关、外观与文案两层策略（含多选候选）、实时预览；
- 外观预设与文案预设各自的新建 / 编辑 / 复制 / 删除；
- 顶部与底部各一组「保存修改 / 放弃修改」。

写入走 `ctx.configForms`（volatile 配置通道），保存失败会显式显示错误。

![配置界面](docs/img/UI.png)

## 安装

> 安装会改动 `%USERPROFILE%\.dsh` 下的 profile 配置，并且需要重启 DSH（重启会打断正在跑的会话）。请确认后执行。

仓库：<https://github.com/AkotaP/dsh-status-flair>

**在「插件」页里装**：侧边栏「插件」→「添加插件」，填入仓库地址 `https://github.com/AkotaP/dsh-status-flair`（同一个输入框也接受本地目录绝对路径和 tarball；发布到 npm 后也可以直接填包名 `dsh-status-flair`）。DSH 会先用 `git ls-remote` 探一次仓库再交给 pnpm，装完在列表里确认它是启用状态。

**一条命令**（等价写法）：

```powershell
dsh plugin --profile desktop add https://github.com/AkotaP/dsh-status-flair
# 发布到 npm 之后可以直接用包名：dsh plugin --profile desktop add dsh-status-flair
```

**让 agent 装**（把下面这段发给 DSH 里的 agent）：

> 把这个仓库装进当前 DSH 的 desktop profile：`https://github.com/AkotaP/dsh-status-flair`。用侧边栏「插件」页的「添加插件」，或 `dsh plugin --profile desktop add https://github.com/AkotaP/dsh-status-flair`。装完确认 profile 的 `dsh.profile.bundles` 里已经有 `dsh-status-flair`，然后**先问我**再重启 DSH，重启后确认插件页的「状态装扮」能打开配置面板。

**本地开发**（以 link 方式装进某个 profile，源码改动实时生效）：见下面的[开发](#开发)一节。

装好后**重启 DSH**，插件页的「状态装扮」里出现配置面板。卸载：侧边栏「插件」页里卸载，或 `dsh plugin --profile desktop remove dsh-status-flair`（并确认 `dsh.profile.bundles` 里已移除该项）。

## 实现要点

- **外观是纯 CSS 覆盖**：插件不接管运行行的渲染，只在启用时给 `<html>` 挂标记并写几个 CSS 变量，DSH 自己的组件照常工作。默认外观时连标记都不挂。
- **文案是一层 `translate` 包装**：只拦截 `chat.deepDiving` / `chat.deepDivingFor`，其它 namespace/key 原样透传；默认文案时直接放行。
- **配置是 volatile 通道**：宿主半只声明 schema，配置由 `ctx.configForms` 实时投影与写入；宿主还提供只读 `GET /status-flair/health`（含浏览器端心跳），方便无浏览器验证安装。
- **默认项不复制素材**：官方配色/字号来自 CSS 变量，鲸鱼遮罩来自 DSH 注入的样式表，官方文案来自 locale；DSH 升级后自动跟随。
- **图标是遮罩**：内置 SVG、官方 APNG 鲸鱼与自定义 SVG/PNG 都只取 alpha 形状，颜色由预设配色决定，扫光与字号联动。
- **旧配置迁移**：旧版 `presets[].texts` 在首次读取时自动迁移成独立 `textPresets`；golden 预设的旧名「暖金色思考」会自动改名为「暖金色」。
- **边界**：运行行不是槽位，没有官方替换点，本插件属于"缝隙"方案；DSH 升级后请先跑测试并刷新页面确认。

## 开发

```bash
# 离线测试：假 DOM + 假 ctx + 迷你 React
node --test --test-isolation=none
```

沙箱环境必须带 `--test-isolation=none`（默认的每文件子进程走管道会被沙箱拒绝）。

以 link 方式装进 profile 做真机调试：

```powershell
# profile 目录下
pnpm add link:<仓库绝对路径>
# 然后把 "dsh-status-flair" 追加到 profile package.json 的 dsh.profile.bundles，
# 改一次 cordis.patch.yml 内容触发热重组（HMR 比对内容，touch 无效）。
```

产物：`lib/index.js`（宿主半：Config schema + 只读健康路由）、`lib/client.js`（浏览器 bundle）。改 `lib/client.js` 由 client-hmr 轮询热更，页面不用刷新；改 `lib/index.js` 需要一次 profile 重组。

版本历史见 [`CHANGELOG.md`](./CHANGELOG.md)。

## 兼容性

- Node.js `>=20`
- DSH `>=0.2.1-rc.2`
- 需要装配 `@deepseek-ai/dsh-client-ui-settings`

## 许可

[MIT](./LICENSE)
