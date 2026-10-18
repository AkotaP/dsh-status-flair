/**
 * 离线测试 harness：假 DOM + 假 ctx + 迷你 React 桩。
 * 目标是不装 DSH、不开浏览器就能跑构建产物。
 */

/** 造一个够用的 document（运行行只有 [data-chat-running] 一个稳定标记）。 */
export function createDom() {
  const vars = new Map()
  const attrs = new Map()
  const styles = []
  const state = { running: true }
  const observers = []

  const documentElement = {
    style: {
      setProperty(name, value) {
        vars.set(name, String(value))
      },
      removeProperty(name) {
        const previous = vars.get(name) ?? ''
        vars.delete(name)
        return previous
      },
      getPropertyValue(name) {
        return vars.get(name) ?? ''
      },
    },
    setAttribute(name, value) {
      attrs.set(name, value === undefined ? '' : String(value))
    },
    removeAttribute(name) {
      attrs.delete(name)
    },
    hasAttribute(name) {
      return attrs.has(name)
    },
  }

  const matchesStyleSelector = (node, selector) => {
    const match = /^style\[data-plugin-css="(.*)"\]$/.exec(selector)
    if (match === null) return false
    return node.tag === 'style' && node.dataset.pluginCss === match[1]
  }

  const head = {
    appendChild(node) {
      styles.push(node)
      return node
    },
  }

  const document = {
    documentElement,
    head,
    body: { tag: 'body' },
    createElement(tag) {
      const node = {
        tag,
        dataset: {},
        textContent: '',
        remove() {
          const index = styles.indexOf(node)
          if (index !== -1) styles.splice(index, 1)
        },
      }
      return node
    },
    querySelector(selector) {
      if (selector === '[data-chat-running]') return state.running ? { tag: 'running' } : null
      return null
    },
    querySelectorAll(selector) {
      return styles.filter((node) => matchesStyleSelector(node, selector.replace(/\\"/g, '"')))
    },
  }

  class MutationObserver {
    constructor(callback) {
      this.callback = callback
      observers.push(this)
    }
    observe() {}
    disconnect() {
      const index = observers.indexOf(this)
      if (index !== -1) observers.splice(index, 1)
    }
  }

  const storage = new Map()
  const localStorage = {
    getItem(key) {
      return storage.has(key) ? storage.get(key) : null
    },
    setItem(key, value) {
      storage.set(key, String(value))
    },
    removeItem(key) {
      storage.delete(key)
    },
    clear() {
      storage.clear()
    },
  }

  return {
    document,
    documentElement,
    vars,
    attrs,
    styles,
    state,
    observers,
    MutationObserver,
    localStorage,
    setRunning(value) {
      state.running = value
    },
    triggerMutations() {
      for (const observer of [...observers]) observer.callback([])
    },
  }
}

/** 迷你 React：只保证客户端半在模块求值与 apply 时不炸。 */
export function createReact() {
  return {
    createElement(type, props, ...children) {
      return { type, props: { ...(props ?? {}), children } }
    },
    useState(initial) {
      return [typeof initial === 'function' ? initial() : initial, () => {}]
    },
    useEffect() {},
    useRef(value) {
      return { current: value === undefined ? null : value }
    },
    useMemo(factory) {
      return factory()
    },
    useSyncExternalStore(_subscribe, getSnapshot) {
      return getSnapshot()
    },
  }
}

let loaded = null

/** 加载一次客户端 bundle，返回 { spec, module, dom }。 */
export async function loadClient() {
  if (loaded !== null) return loaded
  const dom = createDom()
  let spec
  globalThis.window = {
    __ModuleLoader__: {
      load(value) {
        spec = value
      },
    },
  }
  globalThis.document = dom.document
  globalThis.MutationObserver = dom.MutationObserver
  globalThis.localStorage = dom.localStorage
  const react = createReact()
  await import('../../lib/client.js')
  if (spec === undefined) throw new Error('client bundle did not register itself')
  const module = spec.factory((name) => {
    if (name === 'react') return react
    throw new Error('unexpected require: ' + name)
  })
  loaded = { spec, module, dom, react }
  return loaded
}

/**
 * 假 cordis ctx：记录 effect / 注册，locale 用一个可观察的 translate。
 * @param options.forms - 传入假 configForms 服务（缺省模拟"没有设置通道"）。
 */
export function createCtx(options = {}) {
  const effects = []
  const dictionaries = []
  const registrations = []
  const locale = {
    translate(ns, key) {
      return 'ORIGINAL(' + ns + ':' + key + ')'
    },
    bind(ns) {
      return (key, params) => locale.translate(ns, key, params)
    },
    register(ns, dicts) {
      dictionaries.push({ ns, dicts })
      return () => {}
    },
    subscribe() {
      return () => {}
    },
    getSnapshot() {
      return { active: 'zh', revision: 1 }
    },
  }
  const slots = {
    inject(_owner, callback) {
      return callback()
    },
    register(options_, Component) {
      registrations.push({ options: options_, Component })
      return () => {}
    },
  }
  const ctx = {
    locale,
    slots,
    effect(fn, label) {
      const off = fn()
      effects.push({ label, off })
      return off
    },
    get(name) {
      if (name === 'locale') return locale
      if (name === 'configForms') return options.forms
      if (name === 'theme') return options.theme
      if (name === 'uiConversation') return options.uiConversation
      if (name === 'sessions') return options.sessions
      return undefined
    },
    /** 可选依赖注入：和 cordis 一样，依赖齐全时同步回调，否则什么都不做。 */
    inject(deps, callback) {
      const ready = deps.every((name) => ctx.get(name) !== undefined)
      if (ready) callback(ctx)
      return { then: (resolve) => Promise.resolve().then(() => resolve?.()) }
    },
    on() {
      return () => {}
    },
  }
  return {
    ctx,
    locale,
    slots,
    effects,
    dictionaries,
    registrations,
    dispose() {
      for (const entry of effects.reverse()) {
        if (typeof entry.off === 'function') entry.off()
      }
    },
  }
}

/** 假 configForms 表单：记录写入、可推送宿主侧更新。 */
export function createForm(initialValue) {
  let snapshot = { status: 'ready', value: initialValue, writable: true, revision: 1, base: initialValue, user: initialValue }
  const listeners = new Set()
  const writes = []
  return {
    writes,
    getSnapshot() {
      return snapshot
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    async set(field, value) {
      writes.push({ field, value })
      snapshot = { ...snapshot, value: { ...(snapshot.value ?? {}), [field]: value }, revision: snapshot.revision + 1 }
      for (const listener of [...listeners]) listener(snapshot)
      return true
    },
    async unset(field) {
      const next = { ...(snapshot.value ?? {}) }
      delete next[field]
      snapshot = { ...snapshot, value: next, revision: snapshot.revision + 1 }
      for (const listener of [...listeners]) listener(snapshot)
      return true
    },
    /** 模拟宿主侧（别的浏览器 / 手改 patch）推来一份新配置。 */
    push(value) {
      snapshot = { ...snapshot, value, revision: snapshot.revision + 1 }
      for (const listener of [...listeners]) listener(snapshot)
    },
    /** 模拟通道不可写。 */
    breakChannel() {
      snapshot = { ...snapshot, writable: false }
      for (const listener of [...listeners]) listener(snapshot)
    },
    /** 模拟尚未就绪。 */
    setLoading() {
      snapshot = { ...snapshot, status: 'loading' }
      for (const listener of [...listeners]) listener(snapshot)
    },
  }
}
