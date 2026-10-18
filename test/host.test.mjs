/**
 * 宿主半：配置 schema 必须真的可被 dsh-settings 投影和写入。
 * 这里抄了 dsh-settings 的 volatileForm / projectForm / isVolatilePath（纯函数），
 * 用它来验证 flair 字段的 volatile 声明没有写歪。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import z from '@deepseek-ai/schemastery'
import { isVolatile } from '@deepseek-ai/cosmokit'
import { Config, DEFAULT_FLAIR, DEFAULT_ID, ENTRY_ID, FLAIR_KEY, apply, inject } from '../lib/index.js'
import { loadClient } from './support/harness.mjs'

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

test('宿主半只依赖 webServer，并注册一条只读健康路由', () => {
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
  apply(ctx, { flair: { get: () => DEFAULT_FLAIR } })
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
  registrations[0].handler({}, res)
  assert.equal(res.status, 200)
  assert.equal(res.headers['cache-control'], 'no-store')
  const body = JSON.parse(chunks[0])
  assert.equal(body.plugin, ENTRY_ID)
  assert.equal(body.loaded, true)
  assert.equal(body.volatile, true)
  assert.equal(body.enabled, true)
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
  registrations[0].handler({ url: '/status-flair/client?id=dsh-status-flair&key=dsh-status-flair' }, beacon)
  assert.equal(beacon.status, 204)
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
  registrations[0].handler({ url: '/status-flair/health' }, resAfter)
  const bodyAfter = JSON.parse(chunksAfter[0])
  assert.equal(bodyAfter.client.moduleId, 'dsh-status-flair')
  assert.equal(typeof bodyAfter.client.at, 'number')

  // 没有 webServer 的部署也不能崩
  assert.doesNotThrow(() => apply({ effect: (fn) => fn(), get: () => undefined }, undefined))
})

test('flair 是唯一的 volatile 块', () => {
  assert.deepEqual(Object.keys(Config.dict), [FLAIR_KEY])
  assert.equal(Config.dict[FLAIR_KEY].meta.volatile, true)
  const form = volatileForm(Config)
  assert.notEqual(form, undefined, 'volatileForm 必须能投影出表单')
  assert.deepEqual(Object.keys(form.dict), [FLAIR_KEY])
})

test('flair 之下的路径全部可写，其它字段不行', () => {
  assert.equal(isVolatilePath(Config, [FLAIR_KEY]), true)
  assert.equal(isVolatilePath(Config, [FLAIR_KEY, 'presets']), true)
  assert.equal(isVolatilePath(Config, [FLAIR_KEY, 'textPresets']), true)
  assert.equal(isVolatilePath(Config, [FLAIR_KEY, 'selection', 'textPresetMode']), true)
  assert.equal(isVolatilePath(Config, ['other']), false)
  assert.equal(isVolatilePath(Config, []), false)
})

test('这份配置里外观、文案与选择字段都在表单里', () => {
  const form = volatileForm(Config)
  const flairForm = form.dict[FLAIR_KEY]
  assert.deepEqual(Object.keys(flairForm.dict).sort(), ['enabled', 'presets', 'selection', 'textPresets'])
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
  assert.deepEqual(Object.keys(presetForm.dict.style.dict).sort(), ['color', 'fontSize', 'icon', 'iconSource', 'shimmerDuration'])
  const textPresetForm = flairForm.dict.textPresets.inner
  assert.deepEqual(Object.keys(textPresetForm.dict).sort(), ['id', 'name', 'texts'])
})

test('校验后的配置能被投影、能原样写回', () => {
  const resolved = plainConfig(Config({ [FLAIR_KEY]: DEFAULT_FLAIR }))
  const form = volatileForm(Config)
  const projected = projectForm(form, resolved)
  assert.deepEqual(Object.keys(projected), [FLAIR_KEY])
  // 保留的旧字段 texts 与新增的 iconSource 会被 schema 补成空值；写回前它们都是空的，不影响迁移
  const stripSchemaDefaults = (flairValue) => ({
    ...flairValue,
    presets: flairValue.presets.map((preset) => {
      const { texts, ...rest } = preset
      const style = { ...rest.style }
      if (style.iconSource === '') delete style.iconSource
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
  const again = projectForm(form, plainConfig(Config({ [FLAIR_KEY]: trimmed })))
  assert.deepEqual(again[FLAIR_KEY].presets.map((preset) => preset.id), ['golden', 'violet'])
  assert.deepEqual(again[FLAIR_KEY].textPresets.map((preset) => preset.id), [])
})

test('空配置也会拿到默认外观与默认文案（首装即用）', () => {
  const resolved = plainConfig(Config({}))
  assert.equal(resolved[FLAIR_KEY].enabled, true)
  assert.equal(resolved[FLAIR_KEY].presets.length, DEFAULT_FLAIR.presets.length)
  assert.equal(resolved[FLAIR_KEY].textPresets.length, DEFAULT_FLAIR.textPresets.length)
  assert.equal(resolved[FLAIR_KEY].selection.fixedPresetId, 'golden')
  assert.equal(resolved[FLAIR_KEY].selection.fixedTextPresetId, 'default')
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
  const resolved = plainConfig(Config({ [FLAIR_KEY]: legacy }))
  assert.deepEqual(resolved[FLAIR_KEY].presets[0].texts, ['正在认真思考中…'], '迁移要靠这份旧字段，不能被 strip')
  // textPresets 默认空数组：客户端据此判断需要迁移
  assert.deepEqual(resolved[FLAIR_KEY].textPresets, [])
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
