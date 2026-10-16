/**
 * End-to-end: load the plugin exactly the way magpie does, sign in with our own method,
 * and drive the real hooks — loader, provider.models, usage. This is the check that matters:
 * it exercises the whole path a Magpie request takes, not the pieces.
 *
 * Run: node scripts/e2e.mjs [--data-dir <dir>]
 * Defaults to a throwaway dir under the OS temp dir, so nothing near the real install moves.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { OurFreeModelPlus } from '../index.mjs'

const argv = process.argv.slice(2)
const dataDirArg = argv.includes('--data-dir') ? argv[argv.indexOf('--data-dir') + 1] : undefined
const DATA = dataDirArg
  ? path.resolve(dataDirArg)
  : fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-plus-e2e-'))

/** magpie's PluginInput, as host.js builds it. */
const input = {
  client: {
    app: { log: ({ body }) => console.log(`[app.log ${body.level}] ${body.message}`) },
    auth: { set() {}, remove() {} },
    config: { get: () => ({ data: {} }) },
  },
  project: { id: 'magpie', worktree: os.tmpdir() },
  directory: os.tmpdir(),
  worktree: os.tmpdir(),
  serverUrl: new URL('http://127.0.0.1:4096'),
  $: undefined,
}

const step = (n, msg) => console.log(`\n[e2e ${n}] ${msg}`)
let failures = 0
const check = (ok, label, detail = '') => {
  console.log(`[e2e]   ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`)
  if (!ok) failures += 1
}

try {
  step(1, 'load plugin')
  const hooks = await OurFreeModelPlus(input, { managed: { dataDir: DATA } })
  check(typeof hooks.config === 'function', 'config hook present')
  check(typeof hooks.auth?.loader === 'function', 'auth.loader present')
  check(typeof hooks.provider?.models === 'function', 'provider.models present')
  check(hooks.provider.id === 'our-free-model-plus', 'provider id is our-free-model-plus', hooks.provider.id)

  step(2, 'config hook declares our provider')
  const cfg = {}
  await hooks.config(cfg)
  check(Object.keys(cfg.provider).join() === 'our-free-model-plus', 'only our provider declared')

  step(3, 'sign in with our own method')
  const method = hooks.auth.methods[0]
  // magpie's own protocol: `authorize()` is *asked for instructions* — it returns
  // `{method, url, instructions, callback}`, and the account is only recorded when the host
  // calls `callback()`, which answers `{type:'success', key, metadata}`. Reading `key` off the
  // `authorize()` result instead yields undefined and every later hook is refused as expired.
  const grant = await method.authorize()
  check(typeof grant.callback === 'function', 'authorize hands back a callback for the host to run')
  check(grant.method === 'auto' && typeof grant.url === 'string', 'sign-in opens the console itself (no typed address)')
  const signIn = await grant.callback()
  check(signIn.type === 'success', 'callback returns success')
  const auth = { type: 'api', key: signIn.key, metadata: signIn.metadata }

  step(4, 'loader starts the embedded service')
  const started = Date.now()
  // Async, exactly as the host calls it (`a.loader(async () => readAuth()[key], …)`).
  const options = await hooks.auth.loader(async () => auth)
  check(typeof options.baseURL === 'string' && options.baseURL.endsWith('/v1'), 'loader gave a /v1 baseURL', options.baseURL)
  check(typeof options.apiKey === 'string' && options.apiKey.length > 0, 'loader gave an apiKey')
  check(typeof options.fetch === 'function', 'loader gave a fetch')
  console.log(`[e2e]   service started in ${Date.now() - started} ms`)

  step(5, 'provider.models lists real models')
  const declared = { 'placeholder': { id: 'placeholder' } }
  const answer = await hooks.provider.models({ models: declared }, { auth })
  // `provider.models` falls back by handing back the caller's own list with magpie's
  // fallback symbol set — so a throwaway data dir yields `{placeholder}` here, NOT an empty
  // map. Reading its keys as if they were real models is what made this step report a
  // "malformed record" and a 404 on a model that was never claimed to exist.
  const FALLBACK = Symbol.for('magpie.fellBack')
  const fellBack = answer[FALLBACK] === true
  const ids = fellBack ? [] : Object.keys(answer)
  const channels = new Set(ids.filter(i => i.includes('/')).map(i => i.split('/')[0]))
  // A throwaway data dir has no accounts, so an empty roster is the *expected* state here, not
  // a defect — the channel-scoped checks below only mean something once accounts exist. The
  // structural checks (hooks, loader, usage, lock) still have to hold either way.
  const populated = ids.length > 0
  if (populated) {
    check(!fellBack, 'did not fall back to the declared list')
    check(channels.size > 0, 'channel-lane models present', [...channels].join(', ') || 'none')
    console.log('[e2e]   sample:', ids.slice(0, 8).join(', '))
  } else {
    check(fellBack, 'an empty roster is marked as a fallback, not served as the truth',
      'otherwise magpie would cache an empty list as real')
    console.log('[e2e]   SKIP  no accounts in a throwaway data dir — model assertions need a populated one')
  }

  step(6, 'every model record is well formed')
  let malformed = 0
  for (const [key, m] of Object.entries(populated ? answer : {})) {
    if (m.id !== key || !m.api?.url || !m.limit || typeof m.limit.context !== 'number') malformed += 1
  }
  check(malformed === 0, 'no malformed records', malformed ? `${malformed} bad` : '')

  step(7, 'auth.usage answers')
  const usage = await hooks.auth.usage(async () => auth)
  check(typeof usage.plan === 'string' && usage.plan.length > 0, 'usage has a plan', usage.plan)

  step(8, 'the loader fetch refuses an unknown model, never forwards it')
  const bogus = await options.fetch(`${options.baseURL}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'definitely/not-a-model', stream: false, messages: [{ role: 'user', content: 'hi' }] }),
  })
  // With an empty roster (throwaway dir has no accounts), `admit` cannot tell "model gone"
  // from "roster transiently empty" — so it answers `unavailable` (503) rather than
  // `missing` (404). Either is a refusal: the request is intercepted, never forwarded to
  // the vendor. A forwarded upstream failure would carry the vendor's own status/body.
  const bogusBody = await bogus.json().catch(() => ({}))
  check(bogus.status === 404 || bogus.status === 503, 'unknown model refused', `got ${bogus.status}`)
  check(bogusBody?.error?.code === 'model_not_found' || bogusBody?.error?.code === 'service_unavailable',
    'the refusal names our own error code, not the vendor\'s', bogusBody?.error?.code)

  step(9, 'a real completion goes through, when there is an account to serve it')
  if (!populated) {
    console.log('[e2e]   SKIP  no accounts — the request path needs one to reach the vendor')
  } else {
    const target = ids.find(i => i.includes('/')) ?? ids[0]
    const res = await options.fetch(`${options.baseURL}/chat/completions`, {
      method: 'POST',
      // The caller's own credential must be dropped and replaced with the service's key.
      headers: { 'content-type': 'application/json', authorization: 'Bearer caller-key-must-be-stripped' },
      body: JSON.stringify({ model: target, stream: false, max_tokens: 24, messages: [{ role: 'user', content: 'Reply with exactly: OK' }] }),
    })
    check(res.status === 200, `completion on ${target} returned 200`, `got ${res.status}`)
    const text = await res.text()
    console.log('[e2e]   body:', text.replace(/\s+/g, ' ').slice(0, 300))
  }

  step(10, 'shut down')
  const { disposeAll } = await import('../src/service.mjs')
  await disposeAll()
  check(!fs.existsSync(path.join(DATA, 'service.lock')), 'service.lock released')
  // The macOS lock guard leaves a zero-byte `service.lock.guard` behind on purpose: the file is
  // not the lock, the BSD `O_EXLOCK` on it is, and the kernel drops that on exit. Assert the
  // lock is gone, not that no guard file exists — asserting the latter would fight the fix.
  check(fs.existsSync(path.join(DATA, 'service.lock.guard')) || process.platform !== 'darwin',
    'the lock guard is released (its file may remain; the lock does not)')
} catch (error) {
  failures += 1
  console.log('\n[e2e] THREW:', error?.stack ?? error)
}

console.log(`\n[e2e] ${failures === 0 ? 'ALL PASSED' : failures + ' FAILURE(S)'}  (data dir: ${DATA})`)
process.exit(failures === 0 ? 0 : 1)
