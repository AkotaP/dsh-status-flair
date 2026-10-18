/** All filesystem fixtures are disposable temporary profiles, never real DSH data. */
import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Config, FlairSchema, DEFAULT_FLAIR, createStorageApi, apply } from '../lib/index.js'
import { FlairFileStore, SETTINGS_FORMAT, cloneJson, fingerprint } from '../lib/storage.js'

const legacyRaw = () => ({ enabled: true, presets: [{ id: 'legacy', name: 'Legacy', texts: ['old inline text'], style: { color: '#123456' } }], extraRawField: { preserved: true }, eventRules: { rules: [] } })
async function fixture(t, options = {}) {
  const dir = await fs.mkdtemp(join(tmpdir(), 'dsh-flair-test-'))
  const fiber = {}
  const entry = { fiber, options: { id: 'status-flair', config: { untouched: { keep: true }, ...(options.raw === null ? {} : { flair: cloneJson(options.raw ?? legacyRaw()) }), storage: options.mode ?? 'auto' } } }
  const editor = { calls: 0, entries: () => [entry], async edit(owner, change) {
    assert.equal(owner, entry)
    this.calls++
    entry.options.config = change(cloneJson(entry.options.config), cloneJson(options.inherited ?? {}))
  } }
  const profile = { dir, name: 'temporary-profile', home: '/not-used' }
  const config = Config(cloneJson(entry.options.config))
  const api = createStorageApi({ profile, config, editor, ownerFiber: fiber, fs: options.fs })
  t.after(async () => { await api.close(); await fs.rm(dir, { recursive: true, force: true }) })
  return { dir, profile, fiber, entry, editor, config, api, path: api.store.path }
}
const save = (api, revision, operationId, flair = DEFAULT_FLAIR) => api.request({ action: 'save', flair, expectedRevision: revision, operationId })
const migrate = (api, revision, operationId) => api.request({ action: 'migrate', expectedRevision: revision, operationId, confirmed: true })
const hasCode = (code) => (error) => error?.code === code

test('construction, load, conditional load and backup are read-only and profile-scoped', async (t) => {
  const f = await fixture(t)
  assert.deepEqual(await fs.readdir(f.dir), [])
  const initial = await f.api.request({ action: 'load', profile: 'untrusted', path: '/ignored' })
  assert.equal(initial.storage.mode, 'legacy')
  assert.equal(initial.storage.profile, 'temporary-profile')
  assert.equal(initial.storage.path, join(f.dir, 'dsh-status-flair', 'settings.json'))
  assert.equal(initial.storage.backupAvailable, false)
  assert.match(initial.revision, /^legacy:/)
  const unchanged = await f.api.request({ action: 'load', ifRevision: initial.revision })
  assert.equal(unchanged.unchanged, true)
  assert.deepEqual(unchanged.storage, initial.storage)
  assert.deepEqual((await f.api.request({ action: 'backup' })).legacy.rawFlair, legacyRaw(), 'export before migration also preserves original legacy data without a write')
  assert.deepEqual(await fs.readdir(f.dir), [], 'reads must not mkdir or persist legacy data')
  assert.throws(() => new FlairFileStore({ profile: { dir: '../untrusted', name: 'x' } }), hasCode('storage-unavailable'))
})

test('no legacy config loads defaults without writes, while explicit file mode cannot resurrect legacy', async (t) => {
  const f = await fixture(t, { raw: null })
  const initial = await f.api.request({ action: 'load' })
  assert.equal(initial.storage.mode, 'defaults')
  assert.deepEqual(initial.value.flair, DEFAULT_FLAIR)
  assert.deepEqual(await fs.readdir(f.dir), [])
  const missing = await fixture(t, { mode: 'file' })
  await assert.rejects(missing.api.request({ action: 'load' }), hasCode('missing-file'))
  assert.deepEqual(await fs.readdir(missing.dir), [])
})

test('first explicit save stores original raw and effective legacy backups; future saves cannot replace them', async (t) => {
  const f = await fixture(t)
  const original = cloneJson(f.entry.options.config.flair)
  const initial = await f.api.request({ action: 'load' })
  const saved = await save(f.api, initial.revision, 'save-one')
  assert.equal(saved.storage.mode, 'file')
  assert.equal(saved.storage.backupAvailable, true)
  assert.equal(saved.storage.cleanupPending, true)
  assert.equal(saved.lastOperationId, 'save-one')
  const backup = await f.api.request({ action: 'backup' })
  assert.equal(backup.format, 'dsh-status-flair-backup')
  assert.deepEqual(backup.legacy.rawFlair, original)
  assert.equal(Object.hasOwn(backup.legacy.rawFlair.presets[0].style, 'fontSize'), false)
  assert.equal(backup.legacy.effectiveFlair.presets[0].style.fontSize, 13)
  assert.equal(backup.legacy.sourceHash, fingerprint(original))
  assert.equal(typeof backup.legacy.createdAt, 'string')
  f.entry.options.config.flair.enabled = false
  await save(f.api, saved.revision, 'save-two', { ...DEFAULT_FLAIR, enabled: false })
  assert.deepEqual((await f.api.request({ action: 'backup' })).legacy, backup.legacy)
  assert.equal(f.entry.options.config.flair.enabled, false, 'save never cleans the profile')
  if (process.platform !== 'win32') assert.equal((await fs.stat(f.path)).mode & 0o777, 0o600)
})

test('a first ordinary save persists the file marker without deleting legacy data', async (t) => {
  const f = await fixture(t, { raw: null })
  const initial = await f.api.request({ action: 'load' })
  const saved = await save(f.api, initial.revision, 'first-fresh-save')
  assert.equal(f.entry.options.config.storage, 'file')
  assert.equal(saved.storage.cleanupPending, false)
  assert.equal(Object.hasOwn(f.entry.options.config, 'flair'), false)
  await fs.unlink(f.path)
  await assert.rejects(f.api.request({ action: 'load' }), hasCode('missing-file'))
  const reopened = createStorageApi({ profile: f.profile, config: Config(cloneJson(f.entry.options.config)), editor: f.editor, ownerFiber: f.fiber })
  try { await assert.rejects(reopened.request({ action: 'load' }), hasCode('missing-file')) }
  finally { await reopened.close() }
})

test('auto mode remembers an observed independent file and refuses fallback if it disappears', async (t) => {
  const f = await fixture(t)
  const initial = await f.api.request({ action: 'load' })
  await save(f.api, initial.revision, 'initial-file')
  const unmarked = createStorageApi({ profile: f.profile, config: Config({ flair: legacyRaw(), storage: 'auto' }), editor: f.editor, ownerFiber: f.fiber })
  try {
    assert.equal((await unmarked.request({ action: 'load' })).storage.mode, 'file')
    await fs.unlink(f.path)
    await assert.rejects(unmarked.request({ action: 'load' }), hasCode('missing-file'))
  } finally { await unmarked.close() }
})

test('a failed first-save marker is visible and can be finalized without rewriting the file', async (t) => {
  const f = await fixture(t, { raw: null })
  const initial = await f.api.request({ action: 'load' }), edit = f.editor.edit
  f.editor.edit = async () => { throw new Error('profile is read-only') }
  const saved = await save(f.api, initial.revision, 'marker-pending')
  assert.equal(saved.storage.cleanupPending, true)
  assert.match(saved.storage.warning, /marker is pending/)
  assert.equal((await f.api.request({ action: 'load' })).storage.cleanupPending, true)
  const bytes = await fs.readFile(f.path, 'utf8')
  f.editor.edit = edit
  const completed = await migrate(f.api, saved.revision, 'marker-finalized')
  assert.equal(completed.storage.cleanupPending, false)
  assert.equal(await fs.readFile(f.path, 'utf8'), bytes)
  assert.equal(f.entry.options.config.storage, 'file')
})

test('CAS rejects stale and pre-save external edits; operation retries are idempotent and payload reuse fails', async (t) => {
  const f = await fixture(t)
  const initial = await f.api.request({ action: 'load' })
  const one = await save(f.api, initial.revision, 'one')
  const bytes = await fs.readFile(f.path, 'utf8')
  const retry = await save(f.api, initial.revision, 'one')
  assert.equal(retry.revision, one.revision)
  assert.equal(await fs.readFile(f.path, 'utf8'), bytes)
  await assert.rejects(save(f.api, initial.revision, 'one', { ...DEFAULT_FLAIR, enabled: false }), hasCode('conflict'))
  await assert.rejects(save(f.api, initial.revision, 'two'), hasCode('conflict'))
  const two = await save(f.api, one.revision, 'two', { ...DEFAULT_FLAIR, enabled: false })
  const olderRetry = await save(f.api, initial.revision, 'one')
  assert.equal(olderRetry.revision, two.revision)
  assert.equal(olderRetry.value.flair.enabled, false, 'retrying an old operation never rolls back newer data')
  await fs.appendFile(f.path, String.fromCharCode(10))
  const external = await f.api.request({ action: 'load' })
  assert.notEqual(external.revision, two.revision)
  await assert.rejects(save(f.api, two.revision, 'three'), hasCode('conflict'))
})

test('legacy CAS token is based on raw data, including fields hidden by normalization', async (t) => {
  const f = await fixture(t)
  const before = await f.api.request({ action: 'load' })
  f.entry.options.config.flair.extraRawField.changed = true
  const after = await f.api.request({ action: 'load' })
  assert.notEqual(after.revision, before.revision)
  await assert.rejects(save(f.api, before.revision, 'stale-legacy'), hasCode('conflict'))
  assert.deepEqual(await fs.readdir(f.dir), [])
})

test('single-profile queue serializes concurrent saves and a conflict does not poison later writes', async (t) => {
  const f = await fixture(t)
  const initial = await f.api.request({ action: 'load' })
  const settled = await Promise.allSettled([save(f.api, initial.revision, 'a'), save(f.api, initial.revision, 'b', { ...DEFAULT_FLAIR, enabled: false })])
  assert.equal(settled.filter((row) => row.status === 'fulfilled').length, 1)
  assert.equal(settled.filter((row) => row.status === 'rejected')[0].reason.code, 'conflict')
  const now = await f.api.request({ action: 'load' })
  assert.equal((await save(f.api, now.revision, 'c')).storage.mode, 'file')
})

test('atomic rename and fsync failures retain the previous document and clean temporary files', async (t) => {
  const io = { ...fs }
  const f = await fixture(t, { fs: io })
  const initial = await f.api.request({ action: 'load' })
  const saved = await save(f.api, initial.revision, 'one')
  const bytes = await fs.readFile(f.path, 'utf8')
  const committed = cloneJson(f.api.store.lastCommitted)
  io.rename = async () => { throw new Error('rename denied') }
  await assert.rejects(save(f.api, saved.revision, 'rename-failure'), hasCode('storage-unavailable'))
  assert.equal(await fs.readFile(f.path, 'utf8'), bytes)
  assert.deepEqual(f.api.store.lastCommitted, committed)
  assert.deepEqual(await fs.readdir(join(f.dir, 'dsh-status-flair')), ['settings.json'])
  io.rename = fs.rename
  io.open = async (...args) => {
    const handle = await fs.open(...args)
    if (args[1] !== 'wx') return handle
    return { writeFile: (...values) => handle.writeFile(...values), sync: async () => { throw new Error('fsync denied') }, close: () => handle.close() }
  }
  await assert.rejects(save(f.api, saved.revision, 'sync-failure'), hasCode('storage-unavailable'))
  assert.equal(await fs.readFile(f.path, 'utf8'), bytes)
  assert.deepEqual(await fs.readdir(join(f.dir, 'dsh-status-flair')), ['settings.json'])
})

test('corrupt JSON, unknown formats, read errors and unsafe symbolic paths never fall back to defaults', async (t) => {
  const f = await fixture(t)
  await fs.mkdir(join(f.dir, 'dsh-status-flair'))
  for (const text of ['{broken', JSON.stringify({ format: 'future-format', version: 2, flair: DEFAULT_FLAIR })]) {
    await fs.writeFile(f.path, text)
    await assert.rejects(f.api.request({ action: 'load' }), hasCode('storage-corrupt'))
    await assert.rejects(save(f.api, 'legacy:' + fingerprint(legacyRaw()), 'unsafe'), hasCode('storage-corrupt'))
    assert.equal(await fs.readFile(f.path, 'utf8'), text)
  }
  const denied = await fixture(t, { fs: { ...fs, readFile: async () => { const error = new Error('denied'); error.code = 'EACCES'; throw error } } })
  await assert.rejects(denied.api.request({ action: 'load' }), hasCode('storage-unavailable'))
  const symbolic = await fixture(t, { fs: { ...fs, lstat: async () => ({ isSymbolicLink: () => true }) } })
  await assert.rejects(symbolic.api.request({ action: 'load' }), hasCode('storage-unavailable'))
})

test('close rejects new writes and drains accepted atomic work without dropping it', async (t) => {
  let release, entered
  const gate = new Promise((resolve) => { release = resolve })
  const ready = new Promise((resolve) => { entered = resolve })
  const f = await fixture(t, { fs: { ...fs, rename: async (...args) => { entered(); await gate; return fs.rename(...args) } } })
  const initial = await f.api.request({ action: 'load' })
  const pending = save(f.api, initial.revision, 'accepted')
  await ready
  let drained = false
  const closing = f.api.close().then(() => { drained = true })
  await assert.rejects(save(f.api, initial.revision, 'rejected'), hasCode('closed'))
  await Promise.resolve()
  assert.equal(drained, false)
  release()
  await pending
  await closing
  assert.equal(JSON.parse(await fs.readFile(f.path, 'utf8')).lastOperationId, 'accepted')
})

test('confirmed migration commits persisted legacy only, then cleans raw flair while retaining unrelated config', async (t) => {
  const f = await fixture(t)
  const initial = await f.api.request({ action: 'load' })
  await assert.rejects(f.api.request({ action: 'migrate', expectedRevision: initial.revision, operationId: 'no-confirmation' }), hasCode('invalid-request'))
  assert.deepEqual(await fs.readdir(f.dir), [])
  const migrated = await f.api.request({ action: 'migrate', expectedRevision: initial.revision, operationId: 'migrate', confirmed: true, flair: { enabled: false } })
  assert.deepEqual(migrated.value.flair, initial.value.flair, 'a client migration payload cannot inject an unsaved draft')
  assert.equal(migrated.storage.cleanupPending, false)
  assert.equal(migrated.lastOperationId, 'migrate')
  assert.deepEqual(f.entry.options.config, { storage: 'file', untouched: { keep: true } })
  const doc = JSON.parse(await fs.readFile(f.path, 'utf8'))
  assert.equal(doc.format, SETTINGS_FORMAT)
  assert.deepEqual(doc.legacy.rawFlair, legacyRaw())
  const conditional = await f.api.request({ action: 'load', ifRevision: migrated.revision })
  assert.equal(conditional.unchanged, true)
  assert.equal(conditional.storage.cleanupPending, false)
})

test('cleanup failure keeps file authoritative; retry cleanup never rewrites settings', async (t) => {
  const f = await fixture(t)
  const initial = await f.api.request({ action: 'load' })
  const edit = f.editor.edit
  f.editor.edit = async () => { throw new Error('profile is read-only') }
  const pending = await migrate(f.api, initial.revision, 'migration')
  assert.equal(pending.storage.cleanupPending, true)
  assert.match(pending.storage.warning, /read-only/)
  assert.deepEqual(f.entry.options.config.flair, legacyRaw())
  const bytes = await fs.readFile(f.path, 'utf8')
  f.editor.edit = edit
  const done = await migrate(f.api, pending.revision, 'retry-cleanup')
  assert.equal(done.storage.cleanupPending, false)
  assert.equal(await fs.readFile(f.path, 'utf8'), bytes)
  assert.equal(f.entry.options.config.flair, undefined)
})

test('inherited legacy and concurrent raw changes preserve profile data and return cleanup warnings', async (t) => {
  const inherited = await fixture(t, { inherited: { flair: legacyRaw() } })
  const initial = await inherited.api.request({ action: 'load' })
  const pending = await migrate(inherited.api, initial.revision, 'inherited')
  assert.equal(pending.storage.cleanupPending, true)
  assert.match(pending.storage.warning, /inherited/)
  assert.deepEqual(inherited.entry.options.config.flair, legacyRaw())
  const changed = await fixture(t)
  const before = await changed.api.request({ action: 'load' })
  changed.editor.edit = async (_owner, update) => {
    changed.entry.options.config.flair.enabled = false
    changed.entry.options.config = update(cloneJson(changed.entry.options.config), {})
  }
  const result = await migrate(changed.api, before.revision, 'changed')
  assert.equal(result.storage.cleanupPending, true)
  assert.match(result.storage.warning, /changed/)
  assert.equal(changed.entry.options.config.flair.enabled, false)
  assert.equal((await changed.api.request({ action: 'backup' })).legacy.rawFlair.enabled, true)
})

test('backup is verified inside the profile edit lock before deleting legacy', async (t) => {
  const f = await fixture(t)
  const initial = await f.api.request({ action: 'load' })
  f.editor.edit = async (_owner, update) => {
    await fs.writeFile(f.path, '{external-corruption')
    f.entry.options.config = update(cloneJson(f.entry.options.config), {})
  }
  const pending = await migrate(f.api, initial.revision, 'verify')
  assert.equal(pending.storage.cleanupPending, true)
  assert.match(pending.storage.warning, /verify backup/)
  assert.deepEqual(f.entry.options.config.flair, legacyRaw())
})

test('HMR cleanup may close its old store without waiting on its own request', { timeout: 2000 }, async (t) => {
  const f = await fixture(t)
  const initial = await f.api.request({ action: 'load' })
  f.editor.edit = async (_owner, update) => {
    const next = update(cloneJson(f.entry.options.config), {})
    await f.api.close()
    f.entry.options.config = next
    f.entry.fiber = undefined
  }
  const result = await migrate(f.api, initial.revision, 'hmr')
  assert.equal(result.storage.mode, 'file')
  assert.equal(result.storage.cleanupPending, false)
  await assert.rejects(f.api.request({ action: 'load' }), hasCode('closed'))
})

test('first-save marker can HMR-close its old store without waiting on its own request', { timeout: 2000 }, async (t) => {
  const f = await fixture(t, { raw: null })
  const initial = await f.api.request({ action: 'load' })
  f.editor.edit = async (_owner, update) => {
    const next = update(cloneJson(f.entry.options.config), {})
    await f.api.close()
    f.entry.options.config = next
    f.entry.fiber = undefined
  }
  const result = await save(f.api, initial.revision, 'marker-hmr')
  assert.equal(result.storage.mode, 'file')
  assert.equal(result.storage.cleanupPending, false)
  assert.equal(f.entry.options.config.storage, 'file')
  await assert.rejects(f.api.request({ action: 'load' }), hasCode('closed'))
})

test('authenticated endpoint uses exact POST buffered Fetch and never adds a public web writer', async (t) => {
  const f = await fixture(t)
  const effects = [], routes = [], web = []
  const connection = { fetch: { register(route) { routes.push(route); return () => { routes.splice(routes.indexOf(route), 1) } } } }
  const services = { connection, profileContext: f.profile, configEditor: f.editor, webServer: { register(route) { web.push(route); return () => {} } } }
  const ctx = { fiber: f.fiber, get: (name) => services[name], effect(fn) { const off = fn(); effects.push(off); return off }, inject(_deps, callback) { callback(ctx) } }
  apply(ctx, f.config)
  assert.deepEqual(await fs.readdir(f.dir), [])
  assert.equal(routes.length, 1)
  assert.equal(routes[0].path, '/api/status-flair/data')
  assert.deepEqual(routes[0].methods, ['POST'])
  assert.equal(routes[0].requestBody, 'buffered')
  assert.equal(web.length, 1)
  assert.equal(web[0].path, '/status-flair')
  const post = (payload) => routes[0].fetch(new Request('http://localhost/api/status-flair/data', { method: 'POST', body: JSON.stringify(payload) }))
  const response = await post({ action: 'load' })
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  const body = await response.json()
  assert.equal(body.ok, true)
  const conflict = await post({ action: 'save', flair: DEFAULT_FLAIR, expectedRevision: 'stale', operationId: 'x' })
  assert.equal(conflict.status, 409)
  assert.equal((await conflict.json()).error.code, 'conflict')
  const invalid = await post({ action: 'unknown' })
  assert.equal(invalid.status, 400)
  assert.equal((await invalid.json()).ok, false)
  for (const off of effects.reverse()) if (typeof off === 'function') await off()
  assert.equal(routes.length, 0)
  assert.deepEqual(await fs.readdir(f.dir), [])
})
