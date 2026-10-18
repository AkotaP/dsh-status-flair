/** Event policies: offline classification, matching and shared-source lifecycle. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { loadClient, createCtx, createForm } from './support/harness.mjs'

const { module, dom } = await loadClient()
const T = module.__test
const plain = (value) => JSON.parse(JSON.stringify(value))
const selection = (patch = {}) => ({ ...plain(T.DEFAULT_FLAIR.selection), ...patch })
const rule = (id, kind, groupIds, patch = {}) => ({
  id, name: id, enabled: true, kind, groupIds, holdMs: 2000,
  selection: selection(), ...patch,
})
const config = (rules = [], patch = {}) => ({
  ...plain(T.DEFAULT_FLAIR),
  eventRules: { enabled: true, minRefreshMs: 0, rules }, ...patch,
})
const entry = (type, data = {}) => ({ type: 'event', event: { type, data } })
const result = (callId, isError = false) => entry('tool/result', { message: { source: { callId }, isError } })
const call = (callId, name, patch = {}) => ({ callId, name, turn: 1, phase: 'start', ...patch })
const live = (attemptId, chunk, step = 1, turn = 1) => ({ type: 'transient', event: { type: 'assistant/live-chunk', seq: 1.5, data: { attemptId, turn, step, chunk } } })
const append = (...entries) => T.consumeLiveChange({ kind: 'append', entries })
const phaseRules = () => ['waiting', 'thinking', 'responding'].map((kind) => rule(kind, 'activity', ['builtin:' + kind]))

function store(initial) {
  let snapshot = initial
  const listeners = new Set()
  return {
    reads: 0, subscriptions: 0,
    getSnapshot() { this.reads++; return snapshot },
    subscribe(listener) {
      this.subscriptions++
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    get size() { return listeners.size },
    set(next) { snapshot = next },
    emit(next = snapshot) {
      snapshot = next
      for (const listener of [...listeners]) listener()
    },
  }
}

// Matches DSH ChatSnapshotBuilder.snapshot(): runningCalls belong to legacy.
function chatSnapshot(runningCalls = [], extra = {}) {
  return { order: [], nodes: new Map(), locations: {}, navigation: {}, timeline: { turnOrder: [], turns: new Map() },
    legacy: { nodes: [], partial: null, runningCalls, ...extra } }
}

function session(id, runningCalls = [], turn = 1) {
  const source = store({ revision: 1, change: { kind: 'replace', entries: [result('historical', true)] } })
  const target = store(chatSnapshot(runningCalls))
  const openTurn = store(turn)
  const binding = { sessionId: id, eventSource: source }
  return {
    id, source, target, openTurn, binding,
    conversation: { openTurn, target: (name) => { assert.equal(name, 'chat'); return target } },
    change(kind, entries, revision = source.getSnapshot().revision + 1) {
      source.emit({ revision, change: { kind, entries } })
    },
  }
}

function services(...items) {
  const byId = (mainId) => Object.fromEntries(items.map((s) => [s.id, { id: s.id, retainedBy: { mainView: s.id === mainId ? 1 : 0 } }]))
  const list = store({ byId: byId(items[0]?.id) })
  const bindings = []
  return {
    list, byId, bindings,
    sessions: {
      list,
      binding(id) { bindings.push(id); return items.find((s) => s.id === id)?.binding },
      follow() { assert.fail('event policies must reuse the existing source') },
    },
    ui: {
      binding(binding) { return items.find((s) => s.binding === binding).conversation },
      events: { register() { assert.fail('projection matchers are not a live event source') } },
    },
  }
}

function activate(value, runningCalls = [], turn = 1) {
  T.applyFlair(value)
  T.resetEventSession('main', true)
  T.updateNativeActivity({ runningCalls }, turn)
}

// Keep mocks and resets local to this suite when --test-isolation=none loads other files.
test.describe('event policy engine', { concurrency: false }, () => {
  test.beforeEach((t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 10000 })
    dom.setRunning(true)
    dom.localStorage.clear()
    T.resetRun()
    T.setRandom(() => 0)
    T.applyFlair(plain(T.DEFAULT_FLAIR))
  })
  test.afterEach(() => T.resetRun())

  test('real Chat snapshot legacy tools drive execution, information and parallel completion states', () => {
    T.applyFlair(config(T.createStarterRules()))
    const root = (subCalls = [], phase = 'start') => call('program', 'run_code', { phase, step: 1, time: 10, subCalls })
    const read = call('reader', 'read', { step: 1, time: 11 })
    const write = call('writer', 'write', { step: 1, time: 12 })
    const main = session('main', [root([], 'preparing')]), env = services(main)
    const off = T.watchMainSession(env.sessions, env.ui)
    try {
      assert.equal(T.eventState.ruleId, 'starter-execution', 'outer code preparation is already tool activity')
      assert.deepEqual(T.eventState.calls.map((c) => c.name), ['run_code'])
      main.target.emit(chatSnapshot([root([read, write])]))
      assert.equal(T.eventState.ruleId, 'starter-information', 'information rule wins over the outer execution wrapper')
      assert.deepEqual(T.eventState.calls.map((c) => c.activity), ['code', 'read', 'write'])
      main.target.emit(chatSnapshot([root([{ kind: 'tool-result', callId: 'reader', name: 'read', subCalls: [] }, write])]))
      assert.equal(T.eventState.ruleId, 'starter-execution', 'one completed subcall does not end the others')
      assert.deepEqual(T.eventState.calls.map((c) => c.name), ['run_code', 'write'])
      main.target.emit(chatSnapshot([]))
      assert.equal(T.eventState.ruleId, 'starter-thinking')
      assert.deepEqual(T.eventState.calls, [])
    } finally { off() }
  })

  test('native nested empty tool list is authoritative over stale flat compatibility fields', () => {
    activate(config(T.createStarterRules()))
    T.updateNativeActivity({ ...chatSnapshot([]), runningCalls: [call('stale', 'read')] }, 1)
    assert.deepEqual(T.eventState.calls, [])
    assert.equal(T.eventState.ruleId, 'starter-thinking')
    T.updateNativeActivity({ runningCalls: [call('old-adapter', 'read')] }, 1)
    assert.equal(T.eventState.ruleId, 'starter-information', 'older flat adapters still work')
  })

  test('plugin tools stay unclassified unless a custom group explicitly assigns their exact names', () => {
    const plugin = call('plugin-search', 'ops_grep')
    const outer = call('program', 'run_code', { subCalls: [plugin] })
    const value = config(T.createStarterRules())
    activate(value)
    T.updateNativeActivity(chatSnapshot([outer]), 1)
    assert.equal(T.nativeActivity('ops_grep'), 'tools', 'plugin names must not be hardcoded as native capabilities')
    assert.equal(T.eventState.ruleId, 'starter-execution')
    value.eventGroups = [{ id: 'plugin-searches', name: 'Plugin searches', kind: 'activity', activityKinds: [], toolNames: ['ops_grep'], events: [] }]
    value.eventRules.rules[1].groupIds.push('plugin-searches')
    T.applyFlair(value)
    assert.equal(T.eventState.ruleId, 'starter-information', 'explicit custom grouping assigns the plugin tool')
    assert.deepEqual(T.eventState.calls.map((c) => c.name), ['run_code', 'ops_grep'])
  })

  test('native categories and tool mapping preserve all 14 DSH activity kinds', () => {
    assert.deepEqual(T.ACTIVITY_KINDS, ['thinking', 'read', 'readImage', 'search', 'write', 'edit', 'commands', 'code', 'webSearch', 'webFetch', 'subagents', 'plan', 'questions', 'tools'])
    const mappings = {
      read: 'read', read_image: 'readImage', grep: 'search', glob: 'search', file_inspect: 'search',
      write: 'write', edit: 'edit', apply_patch: 'edit', bash: 'commands', pwsh: 'commands',
      exec_command: 'commands', write_stdin: 'commands', terminal_open: 'commands', run_code: 'code',
      web_search: 'webSearch', web_fetch: 'webFetch', subagent: 'subagents', subagent_fork: 'subagents',
      todo_write: 'plan', create_goal: 'plan', update_goal: 'plan', get_goal: 'plan',
      ask_user_question: 'questions', request_user_input: 'questions', extension_tool: 'tools', ops_bash: 'tools',
    }
    for (const [name, expected] of Object.entries(mappings)) assert.equal(T.nativeActivity(name), expected, name)
    assert.deepEqual(T.OUTPUT_PHASES, ['waiting', 'thinking', 'responding'])
    assert.equal(T.BUILTIN_GROUPS.length, 18)
    assert.deepEqual(T.BUILTIN_GROUPS.map((g) => g.id), [
      ...T.MATCH_ACTIVITY_KINDS.map((kind) => 'builtin:' + kind), 'builtin:tool-error', 'builtin:tool-success',
    ])
  })

  test('custom groups normalize without persisting virtual built-ins; old config stays disabled', () => {
    const groups = T.normalizeEventGroups([
      { id: 'custom', kind: 'activity', activityKinds: ['read', 'invalid', 'read'], toolNames: [' extension_tool ', 'extension_tool'] },
      { id: 'custom', kind: 'pulse' }, { id: 'builtin:read', kind: 'activity' },
      { id: 'pulse', kind: 'pulse', events: ['tool-error', 'invalid'], activityKinds: ['read'] },
    ])
    assert.equal(groups.length, 2)
    assert.deepEqual(groups[0].activityKinds, ['read'])
    assert.deepEqual(groups[0].toolNames, ['extension_tool'])
    assert.deepEqual(groups[1].events, ['tool-error'])
    assert.deepEqual(groups[1].activityKinds, [])
    const legacy = T.normalizeFlair({ presets: plain(T.DEFAULT_FLAIR.presets) })
    assert.deepEqual(legacy.eventGroups, [])
    assert.equal(legacy.eventRules.enabled, false)
    assert.equal(legacy.eventRules.minRefreshMs, 3000)
    assert.deepEqual(legacy.eventRules.rules, T.createStarterRules())
    assert.deepEqual(T.normalizeEventRules({ rules: [] }).rules, [])
    assert.equal(T.eventGroupsOf(legacy).length, 18)
    assert.equal(T.normalizeEventRules({ rules: [{ id: 'one' }] }).rules[0].enabled, true)
  })

  test('four starter rules cover each confirmed activity exactly once and match the intended group', () => {
    const starters = T.createStarterRules()
    assert.deepEqual(starters.map((r) => r.name), ['思考与交互', '信息获取', '执行与操作', '回复'])
    const ids = starters.flatMap((r) => r.groupIds)
    assert.equal(ids.length, T.MATCH_ACTIVITY_KINDS.length)
    assert.deepEqual([...new Set(ids)].sort(), T.MATCH_ACTIVITY_KINDS.map((kind) => 'builtin:' + kind).sort())
    const value = T.normalizeFlair(config(starters))
    const state = { available: true, turn: 1, calls: [], pulses: [], phase: 'waiting' }
    for (const [index, rule] of starters.entries()) {
      for (const groupId of rule.groupIds) {
        const kind = groupId.slice('builtin:'.length)
        const phase = T.OUTPUT_PHASES.includes(kind)
        const candidate = { ...state, phase: phase ? kind : 'waiting', calls: phase ? [] : [{ id: 'x', name: 'tool', activity: kind }] }
        assert.equal(T.selectEventRule(value, candidate, Date.now()).id, starters[index].id, kind)
      }
    }
    assert.ok(starters.every((r) => r.kind === 'activity' && !r.groupIds.includes('builtin:tool-error') && !r.groupIds.includes('builtin:tool-success')))
  })

  test('enabled starter rules defer styling and copy to DSH without changing the global selection', () => {
    const value = config(T.createStarterRules(), { selection: selection({ fixedPresetId: 'violet' }) })
    for (const calls of [[], [call('read', 'read')], [call('write', 'write')]]) {
      activate(value, calls)
      assert.equal(T.run.presetId, T.DEFAULT_ID)
      assert.equal(T.run.textPresetId, T.DEFAULT_ID)
      assert.equal(T.run.text, null)
      assert.equal(T.currentFlair().selection.fixedPresetId, 'violet')
    }
    activate(value)
    append(live('reply', { type: 'text-delta', index: 0, text: 'response' }))
    assert.equal(T.eventState.ruleId, 'starter-response')
    assert.equal(T.run.presetId, T.DEFAULT_ID)
    assert.equal(T.run.textPresetId, T.DEFAULT_ID)
    assert.equal(T.run.text, null)
  })

  test('starter defaults preserve explicit empty and custom rules on repeated normalization', () => {
    const base = { ...plain(T.DEFAULT_FLAIR), selection: selection({ fixedPresetId: 'violet' }), eventRules: undefined }
    const seeded = T.normalizeFlair(base)
    assert.equal(seeded.eventRules.rules.length, 4)
    assert.equal(seeded.eventRules.enabled, false)
    assert.equal(seeded.selection.fixedPresetId, 'violet', 'never change the existing global selection')
    assert.deepEqual(seeded.eventRules.rules, T.createStarterRules(), 'missing-rule defaults agree with the host schema')
    assert.notEqual(seeded.eventRules.rules[0].selection.presetIds, seeded.eventRules.rules[1].selection.presetIds)
    const empty = T.normalizeFlair({ ...base, eventRules: { enabled: false, rules: [] } })
    assert.deepEqual(T.normalizeFlair(empty).eventRules.rules, [])
    const custom = T.normalizeFlair({ ...base, eventRules: { enabled: true, rules: [rule('custom', 'activity', ['builtin:read'])] } })
    assert.equal(custom.eventRules.rules.length, 1)
    assert.equal(T.normalizeFlair(custom).eventRules.rules[0].id, 'custom')
  })

  test('activity matching is category OR exact tool; pulse tool filters narrow result types', () => {
    const activity = { kind: 'activity', activityKinds: ['read'], toolNames: ['extension_tool'] }
    assert.equal(T.groupMatches(activity, { name: 'read', activity: 'read' }), true)
    assert.equal(T.groupMatches(activity, { name: 'extension_tool', activity: 'tools' }), true)
    assert.equal(T.groupMatches(activity, { name: 'extension_tool_extra', activity: 'tools' }), false)
    const pulse = { kind: 'pulse', events: ['tool-error'], toolNames: ['extension_tool'] }
    assert.equal(T.groupMatches(pulse, { name: 'extension_tool' }, 'tool-error'), true)
    assert.equal(T.groupMatches(pulse, { name: 'other' }, 'tool-error'), false)
    assert.equal(T.groupMatches(pulse, { name: 'extension_tool' }, 'tool-success'), false)
    assert.equal(T.groupMatches({ ...pulse, toolNames: [] }, { name: 'other' }, 'tool-error'), true)
  })

  test('first enabled valid rule wins; disabled, missing, wrong-kind and invalid selections skip', () => {
    const rules = [
      rule('disabled', 'activity', ['builtin:read'], { enabled: false }),
      rule('missing', 'activity', ['deleted']),
      rule('wrong-kind', 'activity', ['builtin:tool-error']),
      rule('bad-look', 'activity', ['builtin:read'], { selection: selection({ fixedPresetId: 'deleted' }) }),
      rule('bad-text', 'activity', ['builtin:read'], { selection: selection({ fixedTextPresetId: 'deleted' }) }),
      rule('first', 'activity', ['builtin:read']), rule('second', 'activity', ['builtin:read']),
    ]
    const value = T.normalizeFlair(config(rules))
    const state = { available: true, turn: 1, calls: [{ name: 'read', activity: 'read' }], pulses: [] }
    assert.equal(T.selectEventRule(value, state, Date.now()).id, 'first')
    assert.equal(T.ruleIssue(value, value.eventRules.rules[1]), 'eventMissingGroup')
    assert.equal(T.ruleIssue(value, value.eventRules.rules[2]), 'eventMissingGroup')
    assert.equal(T.ruleIssue(value, value.eventRules.rules[3]), 'eventMissingPreset')
    assert.equal(T.selectEventRule({ ...value, eventRules: { ...value.eventRules, enabled: false } }, state, Date.now()), null)
    assert.equal(T.selectEventRule(value, { ...state, available: false }, Date.now()), null)
    assert.equal(T.selectEventRule(value, { ...state, turn: null }, Date.now()), null)
    assert.equal(T.selectEventRule(value, { ...state, calls: [] }, Date.now()), null)
  })

  test('numeric turn zero is an active turn for rule matching and native activity', () => {
    const value = T.normalizeFlair(config([rule('reading', 'activity', ['builtin:read'])]))
    const state = { available: true, turn: 0, calls: [{ name: 'read', activity: 'read' }], pulses: [] }
    assert.equal(T.selectEventRule(value, state, Date.now())?.id, 'reading')
    activate(value, [call('zero', 'read', { turn: 0 })], 0)
    assert.equal(T.eventState.turn, 0)
    assert.equal(T.eventState.ruleId, 'reading')
  })

  test('priority is list order across pulse and activity rules, not a hidden kind priority', () => {
    const activity = rule('reading', 'activity', ['builtin:read'])
    const pulse = rule('failure', 'pulse', ['builtin:tool-error'])
    const state = { available: true, turn: 1, calls: [{ name: 'read', activity: 'read' }], pulses: [{ at: Date.now(), name: 'read', event: 'tool-error' }] }
    assert.equal(T.selectEventRule(T.normalizeFlair(config([activity, pulse])), state, Date.now()).id, 'reading')
    assert.equal(T.selectEventRule(T.normalizeFlair(config([pulse, activity])), state, Date.now()).id, 'failure')
  })

  test('disabled policies preserve global selection and the official default sentinel', () => {
    const value = config([rule('reading', 'activity', ['builtin:read'], { selection: selection({ fixedPresetId: 'violet' }) })])
    value.eventRules.enabled = false
    value.selection = selection({ fixedPresetId: 'default', fixedTextPresetId: 'default' })
    activate(value, [call('read', 'read')])
    assert.equal(T.eventState.ruleId, null)
    assert.equal(T.run.presetId, 'default')
    assert.equal(T.readLabel(), null)
    assert.equal(dom.attrs.has(T.ACTIVE_ATTR), false)
  })

  test('parallel PTC results end only the exact call, not parent or another parallel call', () => {
    const parent = call('parent', 'run_code', { subCalls: [call('a', 'read', { phase: 'preparing' }), call('b', 'write'), call('old', 'edit', { turn: 0 }), call('done', 'read', { phase: 'result' })] })
    activate(config(), [parent])
    assert.deepEqual(T.eventState.calls.map((c) => c.id), ['parent', 'a', 'b'])
    T.consumeLiveChange({ kind: 'append', entries: [result('a', true)] })
    assert.deepEqual(T.eventState.calls.map((c) => c.id), ['parent', 'b'])
    assert.equal(T.eventState.pulses[0].name, 'read')
    assert.equal(T.eventState.pulses[0].event, 'tool-error')
    T.consumeLiveChange({ kind: 'append', entries: [entry('tool/ptc-dispatch', { subCallId: 'b', isError: false })] })
    assert.deepEqual(T.eventState.calls.map((c) => c.id), ['parent'])
    assert.equal(T.eventState.pulses[1].name, 'write')
    assert.equal(T.eventState.pulses[1].event, 'tool-success')
    T.consumeLiveChange({ kind: 'append', entries: [entry('turn/end', { turn: 1 })] })
    assert.equal(T.run.active, false)
    assert.deepEqual(T.eventState.calls, [])
    assert.deepEqual(T.eventState.pulses, [])
  })

  test('pulse expiry returns to activity rule at holdMs without a new source event', (t) => {
    activate(config([
      rule('failure', 'pulse', ['builtin:tool-error'], { selection: selection({ fixedPresetId: 'violet' }) }),
      rule('idle', 'activity', ['builtin:waiting']),
    ]))
    assert.equal(T.eventState.ruleId, 'idle')
    T.consumeLiveChange({ kind: 'append', entries: [result('one', true)] })
    assert.equal(T.eventState.ruleId, 'failure')
    assert.equal(T.run.presetId, 'violet')
    t.mock.timers.tick(1999)
    assert.equal(T.eventState.ruleId, 'failure')
    t.mock.timers.tick(1)
    assert.equal(T.eventState.ruleId, 'idle')
    assert.equal(T.run.presetId, 'golden')
  })

  test('repeated activity under the same rule does not redraw or restart the time trigger', (t) => {
    const value = config([rule('reading', 'activity', ['builtin:read'], { selection: selection({ presetMode: 'random', presetIds: ['golden', 'violet'] }) })])
    value.triggers.look.time = { enabled: true, mode: 'fixed', fixedMs: 1000, minMs: 1000, maxMs: 1000 }
    let draws = 0
    T.setRandom(() => { draws++; return 0 })
    activate(value, [call('one', 'read')])
    const count = draws, timer = T.triggerTimers.look, refreshedAt = T.eventState.lastRefresh
    t.mock.timers.tick(400)
    T.updateNativeActivity({ runningCalls: [call('one', 'read'), call('two', 'read')] }, 1)
    assert.equal(draws, count)
    assert.equal(T.triggerTimers.look, timer)
    assert.equal(T.eventState.lastRefresh, refreshedAt)
    t.mock.timers.tick(600)
    assert.equal(draws, count + 1, 'the original 1000ms deadline remains in effect')
  })

  test('same-turn running row remount cannot force execution text back to thinking before five seconds', (t) => {
    const value = config([
      rule('execution', 'activity', ['builtin:code'], { selection: selection({ fixedTextPresetId: 'exec-copy', textPresetIds: ['exec-copy'] }) }),
      rule('thinking', 'activity', ['builtin:waiting', 'builtin:thinking'], { selection: selection({ fixedTextPresetId: 'think-copy', textPresetIds: ['think-copy'] }) }),
    ], { textPresets: [{ id: 'exec-copy', name: 'Execute', texts: ['EXECUTING'] }, { id: 'think-copy', name: 'Think', texts: ['THINKING'] }] })
    value.eventRules.minRefreshMs = 5000
    const main = session('main', [call('program', 'run_code')]), env = services(main)
    const host = createCtx({ forms: { get: () => createForm({ flair: value }) }, sessions: env.sessions, uiConversation: env.ui })
    module.apply(host.ctx)
    try {
      assert.equal(host.locale.translate('chat', 'chat.deepDiving'), 'EXECUTING')
      const appliedAt = T.eventState.lastRefresh
      append(entry('step/start', { turn: 1, step: 1 }))
      t.mock.timers.tick(1000)
      dom.setRunning(false); dom.triggerMutations()
      main.target.emit(chatSnapshot([]))
      t.mock.timers.tick(50)
      dom.setRunning(true); dom.triggerMutations()
      assert.equal(host.locale.translate('chat', 'chat.deepDiving'), 'EXECUTING')
      assert.equal(T.eventState.ruleId, 'execution')
      assert.equal(T.eventState.lastRefresh, appliedAt)
      assert.equal(T.run.stepCount, 1, 'a row remount is not a new turn')
      t.mock.timers.tick(3949)
      assert.equal(host.locale.translate('chat', 'chat.deepDiving'), 'EXECUTING')
      t.mock.timers.tick(1)
      assert.equal(host.locale.translate('chat', 'chat.deepDiving'), 'THINKING')
    } finally { host.dispose() }
  })

  test('native turn end still cancels hidden-row timers, including turn zero', (t) => {
    const value = config([rule('execution', 'activity', ['builtin:code']), rule('thinking', 'activity', ['builtin:waiting'])])
    value.eventRules.minRefreshMs = 5000
    value.triggers.look.time = { enabled: true, mode: 'fixed', fixedMs: 1000, minMs: 1000, maxMs: 1000 }
    const main = session('main', [call('program', 'run_code', { turn: 0 })], 0), env = services(main)
    const host = createCtx({ forms: { get: () => createForm({ flair: value }) }, sessions: env.sessions, uiConversation: env.ui })
    module.apply(host.ctx)
    try {
      assert.equal(T.run.active, true)
      t.mock.timers.tick(1000)
      dom.setRunning(false); dom.triggerMutations()
      assert.equal(T.run.active, true, 'turn zero remains open while its row is hidden')
      main.openTurn.emit(undefined)
      main.change('append', [entry('turn/end', { turn: 0 })])
      assert.equal(T.run.active, false)
      assert.equal(T.triggerTimers.look, null)
      assert.equal(T.triggerTimers.text, null)
      t.mock.timers.tick(10000)
      assert.equal(T.run.active, false)
      assert.equal(T.readLabel({}), null)
    } finally { host.dispose() }
  })

  test('default rule refresh waits three seconds while explicit saved intervals remain valid', (t) => {
    assert.equal(T.normalizeEventRules().minRefreshMs, 3000)
    for (const interval of [0, 500, 1200, 2000, 3000, 5000]) assert.equal(T.normalizeEventRules({ minRefreshMs: interval }).minRefreshMs, interval)
    const value = config([
      rule('reading', 'activity', ['builtin:read']),
      rule('editing', 'activity', ['builtin:edit'], { selection: selection({ fixedPresetId: 'violet' }) }),
    ])
    delete value.eventRules.minRefreshMs
    activate(value, [call('read', 'read')])
    assert.equal(T.currentFlair().eventRules.minRefreshMs, 3000)
    t.mock.timers.tick(1000)
    T.updateNativeActivity(chatSnapshot([call('edit', 'edit')]), 1)
    assert.equal(T.eventState.ruleId, 'reading')
    t.mock.timers.tick(1999)
    assert.equal(T.eventState.ruleId, 'reading')
    t.mock.timers.tick(1)
    assert.equal(T.eventState.ruleId, 'editing')
    assert.equal(T.run.presetId, 'violet')
  })

  test('a config notification cannot briefly paint the base look while the row is still running', (t) => {
    const value = config([rule('reading', 'activity', ['builtin:read'], { selection: selection({ fixedPresetId: 'violet' }) })])
    value.selection = selection({ presetMode: 'random', presetIds: ['golden', 'terminal'] })
    activate(value, [call('read', 'read')])
    const painted = () => dom.document.documentElement.style.getPropertyValue('--dsh-sf-color')
    assert.equal(T.run.presetId, 'violet')
    const before = painted()
    // Settings mirror notifications arrive while the row stays mounted, even if
    // the plugin's own run flag was momentarily cleared.
    T.stopRun()
    T.applyFlair(value)
    assert.equal(painted(), before, 'must not paint the base look while the row is still mounted')
    assert.equal(T.run.presetId, 'violet')
  })

  test('activity rule changes respect minRefreshMs and apply the latest state', (t) => {
    const value = config([
      rule('reading', 'activity', ['builtin:read']),
      rule('editing', 'activity', ['builtin:edit'], { selection: selection({ fixedPresetId: 'violet' }) }),
    ])
    value.eventRules.minRefreshMs = 500
    activate(value, [call('one', 'read')])
    T.updateNativeActivity({ runningCalls: [call('two', 'edit')] }, 1)
    assert.equal(T.eventState.ruleId, 'reading')
    assert.equal(T.eventState.pending, true)
    t.mock.timers.tick(499)
    assert.equal(T.eventState.ruleId, 'reading')
    t.mock.timers.tick(1)
    assert.equal(T.eventState.ruleId, 'editing')
    assert.equal(T.run.presetId, 'violet')
  })

  test('switching rules resets the step-trigger baseline, not the session step count', () => {
    const textSelection = selection({ fixedTextPresetId: 'lines', textPresetIds: ['lines'], textMode: 'sequential' })
    const value = config([
      rule('reading', 'activity', ['builtin:read'], { selection: textSelection }),
      rule('editing', 'activity', ['builtin:edit'], { selection: textSelection }),
    ], { textPresets: [{ id: 'lines', name: 'Lines', texts: ['A', 'B', 'C'] }] })
    value.triggers.text.step = { enabled: true, every: 2 }
    activate(value, [call('read', 'read')])
    assert.equal(T.run.text, 'A')
    T.onStepStart(); T.onStepStart(); T.onStepStart()
    assert.equal(T.run.stepCount, 3)
    assert.equal(T.run.text, 'B')
    T.updateNativeActivity({ runningCalls: [call('edit', 'edit')] }, 1)
    assert.equal(T.eventState.stepOrigin, 3)
    assert.equal(T.run.stepCount, 3)
    assert.equal(T.run.text, 'A', 'each rule has its own sequential text scope')
    T.onStepStart()
    assert.equal(T.run.text, 'A')
    T.onStepStart()
    assert.equal(T.run.text, 'B')
  })

  test('enabled policies with no matching rule retain base draws across turns when turn triggers are off', () => {
    const value = config([rule('reading', 'activity', ['builtin:read'])], {
      textPresets: [{ id: 'base-lines', name: 'Base', texts: ['A', 'B'] }],
      selection: selection({ fixedTextPresetId: 'base-lines', textPresetIds: ['base-lines'], textMode: 'sequential' }),
    })
    value.triggers.look.turn.enabled = false
    value.triggers.text.turn.enabled = false
    activate(value, [], 0)
    assert.equal(T.eventState.ruleId, null)
    assert.equal(T.run.text, 'A')
    const key = T.eventState.policyKey
    T.consumeLiveChange({ kind: 'append', entries: [entry('turn/end', { turn: 0 })] })
    T.updateNativeActivity({ runningCalls: [] }, null)
    T.consumeLiveChange({ kind: 'append', entries: [entry('turn/start', { turn: 1 })] })
    T.updateNativeActivity({ runningCalls: [] }, 1)
    assert.equal(T.eventState.ruleId, null)
    assert.equal(T.eventState.policyKey, key)
    assert.equal(T.run.text, 'A')
  })

  test('a previous-turn matched rule cannot leak into the next turn base even with turn triggers off', () => {
    const value = config([rule('reading', 'activity', ['builtin:read'], {
      selection: selection({ fixedPresetId: 'violet', fixedTextPresetId: 'rule-lines', textPresetIds: ['rule-lines'], textMode: 'first' }),
    })], {
      textPresets: [
        { id: 'base-lines', name: 'Base', texts: ['Base'] },
        { id: 'rule-lines', name: 'Rule', texts: ['Rule'] },
      ],
      selection: selection({ fixedTextPresetId: 'base-lines', textPresetIds: ['base-lines'], textMode: 'first' }),
    })
    value.triggers.look.turn.enabled = false
    value.triggers.text.turn.enabled = false
    activate(value, [call('read-zero', 'read', { turn: 0 })], 0)
    assert.equal(T.run.presetId, 'violet')
    assert.equal(T.run.text, 'Rule')
    T.consumeLiveChange({ kind: 'append', entries: [entry('turn/end', { turn: 0 })] })
    T.updateNativeActivity({ runningCalls: [] }, null)
    T.updateNativeActivity({ runningCalls: [] }, 1)
    assert.equal(T.eventState.ruleId, null)
    assert.equal(T.run.presetId, 'golden')
    assert.equal(T.run.text, 'Base')
    assert.equal(T.effectiveFlair().selection.fixedPresetId, 'golden')
  })

  test('the same event rule is entered again in a new numeric turn', () => {
    const value = config([rule('reading', 'activity', ['builtin:read'], {
      selection: selection({ fixedTextPresetId: 'lines', textPresetIds: ['lines'], textMode: 'sequential' }),
    })], { textPresets: [{ id: 'lines', name: 'Lines', texts: ['A', 'B'] }] })
    value.triggers.text.turn.enabled = false
    activate(value, [call('zero', 'read', { turn: 0 })], 0)
    assert.equal(T.run.text, 'A')
    T.consumeLiveChange({ kind: 'append', entries: [entry('turn/end', { turn: 0 })] })
    T.updateNativeActivity({ runningCalls: [] }, null)
    T.updateNativeActivity({ runningCalls: [call('one', 'read')] }, 1)
    assert.equal(T.eventState.ruleId, 'reading')
    assert.equal(T.run.text, 'B')
  })

  test('watchMainSession borrows existing binding, target, openTurn and source snapshots', (t) => {
    T.applyFlair(config([rule('reading', 'activity', ['builtin:read'])]))
    const main = session('main', [call('read', 'read')]), background = session('background')
    const env = services(main, background)
    const off = T.watchMainSession(env.sessions, env.ui)
    t.after(off)
    assert.equal(T.eventState.sessionId, 'main')
    assert.equal(T.eventState.ruleId, 'reading')
    assert.deepEqual(env.bindings, ['main'])
    for (const observable of [env.list, main.source, main.target, main.openTurn]) {
      assert.equal(observable.size, 1)
      assert.ok(observable.reads > 0)
    }
    assert.equal(background.source.size, 0)
    assert.deepEqual(T.eventState.pulses, [], 'the initial history snapshot is never replayed')
    main.target.emit(chatSnapshot([call('edit', 'edit')]))
    assert.equal(T.eventState.ruleId, null)
    main.openTurn.emit(null)
    assert.equal(T.run.active, false)
    assert.equal(T.readLabel(), null)
  })

  test('mainView list changes are microtask-coalesced and release the old identity', async (t) => {
    T.applyFlair(config())
    const first = session('first', [call('a', 'read')]), second = session('second', [call('b', 'write')])
    const env = services(first, second)
    const off = T.watchMainSession(env.sessions, env.ui)
    t.after(off)
    env.list.emit({ byId: env.byId(null) })
    env.list.emit({ byId: env.byId('second') })
    assert.equal(T.eventState.sessionId, 'first')
    await Promise.resolve()
    assert.equal(T.eventState.sessionId, 'second')
    assert.deepEqual(env.bindings, ['first', 'second'])
    for (const observable of [first.source, first.target, first.openTurn]) assert.equal(observable.size, 0)
    assert.equal(second.source.size, 1)
    first.change('append', [result('a', true)])
    assert.deepEqual(T.eventState.pulses, [])
    env.list.emit({ byId: env.byId('second') })
    await Promise.resolve()
    assert.equal(second.source.subscriptions, 1, 'same binding is not subscribed twice')
    env.list.emit({ byId: {} })
    off()
    await Promise.resolve()
    assert.equal(second.source.size, 0)
    assert.equal(env.list.size, 0)
    assert.equal(T.eventState.available, false)
  })

  test('only fresh append revisions count steps; history prepend and replace do not replay pulses', (t) => {
    T.applyFlair(config())
    const main = session('main'), env = services(main)
    const off = T.watchMainSession(env.sessions, env.ui)
    t.after(off)
    main.change('append', [entry('step/start', { turn: 1 })])
    assert.equal(T.run.stepCount, 1)
    main.source.emit()
    main.target.emit()
    main.openTurn.emit()
    assert.equal(T.run.stepCount, 1)
    main.change('prepend', [entry('step/start', { turn: 1 }), result('history', true)])
    assert.equal(T.run.stepCount, 1)
    assert.deepEqual(T.eventState.pulses, [])
    main.change('append', [result('live', true)])
    assert.equal(T.eventState.pulses.length, 1)
    main.source.emit()
    assert.equal(T.eventState.pulses.length, 1)
    main.change('replace', [entry('step/start', { turn: 1 }), result('reconnect', true)])
    assert.equal(T.run.stepCount, 0)
    assert.deepEqual(T.eventState.pulses, [])
  })

  test('global step triggers still work on live source events when event rules are disabled', (t) => {
    const value = config([], {
      textPresets: [{ id: 'lines', name: 'Lines', texts: ['A', 'B', 'C'] }],
      selection: selection({ fixedTextPresetId: 'lines', textPresetIds: ['lines'], textMode: 'sequential' }),
    })
    value.eventRules.enabled = false
    value.triggers.text.step = { enabled: true, every: 2 }
    T.applyFlair(value)
    const main = session('zero', [], 0), env = services(main)
    const off = T.watchMainSession(env.sessions, env.ui)
    t.after(off)
    assert.equal(T.run.text, 'A')
    main.change('append', [entry('step/start', { turn: 0 })])
    assert.equal(T.run.text, 'A')
    main.change('append', [entry('step/start', { turn: 0 })])
    assert.equal(T.run.stepCount, 2)
    assert.equal(T.run.text, 'B')
    assert.equal(T.eventState.ruleId, null)
    main.source.emit()
    assert.equal(T.run.stepCount, 2)
  })

  test('tool names and exact-call completion survive target-first and source-first result notifications', (t) => {
    T.applyFlair(config())
    const tree = (aPhase, bPhase) => [call('parent', 'run_code', { subCalls: [
      call('a', 'read', { phase: aPhase }), call('b', 'write', { phase: bPhase }),
    ] })]
    const main = session('main', tree('preparing', 'start')), env = services(main)
    const off = T.watchMainSession(env.sessions, env.ui)
    t.after(off)
    main.target.emit(chatSnapshot(tree('result', 'start')))
    main.change('append', [result('a', true)])
    assert.deepEqual(T.eventState.calls.map((c) => c.id), ['parent', 'b'])
    assert.equal(T.eventState.pulses[0].name, 'read')
    main.change('append', [entry('tool/ptc-dispatch', { subCallId: 'b', isError: false })])
    main.target.emit(chatSnapshot(tree('result', 'result')))
    assert.deepEqual(T.eventState.calls.map((c) => c.id), ['parent'])
    assert.deepEqual(T.eventState.pulses.map((p) => [p.name, p.event]), [['read', 'tool-error'], ['write', 'tool-success']])
  })

  test('replace and revision gaps restore current native snapshots without requiring target notifications', (t) => {
    T.applyFlair(config([
      rule('reading', 'activity', ['builtin:read']),
      rule('editing', 'activity', ['builtin:edit'], { selection: selection({ fixedPresetId: 'violet' }) }),
    ]))
    const main = session('main', [call('a', 'read')]), env = services(main)
    const off = T.watchMainSession(env.sessions, env.ui)
    t.after(off)
    assert.equal(T.eventState.ruleId, 'reading')
    main.change('append', [entry('step/start', { turn: 1 }), result('a', true)])
    main.target.set(chatSnapshot([call('b', 'edit', { phase: 'preparing' })]))
    main.change('replace', [result('history', true)])
    assert.equal(T.eventState.ruleId, 'editing')
    assert.equal(T.run.presetId, 'violet')
    assert.deepEqual(T.eventState.calls.map((c) => c.id), ['b'])
    assert.equal(T.run.stepCount, 0)
    assert.deepEqual(T.eventState.pulses, [])
    main.target.set(chatSnapshot([call('c', 'read')]))
    main.change('append', [result('missed', true)], main.source.getSnapshot().revision + 2)
    assert.equal(T.eventState.ruleId, 'reading')
    assert.deepEqual(T.eventState.calls.map((c) => c.id), ['c'])
    assert.deepEqual(T.eventState.pulses, [])
  })

  test('a source revision gap clears transient pulses and step baselines without replaying the tail', (t) => {
    T.applyFlair(config())
    const main = session('main'), env = services(main)
    const off = T.watchMainSession(env.sessions, env.ui)
    t.after(off)
    main.change('append', [entry('step/start', { turn: 1 }), result('live', true)])
    assert.equal(T.run.stepCount, 1)
    assert.equal(T.eventState.pulses.length, 1)
    main.change('append', [entry('step/start', { turn: 1 }), result('missed', true)], main.source.getSnapshot().revision + 2)
    assert.equal(T.run.stepCount, 0)
    assert.equal(T.eventState.stepOrigin, 0)
    assert.deepEqual(T.eventState.pulses, [])
  })

  const fallbackValue = () => config([rule('reading', 'activity', ['builtin:read'], {
    selection: selection({ fixedPresetId: 'violet', fixedTextPresetId: 'rule-copy' }),
  })], {
    textPresets: [
      { id: 'base-copy', name: 'Base', texts: ['Global fallback'] },
      { id: 'rule-copy', name: 'Rule', texts: ['Rule copy'] },
    ],
    selection: selection({ fixedTextPresetId: 'base-copy', textMode: 'first' }),
  })
  const assertFallback = (main, env) => {
    assert.equal(T.eventState.available, false)
    assert.equal(T.eventState.ruleId, null)
    for (const source of [main.target, main.openTurn, main.source]) assert.equal(source.size, 0)
    assert.equal(env.list.size, 1, 'the owned list listener remains available for capability recovery')
    assert.equal(T.readLabel(), 'Global fallback')
    assert.equal(T.run.presetId, 'golden')
  }

  test('missing or incomplete event capabilities degrade without taking partial subscriptions', () => {
    const cases = [
      (main) => { delete main.binding.eventSource },
      (main) => { main.binding.eventSource = { subscribe() {} } },
      (main) => { main.binding.eventSource = { getSnapshot() { return { revision: 1 } } } },
      (main) => { main.conversation.target = () => undefined },
      (main) => { delete main.conversation.openTurn },
    ]
    for (const damage of cases) {
      T.resetRun()
      T.applyFlair(fallbackValue())
      const main = session('main', [call('read', 'read')]), env = services(main)
      damage(main)
      let off
      assert.doesNotThrow(() => { off = T.watchMainSession(env.sessions, env.ui) })
      try { assertFallback(main, env) } finally { off() }
      assert.equal(env.list.size, 0)
      assert.equal(main.target.subscriptions, 0, 'capabilities are checked before subscribing')
      assert.equal(main.openTurn.subscriptions, 0)
    }
  })

  for (const failing of ['openTurn', 'source']) {
    test('a throwing ' + failing + ' subscription rolls back all prior binding subscriptions', () => {
      T.applyFlair(fallbackValue())
      const main = session('main', [call('read', 'read')]), env = services(main)
      main[failing].subscribe = () => { throw new Error('subscription unavailable') }
      let off
      assert.doesNotThrow(() => { off = T.watchMainSession(env.sessions, env.ui) })
      try {
        assertFallback(main, env)
        assert.equal(main.target.subscriptions, 1)
        if (failing === 'source') assert.equal(main.openTurn.subscriptions, 1)
      } finally { off() }
      assert.equal(env.list.size, 0)
    })
  }

  for (const failing of ['source', 'target', 'openTurn']) {
    test('an initial throwing ' + failing + ' snapshot read degrades and releases partial ownership', () => {
      T.applyFlair(fallbackValue())
      const main = session('main', [call('read', 'read')]), env = services(main)
      main[failing].getSnapshot = () => { throw new Error('snapshot unavailable') }
      let off
      assert.doesNotThrow(() => { off = T.watchMainSession(env.sessions, env.ui) })
      try { assertFallback(main, env) } finally { off() }
      assert.equal(env.list.size, 0)
    })
  }

  for (const failing of ['source', 'target', 'openTurn']) {
    test('a live throwing ' + failing + ' snapshot releases the binding and recovers on the same identity', async () => {
      T.applyFlair(fallbackValue())
      const main = session('main', [call('read', 'read')]), env = services(main)
      const off = T.watchMainSession(env.sessions, env.ui)
      try {
        assert.equal(T.eventState.ruleId, 'reading')
        assert.equal(T.readLabel(), 'Rule copy')
        const read = main[failing].getSnapshot
        main[failing].getSnapshot = () => { throw new Error('live snapshot unavailable') }
        assert.doesNotThrow(() => main[failing].emit())
        assertFallback(main, env)
        main[failing].getSnapshot = read
        env.list.emit()
        await Promise.resolve()
        assert.equal(T.eventState.available, true)
        assert.equal(T.eventState.ruleId, 'reading')
        assert.equal(T.readLabel(), 'Rule copy')
        for (const source of [main.source, main.target, main.openTurn]) assert.equal(source.size, 1)
      } finally { off() }
      for (const source of [env.list, main.source, main.target, main.openTurn]) assert.equal(source.size, 0)
    })
  }

  test('list snapshot and subscription failures remain nonthrowing and retain no abandoned ownership', async () => {
    T.applyFlair(fallbackValue())
    const main = session('main', [call('read', 'read')]), env = services(main)
    const off = T.watchMainSession(env.sessions, env.ui)
    try {
      const read = env.list.getSnapshot
      env.list.getSnapshot = () => { throw new Error('list snapshot unavailable') }
      env.list.emit()
      await Promise.resolve()
      assertFallback(main, env)
      env.list.getSnapshot = read
      env.list.emit()
      await Promise.resolve()
      assert.equal(T.eventState.available, true)
    } finally { off() }
    for (const source of [env.list, main.source, main.target, main.openTurn]) assert.equal(source.size, 0)
    env.list.subscribe = () => { throw new Error('list subscription unavailable') }
    let failedOff
    assert.doesNotThrow(() => { failedOff = T.watchMainSession(env.sessions, env.ui) })
    assert.equal(T.eventState.available, false)
    for (const source of [env.list, main.source, main.target, main.openTurn]) assert.equal(source.size, 0)
    failedOff()
  })

  test('output phases are configurable without changing the 14 native tool categories', () => {
    const value = config(phaseRules(), { eventGroups: [{ id: 'output', kind: 'activity', activityKinds: ['waiting', 'thinking', 'responding', 'invalid'] }] })
    assert.deepEqual(T.normalizeFlair(value).eventGroups[0].activityKinds, ['waiting', 'thinking', 'responding'])
    assert.equal(T.ACTIVITY_KINDS.length, 14)
    assert.equal(T.MATCH_ACTIVITY_KINDS.length, 16)
    activate(value)
    assert.equal(T.eventState.phase, 'waiting')
    assert.equal(T.eventState.ruleId, 'waiting')
  })

  test('historical partial blocks never prove current reasoning or replying', () => {
    activate(config(phaseRules()))
    T.updateNativeActivity({ runningCalls: [], partial: { turn: 1, step: 1, blocks: [{ kind: 'reasoning', text: 'old reasoning' }, { kind: 'text', text: 'old response' }] } }, 1)
    assert.equal(T.eventState.phase, 'waiting')
    assert.equal(T.eventState.ruleId, 'waiting')
  })

  test('nonblank live deltas start phases; block end and finish return to waiting', () => {
    activate(config(phaseRules()))
    append(live('a', { type: 'block-start', index: 0, blockType: 'reasoning' }))
    append(live('a', { type: 'reasoning-delta', index: 0, text: '  ' }))
    assert.equal(T.eventState.phase, 'waiting')
    append(live('a', { type: 'reasoning-delta', index: 0, text: 'reasoning' }))
    assert.equal(T.eventState.ruleId, 'thinking')
    append(live('a', { type: 'block-end', index: 0 }))
    assert.equal(T.eventState.ruleId, 'waiting')
    append(live('a', { type: 'block-start', index: 1, blockType: 'text' }), live('a', { type: 'text-delta', index: 1, text: '\n' }))
    assert.equal(T.eventState.phase, 'waiting')
    append(live('a', { type: 'text-delta', index: 1, text: 'visible reply' }))
    assert.equal(T.eventState.ruleId, 'responding')
    assert.deepEqual(T.eventState.output.blocks.get(1), { kind: 'text', visible: true }, 'do not retain model text')
    append(live('a', { type: 'finish' }))
    assert.equal(T.eventState.ruleId, 'waiting')
    append(live('a', { type: 'text-delta', index: 1, text: 'late after finish' }))
    assert.equal(T.eventState.phase, 'waiting')
  })

  test('output follows recent deltas, not array order or an older block end', () => {
    activate(config(phaseRules()))
    append(live('a', { type: 'reasoning-delta', index: 8, text: 'reason' }))
    append(live('a', { type: 'text-delta', index: 2, text: 'reply' }))
    append(live('a', { type: 'block-end', index: 8 }))
    assert.equal(T.eventState.phase, 'responding')
    append(live('a', { type: 'block-end', index: 2 }))
    assert.equal(T.eventState.phase, 'waiting')
    append(live('a', { type: 'text-delta', index: 2, text: 'late ended block' }))
    assert.equal(T.eventState.phase, 'waiting')
    append(live('a', { type: 'block-start', index: 3, blockType: 'text' }), live('a', { type: 'text-delta', index: 3, text: 'fresh' }))
    assert.equal(T.eventState.phase, 'responding')
  })

  test('tools and non-text blocks are not reply evidence; existing tool rules remain effective', () => {
    activate(config([rule('reading', 'activity', ['builtin:read']), ...phaseRules()]))
    append(live('a', { type: 'text-delta', index: 0, text: 'reply' }), live('a', { type: 'usage', usage: {} }))
    assert.equal(T.eventState.phase, 'responding')
    T.updateNativeActivity({ runningCalls: [call('read', 'read')] }, 1)
    assert.equal(T.eventState.ruleId, 'reading')
    append(live('a', { type: 'tool-call-delta', index: 1, name: 'read' }))
    assert.equal(T.eventState.phase, 'waiting')
    T.updateNativeActivity({ runningCalls: [] }, 1)
    assert.equal(T.eventState.ruleId, 'waiting')
    append(live('a', { type: 'block-start', index: 2, blockType: 'image' }))
    assert.equal(T.eventState.phase, 'waiting')
  })

  test('new steps and retries reset output and reject old attempts and steps', () => {
    activate(config(phaseRules()))
    append(entry('step/start', { turn: 1, step: 0 }), live('old', { type: 'text-delta', index: 0, text: 'reply' }, 0))
    assert.equal(T.eventState.phase, 'responding')
    append(entry('llm/retry', { turn: 1, step: 0 }))
    assert.equal(T.eventState.phase, 'waiting')
    append(live('old', { type: 'text-delta', index: 0, text: 'late' }, 0))
    assert.equal(T.eventState.phase, 'waiting')
    append(entry('llm/retry-started', { turn: 1, step: 0 }), live('new', { type: 'reasoning-delta', index: 0, text: 'reason' }, 0))
    assert.equal(T.eventState.phase, 'thinking')
    append(entry('step/start', { turn: 1, step: 1 }))
    assert.equal(T.eventState.phase, 'waiting')
    append(live('new', { type: 'text-delta', index: 1, text: 'previous step' }, 0))
    assert.equal(T.eventState.phase, 'waiting')
    append(live('next', { type: 'text-delta', index: 0, text: 'next reply' }, 1))
    assert.equal(T.eventState.phase, 'responding')
    append(entry('step/end', { turn: 1, step: 1 }))
    assert.equal(T.eventState.phase, 'waiting')
  })

  test('assistant settlement and abandonment end output before the turn ends', () => {
    for (const type of ['assistant/message', 'assistant/attempt']) {
      activate(config(phaseRules()))
      append(live(type, { type: 'text-delta', index: 0, text: 'reply' }))
      append(entry(type, { turn: 1, step: 1 }))
      assert.equal(T.eventState.ruleId, 'waiting', type)
      append(live(type, { type: 'text-delta', index: 0, text: 'late' }))
      assert.equal(T.eventState.phase, 'waiting')
    }
    activate(config(phaseRules()))
    append(live('abandoned', { type: 'text-delta', index: 0, text: 'reply' }))
    T.consumeLiveChange({ kind: 'settle-assistant', attemptId: 'abandoned' })
    assert.equal(T.eventState.phase, 'waiting')
  })

  test('settling an older attempt cannot clear the new attempt output', () => {
    activate(config(phaseRules()))
    append(live('old', { type: 'text-delta', index: 0, text: 'old' }))
    append(live('new', { type: 'reasoning-delta', index: 0, text: 'new' }))
    T.consumeLiveChange({ kind: 'settle-assistant', attemptId: 'old', entry: entry('assistant/attempt', { turn: 1, step: 1 }) })
    assert.equal(T.eventState.phase, 'thinking')
    append(live('old', { type: 'text-delta', index: 0, text: 'late old' }))
    assert.equal(T.eventState.phase, 'thinking')
  })

  test('only live phases count; history, replacement, gaps and stale snapshots never revive replies', () => {
    T.applyFlair(config(phaseRules()))
    const main = session('main'), env = services(main)
    const off = T.watchMainSession(env.sessions, env.ui)
    try {
      main.change('prepend', [live('historical', { type: 'text-delta', index: 0, text: 'history' })])
      assert.equal(T.eventState.phase, 'waiting')
      main.change('append', [live('active', { type: 'text-delta', index: 0, text: 'new reply' })])
      assert.equal(T.eventState.ruleId, 'responding')
      main.target.set(chatSnapshot([], { partial: { turn: 1, step: 1, blocks: [{ kind: 'text', text: 'old' }] } }))
      main.change('replace', [live('active', { type: 'text-delta', index: 0, text: 'replayed' })])
      assert.equal(T.eventState.phase, 'waiting')
      main.target.emit()
      assert.equal(T.eventState.phase, 'waiting')
      main.change('append', [live('active', { type: 'reasoning-delta', index: 1, text: 'fresh reasoning' })])
      assert.equal(T.eventState.phase, 'thinking')
      main.change('append', [live('active', { type: 'text-delta', index: 2, text: 'gap' })], main.source.getSnapshot().revision + 2)
      assert.equal(T.eventState.phase, 'waiting')
    } finally { off() }
  })

  test('turn and main-session changes clear replies, including turn zero', async () => {
    T.applyFlair(config(phaseRules()))
    const a = session('a', [], 0), b = session('b'), env = services(a, b)
    const off = T.watchMainSession(env.sessions, env.ui)
    try {
      a.change('append', [live('zero', { type: 'text-delta', index: 0, text: 'reply' }, 0, 0)])
      assert.equal(T.eventState.phase, 'responding')
      a.change('append', [live('wrong-turn', { type: 'reasoning-delta', index: 1, text: 'ignored' }, 1, 7)])
      assert.equal(T.eventState.phase, 'responding')
      env.list.emit({ byId: env.byId('b') })
      await Promise.resolve()
      assert.equal(T.eventState.phase, 'waiting')
      a.change('append', [live('old-session', { type: 'text-delta', index: 0, text: 'ignored' })])
      assert.equal(T.eventState.phase, 'waiting')
      b.change('append', [live('b', { type: 'reasoning-delta', index: 0, text: 'reason' })])
      assert.equal(T.eventState.phase, 'thinking')
      b.change('append', [entry('turn/end', { turn: 1 })])
      assert.equal(T.eventState.phase, 'waiting')
      assert.equal(T.eventState.turn, null)
    } finally { off() }
  })

  test('whitespace cannot reactivate an earlier visible block after another phase took over', () => {
    activate(config(phaseRules()))
    append(live('a', { type: 'text-delta', index: 0, text: 'reply' }))
    append(live('a', { type: 'tool-call-delta', index: 1, name: 'read' }))
    assert.equal(T.eventState.phase, 'waiting')
    append(live('a', { type: 'text-delta', index: 0, text: ' \n' }))
    assert.equal(T.eventState.phase, 'waiting')
    append(live('a', { type: 'reasoning-delta', index: 2, text: 'reason' }))
    append(live('a', { type: 'text-delta', index: 0, text: '  ' }))
    assert.equal(T.eventState.phase, 'thinking')
  })

  test('edited historical messages and explicitly old durable attempts cannot end fresh output', () => {
    activate(config(phaseRules()))
    append(live('new', { type: 'reasoning-delta', index: 0, text: 'reason' }))
    append({ type: 'event', event: { type: 'assistant/message', surfaceOp: 'replace', data: { turn: 1, step: 1 } } })
    assert.equal(T.eventState.phase, 'thinking')
    append(entry('assistant/attempt', { turn: 1, step: 1, attemptId: 'old' }))
    assert.equal(T.eventState.phase, 'thinking')
    append(entry('assistant/message', { turn: 1, step: 1, attemptId: 'new' }))
    assert.equal(T.eventState.phase, 'waiting')
  })

  test('backward source revisions cannot lower the live watermark or replay old output', () => {
    T.applyFlair(config(phaseRules()))
    const main = session('main'), env = services(main)
    main.source.set({ revision: 10, change: { kind: 'replace', entries: [] } })
    const off = T.watchMainSession(env.sessions, env.ui)
    try {
      main.change('append', [live('active', { type: 'text-delta', index: 0, text: 'current' })], 11)
      assert.equal(T.eventState.phase, 'responding')
      main.change('append', [live('old', { type: 'reasoning-delta', index: 0, text: 'stale' })], 8)
      main.change('append', [live('old', { type: 'text-delta', index: 0, text: 'stale' })], 9)
      assert.equal(T.eventState.output.attemptId, 'active')
      assert.equal(T.eventState.phase, 'responding')
      main.change('append', [live('active', { type: 'finish' })], 12)
      assert.equal(T.eventState.phase, 'waiting')
      main.change('append', [live('old', { type: 'text-delta', index: 0, text: 'stale' })], 9)
      main.change('append', [live('old', { type: 'text-delta', index: 0, text: 'stale' })], 10)
      assert.equal(T.eventState.phase, 'waiting')
      main.change('append', [live('fresh', { type: 'reasoning-delta', index: 0, text: 'new' })], 13)
      assert.equal(T.eventState.phase, 'thinking')
    } finally { off() }
  })

  test('resync retains finished-attempt tombstones while allowing the current live attempt to continue', () => {
    for (const kind of ['replace', 'gap']) {
      T.resetEventSession()
      T.applyFlair(config(phaseRules()))
      const main = session('main'), env = services(main)
      const off = T.watchMainSession(env.sessions, env.ui)
      try {
        main.change('append', [live('old', { type: 'text-delta', index: 0, text: 'old' }), live('old', { type: 'finish' })])
        assert.equal(T.eventState.phase, 'waiting')
        main.change('append', [live('active', { type: 'reasoning-delta', index: 0, text: 'current' })])
        assert.equal(T.eventState.phase, 'thinking')
        if (kind === 'replace') main.change('replace', [])
        else main.change('append', [], main.source.getSnapshot().revision + 2)
        assert.equal(T.eventState.phase, 'waiting')
        assert.ok(T.eventState.output.closedAttempts.has('old'))
        main.change('append', [live('active', { type: 'text-delta', index: 1, text: 'fresh continuation' })])
        assert.equal(T.eventState.phase, 'responding')
        main.change('append', [live('old', { type: 'finish' }), live('old', { type: 'text-delta', index: 0, text: 'late old' })])
        assert.equal(T.eventState.phase, 'responding')
        main.change('append', [live('new', { type: 'reasoning-delta', index: 0, text: 'new attempt' })])
        main.change('append', [live('active', { type: 'finish' })])
        assert.equal(T.eventState.phase, 'thinking')
      } finally { off() }
    }
  })

  test('same-phase tokens do not resample or restart rotation timers', () => {
    const value = config([rule('reply', 'activity', ['builtin:responding'], { selection: selection({ presetMode: 'random', presetIds: ['golden', 'violet'] }) })])
    value.triggers.look.time = { enabled: true, mode: 'fixed', fixedMs: 1000, minMs: 1000, maxMs: 1000 }
    let draws = 0
    T.setRandom(() => { draws++; return 0 })
    activate(value)
    append(live('a', { type: 'text-delta', index: 0, text: 'first' }))
    const count = draws, timer = T.triggerTimers.look, refreshedAt = T.eventState.lastRefresh
    append(live('a', { type: 'text-delta', index: 0, text: ' second' }), live('a', { type: 'text-delta', index: 0, text: ' third' }))
    assert.equal(draws, count)
    assert.equal(T.triggerTimers.look, timer)
    assert.equal(T.eventState.lastRefresh, refreshedAt)
  })

  test('plugin disposal releases source subscriptions and cancels trigger/pulse timers and queued work', async (t) => {
    const value = config([
      rule('failure', 'pulse', ['builtin:tool-error'], { selection: selection({ fixedPresetId: 'violet' }) }),
      rule('idle', 'activity', ['builtin:waiting']),
    ])
    value.triggers.look.time = { enabled: true, mode: 'fixed', fixedMs: 1000, minMs: 1000, maxMs: 1000 }
    const main = session('main'), env = services(main)
    const form = createForm({ flair: value })
    const host = createCtx({ forms: { get: () => form }, sessions: env.sessions, uiConversation: env.ui })
    module.apply(host.ctx)
    main.change('append', [result('live', true)])
    assert.equal(T.eventState.ruleId, 'failure')
    assert.notEqual(T.triggerTimers.look, null)
    const dictionariesBefore = host.dictionaries.length
    env.list.emit({ byId: {} })
    host.dispose()
    await Promise.resolve()
    for (const observable of [env.list, main.source, main.target, main.openTurn]) assert.equal(observable.size, 0)
    assert.equal(T.triggerTimers.look, null)
    assert.equal(T.triggerTimers.text, null)
    assert.equal(T.run.active, false)
    assert.equal(dom.attrs.has(T.ACTIVE_ATTR), false)
    t.mock.timers.tick(60000)
    main.change('append', [result('after-dispose', true)])
    form.push({ flair: value })
    await Promise.resolve()
    assert.equal(T.run.active, false)
    assert.equal(T.readLabel(), null)
    assert.equal(host.dictionaries.length, dictionariesBefore, 'queued label invalidations do not register after disposal')
  })
})
