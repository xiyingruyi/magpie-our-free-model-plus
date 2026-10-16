import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import crypto from 'node:crypto'
import { createModelRuntime, createRuntimeStores } from '../../src/core/runtime.js'
import { generateKey, startForwardServer } from '../../src/forward.js'
import { isLoopbackHost } from '../../src/trust.js'
import { createManagement } from './management.mjs'
import { createStandaloneEac } from './eac.mjs'
import { createChannelRuntime } from './channels/runtime.mjs'

const PRODUCT = 'our-free-model-standalone'
const VERSION = JSON.parse(fs.readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version

export function resolveStandaloneDataDir(env = process.env, home = os.homedir()) {
  const configured = typeof env.OFM_HOME === 'string' ? env.OFM_HOME.trim() : ''
  return configured === '' ? path.join(home, '.our-free-model') : path.resolve(configured)
}

/** 内核自动释放的互斥端点，串行化同一数据目录的锁检查与回收。 */
async function acquireProcessGuard(dataDir) {
  // 其他平台保留原来的保守文件锁行为，不使用会遗留文件的 Unix Socket。
  if (process.platform !== 'win32' && process.platform !== 'linux') return null
  let canonical = fs.realpathSync.native(dataDir)
  if (process.platform === 'win32') canonical = canonical.toLowerCase()
  const id = crypto.createHash('sha256').update(canonical).digest('hex')
  const address = process.platform === 'win32' ? `\\\\.\\pipe\\ofm-service-lock-${id}` : `\0ofm-service-lock-${id}`
  const server = net.createServer(socket => socket.destroy())
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(address, resolve)
    })
  } catch (error) {
    if (error.code === 'EADDRINUSE') {
      throw Object.assign(new Error('数据目录已被服务占用'), { code: 'EEXIST', cause: error })
    }
    throw error
  }
  server.unref()
  return () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
}

async function acquireServiceLock(dataDir) {
  const releaseGuard = await acquireProcessGuard(dataDir)
  const lockFile = path.join(dataDir, 'service.lock')
  const token = crypto.randomUUID()
  let lock
  let ownedStat
  const removeOwnedLock = () => {
    try {
      const current = fs.lstatSync(lockFile)
      if (current.isFile() && current.dev === ownedStat.dev && current.ino === ownedStat.ino) {
        fs.unlinkSync(lockFile)
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }
  try {
    try { lock = fs.openSync(lockFile, 'wx', 0o600) }
    catch (error) {
      if (error.code !== 'EEXIST' || !releaseGuard) throw error
      const previousStat = fs.lstatSync(lockFile)
      if (!previousStat.isFile()) throw error
      const previous = fs.readFileSync(lockFile, 'utf8')
      let owner
      try { owner = JSON.parse(previous) } catch { throw error }
      if (owner?.product !== PRODUCT || !Number.isSafeInteger(owner.pid) || owner.pid <= 0) throw error
      // 只有 ESRCH 能证明进程已经退出；无权限、PID 复用等情况均保留原锁。
      let exited = false
      try { process.kill(owner.pid, 0) }
      catch (probeError) { exited = probeError.code === 'ESRCH' }
      if (!exited) throw error
      const current = fs.lstatSync(lockFile)
      if (current.dev !== previousStat.dev || current.ino !== previousStat.ino ||
          fs.readFileSync(lockFile, 'utf8') !== previous) throw error
      fs.unlinkSync(lockFile)
      lock = fs.openSync(lockFile, 'wx', 0o600)
    }
    ownedStat = fs.fstatSync(lock)
    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, product: PRODUCT, token }))
  } catch (error) {
    try {
      if (lock !== undefined) {
        fs.closeSync(lock)
        if (ownedStat) removeOwnedLock()
      }
    } finally { await releaseGuard?.() }
    throw error
  }
  return async () => {
    try {
      // 在关闭文件句柄前核对归属，避免异常替换的锁被本实例清理。
      const current = JSON.parse(fs.readFileSync(lockFile, 'utf8'))
      if (current?.token === token && current.pid === process.pid && current.product === PRODUCT) removeOwnedLock()
    } catch (error) {
      if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error
    } finally {
      try { fs.closeSync(lock) } finally { await releaseGuard?.() }
    }
  }
}

/** 直接创建核心和 HTTP 服务，不加载插件入口、Cordis 或 DSH 凭据。 */
export async function startStandalone({
  dataDir = resolveStandaloneDataDir(), host = '127.0.0.1', port,
  logger = console, refresh = true, probe,
  // 调用方只想服务某些渠道时给出的渠道 id 列表。给定时，核心泳道（匿名免费池、
  // EAC、Kilo、聚合、组合）完全不进模型清单、不参与补全、也不再被刷新——不是
  // 藏起来，而是根本不跑。不传时行为与从前逐字一致。
  scope,
} = {}) {
  if (!isLoopbackHost(host)) throw new TypeError('the standalone service binds a loopback address only')
  if (typeof dataDir !== 'string' || !path.isAbsolute(dataDir)) throw new TypeError('dataDir must be an absolute path')
  if (port !== undefined && (!Number.isInteger(port) || port < 0 || port > 65535)) {
    throw new TypeError('port must be an integer between 0 and 65535')
  }
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  const releaseLock = await acquireServiceLock(dataDir)
  let stores
  let runtime
  let listener
  let management
  let channels
  let eac
  let timer
  let refreshInFlight
  let closing
  let stopped = false
  try {
    stores = createRuntimeStores({ dataDir, logger })
    const { settings } = stores
    const savedPort = settings.get().standalonePort
    const requestedPort = port ?? (Number.isInteger(savedPort) && savedPort >= 0 && savedPort <= 65535 ? savedPort : 18900)
    const existingKey = settings.get().forwardKey
    const key = typeof existingKey === 'string' && existingKey !== '' ? existingKey : generateKey()
    settings.update({ forwardKey: key, ...probe === undefined ? {} : { standaloneProbe: probe === true } })
    settings.flush()
    if (settings.writeFailed) throw new Error('could not persist the standalone API key')
    const scoped = scope === undefined ? null : new Set(scope)
    // A model is in scope when the id before its first `/` is one of the caller's channels.
    // The account channels are exactly `channel/model`; every other lane is either
    // slash-less (the free pool's `deepseek-v4.1-flash-free`) or names a different owner
    // (`kilo-auto/free`, `nvidia/…`, the aggregate registry), so none of them can match by
    // accident — and a channel the caller did not list (Gemini) is excluded on purpose.
    const inScope = id => {
      if (scoped === null) return true
      const slash = String(id).indexOf('/')
      return slash > 0 && scoped.has(String(id).slice(0, slash))
    }
    const scopeRows = rows => scoped === null ? rows : rows.filter(row => inScope(row?.id))

    // The EAC lane is not constructed at all when the caller named a scope: its sealed
    // credential is what keeps `refreshSealedRoster` and its listing fetch alive, and the
    // runtime's own default (`() => null`) turns the lane off with no dangling reference.
    if (scoped === null) {
      eac = createStandaloneEac({
        dataDir,
        onSaved: () => { void runtime?.refreshSealedLane().catch(error => logger.warn?.(`EAC 清单刷新失败：${error.message}`)) },
      })
    }
    runtime = createModelRuntime({
      ...stores, logger, attributionUserAgent: `${PRODUCT}/${VERSION}`,
      ...(scoped === null ? { sealedCredential: eac.credential } : {}),
    })
    // Scoped: hand the channel worker the roster so it never registers a channel the caller
    // left out (Gemini). Registering it would list it in `runtime.providers`, keep it
    // reachable by id, and draw its card in the console; not registering it removes it.
    channels = await createChannelRuntime({
      dataDir, logger, stats: stores.stats,
      ...(scoped === null ? {} : { channels: [...scoped] }),
    })
    const core = runtime
    runtime = {
      ...core,
      // Read by the console: a scoped instance filters the usage panel by what it serves, so
      // a stripped lane's recorded history stops showing there too.
      scoped: scoped !== null,
      get egress() { return core.egress },
      get gatewayLatency() { return core.gatewayLatency },
      // Everything below is filtered when a scope was given, and this is where it has to
      // happen: `startForwardServer` captures these function *values* at construction
      // (forward.js:305), so a later filter anywhere else would never be seen. The console
      // reads `runtime.publicModelRows()`/`runtime.catalog` straight off this object, so a
      // plugin-side filter could not have reached it either.
      get catalog() {
        const merged = [...core.catalog, ...channels.publicModelRows().map(row => ({ ...row, contextWindow: row.context_window, maxOutput: row.max_tokens }))]
        return scoped === null ? merged : merged.filter(entry => inScope(entry?.id))
      },
      state: () => {
        // The channel rows belong in here too — upstream's own `state()` is
        // `{...core.state(), catalog: [...core.catalog, ...channels.publicModelRows()]}`. A
        // scoped version that filtered only `core.catalog` would leave the console with
        // nothing to show, which is how a strip turns into a broken plugin.
        const base = core.state()
        const catalog = scoped === null
          ? [...core.catalog, ...channels.publicModelRows()]
          : [...core.catalog, ...channels.publicModelRows()].filter(entry => inScope(entry?.id))
        const allowed = new Set(catalog.map(entry => entry.id))
        const membership = {}
        for (const [route, ids] of Object.entries(base.membership ?? {})) {
          const kept = ids.filter(id => allowed.has(id))
          if (kept.length > 0) membership[route] = kept
        }
        return { ...base, catalog, membership }
      },
      publicModelRows: () => scopeRows([...core.publicModelRows(), ...channels.publicModelRows()]),
      complete: (request, onChunk) => {
        // Out of scope is refused here, before the router can pick a lane. Without this the
        // free pool would stay dialable by id even though it is no longer listed — which is
        // the difference between hiding a lane and removing it.
        if (!inScope(request?.model)) {
          return Promise.reject(Object.assign(new Error(`model "${request?.model}" not found`), { statusCode: 404 }))
        }
        return channels.handles(request.model) ? channels.complete(request, onChunk) : core.complete(request, onChunk)
      },
      async refreshCatalog(options) {
        if (stopped) return
        // Scoped: refresh the account channels only. `core.refreshCatalog` is what reaches
        // the free pool, the sealed/EAC listing and Kilo; not calling it is what makes those
        // lanes stop working rather than merely stop showing.
        if (scoped !== null) {
          await channels.refresh().catch(error => { if (!stopped) throw error })
          // Upstream's probe round rides inside `core.refreshCatalog`, so without this a
          // scoped instance answers the console's "probe availability" button with a 200 and
          // changes nothing. Give the channel roster its own round — but only when it was
          // explicitly asked for: a probe is a real request, spent from an account's own
          // allowance, which is why the cadence (never `probe`) leaves it alone.
          if (options?.probe === true && !stopped) await probeChannelRoster()
          return
        }
        await Promise.all([core.refreshCatalog(options), channels.refresh().catch(error => { if (!stopped) throw error })])
      },
    }
    // A probe of the channel roster, for the console's own button. Each candidate gets one
    // minimal completion, off the channel half of `runtime.complete` so it takes the same
    // path a real request does (disabled models and providers are respected). Verdicts land
    // in the same `availability.json` the console reads, and `management.mjs` reads a
    // channel row's verdict from there instead of hardcoding `listed`.
    //
    // Kept off the automatic cadence on purpose: a probe is a real request against the
    // account's own allowance, and twelve channels would spend twelve of them every cycle.
    // The console's button passes `probe: true`; nothing else does.
    async function probeChannelRoster() {
      const rows = channels.publicModelRows().filter(row => inScope(row?.id))
      if (rows.length === 0) return {}
      const mark = (id, state, detail) => {
        if (stopped) return
        stores.availability.edit(value => ({
          ...value,
          results: {
            ...value.results,
            [id]: { state, ...detail === undefined ? {} : { detail }, latencyMs: 0, at: Date.now() },
          },
        }))
      }
      const probeOne = async (row) => {
        const started = Date.now()
        // One model that never answers must not hold the button: a probe is capped at
        // PROBE_TIMEOUT_MS and reports unknown when it runs out.
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(new Error(`probe timed out after ${PROBE_TIMEOUT_MS} ms`)), PROBE_TIMEOUT_MS)
        timer.unref?.()
        try {
          const outcome = await channels.complete({
            model: row.id,
            stream: false,
            signal: controller.signal,
            openAi: {
              model: row.id,
              stream: false,
              max_tokens: PROBE_MAX_TOKENS,
              messages: [{ role: 'system', content: PROBE_SYSTEM }, { role: 'user', content: PROBE_PROMPT }],
            },
          })
          if (outcome?.error !== undefined) {
            const detail = String(outcome.error?.message ?? outcome.error).slice(0, 200)
            // A refusal the vendor explains (no allowance, not signed in, model gone) is a
            // real verdict about that model, not an outage — `unavailable` reads as one, so
            // keep `unknown` and let `detail` carry the vendor's own words.
            mark(row.id, STATE_AVAILABILITY.unknown, detail)
          } else {
            mark(row.id, STATE_AVAILABILITY.available, undefined)
          }
        } catch (error) {
          const detail = String(error?.message ?? error).slice(0, 200)
          const status = error?.statusCode ?? error?.status
          const state = status === 401 || status === 403
            ? STATE_AVAILABILITY.unavailable
            : STATE_AVAILABILITY.unknown
          mark(row.id, state, detail)
        } finally {
          clearTimeout(timer)
        }
        logger.info?.(`our-free-model: probed ${row.id} in ${Date.now() - started} ms`)
      }
      // Two at a time, matching upstream's own probe round (`probeCatalog(..., 2)`): one
      // vendor throttling a burst would otherwise turn a whole round into `throttled`, while
      // a fully serial walk of twelve channels takes well over a minute.
      const queue = [...rows]
      const workers = Array.from({ length: Math.min(PROBE_CONCURRENCY, queue.length) }, async () => {
        while (!stopped) {
          const next = queue.shift()
          if (next === undefined) return
          await probeOne(next)
        }
      })
      await Promise.all(workers)
      if (!stopped) {
        stores.availability.update({ at: Date.now() })
        stores.availability.flush()
      }
      return {}
    }
    // The console reads these three states off the availability store; keep the names in one
    // place rather than inventing a second vocabulary for the channel round.
    const STATE_AVAILABILITY = { available: 'available', unavailable: 'unavailable', unknown: 'unknown' }
    const PROBE_MAX_TOKENS = 16
    // Not decoration: several channels (WorkBuddy among them) refuse a request whose first
    // message is not a system prompt — they answer 400 with a security-block message and the
    // model then reads as broken on every round. Upstream carries the same pair for its own
    // account retest (`PROBE_SYSTEM` / `PROBE_PROMPT` in channels/business.mjs).
    const PROBE_SYSTEM = 'You are a helpful assistant.'
    const PROBE_PROMPT = 'ping'
    // Per model. Upstream's own channel probe allows 120 s; a round here walks every channel
    // model in turn, so it is capped well below that — a model that has not answered by then
    // is reported unknown rather than left holding the whole button.
    const PROBE_TIMEOUT_MS = 30_000
    // How many probes are in flight at once. Upstream's own round uses 2.
    const PROBE_CONCURRENCY = 2
    const capabilities = scoped === null
      ? { anonymous: true, kilo: true, eac: true, accountChannels: true, webUi: true }
      : { anonymous: false, kilo: false, eac: false, accountChannels: true, webUi: true }
    management = createManagement({
      stores, runtime, channels, eac,
      info: () => ({
        product: PRODUCT, version: VERSION, dataDir,
        baseUrl: `http://${host === '::1' ? '[::1]' : host}:${listener?.port ?? requestedPort}`,
        automaticRefresh: refresh,
        networkMode: process.env.OFM_TEST_UPSTREAM ? 'fixture' : 'live',
        capabilities,
      }),
      onSettingsChanged: () => { if (!refreshInFlight) scheduleRefresh() },
    })
    listener = await startForwardServer({
      config: () => ({ host, port: requestedPort, enabled: settings.get().enabled !== false, key: settings.get().forwardKey }),
      complete: runtime.complete,
      modelRows: runtime.publicModelRows,
      health: () => ({
        ok: true, service: PRODUCT, product: 'standalone', version: VERSION,
        capabilities,
      }),
      handleRequest: management.handleRequest,
      log: message => logger.warn?.(`our-free-model standalone: ${message}`),
    })
    management.setPort(listener.port)
    settings.update({ standalonePort: listener.port })
    settings.flush()

    function scheduleRefresh() {
      clearTimeout(timer)
      if (stopped || !refresh) return
      const minutes = Number(settings.get().probeIntervalMinutes)
      timer = setTimeout(() => { void refreshModels() }, (Number.isFinite(minutes) && minutes > 0 ? Math.max(1, minutes) : 15) * 60_000)
      timer.unref?.()
    }
    function refreshModels(force = false) {
      if (refreshInFlight) return refreshInFlight
      refreshInFlight = runtime.refreshCatalog({ probe: settings.get().standaloneProbe === true, force })
        .catch(error => {
          if (!stopped) logger.warn?.(`our-free-model standalone: catalog refresh failed (${error?.message ?? error})`)
        })
        .finally(() => { refreshInFlight = undefined; scheduleRefresh() })
      return refreshInFlight
    }
    // 启动可强制探测；后续周期刷新遵守核心的限流退避。
    const ready = Promise.all([channels.ready, refresh ? refreshModels(settings.get().standaloneProbe === true) : Promise.resolve()])
    return {
      product: PRODUCT, version: VERSION, dataDir,
      url: `http://${host === '::1' ? '[::1]' : host}:${listener.port}`,
      managementUrl: `http://${host === '::1' ? '[::1]' : host}:${listener.port}/${management.bootstrapFragment}`,
      port: listener.port,
      keyFile: path.join(dataDir, 'settings.json'),
      runtime, channels, ready,
      close() {
        if (closing !== undefined) return closing
        stopped = true
        clearTimeout(timer)
        management.dispose()
        // Not optional-chained upstream; with a scope there is no EAC to dispose, and an
        // unguarded call would throw here and leave the lock and the listener behind.
        eac?.dispose()
        runtime.dispose()
        closing = (async () => {
          try { await Promise.all([listener.close(), channels.close()]) } finally {
            try { stores.dispose() } finally { await releaseLock() }
          }
        })()
        return closing
      },
    }
  } catch (error) {
    stopped = true
    clearTimeout(timer)
    management?.dispose()
    eac?.dispose()
    runtime?.dispose()
    if (listener) await listener.close()
    await channels?.close()
    try { stores?.dispose() } finally { await releaseLock() }
    throw error
  }
}
