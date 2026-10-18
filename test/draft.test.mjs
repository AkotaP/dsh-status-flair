/**
 * 草稿模式的行为测试：用带 setState 重渲染的迷你 React 真正把设置页挂起来，
 * 验证「调整 -> 只在页内生效 -> 点保存才写宿主 -> 放弃可回退」。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createDom, createCtx, createForm } from './support/harness.mjs'

/** 迷你 React：只实现 Section 用到的 hooks，但 state 更新会真的重渲染。 */
function createMiniReact() {
  let hooks = []
  let cursor = 0
  let dirty = false
  let component = null
  let componentProps = null
  let tree = null
  let pendingEffects = []

  const sameDeps = (left, right) =>
    left !== undefined && right !== undefined && left.length === right.length && left.every((value, index) => Object.is(value, right[index]))

  const createElement = (type, props, ...children) => ({ type, props: { ...(props ?? {}), children } })

  const React = {
    createElement,
    useState(initial) {
      const hook = (hooks[cursor] ??= { value: typeof initial === 'function' ? initial() : initial })
      cursor++
      return [
        hook.value,
        (next) => {
          const value = typeof next === 'function' ? next(hook.value) : next
          if (!Object.is(value, hook.value)) {
            hook.value = value
            dirty = true
          }
        },
      ]
    },
    useRef(initial) {
      const hook = (hooks[cursor] ??= { current: initial === undefined ? null : initial })
      cursor++
      return hook
    },
    useMemo(factory, deps) {
      const hook = (hooks[cursor] ??= {})
      cursor++
      if (!('value' in hook) || !sameDeps(hook.deps, deps)) {
        hook.value = factory()
        hook.deps = deps
      }
      return hook.value
    },
    useEffect(effect, deps) {
      const hook = (hooks[cursor] ??= {})
      cursor++
      if (!sameDeps(hook.deps, deps)) {
        hook.deps = deps
        pendingEffects.push({ hook, effect })
      }
    },
    useSyncExternalStore(_subscribe, getSnapshot) {
      return getSnapshot()
    },
  }

  function flushEffects() {
    while (pendingEffects.length > 0) {
      const batch = pendingEffects
      pendingEffects = []
      for (const entry of batch) {
        if (typeof entry.hook.cleanup === 'function') entry.hook.cleanup()
        const cleanup = entry.effect()
        entry.hook.cleanup = typeof cleanup === 'function' ? cleanup : undefined
      }
    }
  }

  function render() {
    let guard = 0
    do {
      dirty = false
      cursor = 0
      tree = component(componentProps)
      flushEffects()
      guard++
      if (guard > 50) throw new Error('mini react: too many renders')
    } while (dirty)
    return tree
  }

  return {
    React,
    mount(nextComponent, props) {
      component = nextComponent
      componentProps = props
      hooks = []
      return render()
    },
    rerender() {
      return render()
    },
    unmount() {
      for (const hook of hooks) if (hook !== undefined && typeof hook.cleanup === 'function') hook.cleanup()
    },
    get tree() {
      return tree
    },
  }
}

function textOf(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  return textOf(node.props?.children)
}

function findBy(node, predicate) {
  if (node === null || node === undefined || typeof node !== 'object') return null
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findBy(child, predicate)
      if (found !== null) return found
    }
    return null
  }
  if (predicate(node)) return node
  return findBy(node.props?.children, predicate)
}

async function loadPluginWithReact(react, dom) {
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    MutationObserver: globalThis.MutationObserver,
    localStorage: globalThis.localStorage,
  }
  let spec
  globalThis.window = { __ModuleLoader__: { load(value) { spec = value } } }
  globalThis.document = dom.document
  globalThis.MutationObserver = dom.MutationObserver
  globalThis.localStorage = dom.localStorage
  await import('../lib/client.js?mini-react=' + String(Math.random()).slice(2))
  const module = spec.factory((name) => {
    if (name === 'react') return react
    throw new Error('unexpected require: ' + name)
  })
  return {
    module,
    restore() {
      globalThis.window = previous.window
      globalThis.document = previous.document
      globalThis.MutationObserver = previous.MutationObserver
      globalThis.localStorage = previous.localStorage
    },
  }
}

async function storagePage(options = {}) {
  const dom = createDom(), mini = createMiniReact(), loaded = await loadPluginWithReact(mini.React, dom)
  const T = loaded.module.__test, plain = (v) => JSON.parse(JSON.stringify(v))
  const form = createForm({ flair: plain(T.DEFAULT_FLAIR) }), calls = [], previousFetch = globalThis.fetch
  const state = { revision: 'r1', flair: plain(T.DEFAULT_FLAIR), mode: options.mode ?? 'file', cleanupPending: false, lastOperationId: undefined }
  const snapshot = () => ({ status: 'ready', writable: true, revision: state.revision, value: { flair: plain(state.flair) }, lastOperationId: state.lastOperationId,
    storage: { mode: state.mode, profile: 'test', backupAvailable: true, cleanupPending: state.cleanupPending } })
  const api = { state, snapshot, calls }
  globalThis.fetch = async (_url, init) => {
    const payload = JSON.parse(init.body); calls.push(payload)
    await options.before?.(payload, api)
    let result
    if (payload.action === 'load') result = snapshot()
    else if (payload.action === 'backup') result = { format: 'dsh-status-flair-backup', version: 1, legacy: { rawFlair: { ...plain(T.DEFAULT_FLAIR), enabled: false } } }
    else {
      if (payload.expectedRevision !== state.revision) return { ok: false, status: 409, json: async () => ({ ok: false, error: { code: 'conflict', message: 'stale draft' } }) }
      if (payload.action === 'save') state.flair = plain(payload.flair)
      else { state.mode = 'file'; state.cleanupPending = true }
      state.revision = 'r' + (Number(state.revision.slice(1)) + 1)
      state.lastOperationId = payload.operationId
      result = snapshot()
    }
    return { ok: true, status: 200, json: async () => ({ ok: true, value: result }) }
  }
  const host = createCtx({ forms: { get: () => form }, connection: {} })
  const flush = async () => { await new Promise((resolve) => setImmediate(resolve)); mini.rerender() }
  try {
    loaded.module.apply(host.ctx)
    mini.mount(T.StatusFlairSection, { t: (key) => key })
    await flush()
  } catch (error) {
    mini.unmount(); host.dispose(); loaded.restore(); globalThis.fetch = previousFetch
    throw error
  }
  const editor = () => findBy(mini.tree, (n) => n.type === T.EventRulesEditor)
  const button = (label) => findBy(mini.tree, (n) => n.type === 'button' && textOf(n) === label)
  return { ...api, mini, T, form, button, flush, editor,
    edit(change) { const next = plain(editor().props.value); change(next); editor().props.onChange(next); mini.rerender() },
    close() { mini.unmount(); host.dispose(); loaded.restore(); globalThis.fetch = previousFetch },
  }
}

test('独立存储保存期间的新编辑不会被确认响应清掉，下次保存使用新的基线', async () => {
  let unblock, first = true
  const wait = new Promise((resolve) => { unblock = resolve })
  const page = await storagePage({ before: async (p) => { if (p.action === 'save' && first) { first = false; await wait } } })
  try {
    page.edit((v) => { v.eventRules.rules[0].name = 'First draft'; v.eventRules.rules[0].nameKey = '' })
    const saving = page.button('saveChanges').props.onClick()
    page.mini.rerender()
    assert.equal(page.button('saveChanges').props.disabled, true)
    page.edit((v) => { v.eventRules.rules[0].name = 'Edited while saving' })
    unblock(); await saving; page.mini.rerender()
    assert.equal(page.editor().props.value.eventRules.rules[0].name, 'Edited while saving')
    assert.equal(page.button('saveChanges').props.disabled, false)
    assert.equal(page.state.flair.eventRules.rules[0].name, 'First draft')
    await page.button('saveChanges').props.onClick(); page.mini.rerender()
    const saves = page.calls.filter((p) => p.action === 'save')
    assert.deepEqual(saves.map((p) => p.expectedRevision), ['r1', 'r2'])
    assert.equal(page.state.flair.eventRules.rules[0].name, 'Edited while saving')
    assert.equal(page.button('saveChanges').props.disabled, true)
    assert.equal(page.form.writes.length, 0, 'independent data never writes the old settings block')
  } finally { page.close() }
})

test('其他页面更新后保存冲突会保留草稿，不自动使用最新版本重试', async () => {
  const page = await storagePage()
  try {
    page.edit((v) => { v.eventRules.rules[0].name = 'Keep my draft'; v.eventRules.rules[0].nameKey = '' })
    page.state.revision = 'r2'; page.state.flair.eventRules.rules[0].name = 'Other browser'
    assert.equal(await page.button('saveChanges').props.onClick(), false)
    page.mini.rerender()
    assert.equal(page.editor().props.value.eventRules.rules[0].name, 'Keep my draft')
    assert.match(textOf(page.mini.tree), /saveConflict/)
    assert.equal(page.state.flair.eventRules.rules[0].name, 'Other browser')
    assert.equal(await page.button('saveChanges').props.onClick(), false)
    assert.deepEqual(page.calls.filter((p) => p.action === 'save').map((p) => p.expectedRevision), ['r1', 'r1'])
    assert.equal(page.form.writes.length, 0)
  } finally { page.close() }
})

test('迁移必须二次确认、禁止带草稿，并在确认里提示手动备份', async () => {
  const page = await storagePage({ mode: 'legacy' })
  try {
    assert.deepEqual(page.calls.map((p) => p.action), ['load'])
    page.edit((v) => { v.enabled = false })
    assert.equal(page.button('storageMigrate').props.disabled, true)
    page.button('discard').props.onClick(); page.mini.rerender()
    page.button('storageMigrate').props.onClick(); page.mini.rerender()
    assert.equal(page.calls.filter((p) => p.action === 'migrate').length, 0)
    assert.match(textOf(page.mini.tree), /storageConfirm/)
    await page.button('storageConfirmYes').props.onClick(); page.mini.rerender()
    const migration = page.calls.find((p) => p.action === 'migrate')
    assert.equal(migration.confirmed, true)
    assert.equal('flair' in migration, false)
    assert.match(textOf(page.mini.tree), /storagePartial/)
    assert.equal(page.mini.tree && page.button('storageRestore'), null, 'no automatic-backup restore control')
    assert.equal(page.calls.filter((p) => p.action === 'save').length, 0)
    assert.equal(page.form.writes.length, 0)
  } finally { page.close() }
})

async function importPage() {
  const dom = createDom(), mini = createMiniReact(), loaded = await loadPluginWithReact(mini.React, dom)
  const T = loaded.module.__test, plain = (v) => JSON.parse(JSON.stringify(v))
  const form = createForm({ flair: plain(T.DEFAULT_FLAIR) })
  const host = createCtx({ forms: { get: () => form } })
  loaded.module.apply(host.ctx)
  mini.mount(T.StatusFlairSection, { t: (key) => key })
  const button = (label) => findBy(mini.tree, (n) => n.type === 'button' && textOf(n) === label)
  const area = () => findBy(mini.tree, (n) => n.type === 'textarea' && n.props.className === 'dshsf-area' && n.props.rows === 6)
  return { T, mini, form, button, area, plain,
    open() { button('importConfig').props.onClick(); mini.rerender() },
    type(text) { area().props.onChange({ target: { value: text } }); mini.rerender() },
    close() { mini.unmount(); host.dispose(); loaded.restore() } }
}

test('导入配置只进入草稿，不写盘，并保留内嵌图标', async () => {
  const page = await importPage()
  try {
    const icon = 'data:image/png;base64,iVBORw0KGgo='
    const shared = page.plain(page.T.DEFAULT_FLAIR)
    shared.presets = [{ id: 'shared', name: 'Shared look', style: { ...shared.presets[0].style, icon: 'custom', iconSource: icon } }]
    shared.textPresets = [{ id: 'shared-texts', name: 'Shared copy', texts: ['shared line'] }]
    shared.eventRules = { enabled: true, minRefreshMs: 3000, rules: [{ ...page.T.createStarterRules()[0], id: 'shared-rule', name: 'Shared rule' }] }
    page.open()
    page.type(JSON.stringify({ format: 'dsh-status-flair-backup', version: 1, flair: shared }))
    page.button('importApply').props.onClick()
    page.mini.rerender()
    assert.equal(page.form.writes.length, 0, 'import never persists by itself')
    const current = page.mini.tree
    const imported = findBy(current, (n) => n.props?.className === 'dshsf-notice' && String(textOf(n)).includes('importPresetsN'))
    assert.ok(imported, 'a summary follows the import')
    const value = JSON.parse(JSON.stringify(page.T.currentFlair()))
    assert.equal(value.presets[0].id, 'shared')
    assert.equal(value.presets[0].style.iconSource, icon, 'an embedded PNG data URL travels with the JSON')
    assert.equal(value.textPresets[0].id, 'shared-texts')
    assert.equal(value.eventRules.rules[0].id, 'shared-rule')
    assert.ok(!JSON.stringify(value).includes('E:\\\\'), 'no local file paths in imported data')
  } finally { page.close() }
})

test('导入拒绝坏JSON与非本插件文档，且不改变现有草稿', async () => {
  const page = await importPage()
  try {
    const before = page.plain(page.T.currentFlair())
    page.open()
    page.type('{not json')
    page.button('importApply').props.onClick(); page.mini.rerender()
    assert.match(textOf(page.mini.tree), /importFailed/)
    assert.deepEqual(page.plain(page.T.currentFlair()), before)
    page.type(JSON.stringify({ some: 'other plugin' }))
    page.button('importApply').props.onClick(); page.mini.rerender()
    assert.match(textOf(page.mini.tree), /importUnknown/)
    assert.deepEqual(page.plain(page.T.currentFlair()), before)
    assert.equal(page.form.writes.length, 0)
  } finally { page.close() }
})

test('策略页签切换保留草稿，不自动保存或切换规则总开关', async () => {
  const dom = createDom(), mini = createMiniReact()
  const loaded = await loadPluginWithReact(mini.React, dom)
  let host
  try {
    const T = loaded.module.__test
    const plain = (value) => JSON.parse(JSON.stringify(value))
    const form = createForm({ flair: plain(T.DEFAULT_FLAIR) })
    host = createCtx({ forms: { get: () => form } })
    loaded.module.apply(host.ctx)
    mini.mount(T.StatusFlairSection, { t: (key) => key })
    const tab = (id) => findBy(mini.tree, (n) => n.props?.['data-strategy-tab'] === id)
    const panel = (id) => findBy(mini.tree, (n) => n.props?.role === 'tabpanel' && n.props?.id?.endsWith('-' + id + '-panel'))
    const editor = () => findBy(mini.tree, (n) => n.type === T.EventRulesEditor)
    const button = (label) => findBy(mini.tree, (n) => n.type === 'button' && textOf(n) === label)
    assert.equal(panel('default').props.hidden, false)
    assert.equal(panel('events').props.hidden, true)
    tab('events').props.onClick(); mini.rerender()
    assert.equal(panel('events').props.hidden, false)
    const changed = plain(editor().props.value)
    changed.eventRules.enabled = true
    changed.eventRules.rules[0].name = 'Draft interaction'
    changed.eventRules.rules[0].nameKey = ''
    editor().props.onChange(changed); mini.rerender()
    tab('default').props.onClick(); mini.rerender()
    assert.equal(panel('default').props.hidden, false)
    assert.equal(editor().props.value.eventRules.enabled, true)
    assert.equal(editor().props.value.eventRules.rules[0].name, 'Draft interaction')
    assert.equal(form.writes.length, 0)
    tab('events').props.onClick(); mini.rerender()
    assert.equal(editor().props.value.eventRules.rules[0].name, 'Draft interaction')
    await button('saveChanges').props.onClick(); mini.rerender()
    assert.equal(form.writes.length, 1)
    assert.equal(form.writes[0].value.eventRules.rules[0].name, 'Draft interaction')
    const unsaved = plain(editor().props.value)
    unsaved.eventRules.rules[0].name = 'Unsaved'
    editor().props.onChange(unsaved); mini.rerender()
    tab('default').props.onClick(); mini.rerender()
    button('discard').props.onClick(); mini.rerender()
    assert.equal(panel('default').props.hidden, false)
    assert.equal(editor().props.value.eventRules.rules[0].name, 'Draft interaction')
    assert.equal(form.writes.length, 1)
  } finally {
    mini.unmount()
    host?.dispose()
    loaded.restore()
  }
})

test('草稿模式：调整只在页内生效，点保存才写宿主，放弃可回退', async () => {
  const dom = createDom()
  const mini = createMiniReact()
  const loaded = await loadPluginWithReact(mini.React, dom)
  try {
    const T = loaded.module.__test
    const plain = (value) => JSON.parse(JSON.stringify(value))
    T.setRandom(() => 0)
    const form = createForm({ flair: plain(T.DEFAULT_FLAIR) })
    const host = createCtx({ forms: { get: () => form } })
    loaded.module.apply(host.ctx)

    mini.mount(T.StatusFlairSection, { t: (key) => key })

    const button = (label) => findBy(mini.tree, (node) => node.type === 'button' && textOf(node) === label)
    const enableBox = () => findBy(mini.tree, (node) => node.type === 'input' && node.props?.type === 'checkbox')

    // 初始：干净状态，保存/放弃都不可点，宿主没有写入
    assert.equal(button('saveChanges').props.disabled, true)
    assert.equal(button('discard').props.disabled, true)
    assert.equal(form.writes.length, 0)
    assert.equal(dom.documentElement.hasAttribute(T.ACTIVE_ATTR), true)

    // 页内关闭：运行行立刻恢复官方外观，但还没有写入宿主
    enableBox().props.onChange({ target: { checked: false } })
    mini.rerender()
    assert.equal(dom.documentElement.hasAttribute(T.ACTIVE_ATTR), false, '草稿应即时作用到运行行')
    assert.equal(form.writes.length, 0, '还没点保存，不许写宿主')
    assert.equal(button('saveChanges').props.disabled, false)
    assert.match(textOf(mini.tree), /unsaved/)

    // 保存：写入一次宿主，状态回到干净并显示已保存
    await button('saveChanges').props.onClick()
    mini.rerender()
    assert.equal(form.writes.length, 1)
    assert.equal(form.writes[0].field, 'flair')
    assert.equal(form.writes[0].value.enabled, false)
    assert.equal(button('saveChanges').props.disabled, true)
    assert.match(textOf(mini.tree), /saved/)

    // 再改一次然后放弃：回到已保存的配置（关闭状态）
    enableBox().props.onChange({ target: { checked: true } })
    mini.rerender()
    assert.equal(dom.documentElement.hasAttribute(T.ACTIVE_ATTR), true)
    assert.equal(button('discard').props.disabled, false)
    button('discard').props.onClick()
    mini.rerender()
    assert.equal(form.writes.length, 1, '放弃不能再写宿主')
    assert.equal(dom.documentElement.hasAttribute(T.ACTIVE_ATTR), false, '放弃后运行行回到已保存配置')
    assert.match(textOf(mini.tree), /discarded/)

    // 离开设置页：未保存草稿撤回
    enableBox().props.onChange({ target: { checked: true } })
    mini.rerender()
    mini.unmount()
    assert.equal(dom.documentElement.hasAttribute(T.ACTIVE_ATTR), false)
  } finally {
    loaded.restore()
  }
})
