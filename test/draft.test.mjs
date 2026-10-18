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
