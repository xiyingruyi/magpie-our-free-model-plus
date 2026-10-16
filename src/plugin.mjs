/**
 * The magpie hook surface.
 *
 * One provider (`our-free-model-plus`) that fronts the embedded service. The sign-in is a
 * self-issued sentinel, not a real grant: the service is local and loopback-only, so the
 * only thing worth proving is that this account points at the data dir this plugin owns.
 *
 * @module src/plugin.mjs
 */

import { ensureService, defaultDataDir, validateDataDir, runCheckin } from './service.mjs'
import { CHANNELS, CHANNEL_IDS, isChannelModel, channelOf } from './channels.mjs'

export { CHANNELS, CHANNEL_IDS, isChannelModel, channelOf }

/** The provider id magpie shows and routes on. Deliberately not `our-free-model`. */
export const PROVIDER = 'our-free-model-plus'

/** AI SDK package magpie uses to shape requests: chat completions against our service. */
const SDK = '@ai-sdk/openai-compatible'

/** Sentinel key saved as the account credential. Validated against the data dir below. */
const MANAGED_KEY = 'managed'

/** Marks a model as belonging to a channel lane, for the model list and diagnostics. */
const CHANNEL = 'channel'

/**
 * The symbol magpie reads to mean "keep the list you already had".
 *
 * A plugin falls back implicitly by handing back a *failed* call's list unchanged, but a
 * call that succeeded and simply found nothing has to say so on the list itself.
 */
const FALLBACK = Symbol.for('magpie.fellBack')

function send(client, level, message) {
  try { client?.app?.log?.({ body: { level, service: PROVIDER, message } }) } catch { /* logging must never break a request */ }
}

/** A model id safe to hand magpie: non-empty, trimmed, and not a prototype trap. */
function safeID(value) {
  if (typeof value !== 'string') return undefined
  const id = value.trim()
  if (id === '' || id === '__proto__' || id === 'constructor' || id === 'prototype') return undefined
  return id
}

function positive(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}

function boolean(value, fallback) {
  return typeof value === 'boolean' ? value : fallback
}

/**
 * Map one service row to a magpie model record.
 *
 * The service speaks a flattened OpenAI-ish row; magpie wants the OpenCode `Model` shape
 * with `api`, `limit` and `capabilities`. Reasoning variants keep the service's own effort
 * ids so the picker shows the real levels rather than invented ones.
 *
 * @param {object} row - a row from the service's /v1/models.
 * @param {string} base - the service's /v1 base, put on the model's own api block so a
 *   second instance (different data dir) can never be routed through this one's account.
 */
export function managedModel(row, base) {
  const id = safeID(row?.id)
  if (!id) return undefined

  const efforts = []
  const raw = row.reasoning_efforts ?? row.reasoning?.efforts
  if (Array.isArray(raw)) {
    for (const value of raw) {
      const effort = safeID(typeof value === 'string' ? value : value?.id)
      if (effort && !efforts.includes(effort)) efforts.push(effort)
    }
  }

  const variants = {}
  for (const effort of efforts) variants[effort] = { reasoningEffort: effort }

  const images = Array.isArray(row.input)
    ? row.input.includes('image')
    : boolean(row.vision, false)

  return {
    id,
    name: typeof row.name === 'string' && row.name.trim() ? row.name.trim() : id,
    api: { id, url: base, npm: SDK },
    limit: {
      // `0` means "the service did not say", which magpie reads as "leave it to the vendor"
      // rather than as a ceiling of zero. Inventing a small positive default here was the
      // bug: magpie clamps every request to `limit.output`, and a made-up 4096 truncated
      // replies on the 13 of 18 rows whose `max_tokens` is null — while a made-up 32768
      // context made the agent compact early on a model that really holds 1M.
      //
      // Other plugins (cline, qoder, workbuddy, minimax) all declare `output: 0` for the
      // same reason. A row that DOES carry a figure is passed through untouched.
      context: positive(row.context_window ?? row.context_length, 0),
      output: positive(row.max_tokens, 0),
    },
    capabilities: {
      temperature: true,
      reasoning: boolean(row.reasoning, efforts.length > 0),
      toolcall: boolean(row.tool_call ?? row.toolcall, true),
      attachment: images,
      input: { text: true, image: images, audio: false, video: false, pdf: false },
      output: { text: true, image: false, audio: false, video: false, pdf: false },
    },
    options: {},
    headers: {},
    variants,
    // A channel-lane model comes from a signed-in account; a bare id is a free pool.
    [CHANNEL]: row.channel ?? (id.includes('/') ? id.split('/')[0] : ''),
    free: true,
  }
}

/** The account this plugin recognises: ours, and pointing at our data dir. */
function checkAuth(auth, dataDir) {
  if (auth?.type !== 'api' || auth.key !== MANAGED_KEY || auth.metadata?.dataDir !== dataDir) {
    throw Object.assign(new Error('请在 Our Free Model Plus 供应商中重新启用'), { signIn: 'expired' })
  }
}

/**
 * Ask the service whether a model is live right now.
 *
 * magpie caches the model list, so a model the user disabled in the console would stay
 * selectable and fail at request time. Refuse it with a 404 instead, which magpie
 * understands as "this model is gone".
 */
/** The service's current model rows, or undefined if it could not be reached. */
async function liveRows(instance) {
  try {
    const res = await fetch(`${instance.base}/models`, { headers: { authorization: `Bearer ${instance.key}` } })
    if (!res.ok) return undefined
    const body = await res.json()
    const rows = body?.data ?? body?.models
    return Array.isArray(rows) ? rows : undefined
  } catch {
    return undefined
  }
}

/**
 * Ask the service whether a model is live right now.
 *
 * magpie caches the model list, so a model the user disabled in the console would stay
 * selectable and fail at request time. Refuse it with a 404 instead, which magpie
 * understands as "this model is gone".
 *
 * A *failed* catalog read is not evidence that the model is gone — reporting it as a 404
 * would tell the caller to pick a different model when the real problem is the service.
 * It returns a 503, which reads as what it is: try again.
 */
async function admit(instance, model) {
  const rows = await liveRows(instance)
  if (rows === undefined) return 'unavailable'
  // A successful read that yields an empty roster is the same transient state `provider.models`
  // answers with a fallback ("keep the cached list; retry"), not proof that this one model is
  // gone. Reporting it as `missing` here would 404 every cached model while the list says to
  // keep them, so the two gates would contradict each other. `unavailable` reads as what it
  // is — try again — and leaves the cached list alone.
  if (rows.length === 0) return 'unavailable'
  // Exact match, else the same id without a trailing "(level)" — the service accepts the
  // bare id and strips that suffix itself, so rejecting it here would be stricter than the
  // thing being guarded.
  const bare = String(model).replace(/\s*\([^)]*\)\s*$/, '')
  return rows.some(row => row?.id === model || row?.id === bare) ? 'ok' : 'missing'
}

/**
 * Strip a caller's own credentials before forwarding, then put ours back.
 *
 * magpie sends the service key it got from the loader, but a client may also have attached
 * its own `x-api-key` or `Authorization`; forwarding those would leak a foreign secret to
 * the local service and, worse, replace the key the service actually checks. So: drop
 * every inbound credential, then set exactly the service's own key.
 */
function sanitize(init, key) {
  const headers = new Headers(init?.headers ?? {})
  for (const name of ['authorization', 'x-api-key', 'api-key', 'x-goog-api-key', 'cookie']) headers.delete(name)
  headers.set('content-type', headers.get('content-type') ?? 'application/json')
  headers.set('authorization', `Bearer ${key}`)
  return { ...init, headers }
}

/**
 * Build the hook set magpie consumes.
 *
 * @param {object} input - magpie's PluginInput.
 * @param {object} options - `{ managed?: {...} }`; `managed:false` disables the plugin.
 */
export async function createPlusPlugin(input, options = {}) {
  if (options.managed === false) return {}

  const managed = options.managed ?? {}
  const directory = input?.directory ?? input?.worktree
  const dataDir = validateDataDir(managed.dataDir || defaultDataDir(directory), directory)
  const log = message => send(input?.client, 'info', String(message))

  // A stable per-install sign-in sentinel. The service reuses its own forwardKey across
  // restarts (it lives in settings.json), so nothing here needs to be secret.
  const account = { type: 'api', key: MANAGED_KEY, metadata: { dataDir } }

  const load = () => ensureService(input, { ...managed, dataDir }, log)

  return {
    async config(cfg) {
      cfg.provider ??= {}
      cfg.provider[PROVIDER] ??= {
        name: 'Our Free Model Plus',
        npm: SDK,
        models: {},
      }
    },

    auth: {
      provider: PROVIDER,
      maxConcurrency: positive(managed.maxConcurrency, 2),
      methods: [
        {
          // This is the community plugin's `authorizeConsole`, kept in the same shape on
          // purpose — `{url, method:'auto', instructions, callback}` is what magpie reads,
          // and matching it exactly is what makes this behave the same way in the UI.
          //
          // `type: 'oauth'`, not `'api'`: magpie renders an `'api'` method as a REQUIREMENT
          // for a pasted key and shows a key field no matter what `authorize` does. An
          // `'oauth'` method is called directly, so this asks the user for nothing.
          //
          // `method: 'auto'` is what makes magpie open the browser itself — the user never
          // types an address. The sign-in it records is `{type:'api', key:'managed'}`,
          // because that is what magpie's `save()` stores for a sign-in that returns a key.
          //
          // The menu is reached any time, not once: magpie's add sheet lists a plugin's
          // sign-in methods every time it is opened, and a plugin provider that is already
          // signed in still shows an "Add another … account" row under it (app.js
          // `renderAccounts`, `startSignIn` → `startPluginSignIn`). Recording the account is
          // still required — the host only calls `loader` when an account exists
          // (`if (a?.loader && stored)`), so without `callback` no model would ever be served.
          type: 'oauth',
          label: '打开账号管理控制台（登录 12 个渠道的账号）',
          async authorize() {
            let url
            try {
              const instance = await load()
              // A link that works once, minted now. Handing back a bare fixed address made
              // this read as something to memorise and could be stale; a ticket is a link
              // magpie opens, and it is live because it was just made.
              url = await instance.consoleEntry?.()
            } catch (error) {
              log(`our-free-model-plus: 管理控制台启动失败：${error?.message ?? error}`)
            }
            if (url) log(`our-free-model-plus: 账号管理控制台 ${url}`)
            return {
              // 'auto' is magpie opening the browser itself — the address is never something
              // the user has to remember or type.
              method: 'auto',
              ...(url ? { url } : {}),
              instructions: url
                ? '已在浏览器中打开账号管理控制台。12 个渠道的账号都在这个页面里登录和管理：\n'
                  + '• TRAE 和 Cline 还没有账号，点各自卡片上的登录\n'
                  + '• buddy / workbuddy / qoder / qodercn / zcode 的模型被全部关闭了，在页面里打开\n\n'
                  + '完成后回到 Magpie 刷新模型。以后要再打开控制台，回到「供应商 → Our Free Model Plus」'
                  + '这一项再点一次登录即可。'
                : '本地服务还没起来，控制台暂时打不开。稍等片刻再点一次，或查看 Magpie 日志。',
              async callback() {
                return { type: 'success', key: MANAGED_KEY, metadata: { dataDir } }
              },
            }
          },
        },
      ],

      async loader(getAuth) {
        // magpie passes an **async** getAuth (host: `a.loader(async () => readAuth()[key], …)`).
        // Reading it without awaiting yields a Promise, so every field check below sees
        // `undefined` and the sign-in reads as expired on every single request.
        const auth = await getAuth()
        checkAuth(auth, dataDir)
        const instance = await load()
        return {
          baseURL: instance.base,
          apiKey: instance.key,
          async fetch(request, init) {
            const url = typeof request === 'string' ? request : request?.url ?? String(request)
            const body = init?.body
            let model
            // `init.body` is a JSON string when magpie calls this, but a forwarding client
            // may hand over bytes, a stream, or nothing at all — none of which should make
            // this throw. Anything unreadable simply skips the gate below.
            try {
              if (typeof body === 'string') model = JSON.parse(body)?.model
              else if (body instanceof Uint8Array) model = JSON.parse(new TextDecoder().decode(body))?.model
            } catch { /* not ours to parse */ }
            if (init?.method === 'POST' && model) {
              const verdict = await admit(instance, model)
              if (verdict === 'missing') {
                return new Response(JSON.stringify({
                  error: { message: `模型 ${model} 当前不可用`, type: 'invalid_request_error', code: 'model_not_found' },
                }), { status: 404, headers: { 'content-type': 'application/json' } })
              }
              if (verdict === 'unavailable') {
                return new Response(JSON.stringify({
                  error: { message: `本地服务暂时无法读取模型清单，请稍后重试`, type: 'server_error', code: 'service_unavailable' },
                }), { status: 503, headers: { 'content-type': 'application/json', 'retry-after': '3' } })
              }
            }
            // Hand the response back untouched. magpie's host strips Content-Encoding and
            // Content-Length itself before re-streaming, and a Response's headers are
            // immutable here anyway — trying to edit them throws.
            return fetch(url, sanitize(init, instance.key))
          },
        }
      },

      async usage(getAuth) {
        // Async, like `loader` — see the note there.
        const auth = await getAuth()
        checkAuth(auth, dataDir)
        const instance = await load()
        const providers = instance.service.channels?.providers ?? []
        // The console is reached through the sign-in method, not here. Putting its one-use
        // ticket in `balance` looked harmless but is not: magpie caches the usage payload to
        // `quotas.json`, so a live `/open/<token>` URL — meant to be inert once used, and
        // minted for the browser to consume — was persisted to disk and re-shown on the
        // provider card long after it expired. The card names the console, not a stale link.
        return {
          plan: 'Our Free Model Plus · 一体化（全部渠道）',
          windows: [],
          error: '',
          balance: '账号管理控制台在「供应商 → Our Free Model Plus」中打开',
          user: `${providers.length} 个渠道可用`,
        }
      },

      /**
       * magpie's own daily check-in (签到) hook.
       *
       * Without this the only thing that ever used it was the service's own timer, which
       * fires once per process start and never re-arms — so a Magpie left open across
       * midnight checked in nothing that day, and nothing on screen ever said so. magpie
       * drives this one: a Go loop (`provider.KeepPluginsCheckedIn`) asks once per Beijing
       * day per account and retries same-day after a failure, and it renders the outcome on
       * the provider's card — 今日已签到 / 签到失败，magpie 稍后重试 — with a "Check in now"
       * button and an "Auto check-in" switch, for free.
       *
       * magpie asks once for this plugin's single sentinel account; the twelve channels are
       * fanned out inside `runCheckin` and reported as one aggregate outcome.
       *
       * This never throws. magpie reads a thrown hook as `failed` and loses the message with
       * it, so an unusable service is an outcome too — the reason reaches the card instead.
       */
      async checkin(getAuth) {
        try {
          const auth = await getAuth()
          checkAuth(auth, dataDir)
        } catch (error) {
          return { outcome: 'failed', credit: 0, streak: 0, message: error?.message ?? String(error) }
        }
        try {
          const instance = await load()
          const result = await runCheckin(instance.service)
          log(`our-free-model-plus: 每日签到（magpie 触发）—— ${result.message}`)
          return result
        } catch (error) {
          const message = error?.message ?? String(error)
          log(`our-free-model-plus: 每日签到失败：${message}`)
          return { outcome: 'failed', credit: 0, streak: 0, message }
        }
      },
    },

    provider: {
      id: PROVIDER,
      async models(provider, { auth } = {}) {
        // No account yet: hand back the declared (empty) list rather than starting a service.
        if (!auth) return provider.models
        checkAuth(auth, dataDir)
        const instance = await load()
        const res = await fetch(`${instance.base}/models`, { headers: { authorization: `Bearer ${instance.key}` } })
        if (!res.ok) throw new Error(`模型清单读取失败（${res.status}）`)
        const body = await res.json()
        const rows = body?.data ?? body?.models ?? []
        const out = {}
        for (const row of rows) {
          // Only the account channels are in scope. The service also serves the anonymous
          // pool, Kilo, the EAC lane and the aggregate registry; none of those are ours.
          if (!isChannelModel(row?.id)) continue
          const model = managedModel(row, instance.base)
          if (model) out[model.id] = model
        }
        if (Object.keys(out).length > 0) return out
        // Empty. Returning `provider.models` alone would NOT be safe: magpie decides a hook
        // fell back only when the call *failed* or when the list is explicitly marked
        // (host: `next === given.models && tried && !lastOk`), and this call succeeded — so
        // an unmarked empty map would be taken as the truth and wipe magpie's cached list.
        // The mark is what makes this a fallback, and an empty roster is a thing to retry
        // rather than a thing to believe: it means the accounts are not signed in, or the
        // channel upstream is briefly unhappy.
        const fallback = provider.models ?? {}
        try { fallback[FALLBACK] = true } catch { /* a frozen list is not worth failing over */ }
        return fallback
      },
    },
  }
}
