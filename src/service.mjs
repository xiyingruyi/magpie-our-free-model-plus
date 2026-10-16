/**
 * The embedded service: one upstream standalone instance per data directory, started
 * in this process on first use.
 *
 * Mirrors the community port's lifecycle guarantees (single instance per data dir,
 * idempotent ensure(), clean teardown) without its child process: there is no pipe to
 * lose, no parent poll, and no node download.
 *
 * @module src/service.mjs
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startStandalone } from '../vendor/ofm/packages/standalone/service.mjs'
import { createConsoleHandoff } from './console.mjs'
import { CHANNEL_IDS, CHECKIN_CHANNELS, NO_AUTO_CHECKIN, isChannelModel } from './channels.mjs'

/** One live instance per data directory, and one ensure() in flight per data directory. */
const instances = new Map()
const pending = new Map()

/**
 * Bumped by `disposeAll()`. A start that was already under way when the plugin was torn
 * down compares its captured value against this and closes itself instead of publishing a
 * service nothing would ever release — its lock and port would otherwise be held for the
 * life of the process.
 */
let epoch = 0

/** Upstream's lock product id: only a lock carrying this may be reclaimed. */
const LOCK_PRODUCT = 'our-free-model-standalone'

/**
 * How long to wait for the channel roster before answering magpie anyway.
 *
 * The roster needs one upstream round trip per channel, and the slowest observed run was
 * 27s when a refresh token had to be exchanged mid-flight, so this has to be comfortably
 * clear of that. Missing it is not fatal — the plugin still loads and the list is retried —
 * but it is what makes a channel look empty, so it is deliberately generous.
 */
const REFRESH_CEILING_MS = 120_000

/** How often the roster is re-checked while waiting. */
const REFRESH_POLL_MS = 500

/**
 * How long to keep looking after upstream's own `ready` has settled.
 *
 * `ready` resolving means the refresh finished, so rows are normally there already; this
 * short grace only catches rows that land a moment later. Without it, an install with no
 * accounts at all would sit out the whole ceiling staring at an empty list.
 */
const ROSTER_GRACE_MS = 5_000

/**
 * The console's own port: 0, letting the OS pick.
 *
 * A fixed port was the first idea and it was wrong twice over. It is not needed — magpie
 * never remembers the console's address, it is handed a fresh one every time the user opens
 * the console — and it is actively harmful: a port pinned in code is a port that can be
 * taken by something else, and then the console silently fails to start while the models
 * keep working, so the failure is invisible.
 *
 * The console is reached through `consoleEntry()`, which mints a one-use ticket on the
 * address the handoff actually bound.
 */
const CONSOLE_PORT = 0

/**
 * Settings that strip the lanes this plugin does not serve.
 *
 * The scope is the signed-in account channels only, so the anonymous free pool's probing,
 * the aggregate byo-key registry, the combo fallback chains, the token savers, the local
 * canned answers, the update checker and the announcement feed are all turned off. They
 * are switched off through upstream's own settings document rather than by editing
 * vendored code, so an upstream refresh cannot silently re-enable them.
 *
 * Written once, on the first run that finds no settings file. Anything already there is
 * left exactly as the user left it.
 */
const SCOPE_SETTINGS = {
  enabled: true,
  exposeRegionModels: false,
  // 0 does NOT mean "never": upstream reads a non-positive value as "unset" and falls back
  // to its own 15-minute default, so the free-pool listing would be polled forever. 1440 is
  // the largest value upstream accepts (management.mjs clamps to [1,1440]) — one refresh a
  // day, which is the closest thing to off that the setting offers.
  probeIntervalMinutes: 1440,
  tokenSaver: { enabled: false, rtk: false, prompts: { caveman: 'off', ponytail: 'off' } },
  // Only the switch. `aggregate.providers` holds the user's own third-party keys
  // (vendor/ofm/src/store.js stores each per-provider apiKey in this same file), so it is
  // never written here — turning the lane off must not delete their credentials.
  aggregate: { enabled: false },
  combos: [],
  localOptimize: { enabled: false, quota: false, prefix: false, title: false, suggestion: false, filepath: false },
  updateCheckHours: 0,
  feedUrl: '',
  notifyOs: false,
  streamRecovery: true,
}

/** Where this plugin keeps its state, unless the user named somewhere else. */
export function defaultDataDir(directory) {
  const base = directory || path.join(os.homedir(), '.config', 'magpie')
  return path.join(base, 'our-free-model-plus')
}

/**
 * Real-path of a location that may not exist yet, resolving symlinks on the part that does.
 *
 * `path.resolve` is purely lexical, so a symlink named `~/data` pointing at `~` would sail
 * past every comparison here while upstream wrote `service.lock`, `settings.json` and the
 * account state straight into the home directory. Resolving first means the checks below
 * compare where a path actually lands, not how it is spelled.
 */
function realpathDeep(target) {
  let current = path.resolve(target)
  const trailing = []
  for (;;) {
    try {
      return path.join(fs.realpathSync(current), ...trailing)
    } catch {
      const parent = path.dirname(current)
      if (parent === current) return path.join(current, ...trailing) // nothing on this path exists
      trailing.unshift(path.basename(current))
      current = parent
    }
  }
}

/**
 * Refuse a data dir that would swallow something we do not own. Upstream's own
 * `startStandalone` writes `service.lock` into whatever it is handed, so a bad value
 * here is destructive rather than merely wrong.
 */
export function validateDataDir(dataDir, directory) {
  const resolved = path.resolve(dataDir)
  const forbidden = [path.parse(resolved).root, os.homedir(), directory ? path.resolve(directory) : undefined]
  const landings = forbidden.filter(Boolean).map(realpathDeep)
  if (landings.includes(realpathDeep(resolved))) {
    throw new Error(`managed.dataDir 必须是本插件专用的子目录，不能是系统根目录、主目录或 Magpie 配置目录`)
  }
  return resolved
}

/**
 * How long an unreadable lock must sit untouched before it counts as debris.
 *
 * Upstream opens `service.lock` with `wx` and only then writes `{pid, product}` into it
 * (vendor/ofm/packages/standalone/service.mjs:31-46). A crash inside that window leaves a
 * zero-byte or half-written file, which can never be parsed and therefore can never be
 * matched against a pid. Every later start fails EEXIST on it, so without this one unlucky
 * crash would brick the plugin permanently. A service that is genuinely mid-start writes
 * that file within milliseconds, so an age well past any real startup means debris.
 */
const STALE_LOCK_MS = 60_000

/**
 * `O_EXLOCK`, which Node does not export but macOS and the BSDs implement.
 *
 * Upstream's own process guard (its `acquireProcessGuard`) covers **only** win32 and linux —
 * on darwin it deliberately returns `null` and the stale-lock reclaim is skipped, because the
 * Unix-socket trick it uses would leave a socket file behind. That is the one thing this
 * plugin hit constantly in practice: a Magpie that was force-quit leaves `service.lock`
 * behind and every later start fails with EEXIST until the file is deleted by hand.
 *
 * `O_EXLOCK` is the missing primitive. It takes a real BSD advisory lock on the open file
 * description, so the **kernel** drops it when the holder exits — including on SIGKILL —
 * with no cooperation from the dying process and no daemon to reap. The lock file itself may
 * survive, but the lock does not, which is exactly the property upstream's socket gives on
 * linux and that a pid-and-file check cannot give on its own.
 *
 * Node omits the constant from `fs.constants`, so the raw BSD value is used. `O_NONBLOCK` is
 * what makes a held lock fail fast (`EAGAIN`) instead of blocking the whole start-up.
 */
const O_EXLOCK = 0x20

/** The lock file upstream's `startStandalone` uses; the guard lives beside it. */
const GUARD_SUFFIX = '.guard'

/**
 * Hold a kernel-released exclusive lock for the whole lock-file race, where the platform
 * supports one.
 *
 * The point of holding it across `reclaimStaleLock` **and** `startStandalone` rather than
 * inside either is that the dangerous sequence is check-then-create: two starters can both
 * read a stale lock, both decide it is reclaimable, and the second one unlinks the **live**
 * lock the first one just created. Serialising the pair removes that window entirely.
 *
 * Linux and Windows are skipped: upstream's own socket guard already covers them, and running
 * both would contend with it for the same serialisation for no gain.
 *
 * @returns {Promise<() => void>} release; a no-op when no guard could be taken.
 */
export async function acquireLockGuard(dataDir) {
  if (process.platform !== 'darwin') return () => {}
  const file = path.join(dataDir, `service.lock${GUARD_SUFFIX}`)
  let attempt = 0
  for (;;) {
    try {
      const fd = fs.openSync(file, fs.constants.O_CREAT | fs.constants.O_RDWR | O_EXLOCK | fs.constants.O_NONBLOCK, 0o600)
      // The file is ours to keep; what matters is the lock on the open description, which the
      // kernel releases on exit. Closing the fd here would release it, so the fd is held
      // until the returned release function runs.
      return () => { try { fs.closeSync(fd) } catch { /* already released */ } }
    } catch (error) {
      // EAGAIN (BSD) / EWOULDBLOCK: another starter holds it. Wait briefly and retry — the
      // holder is another start of ours, not a long-lived service, so this is short.
      if (error.code !== 'EAGAIN' && error.code !== 'EWOULDBLOCK') return () => {}
      // Deliberately a *ref'd* timer. An unref'd one does not keep the event loop alive, and
      // during a start there is often nothing else on it yet — the callback would never fire
      // and this await would hang forever with no error to show for it.
      if (++attempt > 150) return () => {}   // ~15s; better to race than to hang the start
      await new Promise(resolve => setTimeout(resolve, 100))
    }
  }
}

/**
 * Reclaim a lock left behind by a service that is provably gone.
 *
 * Upstream opens `service.lock` with `wx`, so a stale file makes `startStandalone` fail
 * with EEXIST forever. Only reclaim when the recorded product matches and the pid is
 * dead — never take a lock someone is still holding.
 *
 * Known limitation: if the dead service's pid has been reused by an unrelated live
 * process, `kill(pid, 0)` succeeds and the lock looks held. The lock file itself carries
 * nothing else to compare against, and reclaiming a lock that might be live is far worse
 * than refusing to reclaim one that is not, so it is left alone.
 */
function reclaimStaleLock(dataDir) {
  const lock = path.join(dataDir, 'service.lock')
  let raw
  try { raw = fs.readFileSync(lock, 'utf8') } catch { return false }

  let previous
  try { previous = JSON.parse(raw) } catch { previous = undefined }

  if (previous === undefined || previous === null || typeof previous !== 'object') {
    // Unreadable: debris only once it is far too old to be someone mid-start.
    let age = Infinity
    try { age = Date.now() - fs.statSync(lock).mtimeMs } catch { return false }
    if (age < STALE_LOCK_MS) return false
    try { fs.unlinkSync(lock); return true } catch { return false }
  }

  if (previous.product !== LOCK_PRODUCT || !Number.isInteger(previous.pid) || previous.pid <= 0) return false
  try {
    process.kill(previous.pid, 0)
    return false // still alive — leave it alone
  } catch (error) {
    if (error.code !== 'ESRCH') return false
  }
  // The pid is ESRCH, so as far as the kernel is concerned nobody is holding a process by it.
  // With the guard held (see `acquireLockGuard`) no other starter is mid-create, which is what
  // makes removing a lock whose pid could have been *reused* safe: a pid is only reused by a
  // process that started after the recorded one exited, and a live service's lock is created
  // under this same guard, so it cannot be observed half-written here.
  try { fs.unlinkSync(lock); return true } catch { return false }
}

/** Settings that must be identical for two callers to share one instance. */
function identity(dataDir, options) {
  return JSON.stringify([dataDir, options.port, options.refresh, options.probe])
}

/**
 * Write the scope settings into a data directory that has no settings yet.
 *
 * Only ever runs when `settings.json` is absent, so an existing install — and anything the
 * user changed by hand — is never overwritten. `startStandalone` merges what it finds over
 * its own defaults, so every key here is one it already understands.
 */
function seedScopeSettings(dataDir) {
  const file = path.join(dataDir, 'settings.json')
  if (fs.existsSync(file)) return false
  fs.writeFileSync(file, JSON.stringify({ version: 1, ...SCOPE_SETTINGS }, null, 2), { mode: 0o600, flag: 'wx' })
  return true
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Fold our settings over an existing document, keeping every key we do not name.
 *
 * The naive `current[key] = value` deletes siblings *inside* that key: writing
 * `aggregate: {enabled:false}` over a document that also holds `aggregate.providers` would
 * destroy the user's stored third-party API keys. Merging one level at a time means turning
 * a lane off never costs the user anything they put there.
 */
function mergeOwned(current, owned) {
  // A scalar, an array, or null we own replaces whatever is stored, wholesale. This has to
  // be the FIRST thing the function decides, because the loop below can only ever merge
  // *properties* — and `Object.entries` of a scalar is empty, so a value handed in as the
  // whole `owned` argument would never reach `out` and the caller would get back the `{}`
  // placeholder instead of its own number. That is exactly how every scalar scope setting
  // (`probeIntervalMinutes: 1440`, `exposeRegionModels: false`, `combos: []`, …) came to be
  // written into settings.json as `{}` on every boot.
  if (!isPlainObject(owned)) return owned
  const out = isPlainObject(current) ? { ...current } : {}
  for (const [key, value] of Object.entries(owned)) out[key] = mergeOwned(out[key], value)
  return out
}

/** Write a JSON document beside its target and swap it in. */
function writeJSONAtomically(file, document) {
  // Deliberately not `${file}.${process.pid}.tmp`: that is exactly the name upstream's own
  // JsonStore writes settings.json under (vendor/ofm/src/store.js:109), and this plugin
  // runs *in* that process, so the two would share a temp file and could clobber each
  // other's rename.
  const temp = `${file}.${process.pid}.plugin.tmp`
  try {
    fs.writeFileSync(temp, JSON.stringify(document, null, 2), { mode: 0o600, flag: 'wx' })
    fs.renameSync(temp, file)
  } finally {
    if (fs.existsSync(temp)) fs.unlinkSync(temp)
  }
}

/**
 * Turn off the lanes this plugin does not serve, in a data directory that already has
 * settings from somewhere else.
 *
 * `seedScopeSettings` covers a fresh directory; this covers the migration case, where the
 * user's existing `settings.json` (carried over from the community plugin) still has the
 * free pool, the aggregate registry, the token savers and the update checker switched on.
 * Only the keys this plugin owns are touched — never an account, a credential or a
 * preference the user chose.
 *
 * @returns {string[]} the settings that were changed, for logging.
 */
export function stripOutOfScopeLanes(dataDir) {
  const file = path.join(dataDir, 'settings.json')
  let current
  try { current = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return [] }
  if (!isPlainObject(current)) return []

  const changed = []
  for (const [key, value] of Object.entries(SCOPE_SETTINGS)) {
    // Never flip the master switch off: `enabled: false` would serve nothing at all.
    if (key === 'enabled') continue
    const merged = mergeOwned(current[key], value)
    if (JSON.stringify(current[key]) === JSON.stringify(merged)) continue
    current[key] = merged
    changed.push(key)
  }
  if (changed.length === 0) return []
  writeJSONAtomically(file, current)
  return changed
}

/**
 * How the carried-over model blocklist is treated.
 *
 * The community plugin let the user disable individual models, and those choices are saved
 * in `channel-pack/state.json`. Carried into this plugin they are silently destructive: four
 * of the user's channels (workbuddy, qoder, qodercn, zcode) have *every* model disabled, so
 * they would look broken — registered, signed in, yet listing nothing.
 *
 * `'keep'` (the default) honours the user's own choices; `'reset'` clears the list so every
 * model is offered again. Either way the decision is logged, because silent either way is
 * how a working channel gets mistaken for a broken one.
 */
const BLOCKLIST_MODE = 'keep'

/**
 * Report — and optionally clear — the carried-over model blocklist.
 *
 * Only ever touches `disabledModels`, and only under `'reset'`. Never an account, never a
 * credential.
 *
 * @returns {{ channels: string[], models: number }|undefined} what was found, if anything.
 */
function applyBlocklistPolicy(dataDir, mode, log) {
  const file = path.join(dataDir, 'channel-pack', 'state.json')
  let state
  try { state = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return undefined }
  const disabled = state?.disabledModels
  if (!disabled || typeof disabled !== 'object') return undefined

  const ours = {}
  for (const [channel, models] of Object.entries(disabled)) {
    if (CHANNEL_IDS.has(channel) && models && typeof models === 'object') ours[channel] = models
  }
  const blocked = Object.entries(ours).filter(([, models]) => Object.keys(models).length > 0)
  if (blocked.length === 0) return undefined

  const count = blocked.reduce((total, [, models]) => total + Object.keys(models).length, 0)
  const summary = blocked.map(([channel, models]) => `${channel}(${Object.keys(models).length})`).join('、')

  if (mode === 'reset') {
    for (const channel of Object.keys(ours)) delete state.disabledModels[channel]
    writeJSONAtomically(file, state)
    log(`our-free-model-plus: 已清除旧插件遗留的模型禁用名单，共 ${count} 个模型重新可用：${summary}`)
  } else {
    log(`our-free-model-plus: 沿用旧插件的模型禁用名单，共 ${count} 个模型被禁用：${summary}。若某个渠道一个模型都不显示，把 managed.blocklist 设为 'reset' 即可全部恢复。`)
  }
  return { channels: blocked.map(([c]) => c), models: count }
}

/**
 * How many in-scope channel models the service is currently serving.
 *
 * This is the same endpoint `provider.models` reads, so "the roster is ready" means
 * exactly "magpie will see models" — rather than a promise that can resolve while the
 * catalog is still empty. A failure to reach the service is 0, not an error: the caller
 * is already inside a bounded wait.
 */
async function countChannelRows(base, key) {
  try {
    const res = await fetch(`${base}/v1/models`, { headers: { authorization: `Bearer ${key}` } })
    if (!res.ok) return 0
    const body = await res.json()
    const rows = body?.data ?? body?.models ?? []
    if (!Array.isArray(rows)) return 0
    let count = 0
    for (const row of rows) if (isChannelModel(row?.id)) count += 1
    return count
  } catch {
    return 0
  }
}

/** The pack's per-channel verdict for one account's check-in. */
const CLAIM_KIND = {
  claimed: 'claimed',
  'already-claimed': 'done',
  inactive: 'inactive',
}

/**
 * Press every channel's daily check-in, once, and report a single outcome for magpie.
 *
 * This is the body of the `auth.checkin` hook magpie calls once a Beijing day. It runs the
 * whole roster inside that one call because magpie asks **per account**, and this plugin
 * fronts twelve upstream channels behind a single sentinel account — magpie never sees the
 * channels, so the fan-out has to happen here.
 *
 * It is deliberately **thrown-free**: magpie's host reads "a hook that throws" as `failed`
 * and would lose every detail, so even an unreachable service comes back as an outcome with
 * a message. A channel that cannot be checked is not a reason to report the whole day as a
 * failure — buddy claiming while minimax is down is a partial success, and the message says
 * which is which.
 *
 * @param {object} service - the started standalone service (`service.channels.rpc`).
 * @returns {Promise<{outcome: string, credit: number, streak: number, message: string}>}
 */
export async function runCheckin(service) {
  const rpc = service?.channels?.rpc
  if (typeof rpc !== 'function') {
    return { outcome: 'failed', credit: 0, streak: 0, message: '本地渠道运行时不可用' }
  }
  // The roster is the check-in roster, not the model roster: `zcode` is in scope for models
  // but the pack refuses to check it in automatically, and asking would fail every day.
  // The service has no "list providers" call anyway (`provider.status` takes ids as an
  // argument), so this is the authoritative list. The union keeps a channel that is
  // momentarily unregistered from silently dropping out of the check-in.
  //
  // The subtraction afterwards is the part that matters: `service.channels.providers` is the
  // worker's full adapter roster, which *always* contains the excluded channel — so without
  // it the union would put back exactly what `NO_AUTO_CHECKIN` took out, and every daily run
  // would ask the pack to claim for a channel it deliberately refuses (the pack's own
  // `isAutoCheckinExcluded` only guards the pack's internal loop, not this call).
  const roster = new Set([...CHECKIN_CHANNELS, ...(service?.channels?.providers ?? [])])
  for (const id of NO_AUTO_CHECKIN) roster.delete(id)
  const providers = [...roster]

  let claimed = 0
  let done = 0
  let failed = 0
  let skipped = 0
  // The pack reports grants split by unit (`totalByUnit: {credits, tokens}`), so only the
  // credit half is a single number worth handing magpie — a token total is a different unit
  // and adding them would be a meaningless figure on the card.
  let credit = 0
  /** @type {string[]} */
  const faults = []
  for (const provider of providers) {
    let value
    try {
      const result = await rpc({ method: 'credits.claimAll', payload: { provider } })
      if (result?.ok === false) {
        const message = result?.error?.message ?? ''
        // "不支持每日签到" is not a fault — it is a channel that has no such thing, which is
        // the pack's own distinction (`isUnsupportedCheckin`). Reporting it as a failure
        // would make a perfectly healthy roster look broken every single day.
        if (message.includes('不支持每日签到') || message.includes('unsupported provider')) { skipped += 1; continue }
        failed += 1
        faults.push(`${provider}：${message || '领取失败'}`)
        continue
      }
      value = result?.value ?? result
    } catch (error) {
      failed += 1
      faults.push(`${provider}：${error?.message ?? error}`)
      continue
    }
    for (const row of Array.isArray(value?.results) ? value.results : []) {
      const kind = CLAIM_KIND[row?.outcome?.kind] ?? 'failed'
      if (kind === 'claimed') claimed += 1
      else if (kind === 'done') done += 1
      else if (kind === 'inactive') skipped += 1
      else {
        failed += 1
        const who = row?.nickname ?? row?.accountId ?? '账号'
        faults.push(`${provider}/${who}：${row?.outcome?.message ?? '失败'}`)
      }
    }
    // Even a run with failures carries credit for the accounts that did claim, so this is
    // added outside the loop over outcomes rather than only on an all-clear.
    credit += Number(value?.summary?.totalByUnit?.credit) || 0
  }

  const parts = []
  if (claimed > 0) parts.push(`${claimed} 个领取成功`)
  if (done > 0) parts.push(`${done} 个今天已领`)
  if (skipped > 0) parts.push(`${skipped} 个不适用`)
  if (failed > 0) parts.push(`${failed} 个失败`)
  const summary = parts.length > 0 ? parts.join('，') : '没有需要领取的账号'
  // The first few reasons are what actually helps; a wall of them is a tooltip nobody reads.
  const message = faults.length > 0 ? `${summary}。${faults.slice(0, 3).join('；')}${faults.length > 3 ? ' …' : ''}` : summary

  // `claimed` and `done` both mean the day is covered. Only when nothing was covered AND
  // something went wrong is this a failure — an all-inapplicable roster (channels with no
  // check-in at all) is `ineligible`, not a broken one.
  const outcome = claimed > 0 ? 'claimed' : done > 0 ? 'done' : failed > 0 ? 'failed' : 'ineligible'
  return { outcome, credit, streak: 0, message }
}

/**
 * Start (or return) the instance for a data directory.
 *
 * @param {object} input - magpie's PluginInput.
 * @param {object} options - the plugin's `managed` options.
 * @param {(message: string) => void} [log]
 * @returns {Promise<{service: object, base: string, key: string, dataDir: string}>}
 */
export async function ensureService(input, options = {}, log = () => {}) {
  const directory = input?.directory ?? input?.worktree
  const dataDir = validateDataDir(options.dataDir || defaultDataDir(directory), directory)
  const key = identity(dataDir, options)

  const live = instances.get(dataDir)
  if (live) {
    if (live.identity !== key) {
      throw new Error('同一数据目录使用了不同的服务设置；请重启 Magpie 后再应用配置')
    }
    return live.resolved
  }
  const inflight = pending.get(dataDir)
  if (inflight) {
    if (inflight.identity !== key) {
      throw new Error('同一数据目录使用了不同的服务设置；请重启 Magpie 后再应用配置')
    }
    return inflight.promise
  }

  const promise = (async () => {
    const startedAt = epoch
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 })
    // Held across the reclaim and the start below: the race worth closing is two starters
    // both finding the same stale lock and the second unlinking the first's live one.
    const releaseGuard = await acquireLockGuard(dataDir)
    try {
      reclaimStaleLock(dataDir)
      seedScopeSettings(dataDir)
      const stripped = stripOutOfScopeLanes(dataDir)
      if (stripped.length > 0) log(`our-free-model-plus: 已关闭不在范围内的功能：${stripped.join('、')}`)
      applyBlocklistPolicy(dataDir, options.blocklist ?? BLOCKLIST_MODE, log)

      const service = await startStandalone({
        dataDir,
        // Only pass a port when the user asked for one. Upstream reuses the `standalonePort`
        // recorded in settings.json when this is undefined, which is what keeps the console at
        // a stable address across restarts. Passing 0 unconditionally overrode that and moved
        // the address every time — so the page the user was told to bookmark stopped working.
        ...(Number.isInteger(options.port) ? { port: options.port } : {}),
        refresh: options.refresh !== false,
        probe: options.probe,
        // The only lanes this plugin serves. Handing the list down is what removes the
        // anonymous free pool, Kilo, the EAC lane, the aggregate registry and the combos from
        // the service itself — they are not listed, not dialable, and not refreshed. Without
        // it the service would still fetch the free pool's listing every round and still
        // answer a request for one of its models by id.
        scope: [...CHANNEL_IDS],
        logger: { info: log, warn: log, error: log },
      })

      // Everything past this point can still throw (a missing or corrupt settings.json, say).
      // The service is already listening and holding its lock, and nothing else keeps a
      // reference to it yet, so it has to be closed here or it is leaked for good.
      const resolved = await adopt(service, log, options)
      if (startedAt !== epoch) {
        await resolved.dispose()
        throw new Error('服务在启动过程中被停止')
      }
      instances.set(dataDir, { identity: key, resolved })
      log(`our-free-model-plus: service up at ${service.url} (data ${dataDir})`)
      return resolved
    } finally {
      releaseGuard()
    }
  })().finally(() => { pending.delete(dataDir) })

  pending.set(dataDir, { identity: key, promise })
  return promise
}

/** Wait for the roster, then describe the running service. Closes it if anything throws. */
async function adopt(service, log, options = {}) {
  try {
    // `startStandalone` hands back before its own `ready` has settled: the channel worker
    // is up, but its model list is still being fetched. Reading `provider.models` before
    // that finishes yields an empty catalog, so wait — with a ceiling, because a slow
    // upstream must delay the model list, never block the plugin from loading.
    //
    // `ready` settling is not enough on its own: it resolves even when a channel's own
    // refresh failed, which is exactly the "signed in but lists nothing" state. So the
    // wait is driven by the endpoint magpie actually reads, until it serves a channel row.
    const settings = JSON.parse(fs.readFileSync(service.keyFile, 'utf8'))
    let rows = await countChannelRows(service.url, settings.forwardKey)
    if (rows === 0) {
      const settled = await Promise.race([
        service.ready.then(() => 'ready', error => `failed: ${error?.message ?? error}`),
        new Promise(resolve => { const t = setTimeout(() => resolve('timeout'), REFRESH_CEILING_MS); t.unref?.() }),
      ])
      // A short grace rather than the whole ceiling: past `ready`, an empty list means this
      // install simply has no accounts in scope — no reason to make the user wait for it.
      const grace = Date.now() + ROSTER_GRACE_MS
      while (rows === 0 && Date.now() < grace) {
        rows = await countChannelRows(service.url, settings.forwardKey)
        if (rows > 0) break
        await new Promise(resolve => { const t = setTimeout(resolve, REFRESH_POLL_MS); t.unref?.() })
      }
      if (rows === 0) log(`our-free-model-plus: 渠道清单为空（${settled}）；若你已登录渠道账号，稍后会自动重试`)
    }
    if (rows > 0) log(`our-free-model-plus: 渠道清单就绪，共 ${rows} 个模型`)

    // The console's front door. Magpie's sign-in cannot carry a repeatable entry point, so
    // this is what makes the page where the 12 accounts live reachable at any time.
    let consoleHandoff
    try {
      consoleHandoff = await createConsoleHandoff(service, options.consolePort ?? CONSOLE_PORT)
    } catch (error) {
      // A console we could not start must not cost the user their models.
      log(`our-free-model-plus: 控制台入口未能启动（${error?.message ?? error}）`)
    }

    // Starting it once at boot makes the entry permanently absent if that one attempt failed
    // — a transient port clash would cost the user the console for the life of the process.
    // So this tries again on demand, and concurrent callers share one attempt.
    let starting
    const consoleEntry = async () => {
      if (consoleHandoff) return consoleHandoff.ticket()
      starting ??= createConsoleHandoff(service, options.consolePort ?? CONSOLE_PORT)
        .then(handoff => { consoleHandoff = handoff; return handoff })
        .catch(error => {
          log(`our-free-model-plus: 控制台入口仍未能启动（${error?.message ?? error}）`)
          return undefined
        })
        .finally(() => { starting = undefined })
      const handoff = await starting
      return handoff?.ticket()
    }

    return {
      service,
      base: `${service.url}/v1`,
      key: settings.forwardKey,
      dataDir: service.dataDir,
      // A FRESH one-use link into the console, every time it is asked for.
      //
      // Handing back the fixed root address instead was the mistake that made the console
      // look unreachable: that address is a bare port, it reads as an address the user has
      // to remember, and there is no way for them to tell whether it still works. A ticket
      // is a link magpie opens for them, and minting one per call means the link on screen
      // is always live rather than whatever was minted at start-up.
      consoleEntry,
      // Kept for the diagnostics that print where the console lives; not the entry itself.
      consoleUrl: consoleHandoff?.url,
      async dispose() {
        instances.delete(service.dataDir)
        try { await consoleHandoff?.close() } catch { /* already gone */ }
        try { await service.close() } catch { /* already gone */ }
      },
    }
  } catch (error) {
    try { await service.close() } catch { /* nothing left to do but report the original */ }
    throw error
  }
}

/** Stop every instance this process started. Used on plugin dispose. */
export async function disposeAll() {
  epoch += 1
  // A start already under way is not in `instances` yet, so it is awaited here too: it
  // sees the new epoch and closes itself rather than publishing an unreleasable service.
  const inflight = [...pending.values()].map(entry => entry.promise.catch(() => undefined))
  await Promise.all(inflight)
  const all = [...instances.values()]
  instances.clear()
  await Promise.all(all.map(entry => entry.resolved.dispose()))
}

export function runningInstanceCount() {
  return instances.size
}
