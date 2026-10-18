/**
 * dsh-status-flair — Host half.
 *
 * The running status ("深度求索中，用时 7秒 ···") is rendered by
 * `@deepseek-ai/dsh-client-ui-chat`; this plugin owns no Host-side runtime
 * behaviour. What the Host half does provide is the one thing the browser
 * cannot own: the durable, live-editable configuration document.
 *
 * Everything under `flair` is marked `.volatile()`, so dsh-settings projects
 * it into the profile's settings document, accepts live writes through
 * `ctx.configForms` in the browser, and persists them into the profile's
 * `cordis.patch.yml` (no restart, survives upgrades).
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

/** Profile entry id; also the settings namespace and the client's configForms key. */
export const ENTRY_ID = 'status-flair'

/** The single volatile field of this plugin's Config. */
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

/** Volatile block: the only shape dsh-settings projects and accepts writes for. */
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

/** Plugin config. `.volatile()` is what makes the settings form live-editable. */
export const Config = z.object({
  [FLAIR_KEY]: FlairSchema.default(DEFAULT_FLAIR).volatile(),
})

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
  // Keep the volatile reference from activation time: the value behind it stays live,
  // while reading `ctx.config` later (from a request handler) has no active fiber.
  let reference
  try {
    reference = config === undefined || config === null ? undefined : config[FLAIR_KEY]
  } catch (error) {
    reference = undefined
  }
  // 浏览器端加载证明：插件页面到底有没有在浏览器里 apply 过、用的哪个模块 id。
  let clientSeen = null

  ctx.effect(() => {
    const server = ctx.get('webServer')
    if (server === undefined) return () => {}
    return server.register(
      {
        kind: 'prefix',
        path: '/status-flair',
        handler: (req, res) => {
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
            const value = reference !== undefined && typeof reference.get === 'function' ? reference.get() : undefined
            payload.configKind = reference === undefined ? 'absent' : typeof reference.get === 'function' ? 'volatile' : typeof reference
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
