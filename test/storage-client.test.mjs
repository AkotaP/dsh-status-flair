import test from 'node:test'
import assert from 'node:assert/strict'
import { loadClient, createForm } from './support/harness.mjs'

const { module } = await loadClient()
const T = module.__test
const clone = (v) => JSON.parse(JSON.stringify(v))
const flair = (patch = {}) => ({ ...clone(T.DEFAULT_FLAIR), ...patch })
const ready = (revision = 'r1', data = flair(), storage = {}) => ({
  status: 'ready', writable: true, revision, value: { flair: data },
  storage: { mode: 'file', profile: 'test', backupAvailable: true, cleanupPending: false, ...storage },
})
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const fail = (code, message = code) => Object.assign(new Error(message), { code })

// Each test owns its source and stops it: no real fetch, timers, profile or files.
test('opening independent storage only loads; migration requires an explicit call', async () => {
  const calls = []
  const source = T.createStorageForm({ pollMs: 0, request: async (p) => {
    calls.push(p)
    return p.action === 'load' ? ready('legacy-token', flair(), { mode: 'legacy' }) : ready('file-token')
  } })
  try {
    await source.start()
    assert.deepEqual(calls.map((p) => p.action), ['load'])
    assert.equal(source.getSnapshot().storage.available, true)
    await source.migrate('legacy-token')
    assert.equal(calls[1].action, 'migrate')
    assert.equal(calls[1].confirmed, true)
    assert.equal(calls[1].expectedRevision, 'legacy-token')
    assert.equal('flair' in calls[1], false, 'migration cannot submit an unsaved draft')
  } finally { source.stop() }
})

test('save transmits the draft baseline and conflicts never silently retry with the latest revision', async () => {
  const calls = []
  let reads = 0
  const source = T.createStorageForm({ pollMs: 0, request: async (p) => {
    calls.push(p)
    if (p.action === 'load') return ready(++reads === 1 ? 'r1' : 'r2', flair({ enabled: false }))
    throw fail('conflict')
  } })
  try {
    await source.start()
    await assert.rejects(source.save(flair(), 'r1'), { code: 'conflict' })
    assert.equal(source.getSnapshot().revision, 'r2')
    assert.equal(calls.filter((p) => p.action === 'save').length, 1)
    assert.equal(calls.find((p) => p.action === 'save').expectedRevision, 'r1')
  } finally { source.stop() }
})

test('a lost acknowledgement is recognized by the exact committed operation id without a duplicate write', async () => {
  let stored = ready(), writes = 0
  const source = T.createStorageForm({ pollMs: 0, request: async (p) => {
    if (p.action === 'load') return stored
    writes++
    stored = { ...ready('r2', p.flair), lastOperationId: p.operationId }
    throw new Error('connection lost after commit')
  } })
  try {
    await source.start()
    const saved = await source.save(flair({ enabled: false }), 'r1')
    assert.equal(saved.revision, 'r2')
    assert.equal(saved.value.flair.enabled, false)
    assert.equal(writes, 1)
  } finally { source.stop() }
})

test('a delayed pre-save load cannot overwrite the accepted save response', async () => {
  const delayed = deferred()
  let reads = 0
  const source = T.createStorageForm({ pollMs: 0, request: async (p) => {
    if (p.action === 'save') return ready('r2', p.flair)
    return ++reads === 1 ? ready() : delayed.promise
  } })
  try {
    await source.start()
    const pending = source.refresh()
    await source.save(flair({ enabled: false }), 'r1')
    delayed.resolve(ready())
    await pending
    assert.equal(source.getSnapshot().revision, 'r2')
    assert.equal(source.getSnapshot().value.flair.enabled, false)
  } finally { source.stop() }
})

test('same-revision polling can update cleanup metadata without replacing the data', async () => {
  let reads = 0
  const source = T.createStorageForm({ pollMs: 0, request: async () => ++reads === 1
    ? ready('r1', flair(), { cleanupPending: true })
    : { unchanged: true, revision: 'r1', storage: { mode: 'file', cleanupPending: false } } })
  try {
    await source.start()
    const value = source.getSnapshot().value
    await source.refresh()
    assert.equal(source.getSnapshot().storage.cleanupPending, false)
    assert.equal(source.getSnapshot().value, value)
  } finally { source.stop() }
})

test('corrupt independent data never falls back to writable legacy defaults', async () => {
  const legacy = createForm({ flair: flair() }), calls = []
  const source = T.createStorageForm({ pollMs: 0, legacyForm: legacy, request: async (p) => { calls.push(p); throw fail('storage-corrupt') } })
  try {
    await source.start()
    assert.equal(source.getSnapshot().status, 'error')
    assert.equal(source.getSnapshot().writable, false)
    await assert.rejects(source.save(flair(), 'r1'), { code: 'storage-unavailable' })
    assert.deepEqual(calls.map((p) => p.action), ['load'])
    assert.equal(legacy.writes.length, 0)
  } finally { source.stop() }
})

test('only a genuinely unavailable old host falls back to its legacy form', async () => {
  const legacy = createForm({ flair: flair() })
  const source = T.createStorageForm({ pollMs: 0, legacyForm: legacy, request: async () => { throw fail('storage-api-unavailable') } })
  try {
    await source.start()
    assert.equal(source.getSnapshot().storage.available, false)
    await source.save(flair({ enabled: false }), 1)
    assert.equal(legacy.writes.length, 1)
    await assert.rejects(source.save(flair(), 1), { code: 'conflict' })
    assert.equal(legacy.writes.length, 1)
    await assert.rejects(source.migrate(source.getSnapshot().revision), { code: 'storage-api-unavailable' })
  } finally { source.stop() }
})

test('network failure retains accepted data read-only, and a successful reread restores availability', async () => {
  let reads = 0
  const source = T.createStorageForm({ pollMs: 0, request: async () => {
    reads++
    if (reads === 2) throw new Error('offline')
    return reads === 1 ? ready() : { unchanged: true, revision: 'r1', storage: { mode: 'file' } }
  } })
  try {
    await source.start()
    const data = source.getSnapshot().value
    await source.refresh()
    assert.equal(source.getSnapshot().status, 'error')
    assert.equal(source.getSnapshot().value, data)
    assert.equal(source.getSnapshot().writable, false)
    await source.refresh()
    assert.equal(source.getSnapshot().status, 'ready')
    assert.equal(source.getSnapshot().writable, true)
  } finally { source.stop() }
})

test('disposal clears polling and ignores a late initial response', async () => {
  const pending = deferred(), timers = new Map()
  let id = 0, notices = 0
  const source = T.createStorageForm({ request: () => pending.promise,
    setTimer(fn) { timers.set(++id, fn); return id }, clearTimer(key) { timers.delete(key) } })
  source.subscribe(() => notices++)
  const started = source.start()
  source.stop()
  pending.resolve(ready())
  await started
  assert.equal(source.getSnapshot().status, 'loading')
  assert.equal(notices, 0)
  assert.equal(timers.size, 0)
})

test('disposing during save does not publish or restart polling after the response', async () => {
  const pending = deferred(), timers = new Map()
  let id = 0
  const source = T.createStorageForm({ request: (p) => p.action === 'load' ? Promise.resolve(ready()) : pending.promise,
    setTimer(fn) { timers.set(++id, fn); return id }, clearTimer(key) { timers.delete(key) } })
  await source.start()
  const saving = source.save(flair({ enabled: false }), 'r1')
  source.stop()
  pending.resolve(ready('r2', flair({ enabled: false })))
  await assert.rejects(saving, { code: 'closed' })
  assert.equal(source.getSnapshot().revision, 'r1')
  assert.equal(timers.size, 0)
})
