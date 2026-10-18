/**
 * 宿主半：保留完整旧配置校验，同时拒绝旧 volatile 通道写回。
 * 这里抄了 dsh-settings 的 volatileForm / projectForm / isVolatilePath（纯函数），
 * 用它验证新版配置不再暴露 volatile 写入。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import z from '@deepseek-ai/schemastery'
import { isVolatile } from '@deepseek-ai/cosmokit'
import { Config, FlairSchema, DEFAULT_FLAIR, DEFAULT_SELECTION, DEFAULT_ID, ENTRY_ID, FLAIR_KEY, createStarterRules, apply, inject } from '../lib/index.js'
import { loadClient } from './support/harness.mjs'

const legacyConfig = (value) => Config({ ...value, flair: value.flair ?? {} })
const compatibilityForm = () => z.object({ flair: FlairSchema })

// ---- dsh-settings/lib/index.js 的三个纯函数的等价实现 ----
const isPlainObject = (value) => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function plainConfig(value) {
  if (isVolatile(value)) return plainConfig(value.get())
  if (Array.isArray(value)) return value.map(plainConfig)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, plainConfig(child)]))
  }
  return value
}

function plainSchema(schema) {
  const result = new z(schema.toJSON())
  const walk = (node) => {
    delete node.meta.volatile
    for (const child of Object.values(node.dict ?? {})) walk(child)
    if (node.inner !== undefined) walk(node.inner)
    for (const child of node.list ?? []) walk(child)
  }
  walk(result)
  return result
}

function volatileForm(schema) {
  if (schema.meta.volatile) return plainSchema(schema)
  if (schema.type === 'object') {
    const dict = Object.fromEntries(
      Object.entries(schema.dict ?? {}).flatMap(([key, child]) => {
        const field = volatileForm(child)
        return field === undefined ? [] : [[key, field]]
      }),
    )
    return Object.keys(dict).length === 0 ? undefined : z.object(dict)
  }
  return undefined
}

function projectForm(schema, value) {
  if (schema.type === 'object' && value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(schema.dict ?? {}).flatMap(([key, child]) => {
        const field = Reflect.get(value, key)
        return field === undefined ? [] : [[key, projectForm(child, field)]]
      }),
    )
  }
  return value
}

function isVolatilePath(schema, path) {
  if (schema.meta.volatile) return true
  const [key, ...rest] = path
  const child = key === undefined ? undefined : schema.dict?.[key]
  return child !== undefined && isVolatilePath(child, rest)
}

test('宿主半缺少可选写依赖仍只注册只读健康路由', async () => {
  assert.deepEqual(inject, ['webServer'])
  assert.equal(typeof apply, 'function')

  const effects = []
  const registrations = []
  const ctx = {
    effect(fn, label) {
      const off = fn()
      effects.push({ label, off })
      return off
    },
    get(name) {
      if (name !== 'webServer') return undefined
      return {
        register(options) {
          registrations.push(options)
          return () => {}
        },
      }
    },
  }
  let currentFlair = DEFAULT_FLAIR
  const activation = { flair: currentFlair }
  apply(ctx, activation)
  assert.equal(effects.length, 1, '只注册健康路由，不增加会话监听')
  assert.equal(registrations.length, 1)
  assert.equal(registrations[0].kind, 'prefix')
  assert.equal(registrations[0].path, '/status-flair')

  const chunks = []
  const res = {
    writeHead(status, headers) {
      this.status = status
      this.headers = headers
    },
    end(body) {
      chunks.push(body)
    },
  }
  await registrations[0].handler({}, res)
  assert.equal(res.status, 200)
  assert.equal(res.headers['cache-control'], 'no-store')
  const body = JSON.parse(chunks[0])
  assert.equal(body.plugin, ENTRY_ID)
  assert.equal(body.loaded, true)
  assert.equal(body.volatile, false)
  assert.equal(body.enabled, true)
  assert.equal(body.eventGroups, 0)
  assert.deepEqual(body.eventRules, { enabled: false, count: 4, enabledCount: 4 })
  assert.deepEqual(body.presets, ['golden', 'violet', 'terminal'])
  assert.deepEqual(body.textPresets, [], '默认不带文案组')
  assert.equal(body.client, null, '没收到浏览器心跳前是 null')

  // 浏览器端心跳：记录模块 id 与 slot key，健康路由可见
  const beacon = {
    writeHead(status) {
      this.status = status
    },
    end() {},
  }
  await registrations[0].handler({ url: '/status-flair/client?id=dsh-status-flair&key=dsh-status-flair' }, beacon)
  assert.equal(beacon.status, 204)
  currentFlair = {
    ...DEFAULT_FLAIR,
    eventGroups: [{ id: 'private-group', name: 'private-group-name', events: ['private-event'] }],
    eventRules: {
      enabled: true,
      minRefreshMs: 750,
      rules: [
        { id: 'private-rule', name: 'private-rule-name', enabled: true, selection: { fixedPresetId: 'private-look' } },
        { id: 'disabled-rule', enabled: false },
      ],
    },
  }
  activation.flair = currentFlair
  const chunksAfter = []
  const resAfter = {
    writeHead(status, headers) {
      this.status = status
      this.headers = headers
    },
    end(bodyText) {
      chunksAfter.push(bodyText)
    },
  }
  await registrations[0].handler({ url: '/status-flair/health' }, resAfter)
  const bodyAfter = JSON.parse(chunksAfter[0])
  assert.equal(bodyAfter.client.moduleId, 'dsh-status-flair')
  assert.equal(typeof bodyAfter.client.at, 'number')
  assert.equal(bodyAfter.eventGroups, 1)
  assert.deepEqual(bodyAfter.eventRules, { enabled: true, count: 2, enabledCount: 1 })
  assert.equal(chunksAfter[0].includes('private-'), false, '健康摘要不得泄露分组或规则内容')

  // 没有 webServer 的部署也不能崩
  assert.doesNotThrow(() => apply({ effect: (fn) => fn(), get: () => undefined }, undefined))
})

test('storage 与兼容 flair 均不可由旧 volatile 表单写回', () => {
  assert.deepEqual(Object.keys(Config.dict).sort(), ['flair', 'storage'])
  assert.equal(volatileForm(Config), undefined)
  assert.equal(Config({}).storage, 'auto')
  assert.equal(Config({}).flair ?? null, null, 'schemastery keeps absent nullable fields omitted')
  assert.equal(Config.dict.flair.meta.default, null)
  assert.deepEqual(Config({ storage: 'file', flair: null }), { storage: 'file', flair: null })
  assert.throws(() => Config({ storage: 'elsewhere' }))
  for (const path of [[FLAIR_KEY], [FLAIR_KEY, 'presets'], [FLAIR_KEY, 'eventRules', 'rules'], ['storage'], []]) {
    assert.equal(isVolatilePath(Config, path), false)
  }
})

test('这份配置里外观、文案与选择字段都在表单里', () => {
  const form = compatibilityForm()
  const flairForm = form.dict[FLAIR_KEY]
  assert.deepEqual(Object.keys(flairForm.dict).sort(), ['enabled', 'eventGroups', 'eventRules', 'presets', 'selection', 'textPresets', 'triggers'])
  assert.deepEqual(Object.keys(flairForm.dict.eventGroups.inner.dict).sort(), ['activityKinds', 'events', 'id', 'kind', 'name', 'toolNames'])
  assert.deepEqual(Object.keys(flairForm.dict.eventRules.dict).sort(), ['enabled', 'minRefreshMs', 'rules'])
  const ruleForm = flairForm.dict.eventRules.dict.rules.inner
  assert.deepEqual(Object.keys(ruleForm.dict).sort(), ['enabled', 'groupIds', 'holdMs', 'id', 'kind', 'name', 'nameKey', 'selection'])
  assert.deepEqual(Object.keys(ruleForm.dict.selection.dict).sort(), Object.keys(flairForm.dict.selection.dict).sort())
  for (const [key, schema] of Object.entries(flairForm.dict.selection.dict)) {
    assert.deepEqual(ruleForm.dict.selection.dict[key].toJSON(), schema.toJSON(), '规则复用 SelectionSchema 字段：' + key)
  }
  // 外观与文案各自独立的触发配置：每轮 + 时间（固定/随机）+ 步骤
  assert.deepEqual(Object.keys(flairForm.dict.triggers.dict).sort(), ['look', 'text'])
  const layerForm = flairForm.dict.triggers.dict.look
  assert.deepEqual(Object.keys(layerForm.dict).sort(), ['step', 'time', 'turn'])
  assert.deepEqual(Object.keys(layerForm.dict.turn.dict).sort(), ['enabled'])
  assert.deepEqual(Object.keys(layerForm.dict.time.dict).sort(), ['enabled', 'fixedMs', 'maxMs', 'minMs', 'mode'])
  assert.deepEqual(Object.keys(layerForm.dict.step.dict).sort(), ['enabled', 'every'])
  assert.deepEqual(Object.keys(flairForm.dict.selection.dict).sort(), [
    'fixedPresetId',
    'fixedTextPresetId',
    'presetIds',
    'presetMode',
    'textMode',
    'textPresetIds',
    'textPresetMode',
  ])
  const presetForm = flairForm.dict.presets.inner
  assert.deepEqual(Object.keys(presetForm.dict).sort(), ['id', 'name', 'nameKey', 'style', 'texts'])
  assert.deepEqual(Object.keys(presetForm.dict.style.dict).sort(), [
    'color',
    'fontSize',
    'icon',
    'iconSource',
    'shimmerDark',
    'shimmerDuration',
    'shimmerLight',
  ])
  const textPresetForm = flairForm.dict.textPresets.inner
  assert.deepEqual(Object.keys(textPresetForm.dict).sort(), ['id', 'name', 'texts'])
})

test('校验后的配置能被投影、能原样写回', () => {
  const resolved = plainConfig(legacyConfig({ [FLAIR_KEY]: DEFAULT_FLAIR }))
  const form = compatibilityForm()
  const projected = projectForm(form, resolved)
  assert.deepEqual(Object.keys(projected), [FLAIR_KEY])
  // 保留的旧字段 texts 与新增的空默认值（iconSource / 扫光色）会被 schema 补出来；
  // 写回前它们都是空的，不影响迁移。
  const stripSchemaDefaults = (flairValue) => ({
    ...flairValue,
    presets: flairValue.presets.map((preset) => {
      const { texts, ...rest } = preset
      const style = { ...rest.style }
      if (style.iconSource === '') delete style.iconSource
      if (style.shimmerDark === '') delete style.shimmerDark
      if (style.shimmerLight === '') delete style.shimmerLight
      return texts !== undefined && texts.length === 0 ? { ...rest, style } : { ...preset, style }
    }),
  })
  assert.deepEqual(stripSchemaDefaults(projected[FLAIR_KEY]), DEFAULT_FLAIR)

  // 删掉一个 preset / 一组文案再投影：数组必须整体替换，不能残留
  const trimmed = {
    ...projected[FLAIR_KEY],
    presets: projected[FLAIR_KEY].presets.slice(0, 2),
    textPresets: projected[FLAIR_KEY].textPresets.slice(0, 1),
  }
  const again = projectForm(form, plainConfig(legacyConfig({ [FLAIR_KEY]: trimmed })))
  assert.deepEqual(again[FLAIR_KEY].presets.map((preset) => preset.id), ['golden', 'violet'])
  assert.deepEqual(again[FLAIR_KEY].textPresets.map((preset) => preset.id), [])
})

test('兼容 flair 空对象仍可补全默认外观与默认文案', () => {
  const resolved = plainConfig(legacyConfig({}))
  assert.equal(resolved[FLAIR_KEY].enabled, true)
  assert.equal(resolved[FLAIR_KEY].presets.length, DEFAULT_FLAIR.presets.length)
  assert.equal(resolved[FLAIR_KEY].textPresets.length, DEFAULT_FLAIR.textPresets.length)
  assert.equal(resolved[FLAIR_KEY].selection.fixedPresetId, 'golden')
  assert.equal(resolved[FLAIR_KEY].selection.fixedTextPresetId, 'default')
  assert.deepEqual(resolved[FLAIR_KEY].eventGroups, [])
  assert.deepEqual(resolved[FLAIR_KEY].eventRules, DEFAULT_FLAIR.eventRules)
})

test('旧配置（文案还挂在预设里）不会被 schema 丢掉 texts', () => {
  const legacy = {
    presets: [
      {
        id: 'golden',
        name: '暖金色思考',
        texts: ['正在认真思考中…'],
        style: { color: '#efb864', fontSize: 13, icon: 'sparkles', shimmerDuration: 2000 },
      },
    ],
    selection: { presetMode: 'fixed', fixedPresetId: 'golden', presetIds: ['golden'], textMode: 'random' },
  }
  const resolved = plainConfig(legacyConfig({ [FLAIR_KEY]: legacy }))
  assert.deepEqual(resolved[FLAIR_KEY].presets[0].texts, ['正在认真思考中…'], '迁移要靠这份旧字段，不能被 strip')
  // textPresets 默认空数组：客户端据此判断需要迁移
  assert.deepEqual(resolved[FLAIR_KEY].textPresets, [])
  assert.deepEqual(resolved[FLAIR_KEY].eventGroups, [], '旧配置不写入内置事件组')
  assert.deepEqual(resolved[FLAIR_KEY].eventRules, DEFAULT_FLAIR.eventRules, '旧配置补入门规则，但不隐式启用事件规则')
})

test('事件分组与规则经过兼容 Schema 和 JSON 持久化后保真，删除项不残留', () => {
  const eventGroups = [
    { id: 'tools', name: '工具活动', kind: 'activity', activityKinds: ['tool'], toolNames: ['read', 'ops_bash'], events: [] },
    { id: 'errors', name: '失败脉冲', kind: 'pulse', activityKinds: [], toolNames: ['ops_bash'], events: ['tool-error'] },
  ]
  const eventRules = {
    enabled: true,
    minRefreshMs: 800,
    rules: [
      {
        id: 'activity-rule', name: '工具规则', nameKey: 'customRuleName', enabled: true, kind: 'activity',
        groupIds: ['tools', 'builtin:thinking'], holdMs: 2000,
        selection: {
          presetMode: 'random', fixedPresetId: 'terminal', presetIds: ['terminal', 'default'],
          textPresetMode: 'random', fixedTextPresetId: 'my-text', textPresetIds: ['my-text', 'default'], textMode: 'sequential',
        },
      },
      {
        id: 'pulse-rule', name: '失败规则', nameKey: '', enabled: false, kind: 'pulse',
        groupIds: ['errors', 'builtin:tool-error', 'builtin:tool-success'], holdMs: 4500,
        selection: { ...DEFAULT_FLAIR.selection, fixedPresetId: 'violet', textMode: 'first' },
      },
    ],
  }
  const input = { [FLAIR_KEY]: { ...DEFAULT_FLAIR, eventGroups, eventRules } }
  const form = compatibilityForm()
  const projected = projectForm(form, plainConfig(legacyConfig(input)))
  assert.deepEqual(projected[FLAIR_KEY].eventGroups, eventGroups)
  assert.deepEqual(projected[FLAIR_KEY].eventRules, eventRules)
  const saved = JSON.parse(JSON.stringify(projected))
  const again = projectForm(form, plainConfig(legacyConfig(saved)))
  assert.deepEqual(again, projected)

  saved[FLAIR_KEY].eventGroups = saved[FLAIR_KEY].eventGroups.slice(1)
  saved[FLAIR_KEY].eventRules.rules = saved[FLAIR_KEY].eventRules.rules.slice(1)
  const trimmed = projectForm(form, plainConfig(legacyConfig(saved)))
  assert.deepEqual(trimmed[FLAIR_KEY].eventGroups, eventGroups.slice(1))
  assert.deepEqual(trimmed[FLAIR_KEY].eventRules.rules, eventRules.rules.slice(1))
})

test('事件配置补全安全默认值，规则保留完整选择字段', () => {
  const resolved = plainConfig(legacyConfig({
    [FLAIR_KEY]: {
      eventGroups: [{ id: 'custom' }],
      eventRules: { rules: [{ id: 'custom-rule' }] },
    },
  }))[FLAIR_KEY]
  assert.deepEqual(resolved.eventGroups, [{ id: 'custom', name: '', kind: 'activity', activityKinds: [], toolNames: [], events: [] }])
  assert.equal(resolved.eventRules.enabled, false)
  assert.equal(resolved.eventRules.minRefreshMs, 3000)
  assert.deepEqual(resolved.eventRules.rules, [{
    id: 'custom-rule', name: '', nameKey: '', enabled: true, kind: 'activity', groupIds: [], holdMs: 2000,
    selection: DEFAULT_FLAIR.selection,
  }])
})

test('事件类型仅接受 activity 或 pulse', () => {
  assert.throws(() => legacyConfig({ [FLAIR_KEY]: { eventGroups: [{ id: 'invalid', kind: 'other' }] } }))
  assert.throws(() => legacyConfig({ [FLAIR_KEY]: { eventRules: { rules: [{ id: 'invalid', kind: 'other' }] } } }))
})

test('规则刷新默认三秒，显式保存的间隔保持不变', () => {
  const missing = plainConfig(legacyConfig({ flair: { eventRules: { rules: [] } } })).flair
  assert.equal(missing.eventRules.minRefreshMs, 3000)
  for (const interval of [0, 500, 1200, 2000, 3000, 5000]) {
    const resolved = plainConfig(legacyConfig({ flair: { eventRules: { minRefreshMs: interval, rules: [] } } })).flair
    assert.equal(resolved.eventRules.minRefreshMs, interval)
    assert.deepEqual(resolved.eventRules.rules, [])
  }
})

test('入门规则固定分为思考交互、信息获取、执行操作和回复，默认选择不变', () => {
  assert.deepEqual(DEFAULT_SELECTION, {
    presetMode: 'fixed', fixedPresetId: 'golden', presetIds: ['golden', 'violet', 'terminal'],
    textPresetMode: 'fixed', fixedTextPresetId: 'default', textPresetIds: ['default'], textMode: 'random',
  })
  assert.deepEqual(DEFAULT_FLAIR.selection, DEFAULT_SELECTION)
  const metadata = createStarterRules().map(({ selection, ...rest }) => rest)
  assert.deepEqual(metadata, [
    { id: 'starter-thinking', name: '思考与交互', nameKey: 'starterThinking', enabled: true, kind: 'activity', holdMs: 2000,
      groupIds: ['builtin:waiting', 'builtin:thinking', 'builtin:questions', 'builtin:plan'] },
    { id: 'starter-information', name: '信息获取', nameKey: 'starterInformation', enabled: true, kind: 'activity', holdMs: 2000,
      groupIds: ['builtin:read', 'builtin:readImage', 'builtin:search', 'builtin:webSearch', 'builtin:webFetch'] },
    { id: 'starter-execution', name: '执行与操作', nameKey: 'starterExecution', enabled: true, kind: 'activity', holdMs: 2000,
      groupIds: ['builtin:write', 'builtin:edit', 'builtin:commands', 'builtin:code', 'builtin:subagents', 'builtin:tools'] },
    { id: 'starter-response', name: '回复', nameKey: 'starterResponse', enabled: true, kind: 'activity', holdMs: 2000,
      groupIds: ['builtin:responding'] },
  ])
  assert.equal(DEFAULT_FLAIR.eventRules.enabled, false)
  assert.equal(DEFAULT_FLAIR.eventRules.minRefreshMs, 3000)
  assert.deepEqual(DEFAULT_FLAIR.eventRules.rules, createStarterRules())
})

test('入门规则使用DSH自带外观与文案，每条选择字段和候选数组独立', () => {
  const baseline = structuredClone(DEFAULT_SELECTION)
  const official = { presetMode: 'fixed', fixedPresetId: DEFAULT_ID, presetIds: [DEFAULT_ID],
    textPresetMode: 'fixed', fixedTextPresetId: DEFAULT_ID, textPresetIds: [DEFAULT_ID], textMode: 'random' }
  const rules = createStarterRules(), second = createStarterRules()
  for (const [index, rule] of rules.entries()) {
    assert.deepEqual(rule.selection, official)
    assert.notEqual(rule.selection, DEFAULT_SELECTION)
    assert.notEqual(rule.selection.presetIds, DEFAULT_SELECTION.presetIds)
    assert.notEqual(rule.selection.textPresetIds, DEFAULT_SELECTION.textPresetIds)
    assert.notEqual(rule.selection, second[index].selection)
    assert.notEqual(rule.groupIds, second[index].groupIds)
    for (const other of rules.slice(index + 1)) {
      assert.notEqual(rule.selection, other.selection)
      assert.notEqual(rule.selection.presetIds, other.selection.presetIds)
      assert.notEqual(rule.selection.textPresetIds, other.selection.textPresetIds)
    }
  }
  rules[0].selection.fixedPresetId = 'changed'
  rules[0].selection.presetIds.push('changed')
  rules[0].selection.textPresetIds.push('changed')
  rules[0].groupIds.push('builtin:changed')
  assert.deepEqual(DEFAULT_SELECTION, baseline)
  assert.deepEqual(rules[1].selection, official)
})


test('缺省事件规则补四条且保持关闭，显式空数组和已有规则不会被补齐或覆盖', () => {
  const form = compatibilityForm()
  for (const input of [{}, { flair: {} }, { flair: { eventRules: {} } }]) {
    const projected = projectForm(form, plainConfig(legacyConfig(input)))
    assert.deepEqual(projected.flair.eventRules, DEFAULT_FLAIR.eventRules)
    const again = projectForm(form, plainConfig(legacyConfig(JSON.parse(JSON.stringify(projected)))))
    assert.deepEqual(again.flair.eventRules, projected.flair.eventRules, '入门规则名称标记与完整选择来回保真')
  }
  for (const enabled of [false, true]) {
    const resolved = plainConfig(legacyConfig({ flair: { eventRules: { enabled, rules: [] } } }))
    assert.deepEqual(resolved.flair.eventRules, { enabled, minRefreshMs: 3000, rules: [] })
    const again = projectForm(form, plainConfig(legacyConfig(JSON.parse(JSON.stringify(resolved)))))
    assert.deepEqual(again.flair.eventRules.rules, [], '显式删除全部规则后不恢复入门规则')
  }
  const existing = { ...createStarterRules()[0], id: 'custom', name: 'Custom name', nameKey: '', groupIds: ['builtin:read'] }
  const resolved = plainConfig(legacyConfig({ flair: { eventRules: { enabled: true, minRefreshMs: 900, rules: [existing] } } }))
  assert.deepEqual(resolved.flair.eventRules, { enabled: true, minRefreshMs: 900, rules: [existing] })
})

test('独立解析配置不会共享入门规则及其候选数组', () => {
  const first = plainConfig(legacyConfig({})).flair.eventRules.rules
  const second = plainConfig(legacyConfig({})).flair.eventRules.rules
  const expected = createStarterRules()
  first[0].selection.presetIds.push('private-look')
  first[0].selection.textPresetIds.push('private-text')
  first[0].name = 'Private name'
  assert.deepEqual(second, expected)
  assert.deepEqual(first[1].selection, expected[1].selection)
  assert.deepEqual(DEFAULT_FLAIR.eventRules.rules, expected)
})

test('客户端半的默认值与宿主半一致', async () => {
  const { module } = await loadClient()
  assert.deepEqual(module.__test.DEFAULT_FLAIR, DEFAULT_FLAIR)
  assert.equal(module.__test.DEFAULT_ID, DEFAULT_ID)
})

test('清单与 patch 条目对得上（id / 包名 / 宿主版本 / 客户端依赖）', () => {
  const root = new URL('../', import.meta.url)
  const pkg = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'))
  const patch = readFileSync(new URL('cordis.patch.yml', root), 'utf8')

  assert.equal(pkg.name, 'dsh-status-flair')
  assert.equal(pkg.type, 'module')
  assert.equal(pkg.exports['.'].default, './lib/index.js')
  assert.equal(pkg.exports['./client'].default, './lib/client.js')
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(pkg.dsh.client.platform, 'web')
  for (const dependency of ['@deepseek-ai/dsh-client-locale', '@deepseek-ai/dsh-client-ui-settings', '@deepseek-ai/dsh-client-ui-slots']) {
    assert.ok(pkg.dsh.client.inject.includes(dependency), 'missing client inject: ' + dependency)
  }
  assert.ok(pkg.engines.dsh.startsWith('>='), 'engines.dsh must declare a host range')
  assert.ok(pkg.dependencies['@deepseek-ai/schemastery'], 'host half imports schemastery, so it must be a dependency')

  assert.ok(patch.includes('id: ' + ENTRY_ID), 'cordis.patch.yml must insert the entry id the client reads')
  assert.ok(patch.includes("name: '" + pkg.name + "'"))
})
