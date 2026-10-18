/** Profile-scoped JSON persistence. Construction and reads never create files. */
import * as nativeFs from 'node:fs/promises'
import { readFileSync, lstatSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'

export const SETTINGS_FORMAT = 'dsh-status-flair-settings'
const queues = new Map()
const MAX_BYTES = 8 * 1024 * 1024
export class StorageError extends Error {
  constructor(code, message) { super(message); this.name = 'StorageError'; this.code = code }
}
export const cloneJson = (value) => JSON.parse(JSON.stringify(value))
const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const stable = (value) => Array.isArray(value) ? value.map(stable) : plain(value)
  ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])])) : value
export const fingerprint = (value) => createHash('sha256').update(JSON.stringify(stable(value))).digest('hex')
const bytesRevision = (bytes) => 'file:' + createHash('sha256').update(bytes).digest('hex')
const failure = (code, message) => { throw new StorageError(code, message) }

function parseDocument(text, normalize) {
  if (Buffer.byteLength(text) > MAX_BYTES) failure('storage-corrupt', 'Settings file exceeds the supported size')
  let doc
  try { doc = JSON.parse(text) } catch { failure('storage-corrupt', 'Settings file contains invalid JSON; no data was replaced') }
  if (!plain(doc) || doc.format !== SETTINGS_FORMAT || doc.version !== 1 || !plain(doc.flair) ||
      !Object.hasOwn(doc, 'legacy') || (doc.legacy !== null && (!plain(doc.legacy) ||
      !Object.hasOwn(doc.legacy, 'rawFlair') || !plain(doc.legacy.effectiveFlair) ||
      typeof doc.legacy.sourceHash !== 'string' || typeof doc.legacy.createdAt !== 'string' ||
      fingerprint(doc.legacy.rawFlair) !== doc.legacy.sourceHash)) ||
      !Array.isArray(doc.operations) || doc.operations.some((op) => !plain(op) || typeof op.operationId !== 'string' || typeof op.requestHash !== 'string') ||
      typeof doc.lastOperationId !== 'string') failure('storage-corrupt', 'Unrecognized or invalid settings document; no data was replaced')
  try { normalize(cloneJson(doc.flair)) } catch { failure('storage-corrupt', 'Stored flair is invalid; no data was replaced') }
  return doc
}

export class FlairFileStore {
  constructor({ profile, mode = 'auto', defaults, normalize, getLegacy, fs = nativeFs, now = () => new Date().toISOString() }) {
    if (!plain(profile) || typeof profile.dir !== 'string' || !isAbsolute(profile.dir) || typeof profile.name !== 'string') {
      failure('storage-unavailable', 'A trusted profile directory and name are required')
    }
    this.profile = { name: profile.name, dir: profile.dir }
    this.path = join(profile.dir, 'dsh-status-flair', 'settings.json')
    this.mode = mode
    this.defaults = cloneJson(defaults)
    this.normalize = normalize
    this.getLegacy = getLegacy
    this.fs = fs
    this.now = now
    this.closed = false
    this.sawFile = false
    this.pending = new Set()
    this.lastCommitted = null
  }
  async checkPaths() {
    for (const path of [dirname(this.path), this.path]) {
      try { if ((await this.fs.lstat(path)).isSymbolicLink()) failure('storage-unavailable', 'Symbolic links are not allowed for plugin settings') }
      catch (error) { if (error.code !== 'ENOENT') throw error }
    }
  }
  async readFile() {
    try {
      await this.checkPaths()
      const bytes = await this.fs.readFile(this.path)
      this.sawFile = true
      return { doc: parseDocument(bytes.toString('utf8'), this.normalize), revision: bytesRevision(bytes) }
    } catch (error) {
      if (error.code === 'ENOENT') return null
      if (error instanceof StorageError) throw error
      failure('storage-unavailable', 'Cannot read settings: ' + error.message)
    }
  }
  async legacy() {
    const state = await this.getLegacy()
    const rawFlair = state?.rawFlair ?? null
    const exists = rawFlair !== null
    return { rawFlair: cloneJson(rawFlair), effectiveFlair: cloneJson(exists ? state.effectiveFlair : this.defaults), exists }
  }
  snapshot(file, legacy) {
    return {
      status: 'ready', writable: true,
      revision: file ? file.revision : (legacy.exists ? 'legacy:' : 'defaults:') + fingerprint(legacy.exists ? legacy.rawFlair : this.defaults),
      value: { flair: cloneJson(file ? this.normalize(cloneJson(file.doc.flair)) : legacy.effectiveFlair) },
      ...(file ? { lastOperationId: file.doc.lastOperationId } : {}),
      storage: { mode: file ? 'file' : legacy.exists ? 'legacy' : 'defaults', profile: this.profile.name, path: this.path,
        backupAvailable: !!file?.doc.legacy, cleanupPending: !!file && (legacy.exists || this.mode !== 'file') },
    }
  }
  async readState() {
    const file = await this.readFile()
    if (!file && (this.mode === 'file' || this.sawFile)) failure('missing-file', 'File storage is selected but settings.json is missing; legacy data was not restored')
    const legacy = await this.legacy()
    return { file, legacy, snapshot: this.snapshot(file, legacy) }
  }
  async load({ ifRevision } = {}) {
    const { snapshot } = await this.readState()
    return ifRevision === snapshot.revision ? { unchanged: true, revision: snapshot.revision, storage: snapshot.storage, ...(snapshot.lastOperationId ? { lastOperationId: snapshot.lastOperationId } : {}) } : snapshot
  }
  async backup() {
    const { file, legacy, snapshot } = await this.readState()
    const original = file ? file.doc.legacy : legacy.exists ? { rawFlair: legacy.rawFlair, effectiveFlair: legacy.effectiveFlair, sourceHash: fingerprint(legacy.rawFlair), createdAt: this.now() } : null
    return { format: 'dsh-status-flair-backup', version: 1, profile: this.profile.name,
      flair: snapshot.value.flair, legacy: cloneJson(original) }
  }
  enqueue(work) {
    if (this.closed) return Promise.reject(new StorageError('closed', 'Settings storage is closing'))
    const previous = queues.get(this.path) ?? Promise.resolve()
    const next = previous.catch(() => {}).then(work)
    queues.set(this.path, next)
    this.pending.add(next)
    const settled = () => { this.pending.delete(next); if (queues.get(this.path) === next) queues.delete(this.path) }
    next.then(settled, settled)
    return next
  }
  async close() { this.closed = true; await Promise.allSettled([...this.pending]) }
  validateOperation(request) {
    if (!plain(request) || typeof request.expectedRevision !== 'string' || !request.expectedRevision ||
        typeof request.operationId !== 'string' || !request.operationId.trim() || request.operationId.length > 200) {
      failure('invalid-request', 'expectedRevision and a nonempty operationId (at most 200 characters) are required')
    }
  }
  save(request) { return this.commit('save', request) }
  prepareMigration(request) {
    if (request?.confirmed !== true) return Promise.reject(new StorageError('invalid-request', 'Migration requires explicit confirmation'))
    return this.commit('migrate', request)
  }
  commit(action, request) {
    let detached
    try { this.validateOperation(request); detached = cloneJson(request) } catch (error) { return Promise.reject(error) }
    return this.enqueue(async () => {
      const state = await this.readState()
      let flair
      try {
        if (action === 'save' && !plain(detached.flair)) failure('invalid-request', 'flair must be a complete configuration object')
        flair = action === 'save' ? this.normalize(detached.flair) : state.snapshot.value.flair
      } catch (error) { if (error instanceof StorageError) throw error; failure('invalid-request', 'Invalid flair: ' + error.message) }
      const requestHash = fingerprint(action === 'save' ? { action, flair: detached.flair } : { action })
      const receipt = state.file?.doc.operations.find((item) => item.operationId === detached.operationId)
      if (receipt) {
        if (receipt.requestHash !== requestHash) failure('conflict', 'operationId was already used with a different payload')
        return { snapshot: cloneJson(state.snapshot), legacy: cloneJson(state.file.doc.legacy) }
      }
      if (detached.expectedRevision !== state.snapshot.revision) failure('conflict', 'Configuration changed since it was loaded; the draft was not saved')
      if (action === 'migrate' && state.file) return { snapshot: { ...cloneJson(state.snapshot), lastOperationId: detached.operationId }, legacy: cloneJson(state.file.doc.legacy) }
      const legacy = state.file ? state.file.doc.legacy : state.legacy.exists ? {
        rawFlair: cloneJson(state.legacy.rawFlair), effectiveFlair: cloneJson(state.legacy.effectiveFlair),
        sourceHash: fingerprint(state.legacy.rawFlair), createdAt: this.now(),
      } : null
      const doc = { format: SETTINGS_FORMAT, version: 1, flair: cloneJson(flair), legacy,
        lastOperationId: detached.operationId, operations: [...(state.file?.doc.operations ?? []), { operationId: detached.operationId, requestHash }] }
      const text = JSON.stringify(doc, null, 2) + String.fromCharCode(10)
      if (Buffer.byteLength(text) > MAX_BYTES) failure('invalid-request', 'Settings document exceeds the supported size')
      await this.atomicWrite(text, state.snapshot.revision)
      const file = await this.readFile()
      if (!file || file.revision !== bytesRevision(Buffer.from(text))) failure('storage-unavailable', 'Settings changed during write verification; legacy data was retained')
      this.lastCommitted = cloneJson(file)
      return { snapshot: this.snapshot(file, state.legacy), legacy: cloneJson(legacy) }
    })
  }
  async atomicWrite(text, expectedRevision) {
    const folder = dirname(this.path), temporary = join(folder, '.settings-' + randomUUID() + '.tmp')
    let handle, renamed = false
    try {
      await this.checkPaths()
      await this.fs.mkdir(folder, { recursive: true, mode: 0o700 })
      handle = await this.fs.open(temporary, 'wx', 0o600)
      await handle.writeFile(text, 'utf8')
      await handle.sync()
      await handle.close(); handle = null
      // Best-effort external-edit detection, not cross-process atomic CAS.
      // The shared in-process queue serializes browser saves; external writers
      // must not race a save between this check and rename.
      const current = await this.readState()
      if (current.snapshot.revision !== expectedRevision) failure('conflict', 'Configuration changed before atomic replacement')
      await this.checkPaths()
      await this.fs.rename(temporary, this.path)
      renamed = true
      // Windows does not support opening a directory handle for fsync.
      if (process.platform !== 'win32') {
        const directory = await this.fs.open(folder, 'r')
        try { await directory.sync() } finally { await directory.close() }
      }
    } catch (error) {
      if (error instanceof StorageError) throw error
      failure('storage-unavailable', 'Cannot commit settings: ' + error.message)
    } finally {
      if (handle) await handle.close().catch(() => {})
      if (!renamed) await this.fs.unlink(temporary).catch(() => {})
    }
  }
  /** Synchronous verification runs inside configEditor's existing profile lock. */
  verifyBackupForCleanup(expected) {
    try {
      for (const path of [dirname(this.path), this.path]) if (lstatSync(path).isSymbolicLink()) throw new Error('Settings path is a symbolic link')
      const doc = parseDocument(readFileSync(this.path, 'utf8'), this.normalize)
      if (fingerprint(doc.legacy) !== fingerprint(expected)) throw new Error('Legacy backup changed')
    } catch (error) { failure('storage-unavailable', 'Cannot verify backup before profile cleanup: ' + error.message) }
  }
}
