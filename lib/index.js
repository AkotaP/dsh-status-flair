/**
 * dsh-status-flair — Host half.
 *
 * The running status ("深度求索中，用时 7秒 ···") is rendered by
 * `@deepseek-ai/dsh-client-ui-chat`; this plugin owns no Host-side runtime
 * behaviour. What the Host half does provide is the one thing the browser
 * cannot own: the durable, live-editable configuration document.
 *
 * Profile settings live in an independent JSON file. The legacy flair field is
 * read-only compatibility input; explicit authenticated saves and migrations
 * own persistence. Construction and loads never write profile data.
 *
 * Configuration has two independent layers:
 *   - `presets`     — how a run looks (colour, size, icon, shimmer);
 *   - `textPresets` — which lines a run can say, grouped as named sets;
 *   - `selection`   — how a look and a text group are chosen, plus how a line
 *                      is chosen inside the chosen text group.
 *
 * The reserved id `default` means "whatever DSH ships". It is never stored as
 * an entry, so official styling and official copy are read from DSH itself and
 * follow DSH upgrades instead of a hard-coded copy.
 *
 * @module dsh-status-flair
 */
import z from '@deepseek-ai/schemastery'
import { FlairFileStore, StorageError, cloneJson, fingerprint } from './storage.js'

/** Profile entry id; also the settings namespace and the client's configForms key. */
export const ENTRY_ID = 'status-flair'

/** Legacy configuration key, retained as nonvolatile compatibility input. */
export const FLAIR_KEY = 'flair'

/** Reserved entry id: "use DSH's own look / own copy". Never stored as a preset. */
export const DEFAULT_ID = 'default'

/** Global selection defaults. Starter rules separately defer to DSH styling and copy. */
export const DEFAULT_SELECTION = {
  /** `fixed` uses `fixedPresetId`; `random` draws from `presetIds`. */
  presetMode: 'fixed',
  fixedPresetId: 'golden',
  presetIds: ['golden', 'violet', 'terminal'],
  /** `fixed` uses `fixedTextPresetId`; `random` draws from `textPresetIds`. */
  textPresetMode: 'fixed',
  fixedTextPresetId: DEFAULT_ID,
  textPresetIds: [DEFAULT_ID],
  /** `first` | `random` | `sequential` — only reached when a text group is picked. */
  textMode: 'random',
}

/** Four editable starter policies, each with independent DSH-default selection fields. */
export function createStarterRules() {
  return [
    ['starter-thinking', '思考与交互', 'starterThinking', ['waiting', 'thinking', 'questions', 'plan']],
    ['starter-information', '信息获取', 'starterInformation', ['read', 'readImage', 'search', 'webSearch', 'webFetch']],
    ['starter-execution', '执行与操作', 'starterExecution', ['write', 'edit', 'commands', 'code', 'subagents', 'tools']],
    ['starter-response', '回复', 'starterResponse', ['responding']],
  ].map(([id, name, nameKey, kinds]) => ({
    id, name, nameKey, enabled: true, kind: 'activity',
    groupIds: kinds.map((kind) => 'builtin:' + kind),
    holdMs: 2000,
    selection: { presetMode: 'fixed', fixedPresetId: DEFAULT_ID, presetIds: [DEFAULT_ID],
          textPresetMode: 'fixed', fixedTextPresetId: DEFAULT_ID, textPresetIds: [DEFAULT_ID], textMode: 'random' },
  }))
}

/**
 * Presets shipped on first run. A preset is *one look*; text lives in
 * `textPresets` and is chosen independently, so the same look works with any
 * text group and the same text group works with any look.
 */
export const DEFAULT_FLAIR = {
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
  // 默认只带外观预设；文案默认交给 DSH 自己的运行行，不预置任何文案组。
  textPresets: [],
  selection: DEFAULT_SELECTION,
  // Event groups are custom only; built-in groups are virtual in the browser.
  eventGroups: [],
  eventRules: { enabled: false, minRefreshMs: 3000, rules: createStarterRules() },
  // 触发配置：每轮触发默认开启（保持历史行为），时间/步骤默认关闭。
  triggers: {
    look: { turn: { enabled: true }, time: { enabled: false, mode: 'fixed', fixedMs: 5000, minMs: 3000, maxMs: 9000 }, step: { enabled: false, every: 2 } },
    text: { turn: { enabled: true }, time: { enabled: false, mode: 'fixed', fixedMs: 5000, minMs: 3000, maxMs: 9000 }, step: { enabled: false, every: 2 } },
  },
}

/** One preset's look. Colours are #rrggbb; duration is milliseconds, 0 turns the sweep off. */
const StyleSchema = z.object({
  color: z.string().default('#EFB864'),
  fontSize: z.number().default(13),
  icon: z.string().default('sparkles'),
  /** Custom icon: raw SVG markup or a data:image/(svg+xml|png) URL; only used when icon is "custom". */
  iconSource: z.string().default(''),
  shimmerDuration: z.number().default(1600),
  /** 自定义扫光色（深色主题 / 浅色主题）；空串表示按主色自动派生，与 DSH 的深浅方向一致。 */
  shimmerDark: z.string().default(''),
  shimmerLight: z.string().default(''),
})

/**
 * One look preset. `texts` is deprecated and kept for one release so configs
 * written by the pre-split version survive: the browser half migrates them into
 * text presets on read and stops writing them back.
 */
const PresetSchema = z.object({
  id: z.string(),
  name: z.string().default('新预设'),
  /** Shipped-name marker: when set, the browser half shows a localized display name. */
  nameKey: z.string().default(''),
  texts: z.array(z.string()),
  style: StyleSchema,
})

/** One named group of candidate lines. */
const TextPresetSchema = z.object({
  id: z.string(),
  name: z.string().default('新文案'),
  texts: z.array(z.string()).default([]),
})

/** How looks and texts are chosen. The two layers are independent. */
const SelectionSchema = z.object({
  presetMode: z.string().default('fixed'),
  fixedPresetId: z.string().default('golden'),
  /** Candidate look ids for `random`; empty falls back to every preset. */
  presetIds: z.array(z.string()).default([]),
  textPresetMode: z.string().default('fixed'),
  fixedTextPresetId: z.string().default('text-golden'),
  /** Candidate text-group ids for `random`; empty falls back to every group. */
  textPresetIds: z.array(z.string()).default([]),
  textMode: z.string().default('random'),
})

/** Custom event groups only; built-in group ids are resolved by the browser. */
const EventKindSchema = z.union([z.const('activity'), z.const('pulse')])
const EventGroupSchema = z.object({
  id: z.string(),
  name: z.string().default(''),
  kind: EventKindSchema.default('activity'),
  activityKinds: z.array(z.string()).default([]),
  toolNames: z.array(z.string()).default([]),
  events: z.array(z.string()).default([]),
})

/** Ordered browser-side rules, each with a complete independent selection. */
const EventRuleSchema = z.object({
  id: z.string(),
  name: z.string().default(''),
  nameKey: z.string().default(''),
  enabled: z.boolean().default(true),
  kind: EventKindSchema.default('activity'),
  groupIds: z.array(z.string()).default([]),
  holdMs: z.number().default(2000),
  selection: SelectionSchema.default(DEFAULT_FLAIR.selection),
})

const EventRulesSchema = z.object({
  enabled: z.boolean().default(false),
  minRefreshMs: z.number().default(DEFAULT_FLAIR.eventRules.minRefreshMs),
  rules: z.array(EventRuleSchema).default(DEFAULT_FLAIR.eventRules.rules),
})

/** Fixed or random re-draw interval for one layer, in milliseconds. */
const TimeTriggerSchema = z.object({
  enabled: z.boolean().default(false),
  mode: z.string().default('fixed'),
  fixedMs: z.number().default(5000),
  minMs: z.number().default(3000),
  maxMs: z.number().default(9000),
})

/** Re-draw one layer every N Session steps. */
const StepTriggerSchema = z.object({
  enabled: z.boolean().default(false),
  every: z.number().default(2),
})

/** Re-draw this layer when a new turn starts; the historical default is on. */
const TurnTriggerSchema = z.object({
  enabled: z.boolean().default(true),
})

/** One layer's triggers; look and text are configured independently. */
const LayerTriggerSchema = z.object({
  turn: TurnTriggerSchema.default({ enabled: true }),
  time: TimeTriggerSchema.default({ enabled: false, mode: 'fixed', fixedMs: 5000, minMs: 3000, maxMs: 9000 }),
  step: StepTriggerSchema.default({ enabled: false, every: 2 }),
})

const TriggersSchema = z.object({
  look: LayerTriggerSchema.default({}),
  text: LayerTriggerSchema.default({}),
})

/** Complete flair document, also used to validate independent file storage. */
export const FlairSchema = z.object({
  enabled: z.boolean().default(true),
  presets: z.array(PresetSchema).default(DEFAULT_FLAIR.presets),
  // Default `[]` (not the shipped groups): a config written before the split has
  // no `textPresets`, and the browser half needs to see that absence to migrate
  // the legacy inline `texts` instead of silently falling back to the defaults.
  textPresets: z.array(TextPresetSchema).default([]),
  selection: SelectionSchema.default(DEFAULT_FLAIR.selection),
  triggers: TriggersSchema.default(DEFAULT_FLAIR.triggers),
  eventGroups: z.array(EventGroupSchema).default([]),
  eventRules: EventRulesSchema.default(DEFAULT_FLAIR.eventRules),
})

/** Legacy config is intentionally nonvolatile: stale browsers cannot revive it. */
export const Config = z.object({
  storage: z.union([z.const('auto'), z.const('file')]).default('auto'),
  [FLAIR_KEY]: z.union([z.const(null), FlairSchema]).default(null),
})

/** Create the authenticated data API without registering any public web-server writer. */
export function createStorageApi({ profile, config = {}, editor, ownerFiber, fs }) {
  let closed = false
  const ownerEntry = () => {
    const matches = typeof editor?.entries === 'function' ? [...editor.entries()].filter((entry) => entry.fiber === ownerFiber && ownerFiber !== undefined) : []
    return matches.length === 1 ? matches[0] : undefined
  }
  const normalize = (value) => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new StorageError('invalid-request', 'flair must be an object')
    return FlairSchema(cloneJson(value))
  }
  const store = new FlairFileStore({
    profile, mode: config.storage ?? 'auto', defaults: DEFAULT_FLAIR, normalize, ...(fs ? { fs } : {}),
    getLegacy: () => {
      const entry = ownerEntry()
      if (!entry && config.flair !== null && config.flair !== undefined) throw new StorageError('storage-unavailable', 'The raw legacy owner is unavailable; a normalized-only backup would be unsafe')
      const rawFlair = entry?.options?.config?.flair ?? null
      return { rawFlair, effectiveFlair: rawFlair === null ? DEFAULT_FLAIR : normalize(rawFlair) }
    },
  })
  const save = async (payload) => {
    const prepared = await store.save(payload)
    const snapshot = cloneJson(prepared.snapshot)
    // Install the lightweight marker only after durability, without deleting any
    // legacy config. Keep configEditor/HMR outside the store's write queue.
    try {
      const entry = ownerEntry()
      if (!entry || typeof editor?.edit !== 'function') throw new Error('Storage marker cannot be safely persisted')
      if (entry.options.config?.storage !== 'file') await editor.edit(entry, (raw) => ({ ...raw, storage: 'file' }))
      store.mode = 'file'
      snapshot.storage.cleanupPending = entry.options.config?.flair != null
    } catch (error) {
      snapshot.storage.cleanupPending = true
      snapshot.storage.warning = 'Data is saved, but the file-storage marker is pending: ' + (error instanceof Error ? error.message : String(error))
    }
    return snapshot
  }
  const migrate = async (payload) => {
    // Only this first phase belongs to the file queue. configEditor may dispose us.
    const prepared = await store.prepareMigration(payload)
    const snapshot = cloneJson(prepared.snapshot)
    snapshot.lastOperationId = payload.operationId
    try {
      const entry = ownerEntry()
      if (!entry || typeof editor?.edit !== 'function') throw new Error('Configuration owner is not safely editable')
      store.verifyBackupForCleanup(prepared.legacy)
      if (entry.options.config?.storage === 'file' && entry.options.config?.flair == null) {
        store.mode = 'file'
        snapshot.storage.cleanupPending = false
        return snapshot
      }
      await editor.edit(entry, (raw, inherited) => {
        store.verifyBackupForCleanup(prepared.legacy)
        if (inherited?.flair != null) throw new Error('Legacy flair is inherited; automatic cleanup is unsafe')
        if (fingerprint(raw?.flair ?? null) !== fingerprint(prepared.legacy?.rawFlair ?? null)) throw new Error('Legacy configuration changed after its backup; it was retained')
        const next = { ...raw, storage: 'file' }
        delete next.flair
        return next
      })
      store.mode = 'file'
      snapshot.storage.cleanupPending = false
      delete snapshot.storage.warning
    } catch (error) {
      snapshot.storage.cleanupPending = true
      snapshot.storage.warning = error instanceof Error ? error.message : String(error)
    }
    return snapshot
  }
  const request = async (payload) => {
    if (closed) throw new StorageError('closed', 'Settings storage is closing')
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new StorageError('invalid-request', 'A JSON request object is required')
    switch (payload.action) {
      case 'load': return store.load(payload)
      case 'backup': return store.backup()
      case 'save': return save(payload)
      case 'migrate': return migrate(payload)
      default: throw new StorageError('invalid-request', 'Unknown action')
    }
  }
  return {
    store, request,
    close() { closed = true; return store.close() },
    async fetch(request_) {
      let status = 200, envelope
      try {
        if (request_.method !== 'POST') throw new StorageError('invalid-request', 'POST is required')
        const text = await request_.text()
        if (Buffer.byteLength(text) > 8 * 1024 * 1024) throw new StorageError('invalid-request', 'Request body is too large')
        let payload
        try { payload = JSON.parse(text) } catch { throw new StorageError('invalid-request', 'Invalid JSON request') }
        envelope = { ok: true, value: await request(payload) }
      } catch (error) {
        const code = error instanceof StorageError ? error.code : 'storage-unavailable'
        status = code === 'conflict' ? 409 : code === 'invalid-request' ? 400 : 503
        envelope = { ok: false, error: { code, message: error instanceof Error ? error.message : String(error) } }
      }
      return new Response(JSON.stringify(envelope), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })
    },
  }
}

/** The health route rides the Host web server; without it the plugin has nothing to say. */
export const inject = ['webServer']

/**
 * The Host half owns two things: the configuration schema above, and a read-only
 * health route so an installation can be verified without a browser.
 *
 * `/status-flair/health` reports what the Host actually resolved — useful when
 * checking that a hot recomposition picked this package up, and harmless to
 * leave mounted in normal use.
 *
 * @param ctx - the Host plugin context.
 * @param config - the resolved entry config (second argument, not `ctx.config`).
 */
export function apply(ctx, config) {
  // Capture the activation config and fiber; request handlers never access ctx.config.
  let reference
  try {
    reference = config
  } catch (error) {
    reference = undefined
  }
  // 浏览器端加载证明：插件页面到底有没有在浏览器里 apply 过、用的哪个模块 id。
  let clientSeen = null
  let api = null
  const ownerFiber = ctx.fiber
  if (typeof ctx.inject === 'function') ctx.inject(['connection', 'profileContext', 'configEditor'], (scope) => {
    const connection = scope.get('connection'), profile = scope.get('profileContext'), editor = scope.get('configEditor')
    if (typeof connection?.fetch?.register !== 'function') return
    scope.effect(() => {
      const current = createStorageApi({ profile, config, editor, ownerFiber })
      api = current
      let off
      try {
        off = connection.fetch.register({ path: '/api/status-flair/data', methods: ['POST'], requestBody: 'buffered', fetch: (request) => current.fetch(request) })
      } catch (error) { current.close(); api = null; throw error }
      return () => { if (api === current) api = null; if (typeof off === 'function') off(); return current.close() }
    }, 'status-flair: profile settings API')
  })

  ctx.effect(() => {
    const server = ctx.get('webServer')
    if (server === undefined) return () => {}
    return server.register(
      {
        kind: 'prefix',
        path: '/status-flair',
        handler: async (req, res) => {
          let path = ''
          let query = new URLSearchParams()
          try {
            const parsed = new URL(req.url ?? '/', 'http://dsh.invalid')
            path = parsed.pathname
            query = parsed.searchParams
          } catch (error) {
            path = ''
          }
          if (path === '/status-flair/client') {
            clientSeen = {
              at: Date.now(),
              moduleId: query.get('id'),
              key: query.get('key'),
            }
            res.writeHead(204, { 'cache-control': 'no-store' })
            res.end()
            return
          }
          // A probe route must never fail the request: a throwing handler becomes a
          // bare 400 from the web server, which hides the reason. Report instead.
          const payload = { plugin: ENTRY_ID, loaded: true, client: clientSeen }
          try {
            payload.volatile = Config.dict[FLAIR_KEY].meta.volatile === true
            const snapshot = api ? await api.store.load() : null
            const value = snapshot?.value.flair ?? reference?.[FLAIR_KEY] ?? DEFAULT_FLAIR
            payload.configKind = snapshot?.storage.mode ?? (reference?.[FLAIR_KEY] == null ? 'defaults' : 'legacy')
            if (snapshot) payload.storage = snapshot.storage
            payload.enabled = value === undefined ? null : value.enabled
            payload.styleFields = Object.keys(StyleSchema.dict)
            payload.presetFields = Object.keys(PresetSchema.dict)
            payload.presets = value === undefined || !Array.isArray(value.presets) ? [] : value.presets.map((preset) => preset.id)
            payload.textPresets =
              value === undefined || !Array.isArray(value.textPresets) ? [] : value.textPresets.map((preset) => preset.id)
            payload.selection = value === undefined ? null : value.selection
            // Event processing stays client-side; expose counts, never rule contents.
            payload.eventGroups = Array.isArray(value?.eventGroups) ? value.eventGroups.length : 0
            const rules = Array.isArray(value?.eventRules?.rules) ? value.eventRules.rules : []
            payload.eventRules = {
              enabled: value?.eventRules?.enabled === true,
              count: rules.length,
              enabledCount: rules.filter((rule) => rule?.enabled !== false).length,
            }
            // 触发配置只在 UI 里用；这里回显一份摘要，方便无浏览器时确认 schema 已生效。
            payload.triggers =
              value === undefined || value.triggers === undefined || value.triggers === null
                ? null
                : {
                    look: {
                      turn: value.triggers.look?.turn?.enabled !== false,
                      time: value.triggers.look?.time?.enabled === true,
                      step: value.triggers.look?.step?.enabled === true,
                    },
                    text: {
                      turn: value.triggers.text?.turn?.enabled !== false,
                      time: value.triggers.text?.time?.enabled === true,
                      step: value.triggers.text?.step?.enabled === true,
                    },
                  }
          } catch (error) {
            payload.error = error instanceof Error ? error.message : String(error)
          }
          res.writeHead(200, {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store',
          })
          res.end(JSON.stringify(payload))
        },
      },
      'status-flair: health route',
    )
  }, 'status-flair: routes')
}
