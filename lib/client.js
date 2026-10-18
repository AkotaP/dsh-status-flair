/**
 * dsh-status-flair — 客户端半（浏览器 bundle）。
 *
 * 四个职责，刻意分开：
 *   1. 外观预设（Look）只描述"长什么样"；
 *   2. 文案预设（TextPreset）只描述"可以说什么"；
 *   3. 选择策略（selection）决定这一轮用哪个外观、哪组文案、组内哪一条；
 *   4. 运行行渲染仍是 DSH 自己的，插件只覆盖外观变量、改写两个 locale key。
 *
 * 随机行为永远不写进预设本身，所以同一个预设既能固定用，也能参与随机；
 * 外观与文案是两层，各自固定/随机，互不干扰。
 *
 * 运行行（"深度求索中，用时 7秒 ···"）由 @deepseek-ai/dsh-client-ui-chat 直接渲染，
 * 不在任何槽位里，所以这里走两条官方留下的缝隙：
 *   - 外观：注入 CSS 覆盖 [data-chat-running]（结构选择器，不碰构建期哈希类名）；
 *   - 文案：给 LocaleRuntime#translate 包一层，改写 chat.deepDiving / chat.deepDivingFor。
 *
 * 保留 id "default" 表示"直接用 DSH 自己的"：外观预设为 default 时插件完全不接管
 * CSS；文案预设为 default 时 translate 原样放行。官方样式与文案因此永远与 DSH
 * 同步，插件里不写死第二份。
 */
/**
 * 过渡兼容（包名从 @local/dsh-status-flair 改成 dsh-status-flair 之后）：
 * 正在运行的 DSH 宿主会把旧包名的 graph 行一直缓存到下一次重启（package-moved），
 * 而那一行也会加载同一份 client.js。两次都以同一个 id 注册会触发
 * "duplicate factory registration"。
 *
 * DSH 的 bundle 是按 combo 脚本拼接下发的：一段脚本里可能同时包含旧行与新行，
 * 条目顺序与 URL 里 `<id>/client.js` 的出现顺序一致。所以按"当前脚本元素内第几次
 * 执行"分配 id：旧行拿到空插件，新行拿到真正的插件。重启后旧行消失，这段分支
 * 自然不再命中。
 */
// 整份 bundle 包在 IIFE 里：DSH 可能把同一份 client.js 在一段 combo 脚本里执行两次，
// 经典脚本的顶层 const 会共享全局词法作用域，重复声明会直接 SyntaxError。
;(() => {
    const LEGACY_PACKAGE_ID = '@local/dsh-status-flair'
  const PACKAGE_ID = 'dsh-status-flair'
  const BUNDLE_PATTERN = /(?:@local\/)?dsh-status-flair\/client\.js/g

  /** 按出现顺序列出这段脚本 URL 里包含的、本插件自己的 bundle ids。 */
  function bundleIds(url) {
    const ids = []
    if (typeof url !== 'string' || url === '') return ids
    const pattern = new RegExp(BUNDLE_PATTERN.source, 'g')
    let match
    while ((match = pattern.exec(url)) !== null) {
      ids.push(match[0].charAt(0) === '@' ? LEGACY_PACKAGE_ID : PACKAGE_ID)
      if (pattern.lastIndex === match.index) pattern.lastIndex++
    }
    return ids
  }

  /**
   * 这次执行该注册哪个 id。
   * @param script - 正在执行的 <script>（document.currentScript），可能为 null。
   * @returns 浏览器模块 id。
   */
  function resolveModuleId(script) {
    try {
      const url = script !== null && script !== undefined && typeof script.src === 'string' ? script.src : ''
      const ids = bundleIds(url)
      if (ids.length === 0) return PACKAGE_ID
      const key = '__dshStatusFlairLoad'
      const seen = typeof script[key] === 'number' ? script[key] : 0
      script[key] = seen + 1
      return ids[seen] ?? PACKAGE_ID
    } catch (error) {
      return PACKAGE_ID
    }
  }

  function currentScriptElement() {
    try {
      return typeof document !== 'undefined' && document !== null ? document.currentScript : null
    } catch (error) {
      return null
    }
  }

  const MODULE_ID = resolveModuleId(currentScriptElement())

window.__ModuleLoader__.load({
  id: MODULE_ID,
  factory: (require) => {
    // 旧 graph 行的空壳：什么都不注入，等重启后这行消失。
    if (MODULE_ID === LEGACY_PACKAGE_ID) {
      return {
        apply() {},
        inject: [],
      }
    }
    'use strict'

    const React = require('react')
    const module = { exports: {} }
    const exports = module.exports

    // ============================== 常量 ==============================

    /** 插件文案命名空间。 */
    const NS = 'status-flair'
    /** 包名 = 浏览器模块 id；plugins.bundle.config 的 key 就是它。 */
    const PACKAGE_NAME = 'dsh-status-flair'
    /** 配置 UI 挂在插件页里该 bundle 自己的页面，而不是设置分区。 */
    const SLOT_NAME = 'plugins.bundle.config'
    /** profile 条目 id：settings 命名空间、configForms 的 key、槽位 id 都用它。 */
    const ENTRY_ID = 'status-flair'
    /** 挂在 <html> 上的启用标记，CSS 只在它存在时接管运行行。 */
    const ACTIVE_ATTR = 'data-dsh-status-flair'
    /** 「不显示图标」标记：挂这个属性时隐藏运行行的图标位。 */
    const NO_ICON_ATTR = 'data-dsh-status-flair-no-icon'
    /** 样式标签标识；热更需要"先删同名再插"。 */
    const CSS_ID = 'dsh-status-flair/status-flair.css'
    /** 顺序轮换游标在 localStorage 里的前缀。 */
    const CURSOR_PREFIX = 'dsh-status-flair/cursor/'
    /** 官方运行行上唯一稳定的标记。 */
    const RUNNING_SELECTOR = '[data-chat-running]'
    /** 这次思考最多只算一次随机：运行行消失 = 本轮结束。 */
    const RUN_WATCH_INTERVAL_MS = 120
    /** 保留 id：不存储条目，表示"用 DSH 自带的"（外观与文案各自一套）。 */
    const DEFAULT_ID = 'default'

    /**
     * 首次运行的默认配置。必须与宿主半 lib/index.js 的 DEFAULT_FLAIR 完全一致
     * （test/host.test.mjs 会断言两边相等，防止两边漂移）。
     */
    const DEFAULT_SELECTION = {
      presetMode: 'fixed', fixedPresetId: 'golden', presetIds: ['golden', 'violet', 'terminal'],
      textPresetMode: 'fixed', fixedTextPresetId: DEFAULT_ID, textPresetIds: [DEFAULT_ID], textMode: 'random',
    }
    function createStarterRules() {
      return [
        { id: 'starter-thinking', name: '思考与交互', nameKey: 'starterThinking', groupIds: ['waiting', 'thinking', 'questions', 'plan'] },
        { id: 'starter-information', name: '信息获取', nameKey: 'starterInformation', groupIds: ['read', 'readImage', 'search', 'webSearch', 'webFetch'] },
        { id: 'starter-execution', name: '执行与操作', nameKey: 'starterExecution', groupIds: ['write', 'edit', 'commands', 'code', 'subagents', 'tools'] },
        { id: 'starter-response', name: '回复', nameKey: 'starterResponse', groupIds: ['responding'] },
      ].map((r) => ({ ...r, groupIds: r.groupIds.map((id) => 'builtin:' + id), enabled: true, kind: 'activity', holdMs: 2000,
        selection: { presetMode: 'fixed', fixedPresetId: DEFAULT_ID, presetIds: [DEFAULT_ID],
          textPresetMode: 'fixed', fixedTextPresetId: DEFAULT_ID, textPresetIds: [DEFAULT_ID], textMode: 'random' } }))
    }
    const DEFAULT_FLAIR = {
      enabled: true,
      presets: [
        {
          id: 'golden',
          name: '暖金色',
          nameKey: 'golden',
          style: { color: '#EFB864', fontSize: 13, icon: 'sparkles', shimmerDuration: 2000 },
        },
        {
          id: 'violet',
          name: '梦幻紫',
          nameKey: 'violet',
          style: { color: '#A78BFA', fontSize: 13, icon: 'star', shimmerDuration: 1600 },
        },
        {
          id: 'terminal',
          name: '终端绿',
          nameKey: 'terminal',
          style: { color: '#64B49A', fontSize: 12, icon: 'terminal', shimmerDuration: 1100 },
        },
      ],
      // 默认只带外观预设；文案默认交给 DSH 自己的运行行。
      textPresets: [],
      selection: DEFAULT_SELECTION,
      eventGroups: [],
      eventRules: { enabled: false, minRefreshMs: 3000, rules: createStarterRules() },
      // 触发配置：每轮触发默认开启（保持历史行为），时间/步骤默认关闭。
      triggers: {
        look: { turn: { enabled: true }, time: { enabled: false, mode: 'fixed', fixedMs: 5000, minMs: 3000, maxMs: 9000 }, step: { enabled: false, every: 2 } },
        text: { turn: { enabled: true }, time: { enabled: false, mode: 'fixed', fixedMs: 5000, minMs: 3000, maxMs: 9000 }, step: { enabled: false, every: 2 } },
      },
    }

    /** 内置图标（24×24，遮罩用 alpha，靠 currentColor 着色）。 */
    const ICONS = {
      sparkles:
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="%23fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/><path d="M18.5 15.5l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7z"/></svg>',
      star: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="%23fff" d="M12 2.6l2.6 6.1 6.6.5-5 4.3 1.5 6.5L12 16.6l-5.7 3.4 1.5-6.5-5-4.3 6.6-.5z"/></svg>',
      moon: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="%23fff" d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>',
      terminal:
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="%23fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M7.5 9.5l3 2.5-3 2.5"/><path d="M13.5 15h3.5"/></svg>',
      wave: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="%23fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 12h3l2-6 3 12 3-9 2 3h6"/></svg>',
      dots: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><g fill="%23fff"><circle cx="6" cy="12" r="2.1"/><circle cx="12" cy="12" r="2.1"/><circle cx="18" cy="12" r="2.1"/></g></svg>',
    }
    const ICON_NAMES = Object.keys(ICONS)

    /** 出厂预设的显示名跟着界面语言走；用户改过名后就不再套用。 */
    const PRESET_NAME_KEYS = {
      golden: 'presetNameGolden',
      violet: 'presetNameViolet',
      terminal: 'presetNameTerminal',
    }
    const SHIPPED_PRESET_NAMES = {
      golden: '暖金色',
      violet: '梦幻紫',
      terminal: '终端绿',
    }
    /** 内置图标的可读名称。 */
    const ICON_KEYS = {
      sparkles: 'iconSparkles',
      star: 'iconStar',
      moon: 'iconMoon',
      terminal: 'iconTerminal',
      wave: 'iconWave',
      dots: 'iconDots',
      whale: 'iconWhale',
    }

    // ============================== 文案 ==============================

    const zh = {
      nav: '状态装扮',
      title: '状态装扮',
      desc: '改的是对话里那条「深度求索中，用时 7秒 ···」：外观（配色、字号、图标、扫光）和文案是两层，各自可以固定或随机。',
      summaryOff: '状态装扮已关闭',
      summaryOn: '外观 {name} · {presets} 个预设 · {texts} 组文案',
      enable: '启用',
      enableHint: '关闭后恢复 DSH 默认的蓝色鲸鱼与官方文案',
      modeTitle: '默认选择（无规则命中时）',
      presetMode: '外观选择',
      presetFixed: '固定一个预设',
      presetRandom: '从候选里随机',
      fixedPreset: '固定预设',
      textPresetMode: '文案选择',
      textPresetFixed: '固定一组文案',
      textPresetRandom: '从候选里随机',
      fixedTextPreset: '固定文案',
      candidates: '随机候选',
      textMode: '组内文案',
      textFirst: '固定第一条',
      textRandom: '随机',
      textSequential: '顺序轮换',
      strategyTitle: '选择配置', defaultStrategyTab: '默认选择',
      strategySourcesHint: '切换页签只改变显示；启用且命中的事件规则优先，未命中时使用默认选择。',
      eventEditDetails: '编辑规则配置', eventAddStarters: '添加入门规则',
      starterRulesHint: '只补齐缺少的入门项：思考与交互、信息获取、执行与操作、回复。新项的外观和文案均使用 DSH 自带；不覆盖已有设置，也不会开启总开关。',
      starterThinking: '思考与交互', starterInformation: '信息获取', starterExecution: '执行与操作', starterResponse: '回复',
      eventsTitle: '事件规则与分组',
      eventsHint: '从上往下匹配，第一条有效规则优先；未命中或未启用时，使用“默认选择”页的配置。切换时机作用于最终生效的选择配置。',
      eventsPriority: '事件规则优先 → 未命中时使用默认选择',
      eventRulesPanelTitle: '规则列表', eventGroupsPanelTitle: '事件分组库',
      eventRulesPanelHint: '这里添加和排序规则，列表越靠上优先级越高。',
      eventGroupsPanelHint: '这里只管理事件如何归类。分组需要被规则引用，才会影响外观和文案。',
      eventsEnable: '启用事件规则', eventRulesTab: '事件规则', eventGroupsTab: '管理分组',
      eventAddRule: '添加规则', eventNewRule: '新规则', eventAddGroup: '新建自定义分组', eventNewGroup: '新分组',
      eventName: '名称', eventKind: '类型', eventActivity: '活动期间', eventPulse: '瞬时结果',
      eventConditions: '匹配以下任意分组（OR）', eventCategories: '包含以下任意活动或输出状态（OR）',
      eventOutputStatus: '输出状态：', eventOutputTools: '工具执行中', eventToolActivities: '已识别的工具活动：',
      eventOutputHint: '无运行工具时区分等待、思考和回复；思考只认显式推理，回复指可见正文，不一定是最终答案。',
      eventTools: '具体工具名（每行一个，精确匹配）', eventToolHint: '活动组：类别或工具名满足其一。结果组：工具名可缩小结果范围；留空表示任意工具。未知扩展工具可在此补充。',
      eventResults: '结果类型', eventHold: '提示保持（秒）', eventRefresh: '最短刷新间隔（毫秒）',
      eventBuiltin: '内置只读，可复制', eventCustom: '自定义', eventInUse: '被 {n} 条规则引用，请先解除引用',
      eventNoRules: '还没有事件规则。添加一条，选择事件分组和对应的外观/文案。默认策略不会被修改。',
      eventNoGroups: '还没有自定义分组；内置分组可以直接使用。',
      eventMissingGroup: '分组缺失、类型不符或未选择：此规则暂不参与匹配。',
      eventMissingPreset: '预设已失效或候选为空：此规则暂不参与匹配，不会扩大到其他预设。',
      eventSourceReady: '已连接当前主会话', eventSourceMissing: '尚无可用的主会话事件源；默认策略仍然可用',
      eventCurrent: '当前规则：', eventFallback: '默认选择', eventPreview: '试抽这条规则',
      eventPreviewHint: '仅本地预览，不发送事件，不推进真实顺序游标，也不改变运行状态。',
      eventMoveUp: '上移', eventMoveDown: '下移', eventEnabled: '启用', eventRuleSelection: '命中后使用的选择配置',
      eventActivity_waiting: '等待响应', eventActivity_thinking: '思考中（显式推理）', eventActivity_responding: '回复中（可见正文）', eventActivity_read: '读取文件', eventActivity_readImage: '读取图片',
      eventActivity_search: '搜索', eventActivity_write: '写入文件', eventActivity_edit: '编辑 / 补丁',
      eventActivity_commands: '命令 / 终端', eventActivity_code: '执行代码', eventActivity_webSearch: '网页搜索',
      eventActivity_webFetch: '获取网页', eventActivity_subagents: '子代理', eventActivity_plan: '待办 / 目标',
      eventActivity_questions: '提问', eventActivity_tools: '其他工具',
      'eventActivity_tool-error': '工具异常', 'eventActivity_tool-success': '工具成功',
      triggersTitle: '切换时机',
      triggersHint: '运行中重新抽签的时机。外观与文案各自独立，默认只在每轮开始时抽一次。',
      layerLook: '外观',
      layerText: '文案',
      turnTrigger: '每轮触发',
      timeTrigger: '时间触发',
      stepTrigger: '步骤触发',
      triggerOff: '关闭',
      triggerOn: '开启',
      triggerEnable: '启用',
      triggerMode: '间隔方式',
      triggerFixed: '固定间隔',
      triggerRandom: '随机间隔',
      intervalSeconds: '间隔（秒）',
      minSeconds: '最短（秒）',
      maxSeconds: '最长（秒）',
      everySteps: '每 N 步',
      stepHint: '步骤来自 DSH 的 step/start 事件；拿不到事件源时该触发不生效。',
      previewTitle: '预览',
      previewAgain: '换一条',
      previewMeta: '外观 {look} · 文案 {texts}',
      previewing: '预览中',
      pinnedBadge: '固定',
      defaultLook: '默认（DSH 自带）',
      defaultTexts: '默认（DSH 自带）',
      officialLookMeta: '跟随 DSH · 官方配色 / 字号 / 鲸鱼 / 扫光',
      officialTextMeta: '跟随 DSH · 官方文案',
      presetsTitle: '我的预设',
      presetMeta: '{n}px · {icon} · {ms}ms',
      addPreset: '新建预设',
      textPresetsTitle: '我的文案',
      textPresetMeta: '{n} 条文案',
      addTextPreset: '新建文案',
      edit: '编辑',
      copy: '复制',
      remove: '删除',
      confirmRemove: '确认删除',
      cancel: '取消',
      save: '保存',
      saved: '已保存',
      saveChanges: '保存修改',
      discard: '放弃修改',
      apply: '应用',
      unsaved: '有未保存的修改',
      discarded: '已放弃修改，回到已保存的配置',
      saveFailed: '没保存成功：宿主拒绝了这次写入',
      unavailable: '这个部署没有设置通道，改动只在本次页面内有效',
      loading: '正在读取配置…',
      readOnly: '当前部署的设置为只读',
      name: '名称',
      texts: '候选文案',
      textsHint: '一行一条；写 {duration} 会替换成 DSH 算好的用时',
      color: '颜色',
      fontSize: '字号',
      icon: '图标',
      iconNone: '不显示图标',
      customIcon: '自定义',
      presetNameGolden: '暖金色',
      presetNameViolet: '梦幻紫',
      presetNameTerminal: '终端绿',
      newTextLine: '正在认真思考中…',
      iconSparkles: '星光',
      iconStar: '星星',
      iconMoon: '月亮',
      iconTerminal: '终端',
      iconWave: '波形',
      iconDots: '圆点',
      iconWhale: '鲸鱼（DSH 原生动画）',
      defaultLocked: '默认项由 DSH 提供，不能编辑或删除',
      iconSource: '自定义图标',
      iconSourceHint: '粘贴 SVG 代码，或上传 SVG / 透明 PNG。图标作为遮罩使用：只取 alpha 形状，颜色跟随预设配色。',
      iconUpload: '上传文件',
      iconSourceEmpty: '还没填图标时会退回内置图标',
      shimmer: '扫光节奏',
      shimmerDark: '扫光色（深色主题）',
      shimmerLight: '扫光色（浅色主题）',
      shimmerAuto: '自动（跟随主色）',
      autoLabel: '自动',
      shimmerColorHint: '留空 = 自动（深色主题提亮 / 浅色主题压暗）；可填 #rrggbb 或任意 CSS 颜色',
      shimmerHint: '毫秒；0 表示关闭扫光',
      newPresetName: '新预设',
      newTextName: '新文案',
      copySuffix: ' 副本',
      empty: '还没有自定义外观，先用默认的吧',
      emptyTexts: '还没有自定义文案，先用默认的吧',
      emptyPreset: '（这组文案是空的，会沿用官方文案）',
      noPreview: '这组文案没有内容，只能看外观',
      msAll: '全部',
      msNone: '未选择',
      msCount: '已选 {n} 项',
      msSelectAll: '全选',
      msLeastOne: '至少保留一项',
      seqHint: '顺序轮换按"每次进入思考状态"前进一格，同一轮里不会跳变',
    }

    const en = {
      nav: 'Status flair',
      title: 'Status flair',
      desc: 'Restyles the running row ("Deep diving …"): the look (colour, size, icon, shimmer) and the copy are two independent layers, each fixed or random.',
      summaryOff: 'Status flair is off',
      summaryOn: 'Look {name} · {presets} presets · {texts} text groups',
      enable: 'Enabled',
      enableHint: 'Turn off to restore the default blue whale and official copy',
      modeTitle: 'Default selection (when no rule matches)',
      presetMode: 'Look',
      presetFixed: 'One fixed preset',
      presetRandom: 'Random from candidates',
      fixedPreset: 'Fixed preset',
      textPresetMode: 'Copy',
      textPresetFixed: 'One fixed group',
      textPresetRandom: 'Random from candidates',
      fixedTextPreset: 'Fixed copy',
      candidates: 'Random candidates',
      textMode: 'Line in the group',
      textFirst: 'Always the first line',
      textRandom: 'Random',
      textSequential: 'Rotate in order',
      strategyTitle: 'Selection configuration', defaultStrategyTab: 'Default selection',
      strategySourcesHint: 'Tabs only change what is shown. Enabled matching event rules take precedence; otherwise the default selection applies.',
      eventEditDetails: 'Edit rule configuration', eventAddStarters: 'Add starter rules',
      starterRulesHint: 'Only missing starters are added: thinking/interaction, information gathering, execution/operations and replies. New items use DSH styling and copy; existing settings and the master switch stay unchanged.',
      starterThinking: 'Thinking and interaction', starterInformation: 'Information gathering', starterExecution: 'Execution and operations', starterResponse: 'Reply',
      eventsTitle: 'Event rules and groups',
      eventsHint: 'Match top to bottom: the first valid rule wins. If none matches or rules are off, use the Default selection tab. Switch timing applies within the effective selection.',
      eventsPriority: 'Event rules first → default selection when unmatched',
      eventRulesPanelTitle: 'Rule list', eventGroupsPanelTitle: 'Event group library',
      eventRulesPanelHint: 'Add and reorder rules here. Higher rules have higher priority.',
      eventGroupsPanelHint: 'Only event classification is managed here. A group affects looks and copy only when referenced by a rule.',
      eventsEnable: 'Enable event rules', eventRulesTab: 'Event rules', eventGroupsTab: 'Manage groups',
      eventAddRule: 'Add rule', eventNewRule: 'New rule', eventAddGroup: 'Add custom group', eventNewGroup: 'New group',
      eventName: 'Name', eventKind: 'Type', eventActivity: 'While active', eventPulse: 'Transient result',
      eventConditions: 'Match any group (OR)', eventCategories: 'Include any activity or output phase (OR)',
      eventOutputStatus: 'Output: ', eventOutputTools: 'Tools running', eventToolActivities: 'Detected tool activities: ',
      eventOutputHint: 'Without running tools, distinguish waiting, explicit reasoning and visible reply text. Reply text is not necessarily the final answer.',
      eventTools: 'Exact tool names (one per line)', eventToolHint: 'Activity: category OR tool name. Result: optional tool names narrow the result; empty means any tool. Add unknown extension tools here.',
      eventResults: 'Result types', eventHold: 'Hold hint (seconds)', eventRefresh: 'Minimum refresh interval (ms)',
      eventBuiltin: 'Built-in, read-only; copy to customize', eventCustom: 'Custom', eventInUse: 'Referenced by {n} rules; remove references first',
      eventNoRules: 'No event rules yet. Add one and choose groups, looks and copy. The default selection is kept unchanged.',
      eventNoGroups: 'No custom groups yet; built-in groups are ready to use.',
      eventMissingGroup: 'Missing, incompatible or unselected group: this rule is skipped.',
      eventMissingPreset: 'Missing preset or empty candidates: this rule is skipped, never expanded to unrelated presets.',
      eventSourceReady: 'Connected to the main Session', eventSourceMissing: 'No main Session event source yet; default selection still works',
      eventCurrent: 'Current rule: ', eventFallback: 'Default selection', eventPreview: 'Sample this rule',
      eventPreviewHint: 'Local preview only: no events, real sequence cursor changes, or running-state changes.',
      eventMoveUp: 'Move up', eventMoveDown: 'Move down', eventEnabled: 'Enabled', eventRuleSelection: 'Selection used by this rule',
      eventActivity_waiting: 'Waiting for output', eventActivity_thinking: 'Thinking (explicit reasoning)', eventActivity_responding: 'Replying (visible text)', eventActivity_read: 'Read files', eventActivity_readImage: 'Read images',
      eventActivity_search: 'Search', eventActivity_write: 'Write files', eventActivity_edit: 'Edit / patch',
      eventActivity_commands: 'Commands / terminal', eventActivity_code: 'Execute code', eventActivity_webSearch: 'Search the web',
      eventActivity_webFetch: 'Fetch pages', eventActivity_subagents: 'Subagents', eventActivity_plan: 'Todos / goals',
      eventActivity_questions: 'Questions', eventActivity_tools: 'Other tools',
      'eventActivity_tool-error': 'Tool error', 'eventActivity_tool-success': 'Tool success',
      triggersTitle: 'Switch timing',
      triggersHint: 'When a run re-draws while it is active. Looks and copy are independent and draw once per run by default.',
      layerLook: 'Look',
      layerText: 'Copy',
      turnTrigger: 'Each turn',
      timeTrigger: 'Time trigger',
      stepTrigger: 'Step trigger',
      triggerOff: 'Off',
      triggerOn: 'On',
      triggerEnable: 'Enable',
      triggerMode: 'Interval',
      triggerFixed: 'Fixed',
      triggerRandom: 'Random',
      intervalSeconds: 'Interval (s)',
      minSeconds: 'Min (s)',
      maxSeconds: 'Max (s)',
      everySteps: 'Every N steps',
      stepHint: 'Steps come from DSH step/start events; the trigger stays idle without an event source.',
      previewTitle: 'Preview',
      previewAgain: 'Another one',
      previewMeta: 'Look {look} · copy {texts}',
      previewing: 'Previewing',
      pinnedBadge: 'Fixed',
      defaultLook: 'Default (DSH)',
      defaultTexts: 'Default (DSH)',
      officialLookMeta: 'Follows DSH · official colour / size / whale / shimmer',
      officialTextMeta: 'Follows DSH · official copy',
      presetsTitle: 'My looks',
      presetMeta: '{n}px · {icon} · {ms}ms',
      addPreset: 'New look',
      textPresetsTitle: 'My copy',
      textPresetMeta: '{n} lines',
      addTextPreset: 'New copy',
      edit: 'Edit',
      copy: 'Duplicate',
      remove: 'Delete',
      confirmRemove: 'Confirm delete',
      cancel: 'Cancel',
      save: 'Save',
      saved: 'Saved',
      saveChanges: 'Save changes',
      discard: 'Discard changes',
      apply: 'Apply',
      unsaved: 'Unsaved changes',
      discarded: 'Discarded; back to the saved configuration',
      saveFailed: 'Not saved: the Host refused the write',
      unavailable: 'This deployment exposes no settings channel; changes last for this page only',
      loading: 'Reading configuration…',
      readOnly: 'Settings are read-only in this deployment',
      name: 'Name',
      texts: 'Candidate copy',
      textsHint: 'One line each; {duration} inserts the elapsed time DSH computed',
      color: 'Colour',
      fontSize: 'Font size',
      icon: 'Icon',
      iconNone: 'No icon',
      customIcon: 'Custom',
      presetNameGolden: 'Warm gold',
      presetNameViolet: 'Violet dream',
      presetNameTerminal: 'Terminal green',
      newTextLine: 'Thinking…',
      iconSparkles: 'Sparkles',
      iconStar: 'Star',
      iconMoon: 'Moon',
      iconTerminal: 'Terminal',
      iconWave: 'Wave',
      iconDots: 'Dots',
      iconWhale: 'Whale (DSH animation)',
      defaultLocked: 'Provided by DSH; it cannot be edited or deleted',
      iconSource: 'Custom icon',
      iconSourceHint: 'Paste SVG markup, or upload an SVG / transparent PNG. The icon is used as a mask: only its alpha shape is taken, colour follows the preset.',
      iconUpload: 'Upload file',
      iconSourceEmpty: 'Falls back to a built-in icon while this is empty',
      shimmer: 'Shimmer',
      shimmerDark: 'Sweep colour (dark theme)',
      shimmerLight: 'Sweep colour (light theme)',
      shimmerAuto: 'Auto (from main colour)',
      autoLabel: 'Auto',
      shimmerColorHint: 'Empty = automatic (lighter in dark themes, darker in light themes); accepts #rrggbb or any CSS colour',
      shimmerHint: 'Milliseconds; 0 turns the sweep off',
      newPresetName: 'New look',
      newTextName: 'New copy',
      copySuffix: ' copy',
      empty: 'No custom looks yet — the default one is in use',
      emptyTexts: 'No custom copy yet — the default one is in use',
      emptyPreset: '(this group is empty, so the official copy is used)',
      noPreview: 'This group has no lines, so only the look can be previewed',
      msAll: 'All',
      msNone: 'None',
      msCount: '{n} selected',
      msSelectAll: 'Select all',
      msLeastOne: 'Keep at least one',
      seqHint: 'Rotation advances once per thinking run, never mid-run',
    }

    // ============================== 纯逻辑 ==============================

    let random = Math.random

    /** 测试用：替换随机源。 */
    function setRandom(fn) {
      random = typeof fn === 'function' ? fn : Math.random
    }

    /** 只接受 #rgb / #rrggbb，统一成小写 6 位。 */
    function normalizeColor(value, fallback) {
      if (typeof value !== 'string') return fallback
      const raw = value.trim()
      const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(raw)
      if (short !== null) return ('#' + short[1] + short[1] + short[2] + short[2] + short[3] + short[3]).toLowerCase()
      if (/^#[0-9a-f]{6}$/i.test(raw)) return raw.toLowerCase()
      return fallback
    }

    function clampNumber(value, min, max, fallback) {
      const n = typeof value === 'number' ? value : Number(value)
      if (!Number.isFinite(n)) return fallback
      return Math.min(max, Math.max(min, n))
    }

    /**
     * 自定义图标清洗：只保留一段 <svg>...</svg>，去掉脚本、事件属性、foreignObject
     * 和除 #id 之外的 href。图标最终当遮罩用，颜色由预设配色决定。
     */
    function sanitizeSvgMarkup(raw) {
      if (typeof raw !== 'string') return ''
      const start = raw.indexOf('<svg')
      if (start === -1) return ''
      const end = raw.lastIndexOf('</svg>')
      if (end === -1 || end <= start) return ''
      let svg = raw.slice(start, end + 6)
      if (svg.length > 65536) return ''
      svg = svg.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<script[^>]*>/gi, '')
      svg = svg.replace(/<foreignObject[\s\S]*?<\/foreignObject>/gi, '')
      svg = svg.replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
      svg = svg.replace(/\s(?:xlink:)?href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi, (match, double, single) => {
        const value = double ?? single ?? ''
        return value.startsWith('#') ? match : ''
      })
      return svg
    }

    function normalizeIconSource(raw) {
      if (typeof raw !== 'string') return ''
      const value = raw.trim()
      if (value === '' || value.length > 262144) return ''
      if (value.startsWith('data:image/')) {
        return /^data:image\/(?:svg\+xml|png);base64,[A-Za-z0-9+/=]+$/i.test(value) ? value : ''
      }
      return sanitizeSvgMarkup(value)
    }

    /**
     * 自定义扫光色清洗：空串表示「自动」（按主题从预设主色派生）。
     * 浏览器里用 CSS.supports 校验；测试等无 CSS 环境只接受 #rgb / #rrggbb。
     */
    function normalizeShimmerColor(raw) {
      if (typeof raw !== 'string') return ''
      const value = raw.trim()
      if (value === '' || value.length > 120) return ''
      if (/[;{}]/.test(value)) return ''
      try {
        if (typeof CSS !== 'undefined' && CSS !== null && typeof CSS.supports === 'function') {
          return CSS.supports('color', value) ? value : ''
        }
      } catch (error) {
        /* 无 CSS 环境时走十六进制校验 */
      }
      return /^#[0-9a-f]{3}$|^#[0-9a-f]{6}$/i.test(value) ? normalizeColor(value, '') : ''
    }

    /** 样式字段归一化：越界或未知值一律退回安全值，避免写坏宿主配置。 */
    function normalizeStyle(raw) {
      const src = raw !== null && typeof raw === 'object' ? raw : {}
      const icon =
        src.icon === 'none' || src.icon === 'custom' || src.icon === 'whale' || ICON_NAMES.indexOf(src.icon) !== -1
          ? src.icon
          : 'sparkles'
      return {
        color: normalizeColor(src.color, '#EFB864'),
        fontSize: Math.round(clampNumber(src.fontSize, 9, 32, 13)),
        icon,
        iconSource: normalizeIconSource(src.iconSource),
        shimmerDuration: Math.round(clampNumber(src.shimmerDuration, 0, 12000, 1600)),
        /** 自定义扫光色：深色主题 / 浅色主题；空串 = 自动派生。 */
        shimmerDark: normalizeShimmerColor(src.shimmerDark),
        shimmerLight: normalizeShimmerColor(src.shimmerLight),
      }
    }

    /** 一条外观预设；文案不再挂在这里（旧配置的 texts 由迁移逻辑搬走）。 */
    function normalizePreset(raw, index) {
      const src = raw !== null && typeof raw === 'object' ? raw : {}
      const id = typeof src.id === 'string' && src.id.trim() !== '' ? src.id.trim() : 'preset-' + String(index + 1)
      const rawName = typeof src.name === 'string' && src.name.trim() !== '' ? src.name.trim() : id
      // 出厂预设改过名：旧配置里仍叫「暖金色思考」的 golden 预设跟着一起改名。
      const name = id === 'golden' && rawName === '暖金色思考' ? '暖金色' : rawName
      // nameKey 表示"这个名字是出厂名，可以跟着界面语言翻译"；用户改名后清空。
      const shipped = SHIPPED_PRESET_NAMES[id]
      const nameKey =
        PRESET_NAME_KEYS[id] === undefined
          ? ''
          : typeof src.nameKey === 'string' && src.nameKey === id
            ? id
            : name === shipped
              ? id
              : ''
      return { id, name, nameKey, style: normalizeStyle(src.style) }
    }

    /** 只保留非空字符串行。 */
    function readTexts(raw) {
      if (!Array.isArray(raw)) return []
      const out = []
      for (const item of raw) {
        if (typeof item !== 'string') continue
        const text = item.trim()
        if (text !== '') out.push(text)
      }
      return out
    }

    function normalizeTextPreset(raw, index) {
      const src = raw !== null && typeof raw === 'object' ? raw : {}
      const id = typeof src.id === 'string' && src.id.trim() !== '' ? src.id.trim() : 'texts-' + String(index + 1)
      const name = typeof src.name === 'string' && src.name.trim() !== '' ? src.name.trim() : id
      return { id, name, texts: readTexts(src.texts) }
    }

    /**
     * 旧版把 texts 放在预设里。升级后第一次读取时，把它们搬成独立的文案预设：
     * 一个旧预设的非空 texts 变成一组，id 用 text-<旧 id>，名字沿用预设名。
     */
    function collectLegacyTexts(rawPresets) {
      const groups = []
      const seen = new Set()
      for (const raw of Array.isArray(rawPresets) ? rawPresets : []) {
        const src = raw !== null && typeof raw === 'object' ? raw : {}
        const texts = readTexts(src.texts)
        if (texts.length === 0) continue
        const key = JSON.stringify(texts)
        if (seen.has(key)) continue
        seen.add(key)
        const baseId = typeof src.id === 'string' && src.id.trim() !== '' ? src.id.trim() : 'preset-' + String(groups.length + 1)
        const name = typeof src.name === 'string' && src.name.trim() !== '' ? src.name.trim() : baseId
        groups.push({ id: 'text-' + baseId, name, texts })
      }
      return groups
    }

    /** 候选 id 列表：保留已知 id（含 default），去重，未知 id 丢掉。 */
    function normalizeCandidates(rawList, ids) {
      if (!Array.isArray(rawList)) return []
      const out = []
      for (const id of rawList) {
        if (typeof id !== 'string') continue
        if (id !== DEFAULT_ID && ids.indexOf(id) === -1) continue
        if (out.indexOf(id) === -1) out.push(id)
      }
      return out
    }

    function uniqueTextPresets(list) {
      const seen = new Set([DEFAULT_ID])
      const out = []
      for (let index = 0; index < list.length; index++) {
        const preset = normalizeTextPreset(list[index], index)
        let id = preset.id
        let suffix = 2
        while (seen.has(id)) id = preset.id + '-' + suffix++
        seen.add(id)
        out.push(id === preset.id ? preset : { ...preset, id })
      }
      return out
    }

    /**
     * 触发配置归一化：毫秒夹到 [500, 600000]、步数夹到 [1, 100]，随机区间保证 min <= max。
     * 「每轮触发」缺省为开（历史行为），时间/步骤缺省为关。
     */
    function normalizeTriggers(raw) {
      const src = raw !== null && typeof raw === 'object' ? raw : {}
      const fallback = DEFAULT_FLAIR.triggers
      const layerOf = (rawLayer, defaults) => {
        const value = rawLayer !== null && typeof rawLayer === 'object' ? rawLayer : {}
        const turn = value.turn !== null && typeof value.turn === 'object' ? value.turn : {}
        const time = value.time !== null && typeof value.time === 'object' ? value.time : {}
        const step = value.step !== null && typeof value.step === 'object' ? value.step : {}
        let minMs = Math.round(clampNumber(time.minMs, 500, 600000, defaults.time.minMs))
        let maxMs = Math.round(clampNumber(time.maxMs, 500, 600000, defaults.time.maxMs))
        if (minMs > maxMs) {
          const swap = minMs
          minMs = maxMs
          maxMs = swap
        }
        return {
          turn: {
            // 只有显式写 false 才关闭；缺省/写坏时保持开启，旧配置行为不变。
            enabled: turn.enabled !== false,
          },
          time: {
            enabled: time.enabled === true,
            mode: time.mode === 'random' ? 'random' : 'fixed',
            fixedMs: Math.round(clampNumber(time.fixedMs, 500, 600000, defaults.time.fixedMs)),
            minMs,
            maxMs,
          },
          step: {
            enabled: step.enabled === true,
            every: Math.round(clampNumber(step.every, 1, 100, defaults.step.every)),
          },
        }
      }
      return { look: layerOf(src.look, fallback.look), text: layerOf(src.text, fallback.text) }
    }

    // DSH 0.2.1 Chat process-activity vocabulary. The internal classifier is not exported.
    const ACTIVITY_KINDS = ['thinking', 'read', 'readImage', 'search', 'write', 'edit', 'commands', 'code', 'webSearch', 'webFetch', 'subagents', 'plan', 'questions', 'tools']
    const OUTPUT_PHASES = ['waiting', 'thinking', 'responding']
    const MATCH_ACTIVITY_KINDS = [...OUTPUT_PHASES, ...ACTIVITY_KINDS.filter((kind) => kind !== 'thinking')]
    const PULSE_EVENTS = ['tool-error', 'tool-success']
    const BUILTIN_GROUPS = Object.freeze([
      ...MATCH_ACTIVITY_KINDS.map((kind) => Object.freeze({ id: 'builtin:' + kind, name: '', kind: 'activity', activityKinds: [kind], toolNames: [], events: [], builtIn: true })),
      ...PULSE_EVENTS.map((kind) => Object.freeze({ id: 'builtin:' + kind, name: '', kind: 'pulse', activityKinds: [], toolNames: [], events: [kind], builtIn: true })),
    ])
    function nativeActivity(name) {
      if (name === 'read') return 'read'
      if (name === 'read_image') return 'readImage'
      if (name === 'grep' || name === 'glob' || name.endsWith('_inspect')) return 'search'
      if (name === 'write') return 'write'
      if (name === 'edit' || name === 'apply_patch') return 'edit'
      if (['bash', 'pwsh', 'exec_command', 'write_stdin'].includes(name) || name.startsWith('terminal_')) return 'commands'
      if (name === 'run_code') return 'code'
      if (name === 'web_search') return 'webSearch'
      if (name === 'web_fetch') return 'webFetch'
      if (name === 'subagent' || name.startsWith('subagent_')) return 'subagents'
      if (['todo_write', 'create_goal', 'update_goal', 'get_goal'].includes(name)) return 'plan'
      if (['ask_user_question', 'request_user_input'].includes(name)) return 'questions'
      return 'tools'
    }
    function stringList(raw) {
      return [...new Set((Array.isArray(raw) ? raw : []).filter((v) => typeof v === 'string').map((v) => v.trim().slice(0, 200)).filter(Boolean))].slice(0, 200)
    }
    function normalizeEventGroups(raw) {
      const seen = new Set(BUILTIN_GROUPS.map((g) => g.id))
      return (Array.isArray(raw) ? raw : []).slice(0, 100).flatMap((g) => {
        if (!g || typeof g !== 'object' || typeof g.id !== 'string') return []
        const id = g.id.trim().slice(0, 200)
        if (!id || id.startsWith('builtin:') || seen.has(id)) return []
        seen.add(id)
        const kind = g.kind === 'pulse' ? 'pulse' : 'activity'
        return [{ id, name: typeof g.name === 'string' ? g.name.slice(0, 100) : id, kind,
          activityKinds: kind === 'activity' ? stringList(g.activityKinds).filter((v) => MATCH_ACTIVITY_KINDS.includes(v)) : [],
          toolNames: stringList(g.toolNames), events: kind === 'pulse' ? stringList(g.events).filter((v) => PULSE_EVENTS.includes(v)) : [] }]
      })
    }
    function normalizeEventRules(raw) {
      const src = raw && typeof raw === 'object' ? raw : {}
      const seen = new Set()
      return { enabled: src.enabled === true, minRefreshMs: Math.round(clampNumber(src.minRefreshMs, 0, 5000, DEFAULT_FLAIR.eventRules.minRefreshMs)),
        rules: (src.rules === undefined ? createStarterRules() : Array.isArray(src.rules) ? src.rules : []).slice(0, 200).flatMap((r) => {
          if (!r || typeof r !== 'object' || typeof r.id !== 'string') return []
          const id = r.id.trim().slice(0, 200)
          if (!id || seen.has(id)) return []
          seen.add(id)
          const s = r.selection && typeof r.selection === 'object' ? r.selection : {}
          return [{ id, name: typeof r.name === 'string' ? r.name.slice(0, 100) : id, nameKey: typeof r.nameKey === 'string' ? r.nameKey : '', enabled: r.enabled !== false,
            kind: r.kind === 'pulse' ? 'pulse' : 'activity', groupIds: stringList(r.groupIds), holdMs: Math.round(clampNumber(r.holdMs, 500, 30000, 2000)),
            selection: { presetMode: s.presetMode === 'random' ? 'random' : 'fixed', fixedPresetId: typeof s.fixedPresetId === 'string' ? s.fixedPresetId : '', presetIds: stringList(s.presetIds),
              textPresetMode: s.textPresetMode === 'random' ? 'random' : 'fixed', fixedTextPresetId: typeof s.fixedTextPresetId === 'string' ? s.fixedTextPresetId : '', textPresetIds: stringList(s.textPresetIds),
              textMode: ['first', 'sequential'].includes(s.textMode) ? s.textMode : 'random' } }]
        }) }
    }
    function eventGroupsOf(value) { return [...BUILTIN_GROUPS, ...value.eventGroups] }
    function validRuleSelection(value, s) {
      const looks = [DEFAULT_ID, ...value.presets.map((p) => p.id)]
      const texts = [DEFAULT_ID, ...value.textPresets.map((p) => p.id)]
      return (s.presetMode === 'fixed' ? looks.includes(s.fixedPresetId) : s.presetIds.some((id) => looks.includes(id))) &&
        (s.textPresetMode === 'fixed' ? texts.includes(s.fixedTextPresetId) : s.textPresetIds.some((id) => texts.includes(id)))
    }
    function ruleIssue(value, rule) {
      const groups = eventGroupsOf(value)
      if (!rule.groupIds.length || rule.groupIds.some((id) => !groups.some((g) => g.id === id && g.kind === rule.kind))) return 'eventMissingGroup'
      if (!validRuleSelection(value, rule.selection)) return 'eventMissingPreset'
      return ''
    }
    function groupMatches(group, call, event) {
      // For pulse groups the optional tool names narrow the event, rather than firing on every tool result.
      if (group.kind === 'pulse') return group.events.includes(event) && (!group.toolNames.length || group.toolNames.includes(call.name))
      return group.activityKinds.includes(call.activity) || group.toolNames.includes(call.name)
    }
    function selectEventRule(value, state, now) {
      if (!value.eventRules.enabled || !state.available || state.turn === null || state.turn === undefined) return null
      const groups = eventGroupsOf(value)
      return value.eventRules.rules.find((r) => r.enabled && !ruleIssue(value, r) && r.groupIds.some((id) => {
        const group = groups.find((g) => g.id === id)
        return r.kind === 'activity'
          ? state.calls.some((call) => groupMatches(group, call)) || (!state.calls.length && groupMatches(group, { name: '', activity: OUTPUT_PHASES.includes(state.phase) ? state.phase : 'waiting' }))
          : state.pulses.some((p) => now - p.at < r.holdMs && groupMatches(group, p, p.event))
      })) ?? null
    }

    /** 配置归一化：宿主上存的东西可能被手改过，这里必须能容错并迁移旧结构。 */
    function normalizeFlair(raw) {
      const src = raw !== null && typeof raw === 'object' ? raw : {}

      const presets = []
      const seen = new Set([DEFAULT_ID])
      const lookList = Array.isArray(src.presets) ? src.presets : []
      for (let index = 0; index < lookList.length; index++) {
        const preset = normalizePreset(lookList[index], index)
        let id = preset.id
        let suffix = 2
        while (seen.has(id)) id = preset.id + '-' + suffix++
        seen.add(id)
        presets.push(id === preset.id ? preset : { ...preset, id })
      }

      const legacyGroups = collectLegacyTexts(lookList)
      const declaredTextPresets = Array.isArray(src.textPresets) ? src.textPresets : null
      const legacy =
        declaredTextPresets === null || (declaredTextPresets.length === 0 && legacyGroups.length > 0)
      const textPresets = uniqueTextPresets(legacy ? legacyGroups : declaredTextPresets ?? [])

      const lookIds = presets.map((preset) => preset.id)
      const textIds = textPresets.map((preset) => preset.id)
      const selection = src.selection !== null && typeof src.selection === 'object' ? src.selection : {}

      const validLookId = (id) => typeof id === 'string' && (id === DEFAULT_ID || lookIds.indexOf(id) !== -1)
      const validTextId = (id) => typeof id === 'string' && (id === DEFAULT_ID || textIds.indexOf(id) !== -1)

      const presetMode = selection.presetMode === 'random' ? 'random' : 'fixed'
      const fixedPresetId = validLookId(selection.fixedPresetId)
        ? selection.fixedPresetId
        : lookIds.length > 0
          ? lookIds[0]
          : DEFAULT_ID
      let presetIds = normalizeCandidates(selection.presetIds, lookIds)
      if (presetIds.length === 0) presetIds = lookIds.length > 0 ? lookIds.slice() : [DEFAULT_ID]

      let textPresetMode
      let fixedTextPresetId
      let textPresetIds
      if (legacy) {
        // 旧配置只有一层：外观随机时文案跟着随机；固定时跟着固定那个预设的文案组。
        textPresetMode = presetMode
        const mapped = 'text-' + (typeof selection.fixedPresetId === 'string' ? selection.fixedPresetId : '')
        fixedTextPresetId = textIds.indexOf(mapped) !== -1 ? mapped : textIds.length > 0 ? textIds[0] : DEFAULT_ID
        textPresetIds = textIds.length > 0 ? textIds.slice() : [DEFAULT_ID]
      } else {
        textPresetMode = selection.textPresetMode === 'random' ? 'random' : 'fixed'
        fixedTextPresetId = validTextId(selection.fixedTextPresetId)
          ? selection.fixedTextPresetId
          : textIds.length > 0
            ? textIds[0]
            : DEFAULT_ID
        textPresetIds = normalizeCandidates(selection.textPresetIds, textIds)
        if (textPresetIds.length === 0) textPresetIds = textIds.length > 0 ? textIds.slice() : [DEFAULT_ID]
      }

      const textMode =
        selection.textMode === 'first' || selection.textMode === 'sequential' ? selection.textMode : 'random'

      return {
        enabled: src.enabled !== false,
        presets,
        textPresets,
        selection: {
          presetMode,
          fixedPresetId,
          presetIds,
          textPresetMode,
          fixedTextPresetId,
          textPresetIds,
          textMode,
        },
        triggers: normalizeTriggers(src.triggers),
        eventGroups: normalizeEventGroups(src.eventGroups),
        eventRules: normalizeEventRules(src.eventRules),
      }
    }

    /** "默认"外观：不存条目，渲染/预览时都按 builtIn 处理。 */
    const DEFAULT_LOOK = Object.freeze({ id: DEFAULT_ID, name: '', builtIn: true, style: null })
    /** "默认"文案：translate 原样放行，用 DSH 自己的文案。 */
    const DEFAULT_TEXTS = Object.freeze({ id: DEFAULT_ID, name: '', builtIn: true, texts: [] })

    function isBuiltIn(item) {
      return item === null || item === undefined || item.builtIn === true
    }

    /** UI 里的完整候选列表（默认项永远排第一）。 */
    function lookOptions(flair) {
      return [DEFAULT_LOOK, ...flair.presets]
    }
    function textOptions(flair) {
      return [DEFAULT_TEXTS, ...flair.textPresets]
    }

    function findLook(flair, id) {
      if (id === DEFAULT_ID) return DEFAULT_LOOK
      return flair.presets.find((preset) => preset.id === id) ?? null
    }
    function findTextPreset(flair, id) {
      if (id === DEFAULT_ID) return DEFAULT_TEXTS
      return flair.textPresets.find((preset) => preset.id === id) ?? null
    }

    function candidatesOf(flair, ids, all, custom, fallback) {
      const picked = all.filter((option) => ids.indexOf(option.id) !== -1)
      if (picked.length > 0) return picked
      return custom.length > 0 ? custom : [fallback]
    }

    /** 随机候选：selection.presetIds 有交集时用交集，否则退回全部自定义预设（没有则默认）。 */
    function candidatePresets(flair) {
      return candidatesOf(flair, flair.selection.presetIds, lookOptions(flair), flair.presets, DEFAULT_LOOK)
    }
    function candidateTextPresets(flair) {
      return candidatesOf(flair, flair.selection.textPresetIds, textOptions(flair), flair.textPresets, DEFAULT_TEXTS)
    }

    function pick(list) {
      return list[Math.floor(random() * list.length) % list.length]
    }

    /** 本轮用哪个外观：固定取 fixedPresetId（可以是 default），随机从候选里抽。 */
    function choosePreset(flair) {
      if (flair.selection.presetMode !== 'random') {
        const fixed = findLook(flair, flair.selection.fixedPresetId)
        if (fixed !== null) return fixed
        return flair.presets.length > 0 ? flair.presets[0] : DEFAULT_LOOK
      }
      const candidates = candidatePresets(flair)
      return candidates.length > 0 ? pick(candidates) : DEFAULT_LOOK
    }

    /** 本轮用哪组文案：同样是固定/随机两层。 */
    function chooseTextPreset(flair) {
      if (flair.selection.textPresetMode !== 'random') {
        const fixed = findTextPreset(flair, flair.selection.fixedTextPresetId)
        if (fixed !== null) return fixed
        return flair.textPresets.length > 0 ? flair.textPresets[0] : DEFAULT_TEXTS
      }
      const candidates = candidateTextPresets(flair)
      return candidates.length > 0 ? pick(candidates) : DEFAULT_TEXTS
    }

    /** 顺序轮换游标：localStorage 优先，坏值/无存储时退回内存。 */
    const cursorMemory = new Map()
    function readCursor(key) {
      try {
        const raw = globalThis.localStorage !== undefined ? globalThis.localStorage.getItem(key) : null
        if (raw !== null && raw !== undefined && raw !== '') {
          const parsed = Number(raw)
          if (Number.isFinite(parsed)) return parsed
        }
      } catch (error) {
        /* 无存储环境：只用内存 */
      }
      return cursorMemory.get(key)
    }
    function writeCursor(key, value) {
      cursorMemory.set(key, value)
      try {
        if (globalThis.localStorage !== undefined) globalThis.localStorage.setItem(key, String(value))
      } catch (error) {
        /* 忽略：下次退回内存 */
      }
    }

    /** 在一组文案里抽一条；空组返回 null（调用方据此沿用官方文案）。 */
    function chooseText(preset, mode, scope = '') {
      if (isBuiltIn(preset)) return null
      const texts = preset.texts
      if (texts.length === 0) return null
      if (mode === 'first') return texts[0]
      if (mode === 'sequential') {
        const key = CURSOR_PREFIX + scope + preset.id
        const previous = readCursor(key)
        const index = Number.isFinite(previous) ? (previous + 1) % texts.length : 0
        writeCursor(key, index)
        return texts[index]
      }
      return pick(texts)
    }

    /** 候选列表里的勾选/取消（UI 与测试共用）。 */
    function toggleCandidate(list, id, checked) {
      const next = Array.isArray(list) ? list.filter((item) => item !== id) : []
      if (checked) next.push(id)
      return next
    }

    /**
     * 占位符替换。DSH 官方模板写法就是 {duration}，这里沿用同一套语法；
     * 未知占位符原样保留。
     */
    function interpolate(text, params) {
      if (params === undefined || params === null) return String(text)
      return String(text).replace(/\{(\w+)\}/g, (match, name) =>
        Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match,
      )
    }

    /** 图标 → 可直接塞进 mask 的 data URI。 */
    function iconDataUri(name) {
      const svg = ICONS[name] ?? ICONS.sparkles
      return 'data:image/svg+xml,' + encodeURIComponent(svg.replace(/%23/g, '#'))
    }

    /** 预设图标 → mask 用的 data URI；自定义图标优先，空则退回内置图标。 */
    function iconMaskUri(style) {
      // 原生鲸鱼：从 DSH 注入的样式表里取官方 APNG 遮罩（与默认外观预览同一份），不复制素材。
      if (style !== null && style !== undefined && style.icon === 'whale') {
        const whale = officialWhaleMask()
        return whale === null ? iconDataUri('sparkles') : whale.dataUrl
      }
      const source = style !== null && style !== undefined && typeof style.iconSource === 'string' ? style.iconSource : ''
      if (style !== null && style !== undefined && style.icon === 'custom' && source !== '') {
        // Chromium 在 data URI 遮罩里会把 currentColor 解析成透明；遮罩只看 alpha，
        // 直接换成实色，用户从别处拷来的 fill="currentColor" 图标也能正常显示。
        return source.startsWith('data:image/') ? source : 'data:image/svg+xml,' + encodeURIComponent(source.replace(/currentColor/gi, '#000'))
      }
      return iconDataUri(style !== null && style !== undefined ? style.icon : 'sparkles')
    }

    function lookLabel(look, t) {
      if (isBuiltIn(look)) return t('defaultLook')
      const key = typeof look.nameKey === 'string' && look.nameKey !== '' ? PRESET_NAME_KEYS[look.id] : undefined
      return key === undefined ? look.name : t(key)
    }

    /** 图标 id → 可读名称（自定义图标用「自定义」）。 */
    function iconLabel(name, t) {
      if (name === 'none') return t('iconNone')
      if (name === 'custom') return t('customIcon')
      const key = ICON_KEYS[name]
      return key === undefined ? name : t(key)
    }
    function textPresetLabel(preset, t) {
      return isBuiltIn(preset) ? t('defaultTexts') : preset.name
    }

    // ---------- 官方文案（直接问 DSH 要，不复制一份） ----------

    /** apply 时绑定的 locale 运行时与它的原始 translate。 */
    let localeRuntime = null
    let officialTranslate = null
    /** 主题服务运行时可选项；拿不到时退回读 color-scheme 计算值。 */
    let themeRuntime = null

    /**
     * 当前主题的深浅色。原生扫光用主题变量（浅色 30% 近黑 / 深色 45% 近白），
     * 我们覆盖这个变量时必须跟着主题走，否则浅色模式下扫光会发白。
     * @returns 'light' | 'dark'；无法判断时按深色处理（保持历史行为）。
     */
    function currentColorScheme() {
      try {
        if (themeRuntime !== null && themeRuntime !== undefined && typeof themeRuntime.getSnapshot === 'function') {
          const snapshot = themeRuntime.getSnapshot()
          const scheme = snapshot !== null && snapshot !== undefined && snapshot.active !== undefined ? snapshot.active.colorScheme : ''
          if (scheme === 'light' || scheme === 'dark') return scheme
        }
      } catch (error) {
        /* 退回计算值 */
      }
      try {
        if (typeof getComputedStyle === 'function' && typeof document !== 'undefined' && document.documentElement !== undefined) {
          const scheme = getComputedStyle(document.documentElement).colorScheme ?? ''
          if (/dark/i.test(scheme)) return 'dark'
          if (/light/i.test(scheme)) return 'light'
        }
      } catch (error) {
        /* 退回落深色 */
      }
      return 'dark'
    }

    /**
     * 扫光色：优先用预设里为该主题配置的自定义颜色；留空时按主题从主色派生
     * （深色往白里提：45% 预设色 + 55% 白；浅色往黑里压：70% 预设色 + 30% 黑）。
     * @param style - 预设样式（可只带 color/shimmerDark/shimmerLight）。
     * @returns 可直接写进 CSS 变量的颜色表达式。
     */
    function shimmerColor(style) {
      const scheme = currentColorScheme()
      const src = style !== null && typeof style === 'object' ? style : {}
      const custom = scheme === 'light' ? src.shimmerLight : src.shimmerDark
      if (typeof custom === 'string' && custom !== '') return custom
      const color = typeof src.color === 'string' && src.color !== '' ? src.color : '#EFB864'
      return scheme === 'light'
        ? 'color-mix(in srgb, ' + color + ' 70%, #000000)'
        : 'color-mix(in srgb, ' + color + ' 45%, #ffffff)'
    }

    /** #rrggbb → [r, g, b]；无法解析时返回 null。 */
    function parseHexColor(value) {
      if (typeof value !== 'string') return null
      const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(value.trim())
      if (match === null) return null
      return [parseInt(match[1], 16), parseInt(match[2], 16), parseInt(match[3], 16)]
    }

    /** 在不透明 sRGB 里把两个颜色按比例混合；weight 是目标色的占比。 */
    function blendHex(color, target, weight) {
      const from = parseHexColor(color)
      const to = parseHexColor(target)
      if (from === null || to === null) return color
      const hex = from
        .map((channel, index) => Math.round(channel * (1 - weight) + to[index] * weight))
        .map((channel) => channel.toString(16).padStart(2, '0'))
        .join('')
      return '#' + hex
    }

    /**
     * 「自动」扫光色对应的实色近似值（供取色面板显示；真正的运行值仍是 color-mix）。
     * 与 shimmerColor 的自动分支同一比例：深色 55% 白、浅色 30% 黑。
     * @param style - 预设样式。
     * @returns #rrggbb 近似色。
     */
    function autoShimmerHex(style, forcedScheme) {
      const src = style !== null && typeof style === 'object' ? style : {}
      const color = typeof src.color === 'string' && src.color !== '' ? src.color : '#EFB864'
      const scheme = forcedScheme === 'light' || forcedScheme === 'dark' ? forcedScheme : currentColorScheme()
      return scheme === 'light' ? blendHex(color, '#000000', 0.3) : blendHex(color, '#ffffff', 0.55)
    }

    function officialString(key, params) {
      if (localeRuntime === null || typeof officialTranslate !== 'function') return ''
      try {
        const value = officialTranslate.call(localeRuntime, 'chat', key, params)
        return typeof value === 'string' ? value : ''
      } catch (error) {
        return ''
      }
    }

    /** 预览用示例用时：数字 + DSH 自己的单位词，跟着语言走。 */
    function sampleDuration() {
      return '7' + officialString('duration.secondUnit')
    }

    /** DSH 官方的运行行文案（预览默认文案时用）。 */
    function officialLabel() {
      const label = officialString('chat.deepDivingFor', { duration: sampleDuration() })
      if (label !== '') return label
      return officialString('chat.deepDiving')
    }

    /**
     * 从 DSH 自己注入的样式里取出官方的鲸鱼遮罩（APNG data URL + 位置/尺寸/模式），
     * 不在插件里复制一份素材。找不到就返回 null，预览退化成纯文字。
     */
    function extractWhaleMask(cssText) {
      if (typeof cssText !== 'string' || cssText === '') return null
      const match = /\.([A-Za-z0-9_-]*runningWhaleAnimated)[^{}]*\{[^{}]*mask\s*:\s*url\(\s*(['"]?)(data:image\/png;base64,[^)'"]*)\2\s*\)([^;}]*)/.exec(cssText)
      if (match === null) return null
      return { dataUrl: match[3], suffix: match[4].trim() }
    }

    function searchWhaleRules(rules) {
      if (rules === undefined || rules === null) return null
      for (const rule of Array.from(rules)) {
        if (rule.cssRules !== undefined && rule.cssRules !== null) {
          const nested = searchWhaleRules(rule.cssRules)
          if (nested !== null) return nested
          continue
        }
        const found = extractWhaleMask(typeof rule.cssText === 'string' ? rule.cssText : '')
        if (found !== null) return found
      }
      return null
    }

    /** 缓存：样式表在页面启动早期就注入完毕，设置页打开时肯定能扫到。 */
    let whaleMask
    let whaleMaskTried = false
    function resetWhaleMaskCache() {
      whaleMask = undefined
      whaleMaskTried = false
    }
    function officialWhaleMask() {
      if (whaleMaskTried) return whaleMask
      whaleMaskTried = true
      whaleMask = null
      try {
        const sheets =
          typeof document !== 'undefined' && document !== null && document.styleSheets !== undefined && document.styleSheets !== null
            ? document.styleSheets
            : []
        for (const sheet of Array.from(sheets)) {
          let rules
          try {
            rules = sheet.cssRules
          } catch (error) {
            continue
          }
          const found = searchWhaleRules(rules)
          if (found !== null) {
            whaleMask = found
            return whaleMask
          }
        }
        const nodes = typeof document !== 'undefined' && document !== null && document.querySelectorAll !== undefined ? document.querySelectorAll('style') : []
        for (const node of Array.from(nodes)) {
          const found = extractWhaleMask(node.textContent)
          if (found !== null) {
            whaleMask = found
            return whaleMask
          }
        }
      } catch (error) {
        whaleMask = null
      }
      return whaleMask
    }

    /**
     * 预览抽样：只记 id 和这条示例文案，渲染时再按当前草稿取样式，
     * 这样改颜色/字号/名字时预览会即时跟着变，不会重抽。
     */
    function samplePreview(flair) {
      const preset = choosePreset(flair)
      const textPreset = chooseTextPreset(flair)
      let text = null
      if (!isBuiltIn(textPreset)) {
        const texts = textPreset.texts
        if (texts.length === 0) text = ''
        else if (flair.selection.textMode === 'first') text = texts[0]
        else text = pick(texts)
      }
      return {
        presetId: isBuiltIn(preset) ? DEFAULT_ID : preset.id,
        textPresetId: isBuiltIn(textPreset) ? DEFAULT_ID : textPreset.id,
        text,
      }
    }

    /** 预览抽样：不动顺序轮换的游标，也不碰本轮状态。 */
    function previewSample(flair) {
      const preset = choosePreset(flair)
      const textPreset = chooseTextPreset(flair)
      let text = null
      if (!isBuiltIn(textPreset)) {
        const texts = textPreset.texts
        if (texts.length === 0) text = ''
        else if (flair.selection.textMode === 'first') text = texts[0]
        else text = pick(texts)
      }
      return { preset, textPreset, text }
    }

    /** 预览里显示的文案（含 {duration} 的示例替换）。 */
    function previewLabel(sample) {
      if (sample === null || sample === undefined) return ''
      if (sample.text === null) return officialLabel()
      return interpolate(sample.text, { duration: sampleDuration() })
    }

    // ============================== 运行时状态 ==============================

    /** 当前生效配置（归一化后）。 */
    let flair = normalizeFlair(DEFAULT_FLAIR)
    /** 本轮思考抽到的结果：active=false 或 rolled=false 时，下一次 translate 重新抽。 */
    const run = { active: false, rolled: false, presetId: '', textPresetId: '', text: null, stepCount: 0 }
    function createOutputEvidence(step = null, closedAttempts = new Set()) {
      return { step, attemptId: null, index: null, closedAttempts, blocks: new Map(), endedBlocks: new Set() }
    }
    const eventState = { available: false, sessionId: '', turn: null, calls: [], pulses: [], names: new Map(), ruleId: null, policyKey: '', lastRefresh: -Infinity, stepOrigin: 0, phase: 'waiting', output: createOutputEvidence() }
    function finishOutputAttempt(attemptId = eventState.output.attemptId) {
      const output = eventState.output
      if (typeof attemptId === 'string' && attemptId) {
        output.closedAttempts.add(attemptId)
        if (output.closedAttempts.size > 128) output.closedAttempts.delete(output.closedAttempts.values().next().value)
      }
      if (attemptId === output.attemptId || attemptId === null || attemptId === undefined) {
        eventState.phase = 'waiting'
        output.index = null
        output.blocks.clear()
      }
    }
    function resetOutputEvidence(step = null, clearAttempts = false) {
      if (!clearAttempts) finishOutputAttempt()
      const closed = clearAttempts ? new Set() : eventState.output.closedAttempts
      eventState.output = createOutputEvidence(step, closed)
      eventState.phase = 'waiting'
    }
    function suspendOutputEvidence() {
      const previous = eventState.output
      eventState.output = createOutputEvidence(null, previous.closedAttempts)
      // Rebaseline is not an attempt end. Keep its identity so fresh deltas can
      // continue it, or a newer attempt can retire it without reviving old ones.
      eventState.output.attemptId = previous.attemptId
      eventState.phase = 'waiting'
    }
    function consumeOutputChunk(event) {
      const data = event.data ?? {}, chunk = data.chunk ?? {}
      if (eventState.turn === null || data.turn !== eventState.turn || !Number.isSafeInteger(data.step) || data.step < 0 || typeof data.attemptId !== 'string' || !data.attemptId) return
      const output = eventState.output
      if (output.step === null) output.step = data.step
      if (data.step !== output.step || output.closedAttempts.has(data.attemptId)) return
      if (output.attemptId !== data.attemptId) {
        finishOutputAttempt()
        output.attemptId = data.attemptId
        output.index = null
        output.blocks.clear()
        output.endedBlocks.clear()
      }
      if (chunk.type === 'finish') { finishOutputAttempt(); return }
      if (!Number.isSafeInteger(chunk.index) || chunk.index < 0) return
      if (chunk.type === 'block-start') {
        output.endedBlocks.delete(chunk.index)
        output.blocks.set(chunk.index, { kind: chunk.blockType, visible: false })
        output.index = chunk.index
        eventState.phase = 'waiting'
      } else if (chunk.type === 'block-end') {
        output.endedBlocks.add(chunk.index)
        output.blocks.delete(chunk.index)
        if (output.index === chunk.index) { output.index = null; eventState.phase = 'waiting' }
      } else if (chunk.type === 'tool-call-delta') {
        output.index = chunk.index
        eventState.phase = 'waiting'
      } else if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') {
        if (output.endedBlocks.has(chunk.index) || typeof chunk.text !== 'string' || !chunk.text) return
        const kind = chunk.type === 'text-delta' ? 'text' : 'reasoning'
        const previous = output.blocks.get(chunk.index)
        // Only retain a visibility bit, never accumulate the model's text in plugin state.
        const nonblank = chunk.text.trim() !== ''
        const visible = (previous?.kind === kind && previous.visible === true) || nonblank
        output.blocks.set(chunk.index, { kind, visible })
        if (nonblank) {
          output.index = chunk.index
          eventState.phase = kind === 'text' ? 'responding' : 'thinking'
        }
      }
    }
    let eventWake = null
    const rotationTimers = { look: null, text: null }
    const lastLayerDraw = { look: -Infinity, text: -Infinity }
    function stopDeferredRotations() {
      for (const layer of ['look', 'text']) {
        if (rotationTimers[layer] !== null) clearTimeout(rotationTimers[layer])
        rotationTimers[layer] = null
      }
    }
    function requestRotation(layer) {
      if (!run.active || !flair.enabled || clientDisposed) return
      const delay = flair.eventRules.enabled ? Math.max(0, lastLayerDraw[layer] + flair.eventRules.minRefreshMs - Date.now()) : 0
      if (delay === 0) {
        if (rotationTimers[layer] !== null) clearTimeout(rotationTimers[layer])
        rotationTimers[layer] = null
        if (layer === 'look') rollLook(); else rollText()
      } else if (rotationTimers[layer] === null) {
        const generation = runtimeGeneration
        rotationTimers[layer] = setTimeout(() => {
          rotationTimers[layer] = null
          if (generation !== runtimeGeneration || clientDisposed || !run.active) return
          if (!reconcileEventRule() && !eventState.pending) requestRotation(layer)
        }, delay)
      }
    }
    let runtimeGeneration = 0
    let clientDisposed = false
    let runtimeDictionaryOff = null
    let labelRefreshQueued = false
    let publishedLabel
    const eventListeners = new Set()
    let eventRevision = 0, eventNoticeQueued = false
    function subscribeEvents(listener) { eventListeners.add(listener); return () => eventListeners.delete(listener) }
    function eventSnapshot() { return eventRevision }
    function notifyEvents() {
      if (eventNoticeQueued) return
      eventNoticeQueued = true
      Promise.resolve().then(() => { eventNoticeQueued = false; eventRevision++; for (const fn of eventListeners) fn() })
    }
    function clearEventWake() { if (eventWake !== null) clearTimeout(eventWake); eventWake = null }
    function stopRun() {
      run.active = false
      run.rolled = false
      stopTriggerTimers()
      clearEventWake()
      eventState.pending = false
      notifyEvents()
      invalidateRunningLabel()
    }
    function effectiveFlair() {
      const rule = flair.eventRules.rules.find((r) => r.id === eventState.ruleId)
      return rule && flair.eventRules.enabled ? { ...flair, selection: rule.selection } : flair
    }
    // A private, real copy dictionary registration advances LocaleFace revision. It does not
    // change language preferences, emit a fake locale/change, or mutate React-owned DOM.
    function invalidateRunningLabel() {
      if (clientDisposed || labelRefreshQueued || !localeRuntime || typeof localeRuntime.register !== 'function') return
      labelRefreshQueued = true
      const generation = runtimeGeneration
      Promise.resolve().then(() => {
        labelRefreshQueued = false
        if (clientDisposed || !localeRuntime) return
        if (generation !== runtimeGeneration) { invalidateRunningLabel(); return }
        const label = flair.enabled && run.active ? run.text : null
        if (publishedLabel === label) return
        publishedLabel = label
        if (runtimeDictionaryOff) runtimeDictionaryOff()
        runtimeDictionaryOff = null
        if (run.text !== null && run.text !== undefined && flair.enabled && run.active) {
          const copy = { label: String(run.text) }
          runtimeDictionaryOff = localeRuntime.register(NS + '.running-copy', { zh: copy, en: copy })
        }
      })
    }
    function reconcileEventRule(force = false) {
      clearEventWake()
      eventState.pending = false
      if (clientDisposed || !run.active || !flair.enabled || (!flair.eventRules.enabled && eventState.ruleId === null)) return false
      const now = Date.now()
      eventState.pulses = eventState.pulses.filter((p) => now - p.at < 30000)
      const rule = selectEventRule(flair, eventState, now)
      const id = rule?.id ?? null
      const key = JSON.stringify(rule?.selection ?? flair.selection) + (rule ? '/turn:' + eventState.turn : '')
      const changed = eventState.ruleId !== id || eventState.policyKey !== key
      const wait = Math.max(0, flair.eventRules.minRefreshMs - (now - eventState.lastRefresh))
      if (changed && !force && wait > 0 && !(rule?.kind === 'pulse' && rule.groupIds.includes('builtin:tool-error'))) {
        eventState.pending = true
        eventWake = setTimeout(() => { eventWake = null; reconcileEventRule() }, wait)
        return false
      }
      if (changed || force) {
        stopDeferredRotations()
        eventState.ruleId = id
        eventState.policyKey = key
        notifyEvents()
        eventState.lastRefresh = now
        eventState.stepOrigin = run.stepCount
        rollLook()
        rollText()
        scheduleTriggers()
      }
      // Wake at the earliest future expiry for any pulse rule (including currently masked ones).
      const deadlines = flair.eventRules.enabled ? flair.eventRules.rules.filter((r) => r.enabled && r.kind === 'pulse').flatMap((r) =>
        eventState.pulses.map((p) => p.at + r.holdMs).filter((at) => at > now)) : []
      if (deadlines.length) eventWake = setTimeout(() => { eventWake = null; reconcileEventRule() }, Math.max(1, Math.min(...deadlines) - now))
      return changed || force
    }
    function resetEventSession(sessionId = '', available = false) {
      stopRun()
      runtimeGeneration++
      lastLayerDraw.look = -Infinity; lastLayerDraw.text = -Infinity
      Object.assign(eventState, { sessionId, available, turn: null, calls: [], pulses: [], names: new Map(), ruleId: null, policyKey: '', lastRefresh: -Infinity, stepOrigin: 0 })
      resetOutputEvidence(null, true)
      Object.assign(run, { presetId: '', textPresetId: '', text: null, stepCount: 0 })
      clearPaint()
      notifyEvents()
      invalidateRunningLabel()
    }
    function updateNativeActivity(snapshot, turn) {
      const currentTurn = typeof turn === 'number' ? turn : null
      if (eventState.turn !== currentTurn) {
        stopRun()
        resetOutputEvidence(null, true)
        eventState.pulses = []
        eventState.names.clear()
        eventState.pending = false
        eventState.stepOrigin = 0
        run.stepCount = 0
      }
      eventState.turn = currentTurn
      const calls = [], seen = new Set()
      const visit = (tool, depth = 0) => {
        if (!tool || depth > 32 || seen.has(tool.callId)) return
        seen.add(tool.callId)
        const name = typeof tool.name === 'string' ? tool.name : tool.call?.name ?? ''
        if (name) eventState.names.set(String(tool.callId), name)
        if (currentTurn !== null && tool.turn === currentTurn && (tool.phase === 'preparing' || tool.phase === 'start')) {
          calls.push({ id: String(tool.callId), name, activity: nativeActivity(name) })
        }
        for (const child of Array.isArray(tool.subCalls) ? tool.subCalls : []) visit(child, depth + 1)
      }
      // ChatSnapshotBuilder publishes its compatibility slices under `legacy`.
      // The flat shape is retained only for older adapters. Prefer nested data
      // even when its current tool list is empty.
      const legacy = snapshot?.legacy ?? snapshot
      for (const tool of Array.isArray(legacy?.runningCalls) ? legacy.runningCalls : []) visit(tool)
      eventState.calls = calls
      notifyEvents()
      if (currentTurn === null) { eventState.pulses = []; resetOutputEvidence(null, true); return }
      if (!run.active && flair.enabled && isRunningNow()) rollRun()
      else reconcileEventRule()
    }
    function consumeLiveChange(change) {
      if (change?.kind !== 'append' && change?.kind !== 'settle-assistant') return
      if (change.kind === 'settle-assistant') finishOutputAttempt(change.attemptId)
      const entries = change.kind === 'append' ? change.entries : change.entry ? [change.entry] : []
      for (const entry of entries ?? []) {
        const event = entry?.event
        if (!event) continue
        if (entry.type === 'transient' && event.type === 'assistant/live-chunk') { consumeOutputChunk(event); continue }
        if (entry.type !== 'event') continue
        const data = event.data ?? {}
        if (event.type === 'turn/start') {
          if (eventState.turn !== data.turn) {
            stopRun(); resetOutputEvidence(null, true); eventState.calls = []; eventState.pulses = []; eventState.names.clear()
            eventState.pending = false; eventState.stepOrigin = 0
          }
          eventState.turn = data.turn
          run.stepCount = 0
        } else if (event.type === 'turn/end' && eventState.turn === data.turn) {
          eventState.turn = null; eventState.calls = []; eventState.pulses = []; resetOutputEvidence(null, true); stopRun()
        } else if (event.type === 'step/start' && eventState.turn === data.turn) {
          resetOutputEvidence(Number.isSafeInteger(data.step) ? data.step : null)
          onStepStart()
        } else if (['step/end', 'assistant/message', 'assistant/attempt', 'llm/retry', 'llm/retry-started'].includes(event.type) && eventState.turn === data.turn) {
          if (eventState.output.step === null || data.step === eventState.output.step) {
            const assistantEnd = event.type === 'assistant/message' || event.type === 'assistant/attempt'
            const editedMessage = event.type === 'assistant/message' && event.surfaceOp !== undefined && event.surfaceOp !== 'append'
            const attemptId = change.kind === 'settle-assistant' ? change.attemptId : assistantEnd ? data.attemptId : undefined
            const otherAttempt = typeof attemptId === 'string' && eventState.output.attemptId && attemptId !== eventState.output.attemptId
            if (!editedMessage) {
              if (typeof attemptId === 'string') finishOutputAttempt(attemptId)
              if (!otherAttempt) resetOutputEvidence(Number.isSafeInteger(data.step) ? data.step : eventState.output.step)
            }
          }
        } else if (event.type === 'tool/result' || event.type === 'tool/ptc-dispatch') {
          if (eventState.turn === null) continue
          const message = data.message
          const id = String(event.type === 'tool/result' ? message?.source?.callId ?? '' : data.subCallId ?? '')
          const name = data.name ?? eventState.names.get(id) ?? ''
          const failed = event.type === 'tool/result' ? message?.isError === true : data.isError === true
          eventState.pulses.push({ at: Date.now(), event: failed ? 'tool-error' : 'tool-success', name, activity: nativeActivity(name) })
          if (eventState.pulses.length > 200) eventState.pulses.shift()
          // Remove the exact finished call immediately; a parent or another parallel call stays active.
          eventState.calls = eventState.calls.filter((call) => call.id !== id)
        }
      }
      reconcileEventRule()
      notifyEvents()
    }
    function watchMainSession(sessions, ui) {
      let binding, release = () => {}, disposed = false, queued = false
      const isSource = (source) => source && typeof source.getSnapshot === 'function' && typeof source.subscribe === 'function'
      if (!isSource(sessions?.list) || typeof sessions.binding !== 'function' || typeof ui?.binding !== 'function') {
        resetEventSession()
        return () => {}
      }
      const sync = () => {
        if (disposed) return
        let next
        try {
          const row = Object.values(sessions.list.getSnapshot().byId ?? {}).find((item) => (item.retainedBy?.mainView ?? 0) > 0)
          next = row ? sessions.binding(row.id) : undefined
        } catch { release(); binding = undefined; resetEventSession(); return }
        if (next === binding && (eventState.available || !next)) return
        release(); release = () => {}; binding = next
        resetEventSession(next?.sessionId ?? '', false)
        if (!next) return
        const disposers = []
        let failed = false
        release = () => {
          failed = true
          for (const off of disposers.splice(0).reverse()) { try { off() } catch { /* continue releasing the other owners */ } }
        }
        const fail = () => { release(); resetEventSession(next.sessionId, false) }
        try {
          const source = next.eventSource
          const conversation = ui.binding(next)
          const target = typeof conversation?.target === 'function' ? conversation.target('chat') : undefined
          const turn = conversation?.openTurn
          if (![source, target, turn].every(isSource)) { fail(); return }
          let revision = source.getSnapshot().revision
          const update = () => {
            if (disposed || failed || binding !== next) return
            try { updateNativeActivity(target.getSnapshot(), turn.getSnapshot()) } catch { fail() }
          }
          // Register cleanup immediately after each successful subscription, so a later
          // missing/throwing capability cannot leave the previous subscriptions behind.
          disposers.push(target.subscribe(update))
          disposers.push(turn.subscribe(update))
          disposers.push(source.subscribe(() => {
            if (disposed || failed || binding !== next) return
            try {
              const snapshot = source.getSnapshot()
              // Revisions are monotonic within one binding. Never lower the watermark
              // for a delayed snapshot and then accept its old tail as live output.
              if (snapshot.revision <= revision) return
              const contiguous = snapshot.revision === revision + 1
              revision = snapshot.revision
              if (!contiguous || snapshot.change?.kind === 'replace') {
                eventState.pulses = []
                suspendOutputEvidence()
                run.stepCount = 0
                eventState.stepOrigin = 0
                update()
                reconcileEventRule()
              } else consumeLiveChange(snapshot.change)
            } catch { fail() }
          }))
          eventState.available = true
          update()
        } catch { fail() }
      }
      let offList = () => {}
      try {
        offList = sessions.list.subscribe(() => {
          if (queued || disposed) return
          queued = true
          Promise.resolve().then(() => { queued = false; sync() })
        })
        sync()
      } catch { release(); offList(); resetEventSession() }
      return () => { disposed = true; offList(); release(); resetEventSession() }
    }

    /** 测试与设置页共用：当前配置。 */
    function currentFlair() {
      return flair
    }

    function isRunningNow() {
      if (typeof document === 'undefined') return false
      return document.querySelector(RUNNING_SELECTOR) !== null
    }

    /** 把一套外观写到 <html> 的自定义属性上，CSS 里统一消费。 */
    const VAR_NAMES = [
      '--dsh-sf-color',
      '--dsh-sf-shimmer',
      '--dsh-sf-font-size',
      '--dsh-sf-icon-size',
      '--dsh-sf-icon-mask',
      '--dsh-sf-shimmer-duration',
      '--dsh-sf-shimmer-play',
    ]

    function paintPreset(preset) {
      if (typeof document === 'undefined' || document.documentElement === undefined) return
      // 默认外观：一个变量都不设、标记也摘掉，让 DSH 自己的 CSS 原样生效。
      if (isBuiltIn(preset)) {
        clearPaint()
        setActiveFlag(false)
        return
      }
      const style = document.documentElement.style
      if (style === undefined) return
      const { color, fontSize, icon, shimmerDuration } = preset.style
      const iconSize = Math.max(12, Math.min(30, fontSize + 2))
      setActiveFlag(true)
      setNoIconFlag(icon === 'none')
      style.setProperty('--dsh-sf-color', color)
      style.setProperty('--dsh-sf-shimmer', shimmerColor(preset.style))
      style.setProperty('--dsh-sf-font-size', String(fontSize) + 'px')
      style.setProperty('--dsh-sf-icon-size', String(iconSize) + 'px')
      style.setProperty(
        '--dsh-sf-icon-mask',
        icon === 'none' ? 'linear-gradient(#0000, #0000)' : 'url("' + iconMaskUri(preset.style) + '")',
      )
      style.setProperty('--dsh-sf-shimmer-duration', String(shimmerDuration) + 'ms')
      style.setProperty('--dsh-sf-shimmer-play', shimmerDuration > 0 ? 'running' : 'paused')
    }

    function clearPaint() {
      if (typeof document === 'undefined' || document.documentElement === undefined) return
      const style = document.documentElement.style
      if (style === undefined) return
      for (const name of VAR_NAMES) style.removeProperty(name)
      setNoIconFlag(false)
    }

    /** 运行行图标位隐藏开关。 */
    function setNoIconFlag(hidden) {
      if (typeof document === 'undefined' || document.documentElement === undefined) return
      if (hidden) document.documentElement.setAttribute(NO_ICON_ATTR, '')
      else document.documentElement.removeAttribute(NO_ICON_ATTR)
    }

    /** 启用开关：CSS 只在 <html> 带标记时接管运行行。 */
    function setActiveFlag(enabled) {
      if (typeof document === 'undefined' || document.documentElement === undefined) return
      if (enabled) document.documentElement.setAttribute(ACTIVE_ATTR, '')
      else document.documentElement.removeAttribute(ACTIVE_ATTR)
    }

    /**
     * 换一套配置。运行中不重抽（保持本次思考不变），只在下一轮开始前预热变量，
     * 这样新配置的第一帧就是对的。
     */
    function applyFlair(next) {
      const previous = flair
      flair = normalizeFlair(next)
      if (!flair.enabled) {
        setActiveFlag(false)
        clearPaint()
        stopRun()
        invalidateRunningLabel()
        return flair
      }
      if (!run.active) paintPreset(choosePreset(flair))
      // 运行中改了触发配置：按新设置重排两条时间线（关掉即停，开启即重新计时）。
      else {
        const changed = (previous.eventRules.enabled || flair.eventRules.enabled) && reconcileEventRule()
        if (!changed && JSON.stringify(previous.triggers) !== JSON.stringify(flair.triggers)) scheduleTriggers()
      }
      return flair
    }

    // ---------- 触发引擎：外观与文案各自一条时间线，互不影响 ----------

    const triggerTimers = { look: null, text: null }

    function stopTriggerTimers() {
      stopDeferredRotations()
      for (const layer of ['look', 'text']) {
        if (triggerTimers[layer] !== null) {
          clearTimeout(triggerTimers[layer])
          triggerTimers[layer] = null
        }
      }
    }

    /** 闭区间随机整数毫秒。 */
    function randomBetween(minMs, maxMs) {
      const span = Math.max(0, maxMs - minMs)
      return minMs + Math.floor(random() * (span + 1))
    }

    /** 该层下一次时间触发的延迟；未启用时返回 null。 */
    function triggerDelay(layer) {
      const config = flair.triggers[layer].time
      if (!config.enabled) return null
      return config.mode === 'random' ? randomBetween(config.minMs, config.maxMs) : config.fixedMs
    }

    /** 排一次时间触发：每层同时最多一个定时器，运行结束或配置变化时会被清掉。 */
    function scheduleTrigger(layer) {
      if (triggerTimers[layer] !== null) {
        clearTimeout(triggerTimers[layer])
        triggerTimers[layer] = null
      }
      if (!run.active || !flair.enabled) return
      const delay = triggerDelay(layer)
      if (delay === null) return
      triggerTimers[layer] = setTimeout(() => {
        triggerTimers[layer] = null
        if (!run.active || !flair.enabled) return
        const switched = flair.eventRules.enabled && reconcileEventRule()
        if (!switched && !eventState.pending) {
          requestRotation(layer)
        }
        scheduleTrigger(layer)
      }, delay)
    }

    function scheduleTriggers() {
      stopDeferredRotations()
      scheduleTrigger('look')
      scheduleTrigger('text')
    }

    /** 步骤触发：会话事件 step/start 计数，命中 every 时重抽该层。 */
    function onStepStart() {
      if (!run.active || !flair.enabled) return
      run.stepCount += 1
      if (flair.eventRules.enabled && eventState.available && (reconcileEventRule() || eventState.pending)) return
      for (const layer of ['look', 'text']) {
        const step = flair.triggers[layer].step
        if (!step.enabled) continue
        if ((run.stepCount - (flair.eventRules.enabled ? eventState.stepOrigin : 0)) % step.every !== 0) continue
        requestRotation(layer)
      }
    }

    /** 只重抽外观。 */
    function rollLook() {
      lastLayerDraw.look = Date.now()
      const preset = choosePreset(effectiveFlair())
      run.presetId = isBuiltIn(preset) ? DEFAULT_ID : preset.id
      paintPreset(preset)
    }

    /** 只重抽文案（组 + 组内一行）。 */
    function rollText() {
      lastLayerDraw.text = Date.now()
      const effective = effectiveFlair()
      const textPreset = chooseTextPreset(effective)
      run.textPresetId = isBuiltIn(textPreset) ? DEFAULT_ID : textPreset.id
      const scope = flair.eventRules.enabled ? eventState.sessionId + '/' + (eventState.ruleId ?? 'base') + '/' : ''
      run.text = chooseText(textPreset, effective.selection.textMode, scope)
      invalidateRunningLabel()
    }

    /**
     * 进入一轮运行：按各层「每轮触发」决定是否重抽。
     * 关闭某层的每轮触发时，该层沿用上一轮的抽签结果（首次运行仍会抽一次，保证有东西可显示）。
     */
    function rollRun() {
      if (clientDisposed || !flair.enabled) return
      run.active = true
      run.rolled = true
      run.stepCount = 0
      eventState.stepOrigin = 0
      if (flair.eventRules.enabled || eventState.ruleId !== null) {
        const rule = selectEventRule(flair, eventState, Date.now())
        const key = JSON.stringify(rule?.selection ?? flair.selection) + (rule ? '/turn:' + eventState.turn : '')
        if (eventState.ruleId !== (rule?.id ?? null) || eventState.policyKey !== key) {
          reconcileEventRule(true)
          return
        }
      }
      // presetId / textPresetId 为空表示运行期还没抽过（首次），必须先抽一次。
      if (flair.triggers.look.turn.enabled || run.presetId === '') rollLook()
      if (flair.triggers.text.turn.enabled || run.textPresetId === '') rollText()
      scheduleTriggers()
    }

    /**
     * translate 的替换值。
     * @returns 替换后的文案；null 表示让官方文案原样通过（默认文案预设 / 关闭 / 空组）。
     */
    function readLabel(params) {
      if (!flair || !flair.enabled || clientDisposed || (eventState.available && eventState.turn === null)) return null
      if (!run.active || !run.rolled) rollRun()
      if (run.text === null || run.text === undefined) return null
      // startTime 还没就绪时 DSH 用的是 chat.deepDiving（不带 duration 参数）。
      // 这里不截断、也不裸奔模板：按 0 秒插值，第一帧就是完整文案，随后自动接上真实用时。
      const durationMissing = params === undefined || params === null || params.duration === undefined
      if (durationMissing && String(run.text).indexOf('{duration}') !== -1) {
        return interpolate(run.text, { duration: zeroDurationLabel() })
      }
      return interpolate(run.text, params)
    }

    /**
     * 伪造第一帧的用时：DSH 自己的格式化就是「秒数 + duration.secondUnit」，
     * 这里照搬单位字典，得到与原生一致的 '0秒' / '0s'。
     * @returns 0 值时长文案；拿不到单位字典时退回中性的 `0s`。
     */
    function zeroDurationLabel() {
      try {
        if (localeRuntime !== null && localeRuntime !== undefined && typeof localeRuntime.translate === 'function') {
          const unit = localeRuntime.translate('chat', 'duration.secondUnit')
          // 字典不可用时 translate 会回显 key 或占位文本，这时退回中性单位。
          if (typeof unit === 'string' && unit !== '' && unit.indexOf('duration.') === -1 && unit.indexOf('(') === -1) {
            return '0' + unit
          }
        }
      } catch (error) {
        /* 退回落通用单位 */
      }
      return '0s'
    }

    /** 真实会话的结束由共享来源决定；仅在没有活动轮次来源时，以运行行消失作为降级边界。 */
    function watchRuns() {
      if (typeof document === 'undefined' || typeof MutationObserver !== 'function') return () => {}
      let lastCheck = 0
      let trailing = null
      const check = () => {
        trailing = null
        lastCheck = Date.now()
        // Native status rows may unmount between tool work and model output.
        // That is not a new turn: stopping here makes readLabel -> rollRun force
        // a rule change and bypass minRefreshMs when the row mounts again.
        if (!isRunningNow() && !(eventState.available && eventState.turn !== null)) {
          stopRun()
          invalidateRunningLabel()
        }
      }
      const observer = new MutationObserver(() => {
        const now = Date.now()
        const wait = RUN_WATCH_INTERVAL_MS - (now - lastCheck)
        if (wait <= 0) {
          check()
          return
        }
        if (trailing === null) trailing = setTimeout(check, wait)
      })
      observer.observe(document.body, { childList: true, subtree: true })
      return () => {
        observer.disconnect()
        stopRun()
        if (trailing !== null) clearTimeout(trailing)
      }
    }

    /** 给 LocaleRuntime#translate 包一层；已缓存的 t 是动态调用 this.translate，所以立即生效。 */
    function patchLocale(locale) {
      if (locale === null || locale === undefined || typeof locale.translate !== 'function') return () => {}
      const original = locale.translate
      localeRuntime = locale
      officialTranslate = original
      const patched = function (ns, key, params) {
        if (ns === 'chat' && (key === 'chat.deepDiving' || key === 'chat.deepDivingFor')) {
          const label = readLabel(params)
          if (label !== null) return label
        }
        return original.call(this, ns, key, params)
      }
      locale.translate = patched
      return () => {
        if (locale.translate === patched) locale.translate = original
        if (localeRuntime === locale) {
          localeRuntime = null
          officialTranslate = null
        }
      }
    }

    // ============================== 样式 ==============================

    /** 运行行 + 设置页 + 预览的全部样式。 */
    function buildCss() {
      return [
        /* ---------- 运行行（真实生效区） ---------- */
        'html[' + ACTIVE_ATTR + '] [data-chat-running]{',
        '  color:var(--dsh-sf-color) !important;',
        '  --dsw-alias-label-shimmer:var(--dsh-sf-shimmer) !important;',
        '  font-size:var(--dsh-sf-font-size) !important;',
        '}',
        /* 图标：隐藏内置的两层（APNG 遮罩 + 静态 SVG），容器自身当遮罩画自己的图标 */
        'html[' + ACTIVE_ATTR + '][' + NO_ICON_ATTR + '] [data-chat-running] > :has(> [data-shimmer]) > :first-child{display:none !important}',
        'html[' + ACTIVE_ATTR + '] [data-chat-running] > :has(> [data-shimmer]) > :first-child{',
        '  width:var(--dsh-sf-icon-size) !important;',
        '  height:var(--dsh-sf-icon-size) !important;',
        '  background:currentColor !important;',
        '  -webkit-mask:var(--dsh-sf-icon-mask) center / contain no-repeat !important;',
        '  mask:var(--dsh-sf-icon-mask) center / contain no-repeat !important;',
        '}',
        'html[' + ACTIVE_ATTR + '] [data-chat-running] > :has(> [data-shimmer]) > :first-child > *{',
        '  display:none !important;',
        '}',
        /* 扫光节奏：0ms 时用 paused 停在起点，等于关闭 */
        'html[' + ACTIVE_ATTR + '] [data-chat-running] [data-shimmer] > [aria-hidden],',
        'html[' + ACTIVE_ATTR + '] [data-chat-running] [data-shimmer] > [aria-hidden] *{',
        '  animation-duration:var(--dsh-sf-shimmer-duration,1500ms) !important;',
        '  animation-play-state:var(--dsh-sf-shimmer-play,running) !important;',
        '}',

        /* ---------- 设置页 ---------- */
        '.dshsf-root{display:flex;flex-direction:column;gap:16px;padding:2px 2px 24px;color:var(--dsw-alias-label-primary,#e8e8ea);font-size:13px;line-height:1.5}',
        '.dshsf-summary{font-size:12px;color:var(--dsw-alias-label-tertiary,#9aa0a6)}',
        '.dshsf-desc{font-size:12px;color:var(--dsw-alias-label-tertiary,#9aa0a6)}',
        '.dshsf-card{border:1px solid var(--dsw-alias-border-l2,#2f3034);border-radius:10px;padding:12px;background:var(--dsw-alias-settings-card-fill,var(--dsw-alias-bg-layer-1,#17181b))}',
        '.dshsf-card-title{font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary,#c3c5c9);margin:0 0 10px}',
        '.dshsf-field{display:flex;flex-direction:column;gap:4px;min-width:0}',
        '.dshsf-event-item{margin-top:10px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l1,#333);border-radius:8px}',
        '.dshsf-event-item summary{cursor:pointer;padding:4px 0;font-weight:600}',
        '.dshsf-event-item[open] summary{margin-bottom:10px}',
        '.dshsf-event-choices{display:flex;flex-wrap:wrap;gap:6px 12px}',
        '.dshsf-event-check{display:inline-flex;align-items:center;gap:5px;padding:4px 0;font-size:12px}',
        '.dshsf-event-preview{padding:12px 0;font-size:14px}',
        '.dshsf-event-priority{display:inline-block;padding:5px 9px;margin:4px 0;border-left:3px solid var(--dsw-alias-brand-primary,#4176e6);background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.08));border-radius:4px;font-size:12px;font-weight:600}',
        '.dshsf-event-tabs{display:flex;gap:4px;margin-top:16px;padding:0 6px;border-bottom:1px solid var(--dsw-alias-border-l2,#2f3034)}',
        '.dshsf-event-tab{appearance:none;cursor:pointer;font:inherit;font-size:13px;padding:9px 14px;margin-bottom:-1px;border:1px solid transparent;border-bottom:3px solid transparent;border-radius:8px 8px 0 0;background:transparent;color:var(--dsw-alias-label-secondary,#a5a7ae)}',
        '.dshsf-event-tab:hover{color:var(--dsw-alias-label-primary,#eee);background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.08))}',
        '.dshsf-event-tab[aria-selected=true]{font-weight:600;color:var(--dsw-alias-label-primary,#eee);background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.08));border-color:var(--dsw-alias-border-l2,#2f3034);border-bottom-color:var(--dsw-alias-brand-primary,#4176e6)}',
        '.dshsf-event-tab:focus-visible,.dshsf-event-panel:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4176e6);outline-offset:2px}',
        '.dshsf-event-panel{border:1px solid var(--dsw-alias-border-l2,#2f3034);border-top:0;border-radius:0 0 8px 8px;padding:14px;background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.04))}',
        '.dshsf-event-toolbar{display:flex;align-items:flex-start;gap:12px;flex-wrap:wrap;padding-bottom:12px;margin-bottom:12px;border-bottom:1px solid var(--dsw-alias-border-l2,#2f3034)}',
        '.dshsf-event-toolbar-copy{flex:1 1 200px;min-width:0}',
        '.dshsf-event-panel-title{font-size:13px;font-weight:600;margin:0 0 4px}',
        '.dshsf-event-toolbar .dshsf-field-hint{margin:0;line-height:1.6}',
        '.dshsf-event-toolbar>.dshsf-btn{flex-shrink:0}',
        '.dshsf-strategy-switch>.dshsf-event-tabs{margin-top:0}',
        '.dshsf-strategy-hint{margin:0 0 8px;line-height:1.6}',
        '.dshsf-strategy-panel[hidden]{display:none}',
        '.dshsf-strategy-panel>.dshsf-card{border:0;padding:0;margin:0;background:transparent}',
        '.dshsf-rule-heading{display:flex;align-items:center;gap:8px 12px;flex-wrap:wrap}',
        '.dshsf-rule-name{font-weight:600;flex:1 1 150px;min-width:0;overflow-wrap:anywhere}',
        '.dshsf-rule-actions{display:flex;align-items:center;gap:6px;flex-wrap:wrap}',
        '.dshsf-rule-details{margin-top:8px;border-top:1px solid var(--dsw-alias-border-l2,#2f3034);padding-top:6px}',
        '.dshsf-starter-rules{padding:0 0 10px}',
        '.dshsf-trigger-layers{display:flex;flex-direction:column;gap:14px}',
        '.dshsf-trigger-layer{display:flex;flex-direction:column;gap:8px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l1,#2a2a2a);border-radius:10px}',
        '.dshsf-trigger-title{font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary,#b6b6b6)}',
        '.dshsf-trigger-groups{display:flex;flex-wrap:wrap;gap:14px}',
        '.dshsf-trigger-group{flex:1 1 180px;min-width:170px;display:flex;flex-direction:column;gap:6px;padding-left:14px;border-left:1px solid var(--dsw-alias-border-l1,#2a2a2a)}',
        '.dshsf-trigger-group:first-child{border-left:none;padding-left:0}',
        '.dshsf-trigger-group-title{font-size:11px;color:var(--dsw-alias-label-tertiary,#7d838a)}',
        '.dshsf-trigger-controls{display:flex;flex-wrap:wrap;gap:8px;align-items:flex-start}',
        '.dshsf-trigger-controls .dshsf-select{min-width:88px}',
        '.dshsf-trigger-controls .dshsf-input{width:84px}',
        '.dshsf-field-label{font-size:12px;color:var(--dsw-alias-label-tertiary,#9aa0a6)}',
        '.dshsf-field-hint{font-size:11px;color:var(--dsw-alias-label-tertiary,#7d838a)}',
        '.dshsf-grid{display:flex;flex-wrap:wrap;gap:14px;align-items:flex-start}',
        '.dshsf-switch{display:flex;align-items:center;gap:8px;cursor:pointer}',
        '.dshsf-input,.dshsf-select,.dshsf-area{',
        '  font:inherit;color:inherit;background:var(--dsw-alias-bg-base,#0f1013);',
        '  border:1px solid var(--dsw-alias-border-l2,#2f3034);border-radius:7px;padding:5px 8px;min-width:0;',
        '}',
        '.dshsf-area{resize:vertical;min-height:84px;line-height:1.7}',
        '.dshsf-input:disabled,.dshsf-select:disabled,.dshsf-area:disabled{opacity:.55;cursor:not-allowed}',
        '.dshsf-num{width:88px}',
        '.dshsf-color-row{display:flex;align-items:center;gap:6px}',
        '.dshsf-color{width:32px;height:26px;padding:0;border:1px solid var(--dsw-alias-border-l2,#2f3034);border-radius:7px;background:transparent}',
        /* 按钮：用 DSH 官方的「主按钮底色 + 前景色」配对，别再自己写 #fff */
        '.dshsf-btn{font:inherit;color:var(--dsw-alias-label-primary,inherit);background:var(--dsw-alias-button-elevated-fill,transparent);border:1px solid var(--dsw-alias-border-l2,#2f3034);border-radius:7px;padding:4px 10px;cursor:pointer}',
        '.dshsf-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.06))}',
        '.dshsf-btn:disabled{opacity:.5;cursor:not-allowed}',
        '.dshsf-btn-primary{background:var(--dsw-alias-button-primary-fill,var(--dsw-alias-brand-primary,#4176e6));border-color:transparent;color:var(--dsw-alias-label-primary-foreground,#0b0d12);font-weight:600}',
        '.dshsf-btn-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover,var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.06)))}',
        '.dshsf-btn-danger{color:var(--dsw-alias-state-error-primary,#ff6b6b);border-color:var(--dsw-alias-state-error-primary,#ff6b6b)}',
        '.dshsf-btn-sm{padding:2px 8px;font-size:11px}',
        '.dshsf-file{max-width:100%;font:inherit;font-size:11px;color:var(--dsw-alias-label-secondary,#c3c5c9)}',
        '.dshsf-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}',
        '.dshsf-actions{display:flex;align-items:center;gap:8px;min-height:30px}',
        '.dshsf-actions-bottom{padding-top:2px}',
        '.dshsf-status{display:flex;align-items:center;gap:8px;flex:1;min-width:0;min-height:18px}',
        '.dshsf-preset{display:flex;align-items:center;gap:10px;padding:8px 0;border-top:1px solid var(--dsw-alias-border-l1,#25262a)}',
        '.dshsf-preset:first-of-type{border-top:0}',
        '.dshsf-preset-name{font-weight:600;min-width:96px}',
        '.dshsf-preset-meta{font-size:12px;color:var(--dsw-alias-label-tertiary,#8a9096);flex:1;min-width:120px}',
        '.dshsf-preset-builtin .dshsf-preset-name{font-weight:600;color:var(--dsw-alias-label-secondary,#c3c5c9)}',
        '.dshsf-swatch{width:14px;height:14px;border-radius:4px;flex:none;box-shadow:inset 0 0 0 1px rgba(255,255,255,.18)}',
        '.dshsf-swatch-official{background:var(--dsw-alias-label-deep-diving,#4d8df6)}',
        '.dshsf-text-mark{flex:none;width:14px;text-align:center;color:var(--dsw-alias-label-tertiary,#8a9096);font-size:12px;line-height:14px}',
        '.dshsf-grow{flex:1}',
        '.dshsf-notice{font-size:12px}',
        '.dshsf-notice[data-kind=ok]{color:var(--dsw-alias-state-success-primary,#4dab7a)}',
        '.dshsf-notice[data-kind=error]{color:var(--dsw-alias-state-error-primary,#ff6b6b)}',
        '.dshsf-notice[data-kind=hint]{color:var(--dsw-alias-label-tertiary,#8a9096)}',
        '.dshsf-empty{font-size:12px;color:var(--dsw-alias-label-tertiary,#8a9096)}',
        '.dshsf-star{flex:none;font-size:12px;line-height:1;color:var(--dsw-alias-brand-primary,#f0b45e)}',
        '.dshsf-badge{flex:none;font-size:11px;line-height:16px;padding:0 6px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2,#2f3034);color:var(--dsw-alias-label-tertiary,#8a9096)}',

        /* ---------- 多选下拉（复数候选） ---------- */
        '.dshsf-ms{position:relative;min-width:220px}',
        '.dshsf-ms-btn{display:flex;align-items:center;justify-content:space-between;gap:8px;width:100%;font:inherit;font-size:12px;color:inherit;text-align:left;background:var(--dsw-alias-bg-base,#0f1013);border:1px solid var(--dsw-alias-border-l2,#2f3034);border-radius:7px;padding:5px 8px;cursor:pointer}',
        '.dshsf-ms-btn:hover:not(:disabled){border-color:var(--dsw-alias-border-l3,#4a4c52)}',
        '.dshsf-ms-btn:disabled{opacity:.55;cursor:not-allowed}',
        '.dshsf-ms-text{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
        '.dshsf-ms-caret{flex:none;opacity:.6;font-size:10px}',
        '.dshsf-ms-panel{position:fixed;z-index:1000;display:flex;flex-direction:column;max-height:260px;overflow:auto;padding:4px;border:1px solid var(--dsw-alias-border-l2,#2f3034);border-radius:8px;background:var(--dsw-alias-bg-layer-2,var(--dsw-alias-bg-layer-1,#1d1e22));box-shadow:0 10px 28px rgba(0,0,0,.38)}',
        '.dshsf-ms-item{display:flex;align-items:center;gap:8px;padding:5px 8px;border-radius:6px;font-size:12px;cursor:pointer;white-space:nowrap}',
        '.dshsf-ms-item:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.06))}',
        '.dshsf-ms-foot{display:flex;justify-content:flex-end;gap:6px;margin-top:2px;padding:6px 6px 2px;border-top:1px solid var(--dsw-alias-border-l1,#25262a)}',

        /* ---------- 预览 ---------- */
        '.dshsf-preview{display:flex;align-items:center;gap:6px;min-height:30px;flex-wrap:wrap}',
        '.dshsf-preview-meta{width:100%;font-size:11px;color:var(--dsw-alias-label-tertiary,#7d838a)}',
        '.dshsf-pv-icon{flex:none;background-color:currentColor;-webkit-mask-repeat:no-repeat;mask-repeat:no-repeat;-webkit-mask-position:center;mask-position:center;-webkit-mask-size:contain;mask-size:contain}',
        '.dshsf-pv{position:relative;display:inline-grid;min-width:0}',
        '.dshsf-pv-base{grid-area:1/1;white-space:nowrap}',
        '.dshsf-pv-win{position:absolute;inset:0;overflow:clip;pointer-events:none;',
        '  -webkit-mask-image:linear-gradient(105deg,transparent 0,black 40% 60%,transparent 100%);',
        '  mask-image:linear-gradient(105deg,transparent 0,black 40% 60%,transparent 100%);',
        '  transform:translateX(-100%);animation:dshsf-sweep var(--dsh-sf-pv-duration,1.5s) steps(48,end) .3s infinite}',
        '.dshsf-pv-move{position:absolute;inset:0;white-space:nowrap;color:var(--dsh-sf-pv-shimmer,currentColor);transform:translateX(100%);',
        '  animation:dshsf-highlight var(--dsh-sf-pv-duration,1.5s) steps(48,end) .3s infinite}',
        /* 默认外观：颜色 / 字号直接用 DSH 自己的变量与公式，不另存一份 */
        '.dshsf-pv-official{color:var(--dsw-alias-label-deep-diving,currentColor);font-size:calc(var(--dsh-content-font-size,14px) - 2px)}',
        '.dshsf-pv-whale{flex:none;display:inline-block;background-color:currentColor;color:var(--dsw-alias-label-deep-diving,currentColor)}',
        '@keyframes dshsf-sweep{0%{transform:translateX(-100%)}66.6667%,100%{transform:translateX(100%)}}',
        '@keyframes dshsf-highlight{0%{transform:translateX(100%)}66.6667%,100%{transform:translateX(-100%)}}',
        '@media (prefers-reduced-motion:reduce){.dshsf-pv-win,.dshsf-pv-move{animation:none;display:none}}',
      ].join('\n')
    }

    let cssTag = null
    function injectCss() {
      if (typeof document === 'undefined') return () => {}
      for (const stale of document.querySelectorAll('style[data-plugin-css=' + JSON.stringify(CSS_ID) + ']')) stale.remove()
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-status-flair'
      tag.dataset.pluginCss = CSS_ID
      tag.textContent = buildCss()
      document.head.appendChild(tag)
      cssTag = tag
      return () => {
        if (cssTag === tag) cssTag = null
        tag.remove()
      }
    }

    // ============================== React 绑定 ==============================

    const useStore =
      typeof React.useSyncExternalStore === 'function'
        ? (subscribe, getSnapshot) => React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
        : (subscribe, getSnapshot) => {
            const [value, setValue] = React.useState(getSnapshot)
            React.useEffect(() => subscribe(() => setValue(getSnapshot())), [subscribe, getSnapshot])
            return value
          }

    /** 当前 settings 表单（apply 时注入；没有设置通道时为 undefined）。 */
    let liveForm = null
    /** apply 时绑定的文案读取器：槽位没给 props.t 时兜底。 */
    let boundText = (key) => key
    const EMPTY_SNAPSHOT = Object.freeze({ status: 'unavailable', value: undefined, writable: false, revision: undefined })

    function formSnapshot() {
      return liveForm === null ? EMPTY_SNAPSHOT : liveForm.getSnapshot()
    }
    function subscribeForm(listener) {
      return liveForm === null ? () => {} : liveForm.subscribe(listener)
    }
    function useFormSnapshot() {
      return useStore(subscribeForm, formSnapshot)
    }

    function el(type, props, ...children) {
      return React.createElement(type, props, ...children)
    }

    /** 写配置：先本地生效，再交给宿主持久化；返回宿主是否接受。 */
    async function commitFlair(next) {
      const normalized = applyFlair(next)
      if (liveForm === null) return false
      try {
        return await liveForm.set('flair', normalized)
      } catch (error) {
        return false
      }
    }

    let nextGeneratedId = 0
    function makeId(prefix) {
      const base = String(Date.now().toString(36)) + Math.floor(random() * 1e6).toString(36)
      return (prefix ?? 'preset') + '-' + base + '-' + (++nextGeneratedId)
    }

    // ============================== 多选下拉 ==============================

    /**
     * 复数候选的勾选器：按钮 + 弹出面板（fixed 定位，不会被设置卡片的
     * overflow 裁掉）。value 为空数组表示"回退全部"，勾选时按全部处理。
     */
    function MultiSelect(props) {
      const t = props !== undefined && props !== null && typeof props.t === 'function' ? props.t : boundText
      const options = Array.isArray(props.options) ? props.options : []
      const value = Array.isArray(props.value) ? props.value : []
      const disabled = props.disabled === true
      const optionIds = options.map((option) => option.id)
      const effective = value.length === 0 && props.emptyMeansAll !== false ? optionIds : value
      const [open, setOpen] = React.useState(false)
      const [anchor, setAnchor] = React.useState(null)
      const buttonRef = React.useRef(null)
      const panelRef = React.useRef(null)

      React.useEffect(() => {
        if (!open) return undefined
        const close = () => setOpen(false)
        const onDown = (event) => {
          const target = event !== null && event !== undefined ? event.target : null
          const button = buttonRef.current
          const panel = panelRef.current
          if (button !== null && typeof button.contains === 'function' && button.contains(target)) return
          if (panel !== null && typeof panel.contains === 'function' && panel.contains(target)) return
          close()
        }
        const onKey = (event) => {
          if (event !== null && event !== undefined && event.key === 'Escape') close()
        }
        const onScroll = (event) => {
          const panel = panelRef.current
          if (panel !== null && event !== null && event !== undefined && event.target !== null && event.target !== undefined && typeof panel.contains === 'function' && panel.contains(event.target)) return
          close()
        }
        document.addEventListener('mousedown', onDown)
        document.addEventListener('keydown', onKey)
        document.addEventListener('scroll', onScroll, true)
        if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
          window.addEventListener('resize', close)
        }
        return () => {
          document.removeEventListener('mousedown', onDown)
          document.removeEventListener('keydown', onKey)
          document.removeEventListener('scroll', onScroll, true)
          if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
            window.removeEventListener('resize', close)
          }
        }
      }, [open])

      const toggleOpen = () => {
        if (disabled) return
        const next = !open
        if (next) {
          const button = buttonRef.current
          const rect = button !== null && typeof button.getBoundingClientRect === 'function' ? button.getBoundingClientRect() : null
          setAnchor(rect === null ? null : { left: rect.left, top: rect.bottom + 4, width: Math.max(rect.width, 240) })
        }
        setOpen(next)
      }

      const checkedCount = effective.length
      let summary
      if (checkedCount === 0) summary = t('msNone')
      else if (checkedCount === options.length) summary = t('msAll') + '（' + String(options.length) + '）'
      else if (options.length > 2) {
        const names = options.filter((option) => effective.indexOf(option.id) !== -1).map((option) => option.label)
        summary = t('msCount').replace('{n}', String(checkedCount)) + '：' + names.slice(0, 2).join('、') + (names.length > 2 ? '…' : '')
      } else {
        summary = options
          .filter((option) => effective.indexOf(option.id) !== -1)
          .map((option) => option.label)
          .join('、')
      }

      const setChecked = (id, checked) => {
        if (disabled) return
        if (!checked && effective.length <= 1) return
        const next = toggleCandidate(effective, id, checked)
        if (typeof props.onChange === 'function') props.onChange(next)
      }

      return el(
        'div',
        { className: 'dshsf-ms' },
        el(
          'button',
          {
            type: 'button',
            ref: buttonRef,
            className: 'dshsf-ms-btn',
            disabled,
            'aria-haspopup': 'listbox',
            'aria-expanded': open ? 'true' : 'false',
            onClick: toggleOpen,
          },
          el('span', { className: 'dshsf-ms-text' }, summary),
          el('span', { className: 'dshsf-ms-caret', 'aria-hidden': 'true' }, '▼'),
        ),
        open
          ? el(
              'div',
              {
                className: 'dshsf-ms-panel',
                ref: panelRef,
                role: 'listbox',
                'aria-multiselectable': 'true',
                style:
                  anchor === null
                    ? undefined
                    : { left: String(anchor.left) + 'px', top: String(anchor.top) + 'px', minWidth: String(anchor.width) + 'px' },
              },
              ...options.map((option) =>
                el(
                  'label',
                  { key: option.id, className: 'dshsf-ms-item' },
                  el('input', {
                    type: 'checkbox',
                    checked: effective.indexOf(option.id) !== -1,
                    onChange: (event) => setChecked(option.id, event.target.checked),
                  }),
                  el('span', null, option.label),
                ),
              ),
              effective.length <= 1
                ? el('div', { className: 'dshsf-field-hint', style: { padding: '2px 8px 4px' } }, t('msLeastOne'))
                : null,
              el(
                'div',
                { className: 'dshsf-ms-foot' },
                el(
                  'button',
                  {
                    type: 'button',
                    className: 'dshsf-btn dshsf-btn-sm',
                    onClick: () => {
                      if (typeof props.onChange === 'function') props.onChange(optionIds.slice())
                    },
                  },
                  t('msSelectAll'),
                ),
              ),
            )
          : null,
      )
    }

    // ============================== 设置页 ==============================

    /** 插件页标题下的摘要（plugin-manager 的 view: 'summary'）。 */
    function StatusFlairSummary(props) {
      const t = props !== undefined && props !== null && typeof props.t === 'function' ? props.t : boundText
      const snapshot = useFormSnapshot()
      const ready = snapshot.status === 'ready' && snapshot.value !== undefined && snapshot.value !== null
      const flairView = React.useMemo(() => normalizeFlair(ready ? snapshot.value.flair : currentFlair()), [snapshot])
      if (!flairView.enabled) return el('span', { className: 'dshsf-summary' }, t('summaryOff'))
      const preset = choosePreset(flairView)
      return el(
        'span',
        { className: 'dshsf-summary' },
        t('summaryOn')
          .replace('{name}', lookLabel(preset, t))
          .replace('{presets}', String(flairView.presets.length))
          .replace('{texts}', String(flairView.textPresets.length)),
      )
    }

    /** 槽位入口只做分发，自己不用 hook：view 在一次挂载内不会变。 */
    function StatusFlairSeat(props) {
      const view = props !== undefined && props !== null ? props.view : undefined
      return view === 'summary' ? el(StatusFlairSummary, props) : el(StatusFlairSection, props)
    }

    function eventRuleLabel(rule, t) {
      const template = DEFAULT_FLAIR.eventRules.rules.find((r) => r.id === rule.id && r.nameKey === rule.nameKey && r.name === rule.name)
      return template ? t(template.nameKey) : rule.name
    }
    function eventGroupLabel(group, t) {
      return group.builtIn ? t('eventActivity_' + (group.activityKinds[0] ?? group.events[0])) : group.name
    }
    function EventRulesEditor({ value, onChange, writable, t }) {
      useStore(subscribeEvents, eventSnapshot)
      const [tab, setTab] = React.useState('rules')
      const [preview, setPreview] = React.useState(null)
      const tabsId = React.useRef(null)
      if (tabsId.current === null) tabsId.current = 'dshsf-event-tabs-' + (++nextGeneratedId)
      const groups = eventGroupsOf(value), rules = value.eventRules.rules
      const patchRules = (items) => onChange({ ...value, eventRules: { ...value.eventRules, rules: items } })
      const patchRule = (id, patch) => patchRules(rules.map((r) => r.id === id ? { ...r, ...patch } : r))
      const patchGroup = (id, patch) => onChange({ ...value, eventGroups: value.eventGroups.map((g) => g.id === id ? { ...g, ...patch } : g) })
      const button = (key, onClick, disabled = false, primary = false) => el('button', { type: 'button', className: 'dshsf-btn' + (primary ? ' dshsf-btn-primary' : ''), disabled: !writable || disabled, onClick }, t(key))
      const check = (label, active, onChange) => el('label', { className: 'dshsf-event-check' }, el('input', { type: 'checkbox', checked: active, disabled: !writable, onChange: (e) => onChange(e.target.checked) }), label)
      const field = (key, control) => el('label', { className: 'dshsf-field' }, el('span', { className: 'dshsf-field-label' }, t(key)), control)
      const select = (val, choices, onChange) => el('select', { className: 'dshsf-select', value: val, disabled: !writable, onChange: (e) => onChange(e.target.value) }, ...choices.map(([id, key]) => el('option', { key: id, value: id }, t(key))))
      const toggle = (items, id, active) => active ? [...new Set([...items, id])] : items.filter((x) => x !== id)
      const lookChoices = [{ id: DEFAULT_ID, label: t('defaultLook') }, ...value.presets.map((p) => ({ id: p.id, label: lookLabel(p, t) }))]
      const textChoices = [{ id: DEFAULT_ID, label: t('defaultTexts') }, ...value.textPresets.map((p) => ({ id: p.id, label: p.name }))]
      const renderSelection = (rule) => {
        const s = rule.selection
        const patch = (change) => patchRule(rule.id, { selection: { ...s, ...change } })
        const presetSelect = (key, choices) => el('select', { className: 'dshsf-select', value: s[key], disabled: !writable, onChange: (e) => patch({ [key]: e.target.value }) },
          !choices.some((c) => c.id === s[key]) ? el('option', { value: s[key] }, s[key] || '—') : null,
          ...choices.map((c) => el('option', { key: c.id, value: c.id }, c.label)))
        return el('div', { className: 'dshsf-grid' },
          field('presetMode', select(s.presetMode, [['fixed', 'presetFixed'], ['random', 'presetRandom']], (v) => patch({ presetMode: v }))),
          field(s.presetMode === 'fixed' ? 'fixedPreset' : 'candidates', s.presetMode === 'fixed' ? presetSelect('fixedPresetId', lookChoices) : el(MultiSelect, { t, options: lookChoices, value: s.presetIds, emptyMeansAll: false, disabled: !writable, onChange: (ids) => patch({ presetIds: ids }) })),
          field('textPresetMode', select(s.textPresetMode, [['fixed', 'textPresetFixed'], ['random', 'textPresetRandom']], (v) => patch({ textPresetMode: v }))),
          field(s.textPresetMode === 'fixed' ? 'fixedTextPreset' : 'candidates', s.textPresetMode === 'fixed' ? presetSelect('fixedTextPresetId', textChoices) : el(MultiSelect, { t, options: textChoices, value: s.textPresetIds, emptyMeansAll: false, disabled: !writable, onChange: (ids) => patch({ textPresetIds: ids }) })),
          field('textMode', select(s.textMode, [['first', 'textFirst'], ['random', 'textRandom'], ['sequential', 'textSequential']], (v) => patch({ textMode: v }))),
        )
      }
      const move = (index, delta) => { const next = rules.slice(); [next[index], next[index + delta]] = [next[index + delta], next[index]]; patchRules(next) }
      const newGroup = (source) => {
        const group = source ? { ...source, id: makeId('group'), name: eventGroupLabel(source, t) + t('copySuffix') } : { id: makeId('group'), name: t('eventNewGroup'), kind: 'activity', activityKinds: [], toolNames: [], events: [] }
        onChange({ ...value, eventGroups: [...value.eventGroups, group] })
      }
      const panelProps = { className: 'dshsf-event-panel', role: 'tabpanel', id: tabsId.current + '-panel', 'aria-labelledby': tabsId.current + '-' + tab, tabIndex: 0, key: tab }
      const panelHeader = (title, hint, action) => el('div', { className: 'dshsf-event-toolbar' },
        el('div', { className: 'dshsf-event-toolbar-copy' }, el('h3', { className: 'dshsf-event-panel-title' }, t(title)), el('p', { className: 'dshsf-field-hint' }, t(hint))), action)
      const onTabKey = (event, id) => {
        const ids = ['rules', 'groups']
        let next
        if (event.key === 'ArrowRight') next = ids[(ids.indexOf(id) + 1) % ids.length]
        else if (event.key === 'ArrowLeft') next = ids[(ids.indexOf(id) + ids.length - 1) % ids.length]
        else if (event.key === 'Home') next = ids[0]
        else if (event.key === 'End') next = ids[ids.length - 1]
        if (!next) return
        event.preventDefault()
        setTab(next)
        event.currentTarget?.parentElement?.querySelector('[data-event-tab="' + next + '"]')?.focus()
      }
      const missingStarters = createStarterRules().filter((r) => !rules.some((existing) => existing.id === r.id))
      const current = run.active ? rules.find((r) => r.id === eventState.ruleId) : undefined
      return el('div', { className: 'dshsf-card dshsf-events' },
        el('div', { className: 'dshsf-card-title' }, t('eventsTitle')),
        el('div', { className: 'dshsf-event-priority' }, t('eventsPriority')),
        el('p', { className: 'dshsf-field-hint' }, t('eventsHint')),
        el('div', { className: 'dshsf-row' }, check(t('eventsEnable'), value.eventRules.enabled, (enabled) => onChange({ ...value, eventRules: { ...value.eventRules, enabled } })),
          field('eventRefresh', el('input', { type: 'number', className: 'dshsf-input', min: 0, max: 5000, step: 100, value: value.eventRules.minRefreshMs, disabled: !writable,
            onChange: (e) => onChange({ ...value, eventRules: { ...value.eventRules, minRefreshMs: Number(e.target.value) } }) }))),
        el('p', { className: 'dshsf-field-hint', role: 'status' }, t(eventState.available ? 'eventSourceReady' : 'eventSourceMissing') + ' · ' + t('eventCurrent') + (current ? eventRuleLabel(current, t) : t('eventFallback')) +
          (eventState.available && eventState.turn !== null ? ' · ' + t('eventOutputStatus') + t(eventState.calls.length ? 'eventOutputTools' : 'eventActivity_' + eventState.phase) : '')),
        eventState.calls.length ? el('p', { className: 'dshsf-field-hint' }, t('eventToolActivities') + [...new Set(eventState.calls.map((call) => call.activity))].map((kind) => t('eventActivity_' + kind)).join(' / ')) : null,
        el('p', { className: 'dshsf-field-hint' }, t('eventOutputHint')),
        el('div', { className: 'dshsf-event-tabs', role: 'tablist', 'aria-label': t('eventsTitle') }, ...[['rules', 'eventRulesTab'], ['groups', 'eventGroupsTab']].map(([id, key]) => el('button', {
          key: id, id: tabsId.current + '-' + id, type: 'button', role: 'tab', className: 'dshsf-event-tab', 'data-event-tab': id,
          'aria-selected': tab === id, 'aria-controls': panelProps.id, tabIndex: tab === id ? 0 : -1,
          onClick: () => setTab(id), onKeyDown: (event) => onTabKey(event, id),
        }, t(key)))),
        tab === 'rules' ? el('section', panelProps,
          panelHeader('eventRulesPanelTitle', 'eventRulesPanelHint', button('eventAddRule', () => patchRules([...rules, { id: makeId('rule'), name: t('eventNewRule'), enabled: true, kind: 'activity', groupIds: ['builtin:read'], holdMs: 2000, selection: { ...value.selection } }]), false, true)),
          el('div', { className: 'dshsf-row dshsf-starter-rules' }, button('eventAddStarters', () => patchRules([...rules, ...missingStarters]), missingStarters.length === 0), el('span', { className: 'dshsf-field-hint' }, t('starterRulesHint'))),
          rules.length ? null : el('p', { className: 'dshsf-field-hint' }, t('eventNoRules')),
          ...rules.map((rule, index) => el('article', { className: 'dshsf-event-item dshsf-rule-item', key: rule.id },
            el('div', { className: 'dshsf-rule-heading' },
              el('span', { id: tabsId.current + '-rule-' + index, className: 'dshsf-rule-name' }, String(index + 1) + '. ' + eventRuleLabel(rule, t) + (run.active && eventState.ruleId === rule.id ? ' ★' : '') + (ruleIssue(value, rule) ? ' ⚠' : '')),
              el('div', { className: 'dshsf-rule-actions', role: 'group', 'aria-labelledby': tabsId.current + '-rule-' + index }, check(t('eventEnabled'), rule.enabled, (enabled) => patchRule(rule.id, { enabled })), button('eventMoveUp', () => move(index, -1), index === 0), button('eventMoveDown', () => move(index, 1), index === rules.length - 1))),
            el('details', { className: 'dshsf-rule-details' },
            el('summary', null, t('eventEditDetails')),
            field('eventName', el('input', { className: 'dshsf-input', type: 'text', value: eventRuleLabel(rule, t), maxLength: 100, disabled: !writable, onChange: (e) => patchRule(rule.id, { name: e.target.value, nameKey: '' }) })),
            field('eventKind', select(rule.kind, [['activity', 'eventActivity'], ['pulse', 'eventPulse']], (kind) => patchRule(rule.id, { kind, groupIds: [] }))),
            el('div', { className: 'dshsf-field' }, el('span', { className: 'dshsf-field-label' }, t('eventConditions')),
              el('div', { className: 'dshsf-event-choices' }, ...groups.filter((g) => g.kind === rule.kind).map((g) => el('span', { key: g.id }, check(eventGroupLabel(g, t), rule.groupIds.includes(g.id), (active) => patchRule(rule.id, { groupIds: toggle(rule.groupIds, g.id, active) }))))),
              ...rule.groupIds.filter((id) => !groups.some((g) => g.id === id && g.kind === rule.kind)).map((id) => el('div', { key: id }, check('⚠ ' + id, true, () => patchRule(rule.id, { groupIds: rule.groupIds.filter((item) => item !== id) }))))),
            rule.kind === 'pulse' ? field('eventHold', el('input', { className: 'dshsf-input', type: 'number', min: 0.5, max: 30, step: 0.5, value: rule.holdMs / 1000, disabled: !writable, onChange: (e) => patchRule(rule.id, { holdMs: Number(e.target.value) * 1000 }) })) : null,
            ruleIssue(value, rule) ? el('p', { className: 'dshsf-notice-error', role: 'status' }, t(ruleIssue(value, rule))) : null,
            el('h4', null, t('eventRuleSelection')), renderSelection(rule),
            button('eventPreview', () => setPreview({ ruleId: rule.id, sample: previewSample({ ...value, selection: rule.selection }) }), !!ruleIssue(value, rule)),
            preview?.ruleId === rule.id ? el('div', { className: 'dshsf-event-preview', style: { color: preview.sample.preset.style?.color } }, previewLabel(preview.sample)) : null,
            el('p', { className: 'dshsf-field-hint' }, t('eventPreviewHint')),
            button('remove', () => patchRules(rules.filter((r) => r.id !== rule.id))),
            ),
          )),
        ) : el('section', panelProps,
          panelHeader('eventGroupsPanelTitle', 'eventGroupsPanelHint', button('eventAddGroup', () => newGroup(), false, true)),
          !value.eventGroups.length ? el('p', { className: 'dshsf-field-hint' }, t('eventNoGroups')) : null,
          ...groups.map((group) => {
            const references = rules.filter((r) => r.groupIds.includes(group.id)).length
            return el('details', { key: group.id, className: 'dshsf-event-item' },
              el('summary', null, eventGroupLabel(group, t) + ' · ' + t(group.builtIn ? 'eventBuiltin' : 'eventCustom')),
              group.builtIn ? el('div', null, el('p', { className: 'dshsf-field-hint' }, t('eventBuiltin')), button('copy', () => newGroup(group))) : el('div', null,
                field('eventName', el('input', { className: 'dshsf-input', type: 'text', value: group.name, maxLength: 100, disabled: !writable, onChange: (e) => patchGroup(group.id, { name: e.target.value }) })),
                field('eventKind', select(group.kind, [['activity', 'eventActivity'], ['pulse', 'eventPulse']], (kind) => patchGroup(group.id, { kind, activityKinds: [], events: [] }))),
                el('div', { className: 'dshsf-field' }, el('span', { className: 'dshsf-field-label' }, t(group.kind === 'activity' ? 'eventCategories' : 'eventResults')),
                  el('div', { className: 'dshsf-event-choices' }, ...(group.kind === 'activity' ? MATCH_ACTIVITY_KINDS : PULSE_EVENTS).map((kind) => el('span', { key: kind }, check(t('eventActivity_' + kind), (group.kind === 'activity' ? group.activityKinds : group.events).includes(kind), (active) => patchGroup(group.id, { [group.kind === 'activity' ? 'activityKinds' : 'events']: toggle(group.kind === 'activity' ? group.activityKinds : group.events, kind, active) }))))),
                ),
                field('eventTools', el('textarea', { key: group.id + '-tools-' + JSON.stringify(group.toolNames), className: 'dshsf-area', defaultValue: group.toolNames.join('\n'), disabled: !writable, onBlur: (e) => patchGroup(group.id, { toolNames: e.target.value.split(/\r?\n/) }) })),
                el('p', { className: 'dshsf-field-hint' }, t('eventToolHint')),
                references ? el('p', { className: 'dshsf-field-hint' }, t('eventInUse').replace('{n}', String(references))) : null,
                button('remove', () => onChange({ ...value, eventGroups: value.eventGroups.filter((g) => g.id !== group.id) }), references > 0),
              ),
            )
          }),
        ),
      )
    }

    function StatusFlairSection(props) {
      const t = props !== undefined && props !== null && typeof props.t === 'function' ? props.t : boundText
      const snapshot = useFormSnapshot()
      const ready = snapshot.status === 'ready' && snapshot.value !== undefined && snapshot.value !== null
      const writable = snapshot.writable !== false && liveForm !== null

      /** 已经落盘的配置（宿主快照）。 */
      const persisted = React.useMemo(() => normalizeFlair(ready ? snapshot.value.flair : currentFlair()), [snapshot])
      /** 页面内的草稿：所有调整先改它，点「保存修改」才写入宿主。 */
      const [draft, setDraft] = React.useState(persisted)
      const [dirty, setDirty] = React.useState(false)
      const [strategyTab, setStrategyTab] = React.useState('default')
      const strategyTabsId = React.useRef(null)
      if (strategyTabsId.current === null) strategyTabsId.current = 'dshsf-strategy-tabs-' + (++nextGeneratedId)
      const onStrategyTabKey = (event, id) => {
        const ids = ['default', 'events']
        let next
        if (event.key === 'ArrowRight') next = ids[(ids.indexOf(id) + 1) % ids.length]
        else if (event.key === 'ArrowLeft') next = ids[(ids.indexOf(id) + ids.length - 1) % ids.length]
        else if (event.key === 'Home') next = ids[0]
        else if (event.key === 'End') next = ids[ids.length - 1]
        if (!next) return
        event.preventDefault()
        setStrategyTab(next)
        event.currentTarget?.parentElement?.querySelector('[data-strategy-tab="' + next + '"]')?.focus()
      }
      const sorted = draft
      const persistedRef = React.useRef(persisted)
      persistedRef.current = persisted

      const [editing, setEditing] = React.useState(null)
      const [editingText, setEditingText] = React.useState(null)
      const [pendingDelete, setPendingDelete] = React.useState(null)
      const [pendingDeleteText, setPendingDeleteText] = React.useState(null)
      const [notice, setNotice] = React.useState(null)
      const [preview, setPreview] = React.useState(() => samplePreview(draft))
      const noticeTimer = React.useRef(null)

      React.useEffect(
        () => () => {
          if (noticeTimer.current !== null) clearTimeout(noticeTimer.current)
        },
        [],
      )

      // 宿主配置变化：没动过草稿就跟上；动过就保留草稿，保存时会覆盖宿主。
      React.useEffect(() => {
        if (dirty) return
        setDraft(persisted)
      }, [persisted])

      // 选择策略变化时重新抽样；纯改样式/名字不重抽，预览即时反映草稿。
      const selectionKey = JSON.stringify(draft.selection)
      React.useEffect(() => {
        setPreview(samplePreview(draft))
      }, [selectionKey])

      // 离开设置页时撤回未保存的草稿，运行行回到已落盘配置。
      React.useEffect(() => () => applyFlair(persistedRef.current), [])

      const flash = (kind, text) => {
        setNotice({ kind, text })
        if (noticeTimer.current !== null) clearTimeout(noticeTimer.current)
        if (kind !== 'error') {
          noticeTimer.current = setTimeout(() => {
            noticeTimer.current = null
            setNotice(null)
          }, 2500)
        }
      }

      /** 只改页面草稿并即时作用到运行行/预览，不落盘。 */
      const updateDraft = (next) => {
        const normalized = applyFlair(next)
        setDraft(normalized)
        setDirty(true)
        return normalized
      }

      const patchSelection = (patch) =>
        updateDraft({
          ...sorted,
          selection: { ...sorted.selection, ...patch },
        })

      /** 改一层的触发配置（look | text，time | step）。 */
      const patchTrigger = (layer, group, patch) =>
        updateDraft({
          ...sorted,
          triggers: {
            ...sorted.triggers,
            [layer]: {
              ...sorted.triggers[layer],
              [group]: { ...sorted.triggers[layer][group], ...patch },
            },
          },
        })

      /** 秒 ↔ 毫秒，UI 只用整数秒。 */
      const secondsOf = (ms) => Math.round(ms / 1000)
      const millisOf = (seconds) => Math.round(clampNumber(seconds, 0.5, 600, 5) * 1000)

      /** 明确的落盘动作：只有这里会写 configForms。 */
      const saveChanges = async () => {
        if (liveForm === null) {
          flash('hint', t('unavailable'))
          return false
        }
        let accepted = false
        try {
          accepted = await liveForm.set('flair', normalizeFlair(sorted))
        } catch (error) {
          accepted = false
        }
        if (accepted) {
          setDirty(false)
          flash('ok', t('saved'))
        } else {
          flash('error', t('saveFailed'))
        }
        return accepted
      }

      const discardChanges = () => {
        const next = normalizeFlair(persistedRef.current)
        applyFlair(next)
        setDraft(next)
        setDirty(false)
        setPendingDelete(null)
        setPendingDeleteText(null)
        setEditing(null)
        setEditingText(null)
        flash('hint', t('discarded'))
      }

      // ---------- 外观预设 ----------

      const startEdit = (preset) => {
        setPendingDelete(null)
        setEditingText(null)
        setEditing({
          id: preset.id,
          draft: {
            name: lookLabel(preset, t),
            color: preset.style.color,
            fontSize: String(preset.style.fontSize),
            icon: preset.style.icon,
            iconSource: preset.style.iconSource,
            shimmer: String(preset.style.shimmerDuration),
            shimmerDark: preset.style.shimmerDark,
            shimmerLight: preset.style.shimmerLight,
          },
        })
      }

      const saveEdit = () => {
        if (editing === null) return
        const draft = editing.draft
        const next = {
          ...sorted,
          presets: sorted.presets.map((preset) => {
            if (preset.id !== editing.id) return preset
            const trimmed = draft.name.trim()
            const display = lookLabel(preset, t)
            const keepKey = preset.nameKey !== '' && trimmed === display
            return {
              ...preset,
              name: trimmed === '' ? preset.name : keepKey ? preset.name : trimmed,
              nameKey: trimmed === '' ? preset.nameKey : keepKey ? preset.nameKey : '',
              style: normalizeStyle({
                color: draft.color,
                fontSize: draft.fontSize,
                icon: draft.icon,
                iconSource: draft.iconSource,
                shimmerDuration: draft.shimmer,
                shimmerDark: draft.shimmerDark,
                shimmerLight: draft.shimmerLight,
              }),
            }
          }),
        }
        updateDraft(next)
        setEditing(null)
      }

      /** 上传 SVG / 透明 PNG 作为自定义图标；只读成文本或 data URL，不落别处。 */
      const readIconFile = (event) => {
        const target = event !== null && event !== undefined ? event.target : null
        const file = target !== null && target !== undefined && target.files !== null && target.files !== undefined ? target.files[0] : undefined
        if (file === undefined || file === null) return
        const name = typeof file.name === 'string' ? file.name.toLowerCase() : ''
        const apply = (value) => setEditing((current) => (current === null ? null : { ...current, draft: { ...current.draft, icon: 'custom', iconSource: value } }))
        try {
          if (typeof FileReader === 'function') {
            const reader = new FileReader()
            if (name.endsWith('.svg') || file.type === 'image/svg+xml') {
              reader.onload = () => apply(String(reader.result ?? ''))
              reader.readAsText(file)
            } else if (name.endsWith('.png') || file.type === 'image/png') {
              reader.onload = () => apply(String(reader.result ?? ''))
              reader.readAsDataURL(file)
            }
          }
        } finally {
          if (target !== null && target !== undefined) target.value = ''
        }
      }

      const addPreset = () => {
        const preset = {
          id: makeId('preset'),
          name: t('newPresetName'),
          nameKey: '',
          style: normalizeStyle({ color: '#7D9ADF', fontSize: 13, icon: 'sparkles', shimmerDuration: 1600 }),
        }
        const next = {
          ...sorted,
          presets: [...sorted.presets, preset],
          selection: { ...sorted.selection, presetIds: [...sorted.selection.presetIds, preset.id] },
        }
        updateDraft(next)
        startEdit(preset)
      }

      const duplicatePreset = (preset) => {
        const copy = {
          ...preset,
          id: makeId(preset.id),
          name: lookLabel(preset, t) + t('copySuffix'),
          nameKey: '',
          style: { ...preset.style },
        }
        const next = {
          ...sorted,
          presets: [...sorted.presets, copy],
          selection: { ...sorted.selection, presetIds: [...sorted.selection.presetIds, copy.id] },
        }
        updateDraft(next)
        startEdit(copy)
      }

      const removePreset = (preset) => {
        const presets = sorted.presets.filter((candidate) => candidate.id !== preset.id)
        const selection = {
          ...sorted.selection,
          presetIds: sorted.selection.presetIds.filter((id) => id !== preset.id),
        }
        if (selection.fixedPresetId === preset.id) {
          selection.fixedPresetId = presets.length > 0 ? presets[0].id : DEFAULT_ID
        }
        setPendingDelete(null)
        if (editing !== null && editing.id === preset.id) setEditing(null)
        updateDraft({ ...sorted, presets, selection })
      }

      // ---------- 文案预设 ----------

      const startTextEdit = (preset) => {
        setPendingDeleteText(null)
        setEditing(null)
        setEditingText({ id: preset.id, draft: { name: preset.name, texts: preset.texts.join('\n') } })
      }

      const saveTextEdit = () => {
        if (editingText === null) return
        const draft = editingText.draft
        const next = {
          ...sorted,
          textPresets: sorted.textPresets.map((preset) =>
            preset.id !== editingText.id
              ? preset
              : {
                  ...preset,
                  name: draft.name.trim() === '' ? preset.name : draft.name.trim(),
                  texts: readTexts(draft.texts.split('\n')),
                },
          ),
        }
        updateDraft(next)
        setEditingText(null)
      }

      const addTextPreset = () => {
        const preset = { id: makeId('texts'), name: t('newTextName'), texts: [t('newTextLine')] }
        const next = {
          ...sorted,
          textPresets: [...sorted.textPresets, preset],
          selection: { ...sorted.selection, textPresetIds: [...sorted.selection.textPresetIds, preset.id] },
        }
        updateDraft(next)
        startTextEdit(preset)
      }

      const duplicateTextPreset = (preset) => {
        const copy = { ...preset, id: makeId('texts'), name: preset.name + t('copySuffix'), texts: preset.texts.slice() }
        const next = {
          ...sorted,
          textPresets: [...sorted.textPresets, copy],
          selection: { ...sorted.selection, textPresetIds: [...sorted.selection.textPresetIds, copy.id] },
        }
        updateDraft(next)
        startTextEdit(copy)
      }

      const removeTextPreset = (preset) => {
        const textPresets = sorted.textPresets.filter((candidate) => candidate.id !== preset.id)
        const selection = {
          ...sorted.selection,
          textPresetIds: sorted.selection.textPresetIds.filter((id) => id !== preset.id),
        }
        if (selection.fixedTextPresetId === preset.id) {
          selection.fixedTextPresetId = textPresets.length > 0 ? textPresets[0].id : DEFAULT_ID
        }
        setPendingDeleteText(null)
        if (editingText !== null && editingText.id === preset.id) setEditingText(null)
        updateDraft({ ...sorted, textPresets, selection })
      }

      const refreshPreview = () => setPreview(samplePreview(sorted))

      // ---------- 渲染 ----------

      const lookChoices = [
        { id: DEFAULT_ID, label: t('defaultLook') },
        ...sorted.presets.map((preset) => ({ id: preset.id, label: lookLabel(preset, t) })),
      ]
      const textChoices = [
        { id: DEFAULT_ID, label: t('defaultTexts') },
        ...sorted.textPresets.map((preset) => ({ id: preset.id, label: preset.name })),
      ]

      const fixedLookId = sorted.selection.fixedPresetId
      const fixedTextId = sorted.selection.fixedTextPresetId

      const statusHint =
        liveForm === null
          ? t('unavailable')
          : snapshot.status === 'loading'
            ? t('loading')
            : snapshot.status === 'unavailable'
              ? t('unavailable')
              : writable
                ? null
                : t('readOnly')

      // 状态行始终占位，文案出现/消失不会把下面的卡片顶来顶去。
      const statusMessage =
        notice !== null
          ? notice
          : dirty
            ? { kind: 'hint', text: t('unsaved') }
            : statusHint !== null
              ? { kind: 'hint', text: statusHint }
              : null
      const statusLine = el(
        'div',
        { className: 'dshsf-status' },
        statusMessage === null ? null : el('span', { className: 'dshsf-notice', 'data-kind': statusMessage.kind }, statusMessage.text),
      )

      const actionButtons = () => [
        el(
          'button',
          { key: 'save-changes', type: 'button', className: 'dshsf-btn dshsf-btn-primary', disabled: !writable || !dirty, onClick: saveChanges },
          t('saveChanges'),
        ),
        el('button', { key: 'discard-changes', type: 'button', className: 'dshsf-btn', disabled: !dirty, onClick: discardChanges }, t('discard')),
      ]

      const actionBar = () => el('div', { className: 'dshsf-actions' }, statusLine, ...actionButtons())

      // 底部再放一组：列表很长时不用滚回顶部才能保存，状态提示也同步可见。
      const actionBarBottom = () => el('div', { className: 'dshsf-actions dshsf-actions-bottom' }, statusLine, ...actionButtons())

      const starFor = (builtInMatch, id) => {
        const previewed = preview !== null && (builtInMatch ? preview.presetId === DEFAULT_ID : preview.presetId === id)
        return previewed ? el('span', { className: 'dshsf-star', title: t('previewing'), 'aria-label': t('previewing') }, '★') : null
      }

      const fixedBadge = (match) => (match ? el('span', { className: 'dshsf-badge' }, t('pinnedBadge')) : null)

      // 内置行保留三个按钮的位置，但置灰不可点：既对齐了 ★/徽章，也让界面不显得缺一块。
      const lockedActions = () =>
        ['edit', 'copy', 'remove'].map((key) =>
          el(
            'button',
            { key: 'locked-' + key, type: 'button', className: 'dshsf-btn', disabled: true, title: t('defaultLocked'), 'aria-label': t('defaultLocked') },
            t(key),
          ),
        )

      const renderPreview = () => {
        if (preview === null) return el('div', { className: 'dshsf-empty' }, t('empty'))
        const look = findLook(sorted, preview.presetId) ?? choosePreset(sorted)
        const texts = findTextPreset(sorted, preview.textPresetId) ?? chooseTextPreset(sorted)
        const builtInLook = isBuiltIn(look)
        const emptyText = preview.text === ''
        const label = emptyText ? t('emptyPreset') : previewLabel(preview)
        const style = builtInLook
          ? undefined
          : {
              color: look.style.color,
              fontSize: String(look.style.fontSize) + 'px',
              '--dsh-sf-pv-duration': String(look.style.shimmerDuration) + 'ms',
              '--dsh-sf-pv-shimmer': shimmerColor(look.style),
            }
        const iconSize = builtInLook ? 0 : Math.max(12, Math.min(30, look.style.fontSize + 2))
        const whale = builtInLook ? officialWhaleMask() : null
        const whaleMask = whale === null ? '' : 'url("' + whale.dataUrl + '")' + (whale.suffix === '' ? '' : ' ' + whale.suffix)
        const whaleSize = 'calc(var(--dsh-content-font-size, 14px))'
        return el(
          'div',
          { className: 'dshsf-preview' },
          whale === null
            ? null
            : el('span', {
                className: 'dshsf-pv-whale',
                style: {
                  width: whaleSize,
                  height: whaleSize,
                  WebkitMask: whaleMask,
                  mask: whaleMask,
                },
                'aria-hidden': 'true',
              }),
          builtInLook || (look.style !== null && look.style !== undefined && look.style.icon === 'none')
            ? null
            : el('span', {
                className: 'dshsf-pv-icon',
                style: {
                  width: String(iconSize) + 'px',
                  height: String(iconSize) + 'px',
                  color: look.style.color,
                  WebkitMaskImage: 'url("' + iconMaskUri(look.style) + '")',
                  maskImage: 'url("' + iconMaskUri(look.style) + '")',
                },
                'aria-hidden': 'true',
              }),
          el(
            'span',
            { className: builtInLook ? 'dshsf-pv dshsf-pv-official' : 'dshsf-pv', style },
            el('span', { className: 'dshsf-pv-base' }, label),
            builtInLook || emptyText
              ? null
              : el(
                  'span',
                  { className: 'dshsf-pv-win', 'aria-hidden': 'true' },
                  el('span', { className: 'dshsf-pv-move' }, label),
                ),
          ),
          emptyText ? el('span', { className: 'dshsf-field-hint' }, t('noPreview')) : null,
          el(
            'div',
            { className: 'dshsf-preview-meta' },
            t('previewMeta').replace('{look}', lookLabel(look, t)).replace('{texts}', textPresetLabel(texts, t)),
          ),
        )
      }


      /** 一层（外观 / 文案）的触发配置：每轮 + 时间（固定/随机）+ 步骤。 */
      function renderTriggerLayer(layer, title) {
        const layerTriggers = sorted.triggers[layer]
        const turn = layerTriggers.turn
        const time = layerTriggers.time
        const step = layerTriggers.step
        const onOff = (value, onChange) =>
          el(
            'select',
            { className: 'dshsf-select', value: value ? 'on' : 'off', disabled: !writable, onChange },
            el('option', { value: 'off' }, t('triggerOff')),
            el('option', { value: 'on' }, t('triggerOn')),
          )
        const numberInput = (value, min, max, onChange) =>
          el('input', {
            className: 'dshsf-input',
            type: 'number',
            min,
            max,
            step: 1,
            value,
            disabled: !writable,
            onChange,
          })
        const field = (labelKey, control) =>
          el(
            'label',
            { className: 'dshsf-field dshsf-trigger-field' },
            el('span', { className: 'dshsf-field-label' }, t(labelKey)),
            control,
          )
        const group = (titleText, controls) =>
          el(
            'div',
            { className: 'dshsf-trigger-group' },
            el('div', { className: 'dshsf-trigger-group-title' }, titleText),
            el('div', { className: 'dshsf-trigger-controls' }, ...controls),
          )
        return el(
          'div',
          { className: 'dshsf-trigger-layer' },
          el('div', { className: 'dshsf-trigger-title' }, title),
          el(
            'div',
            { className: 'dshsf-trigger-groups' },
            // 每轮触发：只有一个开关
            group(t('turnTrigger'), [
              field(
                'triggerEnable',
                onOff(turn.enabled, (event) => patchTrigger(layer, 'turn', { enabled: event.target.value === 'on' })),
              ),
            ]),
            // 时间触发：开关 + 方式 + 间隔
            group(t('timeTrigger'), [
              field(
                'triggerEnable',
                onOff(time.enabled, (event) => patchTrigger(layer, 'time', { enabled: event.target.value === 'on' })),
              ),
              time.enabled
                ? field(
                    'triggerMode',
                    el(
                      'select',
                      {
                        className: 'dshsf-select',
                        value: time.mode,
                        disabled: !writable,
                        onChange: (event) => patchTrigger(layer, 'time', { mode: event.target.value }),
                      },
                      el('option', { value: 'fixed' }, t('triggerFixed')),
                      el('option', { value: 'random' }, t('triggerRandom')),
                    ),
                  )
                : null,
              time.enabled && time.mode === 'fixed'
                ? field(
                    'intervalSeconds',
                    numberInput(secondsOf(time.fixedMs), 1, 600, (event) =>
                      patchTrigger(layer, 'time', { fixedMs: millisOf(Number(event.target.value)) }),
                    ),
                  )
                : null,
              time.enabled && time.mode === 'random'
                ? field(
                    'minSeconds',
                    numberInput(secondsOf(time.minMs), 1, 600, (event) =>
                      patchTrigger(layer, 'time', { minMs: millisOf(Number(event.target.value)) }),
                    ),
                  )
                : null,
              time.enabled && time.mode === 'random'
                ? field(
                    'maxSeconds',
                    numberInput(secondsOf(time.maxMs), 1, 600, (event) =>
                      patchTrigger(layer, 'time', { maxMs: millisOf(Number(event.target.value)) }),
                    ),
                  )
                : null,
            ]),
            // 步骤触发：开关 + 步数
            group(t('stepTrigger'), [
              field(
                'triggerEnable',
                onOff(step.enabled, (event) => patchTrigger(layer, 'step', { enabled: event.target.value === 'on' })),
              ),
              step.enabled
                ? field(
                    'everySteps',
                    numberInput(step.every, 1, 100, (event) =>
                      patchTrigger(layer, 'step', {
                        every: Math.round(clampNumber(Number(event.target.value), 1, 100, 2)),
                      }),
                    ),
                  )
                : null,
            ]),
          ),
        )
      }

      /** 扫光色字段：颜色面板 + 文本框 + 「自动」按钮（空串 = 自动派生）。 */
      function shimmerColorField(labelKey, fieldKey) {
        const value = editing === null ? '' : editing.draft[fieldKey]
        const draftColor = editing === null ? '#efb864' : editing.draft.color
        // 留空（自动）时，面板显示该字段所属主题下自动派生出来的实色近似值。
        const fieldScheme = fieldKey === 'shimmerLight' ? 'light' : 'dark'
        const pickerValue = /^#[0-9a-f]{6}$/i.test(value) ? value : autoShimmerHex({ color: draftColor }, fieldScheme)
        const setValue = (next) => {
          if (editing === null) return
          setEditing({ ...editing, draft: { ...editing.draft, [fieldKey]: next } })
        }
        return el(
          'div',
          { className: 'dshsf-field' },
          el('span', { className: 'dshsf-field-label' }, t(labelKey)),
          el(
            'div',
            { className: 'dshsf-color-row' },
            el('input', {
              className: 'dshsf-color',
              type: 'color',
              value: pickerValue,
              disabled: !writable,
              onChange: (event) => setValue(event.target.value),
            }),
            el('input', {
              className: 'dshsf-input',
              style: { width: '92px' },
              value,
              disabled: !writable,
              placeholder: t('shimmerAuto'),
              onChange: (event) => setValue(event.target.value),
            }),
            el(
              'button',
              {
                type: 'button',
                className: 'dshsf-btn dshsf-btn-sm',
                disabled: !writable || value === '',
                onClick: () => setValue(''),
              },
              t('autoLabel'),
            ),
          ),
        )
      }

      return el(
        'div',
        { className: 'dshsf-root' },
        el('div', { className: 'dshsf-desc' }, t('desc')),
        el(
          'label',
          { className: 'dshsf-switch' },
          el('input', {
            type: 'checkbox',
            checked: sorted.enabled,
            disabled: !writable,
            onChange: (event) => updateDraft({ ...sorted, enabled: event.target.checked }),
          }),
          el('span', null, t('enable')),
          el('span', { className: 'dshsf-field-hint' }, t('enableHint')),
        ),
        actionBar(),

        // ---- 同级配置页签：默认选择先显示，切换不改变配置优先级 ----
        el('div', { className: 'dshsf-strategy-switch' },
          el('p', { className: 'dshsf-field-hint dshsf-strategy-hint' }, t('strategySourcesHint')),
          el('div', { className: 'dshsf-event-tabs', role: 'tablist', 'aria-label': t('strategyTitle') },
            ...[['default', 'defaultStrategyTab'], ['events', 'eventsTitle']].map(([id, label]) => el('button', {
              key: id, id: strategyTabsId.current + '-' + id, type: 'button', role: 'tab', className: 'dshsf-event-tab', 'data-strategy-tab': id,
              'aria-selected': strategyTab === id, 'aria-controls': strategyTabsId.current + '-' + id + '-panel', tabIndex: strategyTab === id ? 0 : -1,
              onClick: () => setStrategyTab(id), onKeyDown: (event) => onStrategyTabKey(event, id),
            }, t(label)))),
          el('section', { id: strategyTabsId.current + '-default-panel', role: 'tabpanel', 'aria-labelledby': strategyTabsId.current + '-default',
            className: 'dshsf-event-panel dshsf-strategy-panel', hidden: strategyTab !== 'default', tabIndex: 0 },
        el(
          'div',
          { className: 'dshsf-card' },
          el('div', { className: 'dshsf-card-title' }, t('modeTitle')),
          el(
            'div',
            { className: 'dshsf-grid' },
            // 外观层
            el(
              'label',
              { className: 'dshsf-field' },
              el('span', { className: 'dshsf-field-label' }, t('presetMode')),
              el(
                'select',
                {
                  className: 'dshsf-select',
                  value: sorted.selection.presetMode,
                  disabled: !writable,
                  onChange: (event) => patchSelection({ presetMode: event.target.value }),
                },
                el('option', { value: 'fixed' }, t('presetFixed')),
                el('option', { value: 'random' }, t('presetRandom')),
              ),
            ),
            sorted.selection.presetMode === 'fixed'
              ? el(
                  'label',
                  { className: 'dshsf-field' },
                  el('span', { className: 'dshsf-field-label' }, t('fixedPreset')),
                  el(
                    'select',
                    {
                      className: 'dshsf-select',
                      value: fixedLookId,
                      disabled: !writable,
                      onChange: (event) => patchSelection({ fixedPresetId: event.target.value }),
                    },
                    ...lookChoices.map((choice) => el('option', { key: choice.id, value: choice.id }, choice.label)),
                  ),
                )
              : el(
                  'div',
                  { className: 'dshsf-field' },
                  el('span', { className: 'dshsf-field-label' }, t('candidates')),
                  el(MultiSelect, {
                    t,
                    options: lookChoices,
                    value: sorted.selection.presetIds,
                    disabled: !writable,
                    onChange: (ids) => patchSelection({ presetIds: ids }),
                  }),
                ),
            // 文案层
            el(
              'label',
              { className: 'dshsf-field' },
              el('span', { className: 'dshsf-field-label' }, t('textPresetMode')),
              el(
                'select',
                {
                  className: 'dshsf-select',
                  value: sorted.selection.textPresetMode,
                  disabled: !writable,
                  onChange: (event) => patchSelection({ textPresetMode: event.target.value }),
                },
                el('option', { value: 'fixed' }, t('textPresetFixed')),
                el('option', { value: 'random' }, t('textPresetRandom')),
              ),
            ),
            sorted.selection.textPresetMode === 'fixed'
              ? el(
                  'label',
                  { className: 'dshsf-field' },
                  el('span', { className: 'dshsf-field-label' }, t('fixedTextPreset')),
                  el(
                    'select',
                    {
                      className: 'dshsf-select',
                      value: fixedTextId,
                      disabled: !writable,
                      onChange: (event) => patchSelection({ fixedTextPresetId: event.target.value }),
                    },
                    ...textChoices.map((choice) => el('option', { key: choice.id, value: choice.id }, choice.label)),
                  ),
                )
              : el(
                  'div',
                  { className: 'dshsf-field' },
                  el('span', { className: 'dshsf-field-label' }, t('candidates')),
                  el(MultiSelect, {
                    t,
                    options: textChoices,
                    value: sorted.selection.textPresetIds,
                    disabled: !writable,
                    onChange: (ids) => patchSelection({ textPresetIds: ids }),
                  }),
                ),
            // 组内文案
            el(
              'label',
              { className: 'dshsf-field' },
              el('span', { className: 'dshsf-field-label' }, t('textMode')),
              el(
                'select',
                {
                  className: 'dshsf-select',
                  value: sorted.selection.textMode,
                  disabled: !writable,
                  onChange: (event) => patchSelection({ textMode: event.target.value }),
                },
                el('option', { value: 'first' }, t('textFirst')),
                el('option', { value: 'random' }, t('textRandom')),
                el('option', { value: 'sequential' }, t('textSequential')),
              ),
              sorted.selection.textMode === 'sequential' ? el('span', { className: 'dshsf-field-hint' }, t('seqHint')) : null,
            ),
          ),
        ),

          ),
          el('section', { id: strategyTabsId.current + '-events-panel', role: 'tabpanel', 'aria-labelledby': strategyTabsId.current + '-events',
            className: 'dshsf-event-panel dshsf-strategy-panel', hidden: strategyTab !== 'events', tabIndex: 0 },
            el(EventRulesEditor, { value: sorted, onChange: updateDraft, writable, t })),
        ),

        // ---- 切换时机 ----
        el(
          'div',
          { className: 'dshsf-card' },
          el('div', { className: 'dshsf-card-title' }, t('triggersTitle')),
          el('div', { className: 'dshsf-field-hint', style: { marginBottom: '10px' } }, t('triggersHint')),
          el(
            'div',
            { className: 'dshsf-trigger-layers' },
            renderTriggerLayer('look', t('layerLook')),
            renderTriggerLayer('text', t('layerText')),
          ),
        ),

        // ---- 预览 ----
        el(
          'div',
          { className: 'dshsf-card' },
          el(
            'div',
            { className: 'dshsf-row' },
            el('div', { className: 'dshsf-card-title', style: { margin: 0 } }, t('previewTitle')),
            el('div', { className: 'dshsf-grow' }),
            el('button', { type: 'button', className: 'dshsf-btn', onClick: refreshPreview }, t('previewAgain')),
          ),
          renderPreview(),
        ),

        // ---- 外观预设列表 ----
        el(
          'div',
          { className: 'dshsf-card' },
          el(
            'div',
            { className: 'dshsf-row', style: { marginBottom: '8px' } },
            el('div', { className: 'dshsf-card-title', style: { margin: 0 } }, t('presetsTitle')),
            el('div', { className: 'dshsf-grow' }),
            el('button', { type: 'button', className: 'dshsf-btn', disabled: !writable, onClick: addPreset }, t('addPreset')),
          ),
          // 默认外观：真的就是 DSH 自己的，不占 preset 条目
          el(
            'div',
            { className: 'dshsf-preset dshsf-preset-builtin' },
            el('span', { className: 'dshsf-swatch dshsf-swatch-official' }),
            el('span', { className: 'dshsf-preset-name' }, t('defaultLook')),
            el('span', { className: 'dshsf-preset-meta' }, t('officialLookMeta')),
            starFor(true, DEFAULT_ID),
            fixedBadge(sorted.selection.presetMode === 'fixed' && fixedLookId === DEFAULT_ID),
            ...lockedActions(),
          ),
          sorted.presets.length === 0 ? el('div', { className: 'dshsf-empty' }, t('empty')) : null,
          ...sorted.presets.map((preset) => {
            const isEditing = editing !== null && editing.id === preset.id
            const isFixed = sorted.selection.presetMode === 'fixed' && fixedLookId === preset.id
            return el(
              'div',
              { key: preset.id },
              el(
                'div',
                { className: 'dshsf-preset' },
                el('span', { className: 'dshsf-swatch', style: { background: preset.style.color } }),
                el('span', { className: 'dshsf-preset-name' }, lookLabel(preset, t)),
                el(
                  'span',
                  { className: 'dshsf-preset-meta' },
                  t('presetMeta')
                    .replace('{n}', String(preset.style.fontSize))
                    .replace('{icon}', iconLabel(preset.style.icon, t))
                    .replace('{ms}', String(preset.style.shimmerDuration)),
                ),
                starFor(false, preset.id),
                fixedBadge(isFixed),
                el('button', { type: 'button', className: 'dshsf-btn', disabled: !writable, onClick: () => startEdit(preset) }, t('edit')),
                el('button', { type: 'button', className: 'dshsf-btn', disabled: !writable, onClick: () => duplicatePreset(preset) }, t('copy')),
                pendingDelete === preset.id
                  ? el('button', { type: 'button', className: 'dshsf-btn dshsf-btn-danger', disabled: !writable, onClick: () => removePreset(preset) }, t('confirmRemove'))
                  : el(
                      'button',
                      {
                        type: 'button',
                        className: 'dshsf-btn',
                        disabled: !writable,
                        onClick: () => {
                          setPendingDelete(preset.id)
                          setEditing(null)
                        },
                      },
                      t('remove'),
                    ),
              ),
              isEditing
                ? el(
                    'div',
                    { className: 'dshsf-card', style: { margin: '0 0 10px' } },
                    el(
                      'div',
                      { className: 'dshsf-grid' },
                      el(
                        'label',
                        { className: 'dshsf-field' },
                        el('span', { className: 'dshsf-field-label' }, t('name')),
                        el('input', {
                          className: 'dshsf-input',
                          value: editing.draft.name,
                          disabled: !writable,
                          onChange: (event) => setEditing({ ...editing, draft: { ...editing.draft, name: event.target.value } }),
                        }),
                      ),
                      el(
                        'label',
                        { className: 'dshsf-field' },
                        el('span', { className: 'dshsf-field-label' }, t('color')),
                        el(
                          'div',
                          { className: 'dshsf-color-row' },
                          el('input', {
                            className: 'dshsf-color',
                            type: 'color',
                            value: /^#[0-9a-f]{6}$/i.test(editing.draft.color) ? editing.draft.color : '#efb864',
                            disabled: !writable,
                            onChange: (event) => setEditing({ ...editing, draft: { ...editing.draft, color: event.target.value } }),
                          }),
                          el('input', {
                            className: 'dshsf-input',
                            style: { width: '92px' },
                            value: editing.draft.color,
                            disabled: !writable,
                            onChange: (event) => setEditing({ ...editing, draft: { ...editing.draft, color: event.target.value } }),
                          }),
                        ),
                      ),
                      el(
                        'label',
                        { className: 'dshsf-field' },
                        el('span', { className: 'dshsf-field-label' }, t('fontSize')),
                        el('input', {
                          className: 'dshsf-input dshsf-num',
                          type: 'number',
                          min: '9',
                          max: '32',
                          value: editing.draft.fontSize,
                          disabled: !writable,
                          onChange: (event) => setEditing({ ...editing, draft: { ...editing.draft, fontSize: event.target.value } }),
                        }),
                      ),
                      el(
                        'label',
                        { className: 'dshsf-field' },
                        el('span', { className: 'dshsf-field-label' }, t('icon')),
                        el(
                          'select',
                          {
                            className: 'dshsf-select',
                            value: editing.draft.icon,
                            disabled: !writable,
                            onChange: (event) => setEditing({ ...editing, draft: { ...editing.draft, icon: event.target.value } }),
                          },
                          el('option', { value: 'whale' }, t('iconWhale')),
                          el('option', { value: 'none' }, t('iconNone')),
                          ...ICON_NAMES.map((name) => el('option', { key: name, value: name }, iconLabel(name, t))),
                          el('option', { value: 'custom' }, t('customIcon')),
                        ),
                      ),
                      el(
                        'label',
                        { className: 'dshsf-field' },
                        el('span', { className: 'dshsf-field-label' }, t('shimmer')),
                        el('input', {
                          className: 'dshsf-input dshsf-num',
                          type: 'number',
                          min: '0',
                          max: '12000',
                          step: '100',
                          value: editing.draft.shimmer,
                          disabled: !writable,
                          onChange: (event) => setEditing({ ...editing, draft: { ...editing.draft, shimmer: event.target.value } }),
                        }),
                        el('span', { className: 'dshsf-field-hint' }, t('shimmerHint')),
                      ),
                      shimmerColorField('shimmerDark', 'shimmerDark'),
                      shimmerColorField('shimmerLight', 'shimmerLight'),
                      // 两个扫光色共用一条提示，避免重复两次。
                      el('div', { className: 'dshsf-field-hint', style: { width: '100%' } }, t('shimmerColorHint')),
                    ),
                    editing.draft.icon === 'custom'
                      ? el(
                          'div',
                          { className: 'dshsf-field', style: { marginTop: '10px' } },
                          el('span', { className: 'dshsf-field-label' }, t('iconSource')),
                          el('textarea', {
                            className: 'dshsf-area',
                            style: { minHeight: '64px', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '11px' },
                            value: editing.draft.iconSource,
                            disabled: !writable,
                            placeholder: '<svg viewBox="0 0 24 24">…</svg>',
                            onChange: (event) => setEditing({ ...editing, draft: { ...editing.draft, iconSource: event.target.value } }),
                          }),
                          el(
                            'div',
                            { className: 'dshsf-row', style: { marginTop: '6px' } },
                            el('input', {
                              className: 'dshsf-file',
                              type: 'file',
                              accept: '.svg,image/svg+xml,.png,image/png',
                              disabled: !writable,
                              onChange: readIconFile,
                            }),
                            editing.draft.iconSource.trim() === ''
                              ? el('span', { className: 'dshsf-field-hint' }, t('iconSourceEmpty'))
                              : null,
                          ),
                          el('span', { className: 'dshsf-field-hint' }, t('iconSourceHint')),
                        )
                      : null,
                    el(
                      'div',
                      { className: 'dshsf-row', style: { marginTop: '10px' } },
                      el('button', { type: 'button', className: 'dshsf-btn dshsf-btn-primary', disabled: !writable, onClick: saveEdit }, t('apply')),
                      el('button', { type: 'button', className: 'dshsf-btn', onClick: () => setEditing(null) }, t('cancel')),
                    ),
                  )
                : null,
            )
          }),
        ),

        // ---- 文案预设列表 ----
        el(
          'div',
          { className: 'dshsf-card' },
          el(
            'div',
            { className: 'dshsf-row', style: { marginBottom: '8px' } },
            el('div', { className: 'dshsf-card-title', style: { margin: 0 } }, t('textPresetsTitle')),
            el('div', { className: 'dshsf-grow' }),
            el('button', { type: 'button', className: 'dshsf-btn', disabled: !writable, onClick: addTextPreset }, t('addTextPreset')),
          ),
          // 默认文案：translate 原样放行，文案跟着 DSH 走
          el(
            'div',
            { className: 'dshsf-preset dshsf-preset-builtin' },
            el('span', { className: 'dshsf-text-mark', 'aria-hidden': 'true' }, '≡'),
            el('span', { className: 'dshsf-preset-name' }, t('defaultTexts')),
            el('span', { className: 'dshsf-preset-meta' }, t('officialTextMeta')),
            preview !== null && preview.textPresetId === DEFAULT_ID
              ? el('span', { className: 'dshsf-star', title: t('previewing'), 'aria-label': t('previewing') }, '★')
              : null,
            fixedBadge(sorted.selection.textPresetMode === 'fixed' && fixedTextId === DEFAULT_ID),
            ...lockedActions(),
          ),
          sorted.textPresets.length === 0 ? el('div', { className: 'dshsf-empty' }, t('emptyTexts')) : null,
          ...sorted.textPresets.map((preset) => {
            const isEditing = editingText !== null && editingText.id === preset.id
            const isFixed = sorted.selection.textPresetMode === 'fixed' && fixedTextId === preset.id
            const previewed = preview !== null && preview.textPresetId === preset.id
            return el(
              'div',
              { key: preset.id },
              el(
                'div',
                { className: 'dshsf-preset' },
                el('span', { className: 'dshsf-text-mark', 'aria-hidden': 'true' }, '≡'),
                el('span', { className: 'dshsf-preset-name' }, preset.name),
                el('span', { className: 'dshsf-preset-meta' }, t('textPresetMeta').replace('{n}', String(preset.texts.length))),
                previewed ? el('span', { className: 'dshsf-star', title: t('previewing'), 'aria-label': t('previewing') }, '★') : null,
                fixedBadge(isFixed),
                el('button', { type: 'button', className: 'dshsf-btn', disabled: !writable, onClick: () => startTextEdit(preset) }, t('edit')),
                el('button', { type: 'button', className: 'dshsf-btn', disabled: !writable, onClick: () => duplicateTextPreset(preset) }, t('copy')),
                pendingDeleteText === preset.id
                  ? el('button', { type: 'button', className: 'dshsf-btn dshsf-btn-danger', disabled: !writable, onClick: () => removeTextPreset(preset) }, t('confirmRemove'))
                  : el(
                      'button',
                      {
                        type: 'button',
                        className: 'dshsf-btn',
                        disabled: !writable,
                        onClick: () => {
                          setPendingDeleteText(preset.id)
                          setEditingText(null)
                        },
                      },
                      t('remove'),
                    ),
              ),
              isEditing
                ? el(
                    'div',
                    { className: 'dshsf-card', style: { margin: '0 0 10px' } },
                    el(
                      'label',
                      { className: 'dshsf-field' },
                      el('span', { className: 'dshsf-field-label' }, t('name')),
                      el('input', {
                        className: 'dshsf-input',
                        value: editingText.draft.name,
                        disabled: !writable,
                        onChange: (event) => setEditingText({ ...editingText, draft: { ...editingText.draft, name: event.target.value } }),
                      }),
                    ),
                    el(
                      'label',
                      { className: 'dshsf-field', style: { marginTop: '10px' } },
                      el('span', { className: 'dshsf-field-label' }, t('texts')),
                      el('textarea', {
                        className: 'dshsf-area',
                        value: editingText.draft.texts,
                        disabled: !writable,
                        onChange: (event) => setEditingText({ ...editingText, draft: { ...editingText.draft, texts: event.target.value } }),
                      }),
                      el('span', { className: 'dshsf-field-hint' }, t('textsHint')),
                    ),
                    el(
                      'div',
                      { className: 'dshsf-row', style: { marginTop: '10px' } },
                      el('button', { type: 'button', className: 'dshsf-btn dshsf-btn-primary', disabled: !writable, onClick: saveTextEdit }, t('apply')),
                      el('button', { type: 'button', className: 'dshsf-btn', onClick: () => setEditingText(null) }, t('cancel')),
                    ),
                  )
                : null,
            )
          }),
        ),
        actionBarBottom(),
      )
    }

    // ============================== 插件入口 ==============================

    const inject = ['slots', 'locale', 'configForms']

    function apply(ctx) {
      clientDisposed = false
      const t = ctx.locale.bind(NS)
      boundText = t
      ctx.effect(
        () =>
          ctx.locale.register(NS, {
            zh,
            en,
          }),
        'status-flair: dictionaries',
      )

      ctx.effect(() => {
        const removeStyle = injectCss()
        return () => {
          clientDisposed = true
          runtimeGeneration++
          stopRun()
          if (runtimeDictionaryOff) runtimeDictionaryOff()
          runtimeDictionaryOff = null
          publishedLabel = undefined
          removeStyle()
          clearPaint()
          setActiveFlag(false)
        }
      }, 'status-flair: stylesheet')

      const runtime = ctx.get('locale')
      ctx.effect(() => patchLocale(runtime), 'status-flair: running label')

      // 主题可选依赖：拿到就从主题服务读深浅色，并在切换主题时立刻重绘扫光。
      const watchTheme = (scope) => {
        const theme = scope.get('theme')
        if (theme === undefined || theme === null) return
        themeRuntime = theme
        scope.effect(
          () => {
            const repaint = () => {
              if (!flair.enabled) return
              paintPreset(findLook(flair, run.presetId) ?? choosePreset(flair))
            }
            const off = typeof scope.on === 'function' ? scope.on('theme/change', repaint) : () => {}
            return () => {
              off()
              if (themeRuntime === theme) themeRuntime = null
            }
          },
          'status-flair: theme repaint',
        )
      }
      if (typeof ctx.inject === 'function') ctx.inject(['theme'], watchTheme)
      else {
        try {
          watchTheme(ctx)
        } catch (error) {
          /* 没有主题服务时按深色回退 */
        }
      }

      ctx.effect(() => watchRuns(), 'status-flair: run watcher')

      // Borrow the main-view binding and Chat's already assembled tool tree. A Definition
      // matcher is a replayable projection, not a live event bus; never put counters in it.
      const tapMainSession = (scope) => {
        const sessions = scope.get('sessions'), ui = scope.get('uiConversation')
        if (!sessions?.list || typeof sessions.binding !== 'function' || typeof ui?.binding !== 'function') return
        scope.effect(() => watchMainSession(sessions, ui), 'status-flair: current session events')
      }
      if (typeof ctx.inject === 'function') ctx.inject(['sessions', 'uiConversation'], tapMainSession)
      else tapMainSession(ctx)

      applyFlair(DEFAULT_FLAIR)

      const forms = ctx.get('configForms')
      const form = forms !== undefined && forms !== null && typeof forms.get === 'function' ? forms.get(ENTRY_ID) : undefined
      liveForm = form === undefined ? null : form
      if (form !== undefined) {
        /**
         * 真实配置是否至少到位过一次。apply() 会先用 DEFAULT_FLAIR 占位：
         * 设置镜像就绪前若运行行已经开跑（translate 触发 rollRun），本轮签是按占位配置抽的，
         * 表现为「金色外观 + DSH 官方文案」。所以首次拿到真实配置时要作废那次抽签。
         */
        let configured = false
        /**
         * 订阅通知可能不带参数（共享镜像的通知就是无参回调），所以一律读当前快照，
         * 不能依赖回调实参——否则表单已 ready 时也会被误判成 loading 而永远跳过。
         */
        const sync = () => {
          let snapshot
          try {
            snapshot = form.getSnapshot()
          } catch (error) {
            return
          }
          if (snapshot === undefined || snapshot === null || snapshot.status !== 'ready') return
          const value = snapshot.value
          if (value === undefined || value === null) return
          const first = !configured
          const rolledEarly = run.active && run.rolled
          configured = true
          applyFlair(value.flair)
          // 首轮抢跑：按真实配置重抽，避免整轮停在官方文案；之后的配置变更仍保持本轮不变。
          if (first && rolledEarly && flair.enabled) {
            run.presetId = ''; run.textPresetId = ''
            rollRun()
          }
        }

        ctx.effect(() => {
          const off = form.subscribe(sync)
          sync()
          return () => {
            off()
            if (liveForm === form) liveForm = null
          }
        }, 'status-flair: configuration')
      }

      // 改名过渡期：插件页是按 bundle 包名找这个 keyed 槽位的。旧页面/旧清单可能
      // 还在按 @local/dsh-status-flair 找，所以同时登记一份旧 key，刷新后自然只用到新 key。
      const slotKeys = PACKAGE_NAME === LEGACY_PACKAGE_ID ? [PACKAGE_NAME] : [PACKAGE_NAME, LEGACY_PACKAGE_ID]
      for (const key of slotKeys) {
        ctx.slots.inject(SLOT_NAME, () =>
          ctx.slots.register(
            {
              name: SLOT_NAME,
              key,
              locale: NS,
            },
            StatusFlairSeat,
          ),
        )
      }

      announceClient()
    }

    /** 只用于诊断：告诉宿主"浏览器端确实加载了这个插件、用的是哪个模块 id"。 */
    function announceClient() {
      try {
        if (typeof fetch !== 'function') return
        if (typeof window === 'undefined' || window === null || window.location === undefined || window.location === null) return
        const query = '?id=' + encodeURIComponent(MODULE_ID) + '&key=' + encodeURIComponent(PACKAGE_NAME)
        fetch('/status-flair/client' + query, { cache: 'no-store', keepalive: true }).catch(() => {})
      } catch (error) {
        /* 诊断失败不影响功能 */
      }
    }

    exports.apply = apply
    exports.inject = inject
    exports.NS = NS
    exports.ENTRY_ID = ENTRY_ID
    exports.__test = {
      DEFAULT_FLAIR,
      createStarterRules, DEFAULT_SELECTION, ACTIVITY_KINDS, OUTPUT_PHASES, MATCH_ACTIVITY_KINDS, BUILTIN_GROUPS, nativeActivity, normalizeEventGroups, normalizeEventRules, eventGroupsOf, ruleIssue, groupMatches, selectEventRule,
      EventRulesEditor, eventRuleLabel, eventGroupLabel, eventState, createOutputEvidence, resetOutputEvidence, consumeOutputChunk, reconcileEventRule, resetEventSession, updateNativeActivity, consumeLiveChange, watchMainSession, effectiveFlair, stopRun,
      resolveModuleId,
      bundleIds,
      DEFAULT_ID,
      DEFAULT_LOOK,
      DEFAULT_TEXTS,
      ICONS,
      ICON_NAMES,
      normalizeFlair,
      normalizePreset,
      normalizeTextPreset,
      normalizeStyle,
      normalizeColor,
      normalizeCandidates,
      toggleCandidate,
      choosePreset,
      chooseTextPreset,
      candidatePresets,
      candidateTextPresets,
      chooseText,
      previewSample,
      samplePreview,
      previewLabel,
      extractWhaleMask,
      officialWhaleMask,
      resetWhaleMaskCache,
      officialLabel,
      interpolate,
      iconDataUri,
      iconMaskUri,
      sanitizeSvgMarkup,
      normalizeIconSource,
      lookLabel,
      iconLabel,
      textPresetLabel,
      DICTIONARIES: { zh, en },
      isBuiltIn,
      buildCss,
      setRandom,
      applyFlair,
      currentFlair,
      readLabel,
      rollRun,
      resetRun() {
        clientDisposed = false
        resetEventSession()
        run.active = false
        run.rolled = false
        run.presetId = ''
        run.textPresetId = ''
        run.text = null
      },
      commitFlair,
      run,
      patchLocale,
      clearPaint,
      normalizeTriggers,
      shimmerColor,
      autoShimmerHex,
      blendHex,
      currentColorScheme,
      triggerDelay,
      scheduleTrigger,
      scheduleTriggers,
      stopTriggerTimers,
      onStepStart,
      rollLook,
      rollText,
      triggerTimers,
      MultiSelect,
      StatusFlairSection,
      StatusFlairSummary,
      StatusFlairSeat,
      PACKAGE_NAME,
      SLOT_NAME,
      ACTIVE_ATTR,
      NO_ICON_ATTR,
      CSS_ID,
      RUNNING_SELECTOR,
    }
      return module.exports
    },
  })
})()

// bilingual: zh/en dictionaries are registered in apply(). The UI follows the DSH locale.
