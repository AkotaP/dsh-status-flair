/**
 * 客户端半：两层选择策略、默认项、迁移、文案替换、样式接管、配置写入。
 * 全部离线跑（假 DOM + 假 ctx + 迷你 React）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { loadClient, createCtx, createForm, createDom } from './support/harness.mjs'

const { module } = await loadClient()
const T = module.__test

const plain = (value) => JSON.parse(JSON.stringify(value))

function reset(dom) {
  T.setRandom(() => 0)
  dom.setRunning(true)
  dom.localStorage.clear()
  for (const key of ['--dsh-sf-color', '--dsh-sf-shimmer', '--dsh-sf-font-size', '--dsh-sf-icon-size', '--dsh-sf-icon-mask', '--dsh-sf-shimmer-duration', '--dsh-sf-shimmer-play']) {
    dom.documentElement.style.removeProperty(key)
  }
  T.resetRun()
  T.applyFlair(T.DEFAULT_FLAIR)
}

function withFlair(patch) {
  return { ...plain(T.DEFAULT_FLAIR), ...patch }
}

function selection(patch) {
  return { ...plain(T.DEFAULT_FLAIR.selection), ...patch }
}

const TEXT_PRESETS = [
  { id: 'text-golden', name: '暖金文案', texts: ['正在认真思考中…', '正在组织语言…', '脑内会议进行中…'] },
  { id: 'text-violet', name: '梦幻文案', texts: ['灵光一闪中…'] },
  { id: 'text-terminal', name: '终端文案', texts: ['Processing…'] },
]

/** 默认配置现在不带文案组；需要文案的用例显式带上一组。 */
function withTextPresets() {
  return withFlair({
    textPresets: plain(TEXT_PRESETS),
    selection: selection({
      textPresetMode: 'fixed',
      fixedTextPresetId: 'text-golden',
      textPresetIds: TEXT_PRESETS.map((preset) => preset.id),
    }),
  })
}

/** 收集 createElement 产物的 className / 文本，用于冒烟断言。 */
function collect(node, out = []) {
  if (node === null || node === undefined || node === false || node === true) return out
  if (typeof node === 'string' || typeof node === 'number') {
    out.push({ text: String(node) })
    return out
  }
  if (Array.isArray(node)) {
    for (const child of node) collect(child, out)
    return out
  }
  out.push({ type: node.type, className: typeof node.type === 'string' ? node.props?.className : undefined, disabled: node.props?.disabled === true })
  collect(node.props?.children, out)
  return out
}

/** 在树里找某一行的文本集合（行 = className 含 dshsf-preset）。 */
function rowTexts(node, name) {
  if (node === null || node === undefined || typeof node !== 'object') return null
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = rowTexts(child, name)
      if (found !== null) return found
    }
    return null
  }
  if (typeof node.type === 'string' && typeof node.props?.className === 'string' && node.props.className.includes('dshsf-preset')) {
    const flat = collect(node)
    const texts = flat.map((entry) => entry.text ?? '')
    if (texts.some((text) => text.includes(name))) return { texts, flat }
  }
  const children = node.props?.children
  if (children === undefined) return null
  return Array.isArray(children) ? children.map((child) => rowTexts(child, name)).find((found) => found !== null) ?? null : rowTexts(children, name)
}

test('样式只认稳定选择器，不写死构建期哈希类名', () => {
  const css = T.buildCss()
  assert.ok(css.includes('[data-chat-running]'))
  assert.ok(css.includes('[data-shimmer]'))
  assert.ok(css.includes(':has(> [data-shimmer])'))
  assert.ok(css.includes('html[' + T.ACTIVE_ATTR + ']'))
  assert.ok(!/xz4KEq|_1rdzk_/.test(css), 'must not depend on hashed module class names')
  assert.ok(css.includes('--dsh-sf-icon-mask'))
  assert.ok(css.includes('animation-duration:var(--dsh-sf-shimmer-duration'))
})

test('保存按钮用 DSH 的主按钮前景色，不再白底白字', () => {
  const css = T.buildCss()
  const primary = css.split('}').find((block) => block.includes('dshsf-btn-primary{'))
  assert.ok(primary !== undefined)
  assert.ok(primary.includes('--dsw-alias-button-primary-fill'), 'primary background must come from DSH')
  assert.ok(primary.includes('--dsw-alias-label-primary-foreground'), 'primary label must use the official foreground token')
  assert.ok(!/color:#fff/.test(primary), 'white-on-white was the bug')
  assert.ok(css.includes('.dshsf-btn-primary:hover:not(:disabled)'), 'hover must not be overridden by the ghost rule')
})

test('配置归一化：旧结构迁移 + 坏数据容错', () => {
  const normalized = T.normalizeFlair({
    presets: [
      { id: 'a', name: '', texts: [' ok ', '', 3], style: { color: '#ABC', fontSize: 99, icon: 'nope', shimmerDuration: -20 } },
      { id: 'a', texts: null },
    ],
    selection: { presetMode: 'weird', fixedPresetId: 'missing', presetIds: ['a', 'ghost'], textMode: 'nope' },
  })

  assert.deepEqual(normalized.presets.map((preset) => preset.id), ['a', 'a-2'])
  assert.equal(normalized.presets[0].name, 'a', '空名字退回 id')
  assert.equal(normalized.presets[0].style.color, '#aabbcc')
  assert.equal(normalized.presets[0].style.fontSize, 32)
  assert.equal(normalized.presets[0].style.icon, 'sparkles')
  assert.equal(normalized.presets[0].style.shimmerDuration, 0)
  assert.equal(normalized.presets[0].texts, undefined, '作品/文案分离后 preset 不再持有 texts')

  // 旧配置的 texts 搬成独立文案预设
  assert.deepEqual(normalized.textPresets.map((preset) => preset.id), ['text-a'])
  assert.deepEqual(normalized.textPresets[0].texts, ['ok'])
  assert.equal(normalized.textPresets[0].name, 'a')
  assert.equal(normalized.selection.presetMode, 'fixed')
  assert.equal(normalized.selection.fixedPresetId, 'a')
  assert.deepEqual(normalized.selection.presetIds, ['a'], '候选里的幽灵 id 被剔除')
  assert.equal(normalized.selection.textMode, 'random')
  // 旧版只有一层随机：外观随机 → 文案也跟着随机
  assert.equal(normalized.selection.textPresetMode, 'fixed', '旧固定模式迁移成固定文案')
  assert.equal(normalized.selection.fixedTextPresetId, 'text-a')
})

test('新结构：文案预设独立保存，default 永远是合法候选', () => {
  const normalized = T.normalizeFlair({
    presets: [{ id: 'a', name: 'A', style: {} }],
    textPresets: [
      { id: 't1', name: 'T1', texts: ['x', ' ', 'y'] },
      { id: 't1', name: 'T1 dup', texts: ['z'] },
      { id: 'default', name: 'shadow', texts: ['nope'] },
    ],
    selection: {
      presetMode: 'random',
      fixedPresetId: 'default',
      presetIds: ['a', 'default', 'ghost'],
      textPresetMode: 'random',
      fixedTextPresetId: 't1',
      textPresetIds: ['t1', 'default', 'ghost'],
      textMode: 'sequential',
    },
  })
  assert.deepEqual(normalized.textPresets.map((preset) => preset.id), ['t1', 't1-2', 'default-2'])
  assert.deepEqual(normalized.textPresets[0].texts, ['x', 'y'])
  assert.equal(normalized.selection.fixedPresetId, 'default')
  assert.deepEqual(normalized.selection.presetIds, ['a', 'default'])
  assert.equal(normalized.selection.textPresetMode, 'random')
  assert.deepEqual(normalized.selection.textPresetIds, ['t1', 'default'])
})

test('外观层：固定 / 随机 / 默认 / 候选回退', () => {
  const fixed = T.normalizeFlair(T.DEFAULT_FLAIR)
  assert.equal(T.choosePreset({ ...fixed, selection: selection({ presetMode: 'fixed', fixedPresetId: 'violet' }) }).id, 'violet')
  assert.equal(T.choosePreset({ ...fixed, selection: selection({ presetMode: 'fixed', fixedPresetId: 'default' }) }).id, 'default')

  const randomFlair = { ...fixed, selection: selection({ presetMode: 'random', presetIds: ['violet', 'terminal'] }) }
  T.setRandom(() => 0)
  assert.equal(T.choosePreset(randomFlair).id, 'violet')
  T.setRandom(() => 0.99)
  assert.equal(T.choosePreset(randomFlair).id, 'terminal')

  // 默认项也能参与随机
  const withDefault = { ...fixed, selection: selection({ presetMode: 'random', presetIds: ['default'] }) }
  assert.equal(T.choosePreset(withDefault).id, 'default')

  // 候选全空时退回全部自定义预设
  const fallback = { ...randomFlair, selection: selection({ presetMode: 'random', presetIds: [] }) }
  assert.deepEqual(T.candidatePresets(fallback).map((preset) => preset.id), ['golden', 'violet', 'terminal'])
})

test('文案层：预设随机 + 组内三条策略', () => {
  const flair = T.normalizeFlair(withTextPresets())
  const fixed = { ...flair, selection: selection({ textPresetMode: 'fixed', fixedTextPresetId: 'text-violet' }) }
  assert.equal(T.chooseTextPreset(fixed).id, 'text-violet')

  const randomTexts = { ...flair, selection: selection({ textPresetMode: 'random', textPresetIds: ['text-violet', 'text-terminal'] }) }
  T.setRandom(() => 0)
  assert.equal(T.chooseTextPreset(randomTexts).id, 'text-violet')
  T.setRandom(() => 0.99)
  assert.equal(T.chooseTextPreset(randomTexts).id, 'text-terminal')

  const preset = flair.textPresets[0]
  assert.equal(T.chooseText(preset, 'first'), preset.texts[0])
  T.setRandom(() => 0)
  assert.equal(T.chooseText(preset, 'random'), preset.texts[0])
  T.setRandom(() => 0.99)
  assert.equal(T.chooseText(preset, 'random'), preset.texts[preset.texts.length - 1])

  const seen = [T.chooseText(preset, 'sequential'), T.chooseText(preset, 'sequential'), T.chooseText(preset, 'sequential')]
  assert.deepEqual(seen, [preset.texts[0], preset.texts[1], preset.texts[2]])

  assert.equal(T.chooseText({ ...preset, texts: [] }, 'random'), null)
  assert.equal(T.chooseText(T.DEFAULT_TEXTS, 'random'), null, '默认文案不是一组可抽的文本')
})

test('{duration} 替换，其它占位符不动，双层括号不再特殊处理', () => {
  assert.equal(T.interpolate('思考中 {duration}', { duration: '7秒' }), '思考中 7秒')
  assert.equal(T.interpolate('思考中 {duration}', undefined), '思考中 {duration}')
  assert.equal(T.interpolate('{who} {duration}', { duration: '3秒' }), '{who} 3秒')
  assert.equal(T.interpolate('思考中 {{duration}}', { duration: '7秒' }), '思考中 {7秒}', '双层括号只认内层，等同于 {duration} 被再包一层')
})

test('图标输出可直接当 mask 用的 data URI', () => {
  for (const name of T.ICON_NAMES) {
    const uri = T.iconDataUri(name)
    assert.ok(uri.startsWith('data:image/svg+xml,'), name)
    assert.ok(uri.includes('%3Csvg'), name)
  }
  assert.ok(T.iconDataUri('nope').startsWith('data:image/svg+xml,'), '未知图标退回默认')
})

test('默认外观 = 不接管 CSS；自定义外观 = 写变量 + 挂标记', async () => {
  const { dom } = await loadClient()

  T.applyFlair(withFlair({ selection: selection({ presetMode: 'fixed', fixedPresetId: 'default' }) }))
  T.resetRun()
  T.applyFlair(withFlair({ selection: selection({ presetMode: 'fixed', fixedPresetId: 'default' }) }))
  assert.equal(dom.documentElement.hasAttribute(T.ACTIVE_ATTR), false, '默认外观必须把标记摘掉')
  assert.equal(dom.documentElement.style.getPropertyValue('--dsh-sf-color'), '', '默认外观不许留变量')

  T.applyFlair(withFlair({ selection: selection({ presetMode: 'fixed', fixedPresetId: 'golden' }) }))
  T.resetRun()
  T.applyFlair(withFlair({ selection: selection({ presetMode: 'fixed', fixedPresetId: 'golden' }) }))
  assert.equal(dom.documentElement.hasAttribute(T.ACTIVE_ATTR), true)
  assert.equal(dom.documentElement.style.getPropertyValue('--dsh-sf-color'), '#efb864')
})

test('apply：注入样式、接管运行行、注册插件页', async () => {
  const { dom } = await loadClient()
  reset(dom)
  const form = createForm({ flair: plain(T.DEFAULT_FLAIR) })
  const host = createCtx({ forms: { get: () => form } })
  module.apply(host.ctx)

  assert.equal(dom.styles.length, 1, '应注入一份样式')
  assert.ok(dom.styles[0].textContent.includes('[data-chat-running]'))
  assert.equal(dom.styles[0].dataset.pluginCss, T.CSS_ID)
  assert.equal(dom.styles[0].dataset.plugin, 'dsh-status-flair')
  assert.equal(dom.documentElement.hasAttribute(T.ACTIVE_ATTR), true)
  assert.equal(host.registrations.length, 2, '新 key + 旧 key 各登记一次（改名过渡）')
  assert.equal(host.registrations[0].options.name, 'plugins.bundle.config')
  assert.equal(host.registrations[0].options.key, 'dsh-status-flair')
  assert.equal(host.registrations[0].options.id, undefined, 'keyed 槽位用 key，不用 id')
  assert.equal(host.registrations[0].options.locale, module.NS)
  assert.equal(host.registrations[0].Component, T.StatusFlairSeat)
  assert.equal(host.registrations[1].options.key, '@local/dsh-status-flair')
  assert.equal(host.registrations[1].Component, T.StatusFlairSeat)
  assert.equal(T.PACKAGE_NAME, 'dsh-status-flair')
  assert.equal(T.SLOT_NAME, 'plugins.bundle.config')
  assert.equal(host.dictionaries[0].ns, module.NS)

  // 默认文案走 DSH 自己的（见下一个用例）；这里换成带文案组的配置再看接管
  T.applyFlair(withTextPresets())
  T.resetRun()
  T.setRandom(() => 0)
  assert.equal(host.locale.translate('chat', 'chat.deepDiving'), '正在认真思考中…')
  assert.equal(host.locale.translate('chat', 'chat.deepDivingFor', { duration: '7秒' }), '正在认真思考中…')
  assert.equal(host.locale.translate('chat', 'other.key'), 'ORIGINAL(chat:other.key)')
  assert.equal(host.locale.translate('common', 'ok'), 'ORIGINAL(common:ok)')

  // 带 {duration} 的模板会被替换
  T.applyFlair(
    withFlair({
      presets: [{ id: 'golden', name: 'g', style: T.DEFAULT_FLAIR.presets[0].style }],
      textPresets: [{ id: 'texts', name: 't', texts: ['思考中 {duration}'] }],
      selection: selection({
        presetMode: 'fixed',
        fixedPresetId: 'golden',
        presetIds: ['golden'],
        textPresetMode: 'fixed',
        fixedTextPresetId: 'texts',
        textPresetIds: ['texts'],
        textMode: 'first',
      }),
    }),
  )
  T.resetRun()
  assert.equal(host.locale.translate('chat', 'chat.deepDivingFor', { duration: '7秒' }), '思考中 7秒')

  host.dispose()
})

test('默认文案预设：translate 原样放行（直接拿 DSH 的文案）', async () => {
  const { dom } = await loadClient()
  reset(dom)
  const host = createCtx({ forms: { get: () => createForm({ flair: plain(T.DEFAULT_FLAIR) }) } })
  module.apply(host.ctx)

  T.applyFlair(withFlair({ selection: selection({ textPresetMode: 'fixed', fixedTextPresetId: 'default' }) }))
  T.resetRun()
  assert.equal(T.readLabel({}), null)
  assert.equal(host.locale.translate('chat', 'chat.deepDiving'), 'ORIGINAL(chat:chat.deepDiving)')
  assert.equal(host.locale.translate('chat', 'chat.deepDivingFor', { duration: '7秒' }), 'ORIGINAL(chat:chat.deepDivingFor)')

  host.dispose()
})

test('一次思考只抽一次：运行行消失后才重新抽', async () => {
  const { dom } = await loadClient()
  reset(dom)
  const host = createCtx({ forms: { get: () => createForm({ flair: plain(withTextPresets()) }) } })
  module.apply(host.ctx)

  T.setRandom(() => 0)
  const first = host.locale.translate('chat', 'chat.deepDiving')
  T.setRandom(() => 0.99)
  const second = host.locale.translate('chat', 'chat.deepDiving')
  assert.equal(first, second, '同一轮里文案不许跳变')

  dom.setRunning(false)
  dom.triggerMutations()
  const third = host.locale.translate('chat', 'chat.deepDiving')
  assert.notEqual(third, first, '新一轮必须重新抽')

  host.dispose()
})

test('关闭后交还官方文案与默认外观', async () => {
  const { dom } = await loadClient()
  reset(dom)
  const host = createCtx({ forms: { get: () => createForm({ flair: plain(T.DEFAULT_FLAIR) }) } })
  module.apply(host.ctx)

  T.applyFlair(withFlair({ enabled: false }))
  assert.equal(dom.documentElement.hasAttribute(T.ACTIVE_ATTR), false)
  assert.equal(host.locale.translate('chat', 'chat.deepDiving'), 'ORIGINAL(chat:chat.deepDiving)')
  assert.equal(T.readLabel({}), null)

  host.dispose()
})

test('写配置走 configForms.set("flair", …)，两层数组整体替换', async () => {
  const { dom } = await loadClient()
  reset(dom)
  const form = createForm({ flair: plain(T.DEFAULT_FLAIR) })
  const host = createCtx({ forms: { get: () => form } })
  module.apply(host.ctx)

  const next = withFlair({
    presets: [plain(T.DEFAULT_FLAIR.presets[0])],
    textPresets: [plain(TEXT_PRESETS[0])],
    selection: selection({ textPresetMode: 'fixed', fixedTextPresetId: 'text-golden', textPresetIds: ['text-golden'] }),
  })
  const accepted = await T.commitFlair(next)
  assert.equal(accepted, true)
  assert.equal(form.writes.length, 1)
  assert.equal(form.writes[0].field, 'flair')
  assert.equal(form.writes[0].value.presets.length, 1)
  assert.equal(form.writes[0].value.textPresets.length, 1)
  assert.equal(form.writes[0].value.presets[0].id, 'golden')
  assert.equal(form.writes[0].value.textPresets[0].id, 'text-golden')

  // 宿主侧推来的新配置立刻生效
  form.push({
    flair: withFlair({
      presets: [{ id: 'solo', name: 'solo', style: { color: '#112233', fontSize: 18, icon: 'moon', shimmerDuration: 900 } }],
      textPresets: [{ id: 'solo-texts', name: 'solo', texts: ['独苗'] }],
      selection: selection({
        presetMode: 'fixed',
        fixedPresetId: 'solo',
        presetIds: ['solo'],
        textPresetMode: 'fixed',
        fixedTextPresetId: 'solo-texts',
        textPresetIds: ['solo-texts'],
        textMode: 'first',
      }),
    }),
  })
  assert.equal(dom.vars.get('--dsh-sf-color'), '#112233')
  assert.equal(dom.vars.get('--dsh-sf-font-size'), '18px')
  assert.equal(dom.vars.get('--dsh-sf-shimmer-duration'), '900ms')
  assert.ok(dom.vars.get('--dsh-sf-icon-mask').includes('data:image/svg+xml'))

  host.dispose()
})

test('没有设置通道也不崩：用默认配置继续工作', async () => {
  const { dom } = await loadClient()
  reset(dom)
  const host = createCtx()
  assert.doesNotThrow(() => module.apply(host.ctx))
  assert.equal(host.registrations.length, 2)
  const written = await T.commitFlair(T.DEFAULT_FLAIR)
  assert.equal(written, false, '没有通道时写入返回 false，由 UI 提示')
  host.dispose()
})

test('卸载后还原：样式标签被移除、translate 复原、标记摘掉', async () => {
  const { dom } = await loadClient()
  reset(dom)
  const host = createCtx({ forms: { get: () => createForm({ flair: plain(T.DEFAULT_FLAIR) }) } })
  module.apply(host.ctx)
  assert.equal(dom.styles.length, 1)
  host.dispose()
  assert.equal(dom.styles.length, 0)
  assert.equal(dom.documentElement.hasAttribute(T.ACTIVE_ATTR), false)
  assert.equal(host.locale.translate('chat', 'chat.deepDiving'), 'ORIGINAL(chat:chat.deepDiving)')
})

test('设置页能真正渲染（冒烟）：默认项、预览、两层列表都在', async () => {
  const { dom } = await loadClient()
  reset(dom)
  const form = createForm({ flair: plain(T.DEFAULT_FLAIR) })
  const host = createCtx({ forms: { get: () => form } })
  module.apply(host.ctx)

  const tree = T.StatusFlairSection({ t: (key) => key })
  const flat = collect(tree)
  assert.equal(tree.type, 'div')
  assert.equal(tree.props.className, 'dshsf-root')
  assert.ok(!flat.some((node) => node.className === 'dshsf-title'), '插件页自己画标题，面板里不该再画一个')
  assert.ok(flat.some((node) => node.className === 'dshsf-preview'), '应有预览区')
  assert.ok(flat.filter((node) => node.className === 'dshsf-card').length >= 4, '应有使用方式 / 预览 / 外观 / 文案四块')
  assert.ok(flat.some((node) => node.text === 'presetNameGolden'), '出厂预设名走本地化 key')
  assert.ok(flat.some((node) => node.text === 'presetNameTerminal'))
  assert.ok(!flat.some((node) => node.text === '暖金文案'), '默认不再带文案组')
  assert.ok(flat.some((node) => node.text === 'ORIGINAL(chat:chat.deepDivingFor)'), '预览应使用 DSH 官方文案')

  // 默认外观与默认文案都各有一行，且都带 DSH 标记
  const defaultRows = flat.filter((node) => node.text === 'defaultLook' || node.text === 'defaultTexts')
  assert.ok(defaultRows.length >= 2, '默认外观与默认文案都要出现在列表里')
  assert.equal(flat.filter((node) => node.className === 'dshsf-star').length, 2, '外观与文案各一行能拿到 ★')

  // ★ 和预览对得上：默认配置固定 golden + 默认文案，★ 必须落在这两行
  const goldenRow = rowTexts(tree, 'presetNameGolden')
  assert.ok(goldenRow !== null, '应有暖金色这一行')
  assert.ok(goldenRow.flat.some((node) => node.text === '★'), '预览中的外观行应有 ★')
  const goldenTextRow = rowTexts(tree, 'defaultTexts')
  assert.ok(goldenTextRow !== null, '应有默认文案这一行')
  assert.ok(goldenTextRow.flat.some((node) => node.text === '★'), '预览中的文案行应有 ★')
  const terminalRow = rowTexts(tree, 'presetNameTerminal')
  assert.ok(terminalRow !== null)
  assert.ok(!terminalRow.flat.some((node) => node.text === '★'), '没被预览的终端绿不该带 ★')

  // 内置行的三个按钮保留但置灰；状态行常驻，页内草稿的保存/放弃按钮在干净时不可点
  const lockedLookRow = rowTexts(tree, 'defaultLook')
  const lockedTextRow = rowTexts(tree, 'defaultTexts')
  assert.equal(lockedLookRow.flat.filter((node) => node.type === 'button' && node.disabled === true).length, 3)
  assert.equal(lockedTextRow.flat.filter((node) => node.type === 'button' && node.disabled === true).length, 3)
  assert.equal(flat.filter((node) => node.text === 'saveChanges').length, 2, '顶部和底部各一组保存按钮')
  assert.equal(flat.filter((node) => node.text === 'discard').length, 2)
  assert.ok(flat.some((node) => node.className === 'dshsf-status'), '状态行必须常驻占位')
  assert.ok(!flat.some((node) => typeof node.className === 'string' && node.className.includes('placeholder')))

  // 随机模式：候选用多选下拉，而不是一排 checkbox
  form.push({ flair: withFlair({ selection: selection({ presetMode: 'random', textPresetMode: 'random' }) }) })
  const randomTree = T.StatusFlairSection({ t: (key) => key })
  const randomFlat = collect(randomTree)
  assert.equal(randomFlat.filter((node) => node.type === T.MultiSelect).length, 2, '外观与文案各一个多选下拉')

  // 空配置：默认项还在，空状态提示也在
  form.push({
    flair: {
      enabled: true,
      presets: [],
      textPresets: [],
      selection: selection({
        presetMode: 'fixed',
        fixedPresetId: 'default',
        presetIds: [],
        textPresetMode: 'fixed',
        fixedTextPresetId: 'default',
        textPresetIds: [],
      }),
    },
  })
  const emptyFlat = collect(T.StatusFlairSection({ t: (key) => key }))
  assert.ok(emptyFlat.some((node) => node.text === 'empty'), '空列表应提示 empty')
  assert.ok(emptyFlat.some((node) => node.text === 'emptyTexts'), '空文案列表应提示 emptyTexts')
  assert.ok(emptyFlat.some((node) => node.text === 'defaultLook'))
  assert.ok(emptyFlat.some((node) => node.text === 'defaultTexts'))

  host.dispose()
})

test('多选下拉：按钮摘要与勾选逻辑', () => {
  const t = (key) => key
  const calls = []
  const tree = T.MultiSelect({
    t,
    options: [
      { id: 'a', label: 'A' },
      { id: 'b', label: 'B' },
      { id: 'c', label: 'C' },
    ],
    value: ['a'],
    onChange: (next) => calls.push(next),
  })
  const flat = collect(tree)
  assert.ok(flat.some((node) => typeof node.text === 'string' && node.text.includes('msCount')), '应显示已选数量')
  assert.equal(flat.filter((node) => node.type === 'label').length, 0, '收起时不应渲染选项')

  assert.deepEqual(T.toggleCandidate(['a'], 'b', true), ['a', 'b'])
  assert.deepEqual(T.toggleCandidate(['a', 'b'], 'a', false), ['b'])
})

test('设置页在写入被拒时给出可见错误（不是静默失败）', async () => {
  const { dom } = await loadClient()
  reset(dom)
  const form = createForm({ flair: plain(T.DEFAULT_FLAIR) })
  const ctxHost = createCtx({ forms: { get: () => form } })
  module.apply(ctxHost.ctx)

  const originalSet = form.set
  form.set = async () => false
  const accepted = await T.commitFlair(T.DEFAULT_FLAIR)
  assert.equal(accepted, false)
  form.set = originalSet

  ctxHost.dispose()
})

test('插件页摘要：view=summary 走摘要分支，外观与文案计数都在', async () => {
  const { dom } = await loadClient()
  reset(dom)
  const form = createForm({ flair: plain(T.DEFAULT_FLAIR) })
  const host = createCtx({ forms: { get: () => form } })
  module.apply(host.ctx)

  const seat = T.StatusFlairSeat({ t: (key) => key, view: 'summary' })
  assert.equal(seat.type, T.StatusFlairSummary, 'summary 视图必须走摘要组件')

  const template = (t) => (key) =>
    key === 'summaryOn' ? '外观 {name} · {presets} 个预设 · {texts} 组文案' : key
  const flat = collect(T.StatusFlairSummary({ t: template() }))
  const text = flat.map((node) => node.text ?? '').join('')
  assert.ok(text.includes('presetNameGolden'), '摘要里应有当前外观名的本地化 key：' + text)
  assert.ok(text.includes('3 个预设'), '摘要里应有外观数量：' + text)
  assert.ok(text.includes('0 组文案'), '默认不带文案组：' + text)

  form.push({ flair: { ...plain(T.DEFAULT_FLAIR), enabled: false } })
  const offText = collect(T.StatusFlairSummary({ t: template() })).map((n) => n.text ?? '').join('')
  assert.equal(offText, 'summaryOff')

  const page = T.StatusFlairSeat({ t: (key) => key, view: 'page' })
  assert.equal(page.type, T.StatusFlairSection)

  host.dispose()
})


test('改名过渡：combo 脚本里旧行只注册空壳，不会重复注册同一份 bundle', async () => {
  // 单行 URL
  assert.equal(T.resolveModuleId({ src: 'http://127.0.0.1/plugins/??dsh-status-flair/client.js&rev=1' }), 'dsh-status-flair')
  assert.equal(T.resolveModuleId({ src: 'http://127.0.0.1/plugins/??@local/dsh-status-flair/client.js&rev=1' }), '@local/dsh-status-flair')
  assert.equal(T.resolveModuleId(null), 'dsh-status-flair', '拿不到 currentScript 时退回新包名')

  // combo 脚本：一段脚本里依次拼了旧行与新行，执行顺序与 URL 里的出现顺序一致
  const batch = { src: 'http://127.0.0.1/plugins/??dsh-chime/client.js,@local/dsh-status-flair/client.js,dsh-status-flair/client.js&rev=2' }
  assert.equal(T.resolveModuleId(batch), '@local/dsh-status-flair')
  assert.equal(T.resolveModuleId(batch), 'dsh-status-flair')
  assert.equal(T.resolveModuleId(batch), 'dsh-status-flair', '多出来的执行退回首包名，不再重复注册旧 id')
  assert.deepEqual(T.bundleIds('x/@local/dsh-status-flair/client.js,y/dsh-status-flair/client.js'), ['@local/dsh-status-flair', 'dsh-status-flair'])

  // 重新执行一次 bundle，模拟旧 URL 的加载
  const previousWindow = globalThis.window
  const previousDocument = globalThis.document
  const dom = createDom()
  dom.document.currentScript = { src: 'http://127.0.0.1:12359/plugins/??@local/dsh-status-flair/client.js&rev=e30156e3481e' }
  let spec
  globalThis.window = {
    __ModuleLoader__: {
      load(value) {
        spec = value
      },
    },
  }
  globalThis.document = dom.document
  try {
    await import('../lib/client.js?legacy-load=1')
    assert.equal(spec.id, '@local/dsh-status-flair')
    const legacyModule = spec.factory(() => {
      throw new Error('legacy shell must not require anything')
    })
    assert.equal(typeof legacyModule.apply, 'function')
    assert.deepEqual(legacyModule.inject, [])
    legacyModule.apply()
    assert.equal(dom.styles.length, 0, '空壳不该注入任何样式')
  } finally {
    globalThis.window = previousWindow
    globalThis.document = previousDocument
  }
})


test('鲸鱼遮罩：直接从 DSH 样式里取，不复制素材', () => {
  const css = '.xz4KEq_runningWhaleAnimated{will-change:transform;background:currentColor;display:block;mask:url(data:image/png;base64,iVBORw0KGgo=) 50%/100% 100% no-repeat alpha}.xz4KEq_runningWhaleStill{display:none}'
  const mask = T.extractWhaleMask(css)
  assert.notEqual(mask, null)
  assert.equal(mask.dataUrl, 'data:image/png;base64,iVBORw0KGgo=')
  assert.equal(mask.suffix, '50%/100% 100% no-repeat alpha')
  assert.equal(T.extractWhaleMask('.x{color:red}'), null)
  assert.equal(T.extractWhaleMask(''), null)
})

test('默认外观的预览复用官方鲸鱼遮罩', async () => {
  const { dom } = await loadClient()
  reset(dom)
  const form = createForm({
    flair: withFlair({
      selection: selection({ presetMode: 'fixed', fixedPresetId: 'default', textPresetMode: 'fixed', fixedTextPresetId: 'default' }),
    }),
  })
  const host = createCtx({ forms: { get: () => form } })
  module.apply(host.ctx)
  T.resetWhaleMaskCache()
  dom.document.styleSheets = [
    {
      cssRules: [
        {
          cssText:
            '.xz4KEq_runningWhaleAnimated{will-change:transform;background:currentColor;display:block;mask:url(data:image/png;base64,iVBORw0KGgo=) 50%/100% 100% no-repeat alpha}',
        },
      ],
    },
  ]
  try {
    const tree = T.StatusFlairSection({ t: (key) => key })
    const flat = collect(tree)
    const whale = flat.find((node) => node.className === 'dshsf-pv-whale')
    assert.ok(whale !== undefined, '默认外观预览应渲染鲸鱼')
    assert.ok(flat.some((node) => node.className === 'dshsf-pv dshsf-pv-official'), '官方文案 + 官方配色')
    assert.ok(!flat.some((node) => node.text === 'officialLookHint'), '说明文案已移除')
  } finally {
    delete dom.document.styleSheets
    T.resetWhaleMaskCache()
    host.dispose()
  }
})


test('旧名迁移：golden 预设从「暖金色思考」改为「暖金色」', () => {
  assert.equal(T.DEFAULT_FLAIR.presets[0].name, '暖金色')
  assert.deepEqual(T.DEFAULT_FLAIR.textPresets, [], '默认不带文案组')
  assert.equal(T.DEFAULT_FLAIR.selection.fixedTextPresetId, 'default')
  const migrated = T.normalizeFlair({ presets: [{ id: 'golden', name: '暖金色思考', style: {} }] })
  assert.equal(migrated.presets[0].name, '暖金色')
  assert.equal(migrated.presets[0].nameKey, 'golden', '出厂名可以跟着语言翻译')
  const custom = T.normalizeFlair({ presets: [{ id: 'golden', name: '我的金', style: {} }] })
  assert.equal(custom.presets[0].name, '我的金', '用户自己起的名字不动')
  assert.equal(custom.presets[0].nameKey, '', '改过名就不再套用出厂名')
})

test('自定义图标：清洗 SVG、data URL 与遮罩生成', () => {
  const dirty = '<svg viewBox="0 0 24 24" onload="alert(1)"><script>alert(1)</script><path d="M0 0h24v24z" fill="#fff"/></svg>'
  const clean = T.sanitizeSvgMarkup(dirty)
  assert.ok(clean.startsWith('<svg'))
  assert.ok(!/script|onload/i.test(clean), '脚本与事件属性必须被清掉')
  assert.equal(T.normalizeIconSource(clean), clean)
  assert.equal(T.normalizeIconSource('not svg'), '')
  assert.equal(T.normalizeIconSource('data:image/png;base64,AAAA'), 'data:image/png;base64,AAAA')
  assert.equal(T.normalizeIconSource('data:text/html;base64,AAAA'), '')

  const style = T.normalizeStyle({ icon: 'custom', iconSource: clean })
  assert.equal(style.icon, 'custom')
  assert.equal(style.iconSource, clean)
  assert.ok(T.iconMaskUri(style).startsWith('data:image/svg+xml,'))
  assert.equal(T.iconMaskUri(T.normalizeStyle({ icon: 'custom', iconSource: '' })), T.iconDataUri('sparkles'), '空图标退回内置')
  assert.equal(T.iconMaskUri(T.normalizeStyle({ icon: 'custom', iconSource: 'data:image/png;base64,AAAA' })), 'data:image/png;base64,AAAA')
  assert.equal(T.iconMaskUri(T.normalizeStyle({ icon: 'star' })), T.iconDataUri('star'))

  const external = T.sanitizeSvgMarkup('<svg><image href="https://example.com/a.png"/><use xlink:href="#a"/></svg>')
  assert.ok(!external.includes('example.com'), '外部引用被清掉')
  assert.ok(external.includes('#a'), '内部引用保留')
})


test('预览抽样只记 id：改样式/名字不会重抽', () => {
  const flair = T.normalizeFlair(withTextPresets())
  T.setRandom(() => 0)
  const sample = T.samplePreview(flair)
  assert.equal(typeof sample.presetId, 'string')
  assert.equal(typeof sample.textPresetId, 'string')
  assert.equal(sample.presetId, 'golden')
  assert.equal(sample.textPresetId, 'text-golden')
  assert.equal(sample.text, '正在认真思考中…')
  assert.equal('preset' in sample, false, '不再把预设对象钉在预览里')
})


test('双语字典：界面文案、出厂预设名与图标名都成对', () => {
  const zh = T.DICTIONARIES.zh
  const en = T.DICTIONARIES.en
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort(), '中英字典 key 必须一一对应')
  for (const [key, value] of Object.entries(zh)) {
    assert.equal(typeof value, 'string', key)
    assert.notEqual(value.trim(), '', key)
    assert.notEqual(en[key].trim(), '', key)
  }

  const tZh = (key) => (T.DICTIONARIES.zh[key] !== undefined ? T.DICTIONARIES.zh[key] : key)
  const tEn = (key) => (T.DICTIONARIES.en[key] !== undefined ? T.DICTIONARIES.en[key] : key)
  const preset = T.normalizeFlair(T.DEFAULT_FLAIR).presets[0]
  assert.equal(T.lookLabel(preset, tZh), '暖金色')
  assert.equal(T.lookLabel(preset, tEn), 'Warm gold')
  assert.equal(T.lookLabel(T.DEFAULT_LOOK, tEn), 'Default (DSH)')
  assert.equal(T.iconLabel('sparkles', tZh), '星光')
  assert.equal(T.iconLabel('sparkles', tEn), 'Sparkles')
  assert.equal(T.iconLabel('custom', tEn), 'Custom')
  assert.equal(T.iconLabel('whale', tEn), 'Whale (DSH animation)')

  // 用户改过名的预设不再翻译
  const renamed = { ...preset, name: 'My look', nameKey: '' }
  assert.equal(T.lookLabel(renamed, tEn), 'My look')
})


test('鲸鱼图标：复用官方 APNG 遮罩，颜色与文字扫光仍由预设控制', async () => {
  const { dom } = await loadClient()
  reset(dom)
  T.resetWhaleMaskCache()
  dom.document.styleSheets = [
    {
      cssRules: [
        {
          cssText:
            '.xz4KEq_runningWhaleAnimated{background:currentColor;display:block;mask:url(data:image/png;base64,iVBORw0KGgo=) 50%/100% 100% no-repeat alpha}',
        },
      ],
    },
  ]
  try {
    const style = T.normalizeStyle({ icon: 'whale', color: '#123456', fontSize: 14, shimmerDuration: 900 })
    assert.equal(style.icon, 'whale', 'whale 是合法图标')
    assert.equal(T.iconMaskUri(style), 'data:image/png;base64,iVBORw0KGgo=', '遮罩取自 DSH 样式表')

    const whaleFlair = {
      ...T.DEFAULT_FLAIR,
      presets: [{ id: 'whale', name: 'whale', style }],
      selection: selection({ presetMode: 'fixed', fixedPresetId: 'whale', presetIds: ['whale'] }),
    }
    T.resetRun()
    T.applyFlair(whaleFlair)
    assert.equal(dom.vars.get('--dsh-sf-color'), '#123456', '颜色跟随预设')
    assert.equal(dom.vars.get('--dsh-sf-icon-mask'), 'url("data:image/png;base64,iVBORw0KGgo=")')
    assert.equal(dom.vars.get('--dsh-sf-shimmer-duration'), '900ms', '扫光节奏仍由预设控制')
  } finally {
    delete dom.document.styleSheets
    T.resetWhaleMaskCache()
  }

  // 找不到官方样式时退回内置图标，不报错
  assert.equal(T.iconMaskUri(T.normalizeStyle({ icon: 'whale' })), T.iconDataUri('sparkles'))
})

test('配置迟到：首轮已抽签时，真实配置到位后立即重抽文案', async () => {
  const { dom } = await loadClient()
  reset(dom)

  // 设置镜像尚未就绪：快照停在 loading，订阅稍后才补发真实配置。
  let snapshot = { status: 'loading', value: undefined, writable: true, revision: 0 }
  const listeners = new Set()
  const form = {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    async set() {
      return true
    },
  }
  const host = createCtx({ forms: { get: () => form } })
  module.apply(host.ctx)

  // 占位 DEFAULT_FLAIR 先抽了签：默认外观 + 官方文案。
  dom.setRunning(true)
  assert.equal(host.locale.translate('chat', 'chat.deepDivingFor', { duration: '2秒' }), 'ORIGINAL(chat:chat.deepDivingFor)')
  assert.equal(T.run.rolled, true, '占位配置已经抽过签')

  // 真实配置迟到送达：同一轮里要作废占位签，换成真实文案组。
  const ready = withTextPresets()
  snapshot = { status: 'ready', value: { flair: plain(ready) }, writable: true, revision: 1, base: plain(ready), user: {} }
  for (const listener of [...listeners]) listener(snapshot)

  assert.equal(T.run.textPresetId, 'text-golden', '首轮重抽后应使用真实文案组')
  assert.equal(host.locale.translate('chat', 'chat.deepDivingFor', { duration: '2秒' }), '正在认真思考中…', '同一轮立即切到真实文案')

  // 之后的配置变更仍保持本轮不变，只在下一轮生效。
  const later = withTextPresets()
  later.textPresets = [{ id: 'text-late', name: '迟到组', texts: ['迟到的第二组'] }]
  later.selection = selection({ textPresetMode: 'fixed', fixedTextPresetId: 'text-late', textPresetIds: ['text-late'] })
  snapshot = { ...snapshot, value: { flair: plain(later) }, revision: 2 }
  for (const listener of [...listeners]) listener(snapshot)
  assert.equal(host.locale.translate('chat', 'chat.deepDivingFor', { duration: '2秒' }), '正在认真思考中…', '运行中不跳变')

  dom.setRunning(false)
  dom.triggerMutations()
  assert.equal(host.locale.translate('chat', 'chat.deepDivingFor', { duration: '2秒' }), '迟到的第二组', '下一轮使用新配置')

  host.dispose()
})

test('订阅通知不带参数时也要应用配置（共享镜像的通知就是无参回调）', async () => {
  const { dom } = await loadClient()
  reset(dom)

  // 真实 createSnapshotStore 的通知回调不带参数。旧实现把第一个实参当快照读，
  // 于是表单 ready 之后每次通知都被误判成 loading 跳过，运行行永远停在占位配置。
  let snapshot = { status: 'loading', value: undefined, writable: true, revision: 0 }
  const listeners = new Set()
  const form = {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    async set() {
      return true
    },
  }
  const host = createCtx({ forms: { get: () => form } })
  try {
    module.apply(host.ctx)
    assert.equal(T.currentFlair().textPresets.length, 0, '挂载时只有占位配置')

    // 宿主侧配置就绪：先更新快照，再以无参回调通知（与真实 store 一致）。
    const ready = plain(withTextPresets())
    snapshot = { status: 'ready', value: { flair: ready }, writable: true, revision: 1, base: { flair: ready }, user: {} }
    for (const listener of [...listeners]) listener()

    assert.deepEqual(
      T.currentFlair().textPresets.map((preset) => preset.id),
      TEXT_PRESETS.map((preset) => preset.id),
      '无参通知后应读到真实配置',
    )
    dom.setRunning(true)
    assert.equal(host.locale.translate('chat', 'chat.deepDivingFor', { duration: '2秒' }), '正在认真思考中…')
  } finally {
    host.dispose()
  }
})

test('startTime 未就绪时不显示裸 {duration} 模板（第一帧交还官方文案）', async () => {
  const { dom } = await loadClient()
  reset(dom)
  const templated = withFlair({
    textPresets: [{ id: 'text-dur', name: '带时长', texts: ['Ciallo～(∠・ω< )⌒★，用时{duration}...'] }],
    selection: selection({ textPresetMode: 'fixed', fixedTextPresetId: 'text-dur', textPresetIds: ['text-dur'] }),
  })
  const host = createCtx({ forms: { get: () => createForm({ flair: plain(templated) }) } })
  try {
    module.apply(host.ctx)
    T.resetRun()

    // chat.deepDiving：DSH 还没拿到 startTime，不带 duration —— 按 0 秒插值，文案完整不裸奔
    // （harness 的 locale 没有 duration.secondUnit 字典，走中性回退 0s）
    assert.equal(host.locale.translate('chat', 'chat.deepDiving'), 'Ciallo～(∠・ω< )⌒★，用时0s...')
    // chat.deepDivingFor：带 duration 才用自定义模板
    assert.equal(
      host.locale.translate('chat', 'chat.deepDivingFor', { duration: '7秒' }),
      'Ciallo～(∠・ω< )⌒★，用时7秒...',
    )

    // 不含占位符的自定义文案在没有参数时照常显示
    const plainText = withFlair({
      textPresets: [{ id: 'text-plain', name: '无时长', texts: ['正在思考中…'] }],
      selection: selection({ textPresetMode: 'fixed', fixedTextPresetId: 'text-plain', textPresetIds: ['text-plain'] }),
    })
    T.applyFlair(plainText)
    T.resetRun()
    assert.equal(host.locale.translate('chat', 'chat.deepDiving'), '正在思考中…')

    // 模板只剩占位符时，第一帧同样显示 0 值而不是空串（字典缺失 → 中性 0s）
    T.applyFlair(
      withFlair({
        textPresets: [{ id: 'text-only', name: '仅时长', texts: ['{duration}'] }],
        selection: selection({ textPresetMode: 'fixed', fixedTextPresetId: 'text-only', textPresetIds: ['text-only'] }),
      }),
    )
    T.resetRun()
    assert.equal(host.locale.translate('chat', 'chat.deepDiving'), '0s')
  } finally {
    host.dispose()
  }
})

test('触发配置归一化：默认关闭、越界夹紧、随机区间自动排序', () => {
  const defaults = T.normalizeTriggers(undefined)
  assert.equal(defaults.look.turn.enabled, true, '每轮触发默认开启（历史行为）')
  assert.equal(defaults.text.turn.enabled, true)
  assert.equal(defaults.look.time.enabled, false, '默认不开启时间触发')
  assert.equal(defaults.look.step.enabled, false, '默认不开启步骤触发')
  assert.equal(defaults.text.time.mode, 'fixed')
  assert.equal(defaults.text.step.every, 2)

  const clamped = T.normalizeTriggers({
    look: { time: { enabled: true, mode: 'random', fixedMs: 1, minMs: 9000, maxMs: 3000 }, step: { enabled: true, every: 999 } },
  })
  assert.equal(clamped.look.turn.enabled, true, '未声明时保持每轮触发开启')
  assert.equal(T.normalizeTriggers({ look: { turn: { enabled: false } } }).look.turn.enabled, false, '显式 false 才关闭')
  assert.equal(clamped.look.time.enabled, true)
  assert.equal(clamped.look.time.mode, 'random')
  assert.deepEqual([clamped.look.time.minMs, clamped.look.time.maxMs], [3000, 9000], 'min/max 颠倒时自动排序')
  assert.equal(clamped.look.time.fixedMs, 500, '过低间隔夹到 500ms')
  assert.equal(clamped.look.step.every, 100, '步数上限 100')
  assert.equal(clamped.text.time.enabled, false, '未配置的层保持默认')
})

test('时间触发：固定/随机延迟按配置计算，关闭时为 null', async () => {
  const { dom } = await loadClient()
  reset(dom)
  const host = createCtx({ forms: { get: () => createForm({ flair: plain(T.DEFAULT_FLAIR) }) } })
  module.apply(host.ctx)
  try {
    T.setRandom(() => 0.5)
    T.applyFlair(
      withFlair({
        triggers: {
          look: { time: { enabled: false, mode: 'fixed', fixedMs: 5000, minMs: 3000, maxMs: 9000 }, step: { enabled: false, every: 2 } },
          text: { time: { enabled: true, mode: 'fixed', fixedMs: 4000, minMs: 1000, maxMs: 3000 }, step: { enabled: false, every: 2 } },
        },
      }),
    )
    assert.equal(T.triggerDelay('look'), null, '关闭的层没有延迟')
    assert.equal(T.triggerDelay('text'), 4000, '固定间隔')

    T.applyFlair(
      withFlair({
        triggers: {
          look: { time: { enabled: false, mode: 'fixed', fixedMs: 5000, minMs: 3000, maxMs: 9000 }, step: { enabled: false, every: 2 } },
          text: { time: { enabled: true, mode: 'random', fixedMs: 4000, minMs: 1000, maxMs: 3000 }, step: { enabled: false, every: 2 } },
        },
      }),
    )
    assert.equal(T.triggerDelay('text'), 2000, '随机间隔落在 [1000, 3000] 中点')
  } finally {
    host.dispose()
  }
})

test('步骤触发：每 N 步重抽文案，未启用的外观层不动', async () => {
  const { dom } = await loadClient()
  reset(dom)
  const base = plain(withTextPresets())
  const config = {
    ...base,
    triggers: {
      look: { time: { enabled: false, mode: 'fixed', fixedMs: 5000, minMs: 3000, maxMs: 9000 }, step: { enabled: false, every: 2 } },
      text: { time: { enabled: false, mode: 'fixed', fixedMs: 5000, minMs: 3000, maxMs: 9000 }, step: { enabled: true, every: 2 } },
    },
  }
  const host = createCtx({ forms: { get: () => createForm({ flair: plain(config) }) } })
  module.apply(host.ctx)
  try {
    T.setRandom(() => 0)
    T.resetRun()
    dom.setRunning(true)
    T.rollRun()
    const firstText = T.run.text
    const firstPreset = T.run.presetId

    T.onStepStart()
    assert.equal(T.run.text, firstText, '第 1 步不触发（每 2 步）')
    assert.equal(T.run.presetId, firstPreset)

    T.setRandom(() => 0.9)
    T.onStepStart()
    assert.notEqual(T.run.text, firstText, '第 2 步重抽文案')
    assert.equal(T.run.presetId, firstPreset, '外观层未启用步骤触发，保持不动')
  } finally {
    host.dispose()
  }
})

test('扫光颜色跟随主题深浅：深色提亮、浅色压暗', async () => {
  const { dom } = await loadClient()
  reset(dom)

  const darkHost = createCtx({})
  module.apply(darkHost.ctx)
  try {
    assert.equal(T.currentColorScheme(), 'dark', '没有主题服务时按深色回退')
    assert.equal(T.shimmerColor({ color: '#efb864' }), 'color-mix(in srgb, #efb864 45%, #ffffff)')
  } finally {
    darkHost.dispose()
  }

  const lightHost = createCtx({ theme: { getSnapshot: () => ({ active: { colorScheme: 'light' } }) } })
  module.apply(lightHost.ctx)
  try {
    assert.equal(T.currentColorScheme(), 'light')
    assert.equal(T.shimmerColor({ color: '#efb864' }), 'color-mix(in srgb, #efb864 70%, #000000)', '浅色主题往黑里压')
  } finally {
    lightHost.dispose()
  }
})

test('自定义扫光色：深色/浅色各取各的，留空回退自动派生', async () => {
  const { dom } = await loadClient()
  reset(dom)

  const darkHost = createCtx({})
  module.apply(darkHost.ctx)
  try {
    const style = { color: '#efb864', shimmerDark: '#ffaa00', shimmerLight: '#334455' }
    assert.equal(T.shimmerColor(style), '#ffaa00', '深色主题用深色自定义色')
    assert.equal(T.shimmerColor({ color: '#efb864', shimmerLight: '#334455' }), 'color-mix(in srgb, #efb864 45%, #ffffff)', '缺深色自定义色时自动派生')
  } finally {
    darkHost.dispose()
  }

  const lightHost = createCtx({ theme: { getSnapshot: () => ({ active: { colorScheme: 'light' } }) } })
  module.apply(lightHost.ctx)
  try {
    const style = { color: '#efb864', shimmerDark: '#ffaa00', shimmerLight: '#334455' }
    assert.equal(T.shimmerColor(style), '#334455', '浅色主题用浅色自定义色')
  } finally {
    lightHost.dispose()
  }
})

test('扫光色归一化：只接受合法 CSS 颜色，非法值退回自动', () => {
  const accepted = T.normalizeStyle({ shimmerDark: '#FF0000', shimmerLight: '#0f0' })
  assert.equal(accepted.shimmerDark, '#ff0000')
  assert.equal(accepted.shimmerLight, '#00ff00')
  const rejected = T.normalizeStyle({ shimmerDark: 'red;}body{display:none', shimmerLight: 'not-a-color' })
  assert.equal(rejected.shimmerDark, '', '注入式字符串被拒绝')
  assert.equal(rejected.shimmerLight, '', '非法颜色退回空串（自动）')
})

test('步骤触发借用主会话来源，不在 replayable Definition 中产生副作用', async () => {
  const { dom } = await loadClient()
  reset(dom)
  const config = { ...plain(withTextPresets()), triggers: {
    look: { step: { enabled: false, every: 2 } }, text: { step: { enabled: true, every: 2 } },
  } }
  function source(initial) {
    let snapshot = initial
    const listeners = new Set()
    return { getSnapshot: () => snapshot, subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn) },
      push(next) { snapshot = next; for (const fn of listeners) fn() } }
  }
  const events = source({ revision: 0, change: { kind: 'replace', entries: [] } })
  const target = source({ legacy: { runningCalls: [] } }), openTurn = source(1)
  const binding = { sessionId: 'main', eventSource: events }
  const sessions = { list: source({ byId: { main: { id: 'main', retainedBy: { mainView: 1 } } } }), binding: () => binding }
  const uiConversation = { binding: () => ({ target: () => target, openTurn }), events: { register() { throw new Error('must not register a side-effect matcher') } } }
  const host = createCtx({ forms: { get: () => createForm({ flair: config }) }, sessions, uiConversation })
  module.apply(host.ctx)
  try {
    T.setRandom(() => 0)
    T.rollRun()
    const first = T.run.text
    const append = (revision, type, data = { turn: 1 }) => events.push({ revision, change: { kind: 'append', entries: [{ type: 'event', event: { type, data } }] } })
    append(1, 'step/start')
    assert.equal(T.run.stepCount, 1)
    append(1, 'step/start')
    assert.equal(T.run.stepCount, 1, '重复 revision 不计步')
    T.setRandom(() => 0.9)
    append(2, 'step/start')
    assert.notEqual(T.run.text, first)
    events.push({ revision: 3, change: { kind: 'prepend', entries: [{ type: 'event', event: { type: 'step/start', data: { turn: 1 } } }] } })
    assert.equal(T.run.stepCount, 2, '历史 prepend 不计步')
    append(4, 'turn/start', { turn: 2 })
    assert.equal(T.run.stepCount, 0)
  } finally { host.dispose() }
})

test('设置页渲染切换时机：外观与文案两层各含每轮、时间、步骤触发', async () => {
  const { dom } = await loadClient()
  reset(dom)
  const host = createCtx({ forms: { get: () => createForm({ flair: plain(withTextPresets()) }) } })
  module.apply(host.ctx)
  try {
    const tree = T.StatusFlairSection({ t: (key) => key })
    const flat = collect(tree)
    const texts = flat.map((node) => node.text ?? '')
    assert.ok(texts.includes('triggersTitle'), '有「切换时机」卡片')
    assert.ok(texts.includes('layerLook') && texts.includes('layerText'), '外观与文案两层')
    assert.equal(texts.filter((value) => value === 'turnTrigger').length, 2, '两层各一个每轮触发')
    assert.equal(texts.filter((value) => value === 'timeTrigger').length, 2, '两层各一个时间触发')
    assert.equal(texts.filter((value) => value === 'stepTrigger').length, 2, '两层各一个步骤触发')
    assert.equal(texts.filter((value) => value === 'triggerOff').length, 6, '两层各三个开关')
  } finally {
    host.dispose()
  }
})

test('每轮触发：关闭某层后新一轮沿用上一轮抽签结果', async () => {
  const { dom } = await loadClient()
  reset(dom)
  const base = plain(
    withFlair({
      presets: plain(T.DEFAULT_FLAIR.presets),
      textPresets: [{ id: 'text-a', name: 'A', texts: ['第一条文案', '第二条文案'] }],
      selection: selection({
        presetMode: 'random',
        presetIds: ['golden', 'violet', 'terminal'],
        textPresetMode: 'fixed',
        fixedTextPresetId: 'text-a',
        textPresetIds: ['text-a'],
        textMode: 'random',
      }),
    }),
  )
  const off = { enabled: false, mode: 'fixed', fixedMs: 5000, minMs: 3000, maxMs: 9000 }
  const config = {
    ...base,
    triggers: {
      look: { turn: { enabled: false }, time: off, step: { enabled: false, every: 2 } },
      text: { turn: { enabled: true }, time: off, step: { enabled: false, every: 2 } },
    },
  }
  const host = createCtx({ forms: { get: () => createForm({ flair: plain(config) }) } })
  module.apply(host.ctx)
  try {
    T.setRandom(() => 0)
    T.resetRun()
    dom.setRunning(true)
    T.rollRun()
    const firstLook = T.run.presetId
    const firstText = T.run.text
    assert.equal(firstLook, 'golden')
    assert.equal(firstText, '第一条文案')

    // 本轮结束 → 新一轮开始：外观层关闭每轮触发，文案层开启
    dom.setRunning(false)
    dom.triggerMutations()
    T.setRandom(() => 0.9)
    dom.setRunning(true)
    T.rollRun()
    assert.equal(T.run.presetId, firstLook, '外观沿用上一轮')
    assert.notEqual(T.run.text, firstText, '文案每轮重抽')
  } finally {
    host.dispose()
  }
})

test('每轮触发关闭且无其它触发器时，两层都保持初始抽签结果', async () => {
  const { dom } = await loadClient()
  reset(dom)
  const base = plain(
    withFlair({
      presets: plain(T.DEFAULT_FLAIR.presets),
      textPresets: [{ id: 'text-a', name: 'A', texts: ['第一条文案', '第二条文案'] }],
      selection: selection({
        presetMode: 'random',
        presetIds: ['golden', 'violet', 'terminal'],
        textPresetMode: 'fixed',
        fixedTextPresetId: 'text-a',
        textPresetIds: ['text-a'],
        textMode: 'random',
      }),
    }),
  )
  const off = { enabled: false, mode: 'fixed', fixedMs: 5000, minMs: 3000, maxMs: 9000 }
  const config = {
    ...base,
    triggers: {
      look: { turn: { enabled: false }, time: off, step: { enabled: false, every: 2 } },
      text: { turn: { enabled: false }, time: off, step: { enabled: false, every: 2 } },
    },
  }
  const host = createCtx({ forms: { get: () => createForm({ flair: plain(config) }) } })
  module.apply(host.ctx)
  try {
    T.setRandom(() => 0)
    T.resetRun()
    dom.setRunning(true)
    T.rollRun()
    const firstLook = T.run.presetId
    const firstText = T.run.text

    dom.setRunning(false)
    dom.triggerMutations()
    T.setRandom(() => 0.9)
    dom.setRunning(true)
    T.rollRun()
    assert.equal(T.run.presetId, firstLook, '外观保持')
    assert.equal(T.run.text, firstText, '文案保持')
  } finally {
    host.dispose()
  }
})

test('自动扫光色：面板近似值跟随主题与主色', async () => {
  const { dom } = await loadClient()
  reset(dom)

  const darkHost = createCtx({})
  module.apply(darkHost.ctx)
  try {
    // 深色：45% 主色 + 55% 白
    assert.equal(T.autoShimmerHex({ color: '#efb864' }), '#f8dfb9')
    assert.equal(T.blendHex('#000000', '#ffffff', 0.5), '#808080')
  } finally {
    darkHost.dispose()
  }

  const lightHost = createCtx({ theme: { getSnapshot: () => ({ active: { colorScheme: 'light' } }) } })
  module.apply(lightHost.ctx)
  try {
    // 浅色：70% 主色 + 30% 黑
    assert.equal(T.autoShimmerHex({ color: '#efb864' }), '#a78146')
  } finally {
    lightHost.dispose()
  }
})

test('图标可选「不显示」：归一化接受 none，绘制时隐藏图标位', async () => {
  const { dom } = await loadClient()
  reset(dom)
  assert.equal(T.normalizeStyle({ icon: 'none' }).icon, 'none')
  assert.equal(T.iconLabel('none', (key) => key), 'iconNone')

  const host = createCtx({})
  module.apply(host.ctx)
  try {
    const noIcon = withFlair({
      presets: [{ id: 'plain', name: '无图标', style: { color: '#efb864', fontSize: 13, icon: 'none', shimmerDuration: 2000 } }],
      selection: selection({ presetMode: 'fixed', fixedPresetId: 'plain', presetIds: ['plain'] }),
    })
    T.applyFlair(noIcon)
    T.resetRun()
    dom.setRunning(true)
    T.rollRun()
    assert.equal(dom.documentElement.hasAttribute(T.NO_ICON_ATTR), true, '挂上隐藏标记')
    assert.equal(dom.vars.get('--dsh-sf-icon-mask'), 'linear-gradient(#0000, #0000)', '遮罩变全透明')
    T.clearPaint()
    assert.equal(dom.documentElement.hasAttribute(T.NO_ICON_ATTR), false, '清除时摘掉标记')
  } finally {
    host.dispose()
  }
})

test('事件配置界面：添加/排序/预览不修改默认选择或运行游标', async () => {
  const { dom } = await loadClient()
  reset(dom)
  let value = T.normalizeFlair({ ...withTextPresets(), eventRules: { enabled: false, rules: [] } }), changed
  const nodes = (tree, out = []) => { if (Array.isArray(tree)) tree.forEach((v) => nodes(v, out)); else if (tree && typeof tree === 'object') { out.push(tree); nodes(tree.props?.children, out) } return out }
  const render = () => nodes(T.EventRulesEditor({ value, t: (key) => key, writable: true, onChange: (next) => { changed = next } }))
  const button = (tree, text, n = 0) => tree.filter((x) => x.type === 'button' && x.props.children.includes(text))[n]
  button(render(), 'eventAddRule').props.onClick()
  assert.equal(changed.eventRules.rules.length, 1)
  assert.deepEqual(changed.eventRules.rules[0].selection, value.selection)
  assert.deepEqual(changed.selection, value.selection)
  value = T.normalizeFlair(changed)
  button(render(), 'eventAddRule').props.onClick()
  // makeId must produce distinct ids even when the random source is deterministic.
  assert.notEqual(changed.eventRules.rules[0].id, changed.eventRules.rules[1].id)
  value = T.normalizeFlair(changed)
  const second = value.eventRules.rules[1].id
  button(render(), 'eventMoveUp', 1).props.onClick()
  assert.equal(changed.eventRules.rules[0].id, second)
  const before = plain(T.run)
  button(render(), 'eventPreview').props.onClick()
  assert.deepEqual(plain(T.run), before)
  assert.ok(render().some((node) => node.type === 'input' && node.props.type === 'checkbox'))
  const locked = nodes(T.EventRulesEditor({ value, t: (key) => key, writable: false, onChange() { throw new Error('read-only') } }))
  assert.equal(button(locked, 'eventAddRule').props.disabled, true)
})

test('事件界面显示实时等待、思考和回复状态，工具执行时仍显示工具状态', async () => {
  const { dom } = await loadClient()
  reset(dom)
  T.resetEventSession('main', true)
  T.updateNativeActivity({ runningCalls: [] }, 1)
  const t = (key) => T.DICTIONARIES.zh[key] ?? key
  const props = { value: T.normalizeFlair(T.DEFAULT_FLAIR), writable: true, onChange() {}, t }
  const findStatus = (node) => {
    if (Array.isArray(node)) return node.map(findStatus).find(Boolean)
    if (!node || typeof node !== 'object') return undefined
    if (node.props?.role === 'status') return node
    return findStatus(node.props?.children)
  }
  const status = () => collect(findStatus(T.EventRulesEditor(props))).map((item) => item.text ?? '').join('')
  const chunk = (type, index, text) => T.consumeLiveChange({ kind: 'append', entries: [{ type: 'transient', event: { type: 'assistant/live-chunk', data: { turn: 1, step: 1, attemptId: 'a', chunk: { type, index, text } } } }] })
  try {
    assert.ok(status().includes('输出状态：等待响应'))
    chunk('reasoning-delta', 0, '推理')
    assert.ok(status().includes('输出状态：思考中（显式推理）'))
    chunk('text-delta', 1, '正文')
    assert.ok(status().includes('输出状态：回复中（可见正文）'))
    T.updateNativeActivity({ legacy: { runningCalls: [{ callId: 'one', name: 'read', turn: 1, phase: 'start' }] } }, 1)
    assert.ok(status().includes('输出状态：工具执行中'))
    const allText = collect(T.EventRulesEditor(props)).map((item) => item.text ?? '').join('')
    assert.ok(allText.includes('已识别的工具活动：读取文件'))
  } finally { T.resetRun() }
})

test('规则与分组页签有独立内容区和局部操作栏，键盘切换同步选择与焦点', async () => {
  const { dom, react } = await loadClient()
  reset(dom)
  const original = react.useState
  let tab = 'rules', hook = 0
  react.useState = (initial) => {
    const slot = hook++
    return [slot === 0 ? tab : initial, (next) => { if (slot === 0) tab = next }]
  }
  const nodes = (tree, out = []) => { if (Array.isArray(tree)) tree.forEach((v) => nodes(v, out)); else if (tree && typeof tree === 'object') { out.push(tree); nodes(tree.props?.children, out) } return out }
  const props = { value: T.normalizeFlair(T.DEFAULT_FLAIR), t: (key) => key, writable: true, onChange() {} }
  const render = () => { hook = 0; return nodes(T.EventRulesEditor(props)) }
  const texts = (tree) => nodes(tree).flatMap((n) => n.props?.children ?? []).filter((n) => typeof n === 'string')
  try {
    let tree = render()
    let tabs = tree.filter((n) => n.props.role === 'tab')
    let panel = tree.find((n) => n.props.role === 'tabpanel')
    assert.equal(tabs.length, 2)
    assert.equal(tabs.filter((n) => n.props['aria-selected']).length, 1)
    assert.equal(tabs[0].props.tabIndex, 0)
    assert.equal(tabs[1].props.tabIndex, -1)
    assert.equal(tabs[0].props['aria-controls'], panel.props.id)
    assert.equal(panel.props['aria-labelledby'], tabs[0].props.id)
    const toolbar = nodes(panel).find((n) => n.props.className === 'dshsf-event-toolbar')
    assert.ok(texts(toolbar).includes('eventRulesPanelTitle'))
    assert.ok(texts(toolbar).includes('eventAddRule'))
    assert.ok(!texts(panel).includes('eventAddGroup'))
    tabs[1].props.onClick()
    tree = render()
    tabs = tree.filter((n) => n.props.role === 'tab')
    panel = tree.find((n) => n.props.role === 'tabpanel')
    assert.equal(tabs[1].props['aria-selected'], true)
    assert.equal(panel.props['aria-labelledby'], tabs[1].props.id)
    assert.ok(texts(panel).includes('eventGroupsPanelTitle'))
    assert.ok(texts(panel).includes('eventAddGroup'))
    assert.ok(!texts(panel).includes('eventAddRule'))
    let prevented = false, focused = ''
    tabs[1].props.onKeyDown({ key: 'ArrowRight', preventDefault() { prevented = true }, currentTarget: { parentElement: { querySelector(selector) { focused = selector; return { focus() {} } } } } })
    assert.equal(tab, 'rules')
    assert.equal(prevented, true)
    assert.match(focused, /rules/)
  } finally { react.useState = original }
})

test('默认选择与事件规则同级切换，默认页先打开且不会切换生效配置', async () => {
  const { dom, react } = await loadClient()
  reset(dom)
  const host = createCtx({ forms: { get: () => createForm({ flair: plain(T.DEFAULT_FLAIR) }) } })
  module.apply(host.ctx)
  const original = react.useState
  let active = 'default'
  react.useState = (initial) => initial === 'default' ? [active, (next) => { active = next }] : original(initial)
  const nodes = (tree, out = []) => { if (Array.isArray(tree)) tree.forEach((v) => nodes(v, out)); else if (tree && typeof tree === 'object') { out.push(tree); nodes(tree.props?.children, out) } return out }
  const render = () => nodes(T.StatusFlairSection({ t: (key) => key }))
  try {
    const before = plain(T.currentFlair())
    let tree = render()
    const tabs = tree.filter((n) => n.props['data-strategy-tab'])
    assert.deepEqual(tabs.map((n) => n.props['data-strategy-tab']), ['default', 'events'])
    assert.equal(tabs[0].props['aria-selected'], true)
    let panels = tree.filter((n) => n.props.className?.includes('dshsf-strategy-panel'))
    assert.equal(panels[0].props.hidden, false)
    assert.equal(panels[1].props.hidden, true)
    assert.equal(panels[0].props['aria-labelledby'], tabs[0].props.id)
    assert.equal(panels[1].props['aria-labelledby'], tabs[1].props.id)
    assert.ok(nodes(panels[0]).some((n) => n.props.className === 'dshsf-card-title' && n.props.children.includes('modeTitle')))
    assert.ok(nodes(panels[1]).some((n) => n.type === T.EventRulesEditor))
    assert.equal(tree.filter((n) => n.type === T.EventRulesEditor).length, 1)
    tabs[1].props.onClick()
    tree = render(); panels = tree.filter((n) => n.props.className?.includes('dshsf-strategy-panel'))
    assert.equal(panels[0].props.hidden, true)
    assert.equal(panels[1].props.hidden, false)
    assert.deepEqual(plain(T.currentFlair()), before)
    let focused = ''
    const eventsTab = tree.find((n) => n.props['data-strategy-tab'] === 'events')
    eventsTab.props.onKeyDown({ key: 'Home', preventDefault() {}, currentTarget: { parentElement: { querySelector(selector) { focused = selector; return { focus() {} } } } } })
    assert.equal(active, 'default')
    assert.match(focused, /default/)
    const timing = tree.find((n) => n.props.className === 'dshsf-card-title' && n.props.children.includes('triggersTitle'))
    assert.ok(timing)
    assert.ok(!panels.some((p) => nodes(p).includes(timing)), 'global rotation timing is shared, not hidden in one strategy panel')
  } finally { react.useState = original; host.dispose() }
})


test('收起的规则仍可启用和排序，快捷操作不位于折叠内容中', async () => {
  const { dom } = await loadClient()
  reset(dom)
  let changed
  const value = T.normalizeFlair(T.DEFAULT_FLAIR)
  const nodes = (tree, out = []) => { if (Array.isArray(tree)) tree.forEach((v) => nodes(v, out)); else if (tree && typeof tree === 'object') { out.push(tree); nodes(tree.props?.children, out) } return out }
  const tree = nodes(T.EventRulesEditor({ value, t: (key) => key, writable: true, onChange: (next) => { changed = next } }))
  const items = tree.filter((n) => n.type === 'article' && n.props.className.includes('dshsf-rule-item'))
  assert.equal(items.length, 4)
  for (const item of items) {
    const descendants = nodes(item)
    const details = descendants.find((n) => n.type === 'details')
    assert.notEqual(details.props.open, true)
    const actions = descendants.find((n) => n.props.className === 'dshsf-rule-actions')
    assert.ok(actions)
    assert.ok(!nodes(details).includes(actions), 'quick actions must not disappear with the detail body')
    assert.equal(nodes(actions).filter((n) => n.type === 'input' && n.props.type === 'checkbox').length, 1)
    assert.equal(nodes(actions).filter((n) => n.type === 'button').length, 2)
  }
  const firstActions = nodes(items[0]).find((n) => n.props.className === 'dshsf-rule-actions')
  const enable = nodes(firstActions).find((n) => n.type === 'input')
  enable.props.onChange({ target: { checked: false } })
  assert.equal(changed.eventRules.rules[0].enabled, false)
  assert.equal(changed.eventRules.enabled, false, 'individual edit does not turn on the master switch')
  const secondActions = nodes(items[1]).find((n) => n.props.className === 'dshsf-rule-actions')
  nodes(secondActions).find((n) => n.type === 'button' && n.props.children.includes('eventMoveUp')).props.onClick()
  assert.equal(changed.eventRules.rules[0].id, value.eventRules.rules[1].id)
})

test('入门规则只补缺少的条目，新项使用DSH自带选择但不覆盖已有配置', async () => {
  const { dom } = await loadClient()
  reset(dom)
  const nodes = (tree, out = []) => { if (Array.isArray(tree)) tree.forEach((v) => nodes(v, out)); else if (tree && typeof tree === 'object') { out.push(tree); nodes(tree.props?.children, out) } return out }
  const base = T.normalizeFlair(withTextPresets())
  base.selection.fixedPresetId = 'violet'
  const starter = T.createStarterRules()[0]
  starter.name = 'My interaction'; starter.nameKey = ''
  starter.selection.fixedPresetId = 'terminal'
  let value = T.normalizeFlair({ ...base, eventRules: { enabled: false, rules: [starter] } }), changed
  const render = () => nodes(T.EventRulesEditor({ value, t: (key) => key, writable: true, onChange: (next) => { changed = next } }))
  const button = render().find((n) => n.type === 'button' && n.props.children.includes('eventAddStarters'))
  assert.equal(button.props.disabled, false)
  button.props.onClick()
  assert.equal(changed.eventRules.rules.length, 4)
  assert.deepEqual(changed.eventRules.rules[0], starter)
  assert.equal(changed.eventRules.enabled, false)
  for (const r of changed.eventRules.rules.slice(1)) {
    assert.equal(r.selection.fixedPresetId, T.DEFAULT_ID)
    assert.equal(r.selection.fixedTextPresetId, T.DEFAULT_ID)
    assert.deepEqual(r.selection.presetIds, [T.DEFAULT_ID])
    assert.deepEqual(r.selection.textPresetIds, [T.DEFAULT_ID])
  }
  assert.equal(changed.selection.fixedPresetId, 'violet', 'global selection is not changed')
  assert.notEqual(changed.eventRules.rules[1].selection.presetIds, changed.eventRules.rules[2].selection.presetIds)
  value = T.normalizeFlair(changed)
  assert.equal(render().find((n) => n.type === 'button' && n.props.children.includes('eventAddStarters')).props.disabled, true)
})

test('入门规则按固定身份补缺：首次四条、已有两条补两条、齐全后禁用', async () => {
  const { dom } = await loadClient()
  reset(dom)
  const nodes = (tree, out = []) => { if (Array.isArray(tree)) tree.forEach((v) => nodes(v, out)); else if (tree && typeof tree === 'object') { out.push(tree); nodes(tree.props?.children, out) } return out }
  const base = T.normalizeFlair(T.DEFAULT_FLAIR)
  for (const [present, customCount, expectedAdded] of [[0, 0, 4], [2, 0, 2], [4, 0, 0], [0, 1, 4]]) {
    const existing = T.createStarterRules().slice(0, present)
    if (customCount) existing.push({ ...T.createStarterRules()[0], id: 'custom', name: 'My own rule', nameKey: '' })
    let value = T.normalizeFlair({ ...base, eventRules: { enabled: false, rules: existing } }), changed
    const render = () => nodes(T.EventRulesEditor({ value, t: (key) => key, writable: true, onChange: (next) => { changed = next } }))
    const add = render().find((n) => n.type === 'button' && n.props.children.includes('eventAddStarters'))
    assert.equal(add.props.disabled, expectedAdded === 0)
    if (!expectedAdded) continue
    add.props.onClick()
    assert.equal(changed.eventRules.rules.length - existing.length, expectedAdded)
    assert.deepEqual(changed.eventRules.rules.slice(0, existing.length), value.eventRules.rules)
    assert.equal(changed.eventRules.enabled, false)
    value = T.normalizeFlair(changed)
    assert.equal(render().find((n) => n.type === 'button' && n.props.children.includes('eventAddStarters')).props.disabled, true)
  }
})

test('入门规则名称随语言切换，手动改名后保持自定义名称', async () => {
  await loadClient()
  const rules = T.createStarterRules()
  const zh = (key) => T.DICTIONARIES.zh[key] ?? key
  const en = (key) => T.DICTIONARIES.en[key] ?? key
  assert.equal(T.eventRuleLabel(rules[0], zh), '思考与交互')
  assert.equal(T.eventRuleLabel(rules[0], en), 'Thinking and interaction')
  assert.equal(T.eventRuleLabel({ ...rules[0], name: 'Custom name', nameKey: '' }, en), 'Custom name')
})

test('事件分组界面：内置可复制，自定义工具可编辑，被引用分组禁止删除', async () => {
  const { dom, react } = await loadClient()
  reset(dom)
  const original = react.useState
  let hooks = 0, changed
  react.useState = () => [hooks++ === 0 ? 'groups' : null, () => {}]
  const nodes = (tree, out = []) => { if (Array.isArray(tree)) tree.forEach((v) => nodes(v, out)); else if (tree && typeof tree === 'object') { out.push(tree); nodes(tree.props?.children, out) } return out }
  try {
    const custom = { id: 'reading', name: 'Reading', kind: 'activity', activityKinds: ['read'], toolNames: ['custom_read'], events: [] }
    const value = T.normalizeFlair({ ...withTextPresets(), eventGroups: [custom], eventRules: { enabled: true, rules: [{ id: 'r', name: 'R', kind: 'activity', groupIds: ['reading'], selection: withTextPresets().selection }] } })
    const tree = nodes(T.EventRulesEditor({ value, t: (key) => key, writable: true, onChange: (next) => { changed = next } }))
    const copy = tree.find((n) => n.type === 'button' && n.props.children.includes('copy'))
    copy.props.onClick()
    assert.equal(changed.eventGroups.length, 2)
    assert.ok(!changed.eventGroups[1].id.startsWith('builtin:'))
    const remove = tree.find((n) => n.type === 'button' && n.props.children.includes('remove'))
    assert.equal(remove.props.disabled, true)
    const textarea = tree.find((n) => n.type === 'textarea')
    textarea.props.onBlur({ target: { value: 'custom_read\ncustom_search' } })
    assert.deepEqual(changed.eventGroups[0].toolNames, ['custom_read', 'custom_search'])
  } finally { react.useState = original }
})

test('真实配置迟到：禁用不会重新激活；关闭每轮触发也不能保留占位抽签', async () => {
  const { dom } = await loadClient()
  for (const disabled of [false, true]) {
    reset(dom)
    let snapshot = { status: 'loading', value: undefined, writable: true }
    const listeners = new Set()
    const form = { getSnapshot: () => snapshot, subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn) } }
    const host = createCtx({ forms: { get: () => form } })
    module.apply(host.ctx)
    try {
      host.locale.translate('chat', 'chat.deepDiving')
      const ready = withTextPresets()
      ready.enabled = !disabled
      ready.triggers = { look: { turn: { enabled: false } }, text: { turn: { enabled: false } } }
      snapshot = { status: 'ready', value: { flair: ready }, writable: true }
      for (const fn of listeners) fn()
      if (disabled) {
        assert.equal(T.run.active, false)
        assert.equal(dom.attrs.has(T.ACTIVE_ATTR), false)
      } else assert.equal(T.run.textPresetId, 'text-golden')
    } finally { host.dispose() }
  }
})

test('事件模式下密集步骤合并一次，结束后不会执行延迟抽签', async (context) => {
  const { dom } = await loadClient()
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 10000 })
  reset(dom)
  const value = withTextPresets()
  value.selection.textMode = 'sequential'
  value.eventRules = { enabled: true, minRefreshMs: 500, rules: [] }
  value.triggers = { text: { step: { enabled: true, every: 1 } } }
  T.applyFlair(value)
  T.resetEventSession('main', true)
  T.eventState.turn = 1
  T.rollRun()
  try {
    const first = T.run.text
    T.onStepStart(); T.onStepStart()
    assert.equal(T.run.text, first)
    context.mock.timers.tick(500)
    assert.notEqual(T.run.text, first)
    const second = T.run.text
    T.onStepStart()
    T.stopRun()
    context.mock.timers.tick(1000)
    assert.equal(T.run.text, second)
  } finally { T.stopRun(); context.mock.timers.reset() }
})

test('文案更新用私有字典修订通知渲染，不改变语言、不写宿主配置', async () => {
  const { dom } = await loadClient()
  reset(dom)
  const form = createForm({ flair: plain(withTextPresets()) })
  const host = createCtx({ forms: { get: () => form } })
  module.apply(host.ctx)
  try {
    T.rollRun()
    await Promise.resolve()
    const runtime = host.dictionaries.filter((d) => d.ns.endsWith('.running-copy'))
    assert.ok(runtime.length > 0)
    assert.equal(runtime.at(-1).dicts.zh.label, T.run.text)
    assert.equal(form.writes.length, 0)
  } finally { host.dispose() }
})

test('扫光面板预览：两种主题字段各按自己的主题取自动色', async () => {
  const { dom } = await loadClient()
  reset(dom)
  const host = createCtx({})
  module.apply(host.ctx)
  try {
    // 当前是深色主题，但「浅色主题」字段要预览浅色主题下的自动色
    assert.equal(T.autoShimmerHex({ color: '#efb864' }, 'dark'), '#f8dfb9')
    assert.equal(T.autoShimmerHex({ color: '#efb864' }, 'light'), '#a78146')
  } finally {
    host.dispose()
  }
})
