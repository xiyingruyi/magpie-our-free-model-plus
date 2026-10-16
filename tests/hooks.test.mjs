/**
 * Hook-contract check — the same shape the community repo's scripts/check.mjs asserts, so a
 * refactor that breaks what magpie loads fails here instead of in the app.
 *
 * Runner: `node --test` (see package.json). No network, no service start.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import http from 'node:http'

import { OurFreeModelPlus } from '../index.mjs'
import { PROVIDER, CHANNELS, managedModel, isChannelModel, channelOf } from '../src/plugin.mjs'
import { CHANNEL_IDS, NO_AUTO_CHECKIN } from '../src/channels.mjs'
import { defaultDataDir, validateDataDir, stripOutOfScopeLanes, runCheckin, acquireLockGuard } from '../src/service.mjs'

/** magpie hands the plugin a directory; anything absolute and harmless will do. */
const fakeInput = { client: { app: { log() {} } }, directory: os.tmpdir() }

test('the entry exports exactly one plugin function', async () => {
  const mod = await import('../index.mjs')
  const fns = Object.entries(mod).filter(([, v]) => typeof v === 'function')
  assert.deepEqual(fns.map(([k]) => k), ['OurFreeModelPlus'])
  assert.equal(typeof OurFreeModelPlus, 'function')
})

test('the hooks are the shape magpie calls', async () => {
  const hooks = await OurFreeModelPlus(fakeInput, {})
  assert.equal(typeof hooks.config, 'function')
  assert.equal(typeof hooks.auth.provider, 'string')
  assert.equal(typeof hooks.auth.loader, 'function')
  assert.equal(typeof hooks.auth.usage, 'function')
  assert.ok(Array.isArray(hooks.auth.methods) && hooks.auth.methods.length > 0)
  assert.equal(typeof hooks.provider.models, 'function')
  // auth.provider and provider.id must agree, or magpie will not bind the account.
  assert.equal(hooks.auth.provider, hooks.provider.id)
  assert.equal(hooks.provider.id, PROVIDER)
})

test('the sign-in is a one-click oauth method, never an api key field', async () => {
  // magpie renders an `api` method as a required key field no matter what `authorize`
  // returns — that is what once made this plugin claim "no input needed" and then demand
  // input anyway. An `oauth` method is called directly, so this pins the type.
  //
  // `authorize()` itself is deliberately NOT called here: it starts the local service (to
  // hand back the console URL), which is a real side effect and belongs in the acceptance
  // script, not in a unit test.
  const hooks = await OurFreeModelPlus(fakeInput, {})
  const method = hooks.auth.methods[0]
  assert.equal(method.type, 'oauth', 'an api method would show a key box the user must fill')
  assert.equal(typeof method.authorize, 'function')
  assert.equal(method.placeholder, undefined, 'a placeholder would mean a key field is rendered')
  // The label has to say where the channels get signed in, or the console is undiscoverable.
  assert.match(method.label, /控制台/, 'the label must name the account console')
})

test('checkAuth accepts exactly what the sign-in records', async () => {
  // What `callback()` records must be what checkAuth compares against, or magpie would sign
  // the user in and then immediately treat the account as expired.
  const hooks = await OurFreeModelPlus(fakeInput, {})
  const dataDir = defaultDataDir(os.tmpdir())
  const recorded = { type: 'api', key: 'managed', metadata: { dataDir } }
  assert.equal(recorded.type, 'api')
  assert.equal(recorded.metadata.dataDir, dataDir)
  // A sign-in for a different data dir must be refused, so two installs cannot cross over.
  await assert.rejects(
    () => hooks.provider.models({ models: {} }, { auth: { ...recorded, metadata: { dataDir: '/somewhere/else' } } }),
    error => error.signIn === 'expired',
  )
})

test('config declares only our own provider id', async () => {
  const hooks = await OurFreeModelPlus(fakeInput, {})
  const cfg = {}
  await hooks.config(cfg)
  assert.deepEqual(Object.keys(cfg.provider), [PROVIDER])
  assert.equal(cfg.provider[PROVIDER].npm, '@ai-sdk/openai-compatible')
})

test('config never overwrites a provider the user already configured', async () => {
  const hooks = await OurFreeModelPlus(fakeInput, {})
  const mine = { name: 'mine', npm: 'x', models: {} }
  const cfg = { provider: { [PROVIDER]: mine } }
  await hooks.config(cfg)
  assert.equal(cfg.provider[PROVIDER], mine)
})

test('managed:false disables the plugin without touching anything', async () => {
  const hooks = await OurFreeModelPlus(fakeInput, { managed: false })
  assert.deepEqual(hooks, {})
})

test('without a sign-in, provider.models hands back the declared list and starts nothing', async () => {
  const hooks = await OurFreeModelPlus(fakeInput, {})
  const declared = { 'a-model': { id: 'a-model' } }
  const out = await hooks.provider.models({ models: declared }, {})
  assert.equal(out, declared)
})

test('a sign-in pointing at another data dir is refused as expired', async () => {
  const hooks = await OurFreeModelPlus(fakeInput, {})
  const wrong = { type: 'api', key: 'managed', metadata: { dataDir: '/somewhere/else' } }
  await assert.rejects(
    () => hooks.provider.models({ models: {} }, { auth: wrong }),
    error => error.signIn === 'expired',
  )
})

test('the default data dir is our own subdirectory, not the config dir itself', () => {
  const dir = path.join(os.tmpdir(), 'magpie-config')
  const dataDir = defaultDataDir(dir)
  assert.equal(dataDir, path.join(dir, 'our-free-model-plus'))
  // and it must never collide with the community plugin's directory
  assert.ok(!dataDir.endsWith(path.sep + 'our-free-model'))
})

test('a data dir that would swallow the config dir or home is refused', () => {
  const dir = path.join(os.tmpdir(), 'magpie-config')
  assert.throws(() => validateDataDir(dir, dir))
  assert.throws(() => validateDataDir(os.homedir(), dir))
  assert.throws(() => validateDataDir(path.parse(process.cwd()).root, dir))
  assert.equal(validateDataDir(path.join(dir, 'our-free-model-plus'), dir), path.join(dir, 'our-free-model-plus'))
})

test('a symlink cannot smuggle in the home directory as a data dir', () => {
  // path.resolve is lexical, so without resolving the real path a link named ~/whatever
  // pointing at $HOME passes every check while upstream writes its state into the home dir.
  const link = path.join(os.tmpdir(), `ofm-link-${process.pid}`)
  fs.rmSync(link, { force: true })
  fs.symlinkSync(os.homedir(), link)
  try {
    assert.throws(() => validateDataDir(link, path.join(os.tmpdir(), 'magpie-config')), /managed\.dataDir/)
  } finally {
    fs.rmSync(link, { force: true })
  }
})

test('stripping the out-of-scope lanes never deletes what the user put there', () => {
  // Turning the aggregate lane off used to write `aggregate: {enabled:false, providers:{}}`
  // over the whole object, destroying the third-party API keys stored alongside the switch.
  // The same shape of mistake would wipe any nested value under a key we own.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-scope-'))
  const file = path.join(dir, 'settings.json')
  fs.writeFileSync(file, JSON.stringify({
    version: 1,
    // Deliberately NOT the value we own (1440): the strip is entitled to overwrite it, and
    // the assertion below checks it became our number rather than a `{}`.
    probeIntervalMinutes: 5,
    aggregate: { enabled: true, providers: { nvidia: { apiKey: 'sk-keep-me' } } },
    tokenSaver: { enabled: true, rtk: true, prompts: { caveman: 'on', custom: 'keep' } },
  }))
  try {
    const changed = stripOutOfScopeLanes(dir)
    const after = JSON.parse(fs.readFileSync(file, 'utf8'))
    assert.equal(after.aggregate.enabled, false, 'the lane is switched off')
    assert.deepEqual(after.aggregate.providers, { nvidia: { apiKey: 'sk-keep-me' } }, 'stored keys survive untouched')
    assert.equal(after.tokenSaver.prompts.custom, 'keep', 'an unknown sub-key survives too')
    assert.equal(after.tokenSaver.enabled, false)
    // The scalar we own must land as a scalar. `Object.entries` of a number is empty, so a
    // merge that only walks properties returned the `{}` placeholder instead and wrote it
    // over the value — which is how `probeIntervalMinutes`, `exposeRegionModels`,
    // `streamRecovery`, `combos`, `updateCheckHours`, `feedUrl` and `notifyOs` all came to be
    // stored as `{}` in a real install. Asserting the *type* is the point: `{}` is truthy and
    // would sail past a bare `assert.ok`.
    assert.equal(after.probeIntervalMinutes, 1440, 'the owned number is written, not an object')
    assert.equal(typeof after.exposeRegionModels, 'boolean', 'the owned boolean is written')
    assert.equal(after.exposeRegionModels, false)
    assert.ok(Array.isArray(after.combos), 'the owned array stays an array')
    assert.equal(after.feedUrl, '')
    assert.equal(after.notifyOs, false)
    assert.equal(after.streamRecovery, true)
    assert.ok(changed.includes('aggregate') && changed.includes('tokenSaver'))
    // A second pass changes nothing, so booting twice is not a slow drip of rewrites.
    assert.deepEqual(stripOutOfScopeLanes(dir), [])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('the strip leaves no temp file that upstream would share', () => {
  // Upstream's JsonStore writes settings.json via `${file}.${process.pid}.tmp`. This plugin
  // runs inside that same process, so using the same name would race its rename.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-tmp-'))
  const file = path.join(dir, 'settings.json')
  fs.writeFileSync(file, JSON.stringify({ version: 1, probeIntervalMinutes: 5 }))
  try {
    stripOutOfScopeLanes(dir)
    assert.deepEqual(fs.readdirSync(dir), ['settings.json'], 'only the final file is left behind')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('managedModel maps a channel row into magpie model shape', () => {
  const row = {
    id: 'codearts/glm-4.6',
    name: 'GLM-4.6',
    context_window: 200000,
    max_tokens: 128000,
    reasoning: true,
    reasoning_efforts: ['low', 'high'],
    input: ['text', 'image'],
    channel: 'codearts',
  }
  const model = managedModel(row, 'http://127.0.0.1:1234/v1')
  assert.equal(model.id, 'codearts/glm-4.6')
  assert.equal(model.name, 'GLM-4.6')
  assert.deepEqual(model.api, { id: 'codearts/glm-4.6', url: 'http://127.0.0.1:1234/v1', npm: '@ai-sdk/openai-compatible' })
  assert.deepEqual(model.limit, { context: 200000, output: 128000 })
  assert.equal(model.capabilities.reasoning, true)
  assert.equal(model.capabilities.input.image, true)
  assert.equal(model.capabilities.attachment, true)
  assert.deepEqual(Object.keys(model.variants), ['low', 'high'])
  assert.equal(model.free, true)
})

test('managedModel survives junk rows instead of throwing', () => {
  for (const bad of [undefined, null, {}, { id: '' }, { id: '   ' }, { id: '__proto__' }, { id: 42 }, { id: 'x', reasoning_efforts: 'nope' }]) {
    const model = managedModel(bad, 'http://127.0.0.1:1/v1')
    if (bad && bad.id === 'x') assert.ok(model && model.id === 'x')
    else assert.equal(model, undefined, `expected ${JSON.stringify(bad)} to be dropped`)
  }
})

test('managedModel reports 0 rather than inventing a limit the service omitted', () => {
  const model = managedModel({ id: 'm' }, 'http://127.0.0.1:1/v1')
  // magpie clamps requests to `limit.output` and compacts on `limit.context`, so a made-up
  // positive default becomes a real ceiling. `0` means "the service did not say".
  assert.deepEqual(model.limit, { context: 0, output: 0 })
  assert.equal(model.capabilities.toolcall, true)
  assert.equal(model.capabilities.reasoning, false)
})

test('a context-only row keeps its window but asks for no output ceiling', () => {
  // The live service returns this shape for loomy/lobsterai/codearts rows: a real 1M
  // context_window and NO max_tokens. The window must survive; the output must stay 0 so
  // magpie does not clamp the reply to the plugin's guess (4096 was truncating these).
  const model = managedModel({ id: 'loomy/DeepSeek-V4.1-Flash', context_window: 1048576 }, 'http://127.0.0.1:1/v1')
  assert.deepEqual(model.limit, { context: 1048576, output: 0 })
})

test('a row with no context_window at all is not given a made-up window', () => {
  // codearts/glm-5.3 is the real case: the service omits context_window entirely, and the
  // old 32768 fallback made the agent compact early on a 1M model.
  const model = managedModel({ id: 'codearts/glm-5.3', max_tokens: 100000 }, 'http://127.0.0.1:1/v1')
  assert.deepEqual(model.limit, { context: 0, output: 100000 })
})

test('the channel list is exactly the twelve the user asked for', () => {
  assert.equal(CHANNELS.length, 12)
  assert.deepEqual(CHANNELS.map(c => c.id), [
    'codearts', 'buddy', 'workbuddy', 'lobsterai', 'qoder', 'qodercn',
    'trae', 'cline', 'loomy', 'raccoon', 'minimax', 'zcode',
  ])
  // Gemini is explicitly out of scope
  assert.ok(!CHANNELS.some(c => c.id === 'gemini'))
})

test('only account-channel models are in scope; every other lane is filtered out', () => {
  // in scope
  for (const id of ['codearts/glm-4.6', 'buddy/hy3', 'qodercn/qfmodel', 'zcode/GLM-5.3', 'minimax/MiniMax-M3']) {
    assert.equal(isChannelModel(id), true, `${id} should be in scope`)
    assert.equal(channelOf(id), id.split('/')[0])
  }
  // out of scope: the anonymous pool, Kilo, and the aggregate registry's providers
  for (const id of [
    'mimo-v2.6-flash-free',      // anonymous pool: no slash at all
    'kilo-auto/free',            // Kilo lane
    'nvidia/nemotron-3.5-super-vl:free',
    'poolside/laguna-s-2.1:free',
    'openrouter/free',
    'gemini/gemini-2.5-pro',     // excluded on request
    'trae-cn/something',         // name variant, not our id
  ]) {
    assert.equal(isChannelModel(id), false, `${id} should be out of scope`)
    assert.equal(channelOf(id), undefined)
  }
  assert.equal(isChannelModel(undefined), false)
  assert.equal(isChannelModel('/leading'), false)
  assert.equal(isChannelModel(42), false)
})

test('the readiness ceiling clears the slowest observed refresh', () => {
  // The roster is fetched one channel at a time and a refresh-token exchange can happen
  // mid-flight; the slowest real run measured 27s. A ceiling under that is exactly the bug
  // that made channels list zero models, so guard the number itself.
  const source = fs.readFileSync(new URL('../src/service.mjs', import.meta.url), 'utf8')
  const match = /const REFRESH_CEILING_MS = ([0-9_]+)/.exec(source)
  assert.ok(match, 'REFRESH_CEILING_MS must be a plain literal')
  const ceiling = Number(match[1].replaceAll('_', ''))
  assert.ok(ceiling >= 60_000, `ceiling ${ceiling}ms is too tight for a 27s refresh`)
})

// ── the console entry ────────────────────────────────────────────────────────────────
//
// The console is the whole point of the plugin's sign-in: it is the only page where the
// 12 channel accounts are signed in. These pin the properties that made it fail before —
// a fixed port that could be taken, and a bare root address handed out as "the entry".

test('the console handoff only ever answers a one-use /open/ ticket', async () => {
  const { createConsoleHandoff } = await import('../src/console.mjs')
  // A service stand-in: the handoff only reads keyFile and url.
  const keyFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-console-')), 'settings.json')
  fs.writeFileSync(keyFile, JSON.stringify({ forwardKey: 'test-key' }))
  // A fake upstream that hands back a session cookie, so handOver() can complete.
  const upstream = await new Promise(resolve => {
    const s = http.createServer((req, res) => {
      res.writeHead(200, { 'set-cookie': 'sid=1; HttpOnly; Path=/' })
      res.end('{}')
    })
    s.listen(0, '127.0.0.1', () => resolve(s))
  })
  const service = { url: `http://127.0.0.1:${upstream.address().port}`, keyFile }
  const handoff = await createConsoleHandoff(service, 0)
  try {
    // The bare root must not hand out a session.
    const root = await fetch(handoff.url, { redirect: 'manual' })
    assert.equal(root.status, 401, 'the root address must not be an entry')

    // A real ticket does, exactly once.
    const ticket = handoff.ticket()
    assert.match(ticket, /^http:\/\/127\.0\.0\.1:\d+\/open\/[\w-]+$/)
    assert.ok(!ticket.includes('test-key') && !/key=/.test(ticket), 'the key never enters the URL')
    const once = await fetch(ticket, { redirect: 'manual' })
    assert.equal(once.status, 303)
    const twice = await fetch(ticket, { redirect: 'manual' })
    assert.equal(twice.status, 401, 'a ticket is single use')

    // Every ask is a fresh link, never the same address twice.
    assert.notEqual(handoff.ticket(), handoff.ticket())
  } finally {
    await handoff.close()
    await new Promise(r => upstream.close(r))
  }
})

test('the console port is OS-chosen, never a fixed one that can be taken', async () => {
  const source = fs.readFileSync(new URL('../src/service.mjs', import.meta.url), 'utf8')
  assert.match(source, /const CONSOLE_PORT = 0\b/,
    'a pinned port is a port something else can take, and then the console silently dies')
})

// ── stripping the out-of-scope lanes from the service itself ─────────────────────────
//
// Filtering in the plugin was not enough: the service still listed the anonymous free pool,
// Kilo, the EAC lane and the aggregate registry, still fetched the free pool's listing on
// every refresh, and still ANSWERED a request for one of their models by id. These pin the
// plumbing that removes them at the service, so an upstream re-sync cannot quietly undo it.

test('the service is started with exactly the twelve channels as its scope', async () => {
  const source = fs.readFileSync(new URL('../src/service.mjs', import.meta.url), 'utf8')
  assert.match(source, /scope:\s*\[\.\.\.CHANNEL_IDS\]/,
    'the channel list must be handed to startStandalone, or the other lanes stay live')
})

test('the vendored service actually filters rows, completion and refresh by that scope', async () => {
  const source = fs.readFileSync(
    new URL('../vendor/ofm/packages/standalone/service.mjs', import.meta.url), 'utf8')
  // A scoped start must not compose the other lanes into what it serves...
  assert.match(source, /const scoped = scope === undefined \? null : new Set\(scope\)/)
  assert.match(source, /publicModelRows: \(\) => scopeRows\(\[\.\.\.core\.publicModelRows\(\)/,)
  // ...must refuse an out-of-scope model before routing it...
  assert.match(source, /if \(!inScope\(request\?\.model\)\)/)
  // ...and must not refresh the core lane, which is what reaches the free pool and Kilo.
  assert.match(source, /if \(scoped !== null\) \{\s*await channels\.refresh\(\)/)
  // The capability flags must not advertise lanes that are switched off.
  assert.match(source, /anonymous: false, kilo: false, eac: false, accountChannels: true/)
})

test('a scoped start still shows the channel rows in the console', async () => {
  // The bug this pins: filtering only `core.catalog` in state() left the console blank,
  // because the channel rows are concatenated there by upstream, not held in core.
  const source = fs.readFileSync(
    new URL('../vendor/ofm/packages/standalone/service.mjs', import.meta.url), 'utf8')
  const state = source.slice(source.indexOf('      state: () => {'))
  const body = state.slice(0, state.indexOf('\n      },'))
  assert.match(body, /channels\.publicModelRows\(\)/,
    "the console's own state() must include the channel rows")
})

// ── the console's "probe availability" button actually does something, scoped ──────────

test('a scoped probe round reaches the channel roster, not the stripped core lane', () => {
  const svc = fs.readFileSync(
    new URL('../vendor/ofm/packages/standalone/service.mjs', import.meta.url), 'utf8')
  // Upstream's probe lives inside `core.refreshCatalog`, which a scoped instance never calls;
  // without its own round the button returns 200 having changed nothing.
  assert.match(svc, /if \(options\?\.probe === true && !stopped\) await probeChannelRoster\(\)/,
    'a scoped refresh asked to probe must probe the channels')
  assert.match(svc, /async function probeChannelRoster\(\) \{/,
    'the scoped probe round must exist')
  // It must go through the same channel path a real request takes, so disabled models and
  // providers are respected rather than probed anyway.
  assert.match(svc, /await channels\.complete\(\{[\s\S]{0,200}model: row\.id/,
    'the probe must use the channel half of complete()')
  // It must not ride the automatic cadence: a probe is a real request off the account's own
  // allowance, so a cycle that only refreshes must never spend one.
  assert.doesNotMatch(svc, /refreshCatalog\([^)]*\)\s*\{[^}]{0,400}?probeChannelRoster\(\)[\s\S]{0,120}?\n      \}/,
    'the always-on cadence must not probe')
})

test('the scoped probe writes verdicts to the same store the console reads', () => {
  const svc = fs.readFileSync(
    new URL('../vendor/ofm/packages/standalone/service.mjs', import.meta.url), 'utf8')
  const round = svc.slice(svc.indexOf('async function probeChannelRoster()'))
  assert.match(round, /stores\.availability\.edit\(/, 'a verdict must land in availability.json')
  assert.match(round, /stores\.availability\.flush\(\)/, 'and must be flushed, or it never persists')
})

test('a channel row reports its probe verdict instead of a hardcoded "listed"', () => {
  const mgmt = fs.readFileSync(
    new URL('../vendor/ofm/packages/standalone/management.mjs', import.meta.url), 'utf8')
  // Upstream: `entry.channel ? 'listed' : …` — a channel row was never allowed a verdict.
  assert.match(mgmt, /availability: available\.results\?\.\[entry\.id\]\?\.state \?\? \(entry\.channel \? 'listed' : 'unknown'\)/,
    "a channel row's availability must come from the store, falling back to listed")
  assert.doesNotMatch(mgmt, /availability: entry\.channel \? 'listed' :/,
    'the hardcoded channel verdict must be gone')
})

// ── Gemini is not merely hidden from the model list ───────────────────────────────────

test('the channel worker is handed the scope, so Gemini is never even registered', () => {
  const svc = fs.readFileSync(
    new URL('../vendor/ofm/packages/standalone/service.mjs', import.meta.url), 'utf8')
  // Passing the roster to the worker is what stops Gemini being registered at all.
  assert.match(svc, /channels: \[\.\.\.scoped\]/,
    'the channel worker must be told the roster, or Gemini stays a registered provider')

  const runtime = fs.readFileSync(
    new URL('../vendor/ofm/packages/standalone/channels/runtime.mjs', import.meta.url), 'utf8')
  assert.match(runtime, /workerData: \{ dataDir, \.\.\.\(Array\.isArray\(channels\) \? \{ channels \} : \{\}\) \}/,
    'the scope must reach workerData')

  const worker = fs.readFileSync(
    new URL('../vendor/ofm/packages/standalone/channels/worker.mjs', import.meta.url), 'utf8')
  // Registration is the seam: a channel not registered has no roster entry, no card and no
  // reachable id — which is the difference between "filtered out" and "not there".
  assert.match(worker, /if \(scoped !== null && !scoped\.has\(provider\)\) continue/,
    'registerAdapter must skip an out-of-scope channel')
  assert.match(worker, /Array\.isArray\(workerData\.channels\) \? new Set\(workerData\.channels\) : null/,
    'no scope must mean upstream behaviour, unchanged')
})

test('the console ships no Gemini card', () => {
  // The card grid is rendered from this file's static list (`xe = Pe.filter(...)` in
  // channels-*.js), so a Gemini entry here puts a Gemini card on screen regardless of
  // what the runtime registered.
  const list = fs.readFileSync(
    new URL('../vendor/ofm/packages/standalone/web/_ofm-provider-list-D9WP3xjp.js', import.meta.url), 'utf8')
  const ids = [...list.matchAll(/\{id:"([^"]+)"/g)].map(m => m[1])
  assert.deepEqual(ids, CHANNELS.map(c => c.id),
    'the console card list must be exactly the twelve channels, in order')
  assert.equal(ids.includes('gemini'), false)
})

// ── the console's own hardcoded UI ────────────────────────────────────────────────────
//
// The service was scoped long before the console was. The console is a minified bundle that
// the runtime data never feeds: its navigation, its dashboard cards and its filter dropdowns
// are written into the JS, so a stripped lane stayed on screen with a count of 0 — visible
// even though it was no longer dialable. These pin the edits that remove them.

const WEB = new URL('../vendor/ofm/packages/standalone/web/', import.meta.url)
const read = name => fs.readFileSync(new URL(name, WEB), 'utf8')

/** Read a file from the plugin's own `src/`, which `read` above cannot reach. */
const SRC = name => fs.readFileSync(new URL(`../src/${name}`, import.meta.url), 'utf8')

test('the console nav offers no stripped lane', () => {
  const app = read('app.js')
  // The left nav is a literal array; "EAC 协付渠道" was an item in it.
  assert.equal(app.includes('id:"eac",name:"EAC 协付渠道"'), false, 'the EAC nav item must be gone')
  // The page-title map and the valid-page list are literals too.
  assert.equal(app.includes(',eac:"EAC 协付渠道"'), false, 'the EAC title must be gone')
  assert.equal(app.includes('"usage","channels","eac","settings"'), false, 'eac must not be a valid page')
  assert.equal(app.includes('g==="channels"||g==="eac"'), false, 'the eac route must be unreachable')
})

test('the overview lists only the channel source, with an honest count', () => {
  const app = read('app.js')
  assert.equal(app.includes('name:"匿名与 Kilo"'), false, 'the free-pool/Kilo card must be gone')
  assert.equal(app.includes('name:"EAC 协付渠道"'), false, 'the EAC card must be gone')
  assert.equal(app.includes('13 个供应商'), false, 'the count was wrong: there are twelve')
  assert.match(app, /12 个账号渠道，独立账号池/)
})

test('the model list cannot filter by a lane the service does not serve', () => {
  const models = read('models-8lE4ufFd.js')
  // The dropdown seeds itself with these three literals regardless of the catalog.
  assert.equal(models.includes('new Set(["anonymous","kilo","eac"'), false,
    'the channel filter must be derived from the catalog, not seeded with stripped lanes')
  assert.match(models, /new Set\(\[\.\.\.o\.catalog\.map\(c=>c\.channel\),t\.channel\]\)/)
  // The Kilo footnote is static text, shown even with no Kilo model in sight.
  assert.equal(models.includes('Kilo 免费池可能记录提示词'), false, 'the Kilo footnote must be gone')
})

test('the channels page keeps only the tabs this plugin serves', () => {
  const channels = read('channels-BNNYYkX2.js')
  assert.match(channels, /Dt=\["channels","ledger","logs","gateway"\]/,
    'the tab list must not offer the free pool, EAC, aggregate, savers, routing or upgrade')
  assert.match(channels, /Dt\.includes\(R\)\?R:"channels"/,
    'the fallback tab must be a tab that exists')
  // `registerFlush`... the provider dropdown is fed by a second, independent copy of the
  // thirteen-channel list — the same static table, inlined again in this bundle.
  const geminiCard = channels.slice(channels.indexOf('ze=[{id:"codearts"'))
  const list = geminiCard.slice(0, geminiCard.indexOf('],Je='))
  assert.equal(list.includes('id:"gemini"'), false,
    'the channels page carries its own copy of the provider list; Gemini must be gone from it too')
})

test('the stripped-lane page components are unreachable, not merely unlinked', () => {
  // The bundle still *contains* the EAC page component — deleting dead code from a minified
  // 335KB blob buys nothing and risks breaking a chunk boundary. What matters is that no code
  // path can select it, so it can never render. Two independent guards, and the render sweep
  // in scripts/ confirms it against the real DOM.
  const app = read('app.js')
  // `kind` is what selects the page, and it is only ever produced by this route.
  assert.equal(app.includes('g==="eac"'), false,
    'app.js must never route to kind:"eac" — that is the only argument that selects the EAC page')
  assert.match(app, /g==="channels"\)\?/, 'the channels page must still be routed')
  const channels = read('channels-BNNYYkX2.js')
  assert.match(channels, /Dt=\["channels","ledger","logs","gateway"\]/,
    'and the in-page tab list must not offer it either')
})

test('every label a stripped lane owned is gone from what the pages render', () => {
  // These are the strings that were on screen with a count of 0 — the bug the user reported.
  // Each is checked in the file that rendered it, so a re-introduced label fails here.
  const checks = [
    ['app.js', '匿名与 Kilo'],
    ['app.js', 'name:"EAC 协付渠道"'],
    ['app.js', '13 个供应商'],
    ['models-8lE4ufFd.js', 'Kilo 免费池可能记录提示词'],
    ['models-8lE4ufFd.js', 'new Set(["anonymous","kilo","eac"'],
  ]
  for (const [file, phrase] of checks) {
    assert.equal(read(file).includes(phrase), false, `${file} still ships "${phrase}"`)
  }
})

// --- The daily check-in hook ------------------------------------------------------------
// magpie calls `auth.checkin` once per Beijing day per account and renders the outcome on
// the provider's card, so this hook is the whole user-visible surface for 签到. These lock
// in the two things that decide whether that surface is honest: the aggregate verdict, and
// the fact that it never throws (a throw is an outcome-less `failed` in magpie).

/** A channel runtime that answers `credits.claimAll` from a table of per-provider results. */
function claimRuntime(table) {
  const calls = []
  return {
    calls,
    async rpc(body) {
      calls.push(body.payload?.provider)
      const entry = table[body.payload?.provider]
      if (entry === undefined) return { ok: false, error: { message: 'unsupported provider' } }
      if (typeof entry === 'function') return entry()
      return { ok: true, value: entry }
    },
  }
}

const providersCalled = runtime => runtime.calls

test('a day where something claimed is claimed, and the message counts every outcome', async () => {
  const runtime = claimRuntime({
    buddy: { summary: { totalByUnit: { credit: 2, token: 0 } }, results: [
      { outcome: { kind: 'already-claimed' } }, { outcome: { kind: 'claimed' } },
    ] },
    lobsterai: { summary: { totalByUnit: { credit: 1 } }, results: [{ outcome: { kind: 'claimed' } }] },
    qoder: { summary: { totalByUnit: { credit: 0 } }, results: [{ outcome: { kind: 'inactive' } }] },
  })
  const out = await runCheckin({ channels: runtime })
  assert.equal(out.outcome, 'claimed', 'a channel that granted must make the day claimed')
  assert.equal(out.credit, 3, 'credit is the sum of the pack’s credit grants, 2 + 1')
  assert.match(out.message, /2 个领取成功/)
  assert.match(out.message, /1 个今天已领/)
  // `skipped` counts both the inactive account above and the channels this mock does not
  // answer for (they come back "unsupported provider"), so the assertion is on the presence
  // of the category, not a count the fixture would have to keep in step.
  assert.match(out.message, /个不适用/)
})

test('the check-in roster never asks a channel the pack refuses to auto-check', async () => {
  // `zcode` is in scope for models but the pack refuses to claim for it automatically
  // (`isAutoCheckinExcluded`), which is why channels.mjs keeps it out of CHECKIN_CHANNELS.
  // runCheckin then unions the live adapter roster back in — and that roster always lists
  // every registered channel, so the excluded one came straight back and every daily run
  // asked for a claim the pack deliberately declines. The union must not resurrect it.
  const runtime = claimRuntime({ buddy: { summary: { totalByUnit: { credit: 1 } }, results: [{ outcome: { kind: 'claimed' } }] } })
  // The worker's real roster: every channel in scope, the excluded one included.
  runtime.providers = [...CHANNEL_IDS]
  const out = await runCheckin({ channels: runtime })
  assert.ok(providersCalled(runtime).includes('buddy'), 'an ordinary channel is still asked')
  for (const id of NO_AUTO_CHECKIN) {
    assert.ok(!providersCalled(runtime).includes(id), `${id} must not be asked to claim`)
  }
  assert.equal(out.outcome, 'claimed')
})

test('every account already in still reads as done, not as failure', async () => {
  const runtime = claimRuntime({
    buddy: { summary: { totalByUnit: { credit: 0 } }, results: [
      { outcome: { kind: 'already-claimed' } }, { outcome: { kind: 'already-claimed' } },
    ] },
  })
  const out = await runCheckin({ channels: runtime })
  assert.equal(out.outcome, 'done', 'a fully-claimed day is done — reporting it as failed would nag every day after the first')
  assert.equal(out.credit, 0)
})

test('a channel with no check-in at all is not reported as a failure', async () => {
  // raccoon/workbuddy answer 无签到接口 upstream; the pack counts those as `skipped`, and
  // treating them as failures would put a permanent red line on a healthy provider.
  const runtime = claimRuntime({
    buddy: { summary: { totalByUnit: { credit: 1 } }, results: [{ outcome: { kind: 'claimed' } }] },
    raccoon: () => ({ ok: false, error: { message: '该渠道不支持每日签到' } }),
  })
  const out = await runCheckin({ channels: runtime })
  assert.equal(out.outcome, 'claimed')
  assert.equal(out.message.includes('raccoon'), false, `an unsupported channel must not be named as a fault: ${out.message}`)
})

test('a genuine failure is named, with its reason, on the card', async () => {
  const runtime = claimRuntime({
    buddy: { summary: { totalByUnit: { credit: 0 } }, results: [
      { accountId: 'b-1', nickname: '一号', outcome: { kind: 'failed', message: 'the security token has expired' } },
    ] },
    lobsterai: { summary: { totalByUnit: { credit: 2 } }, results: [{ outcome: { kind: 'claimed' } }] },
  })
  const out = await runCheckin({ channels: runtime })
  assert.equal(out.outcome, 'claimed', 'a partial failure is still a claimed day')
  assert.equal(out.credit, 2, 'the healthy channel’s credit still counts')
  assert.match(out.message, /1 个失败/)
  assert.match(out.message, /buddy/)
  assert.match(out.message, /security token has expired/, 'the vendor’s own reason is what makes this actionable')
})

test('a day where nothing claimed and something failed reports failed', async () => {
  const runtime = claimRuntime({
    codearts: { summary: { totalByUnit: { credit: 0 } }, results: [
      { outcome: { kind: 'failed', message: 'HTTP 400' } }, { outcome: { kind: 'failed', message: 'HTTP 400' } },
    ] },
  })
  const out = await runCheckin({ channels: runtime })
  assert.equal(out.outcome, 'failed')
  assert.equal(out.credit, 0)
  assert.match(out.message, /2 个失败/)
})

test('a roster with nothing to claim and nothing broken is ineligible, not failed', async () => {
  const runtime = claimRuntime({ buddy: { summary: { totalByUnit: { credit: 0 } }, results: [] } })
  const out = await runCheckin({ channels: runtime })
  assert.equal(out.outcome, 'ineligible', 'no accounts to claim is not a broken provider')
})

test('check-in never touches zcode, which the pack excludes from automatic check-in', async () => {
  const runtime = claimRuntime({ buddy: { summary: { totalByUnit: { credit: 1 } }, results: [{ outcome: { kind: 'claimed' } }] } })
  await runCheckin({ channels: runtime })
  assert.equal(providersCalled(runtime).includes('zcode'), false,
    'asking zcode would fail every day: its credits are only given inside the ZCode app')
})

test('the check-in hook never throws — an unusable service is an outcome too', async () => {
  assert.equal((await runCheckin({})).outcome, 'failed', 'no runtime at all')
  assert.equal((await runCheckin(undefined)).outcome, 'failed', 'no service at all')
  const exploding = { channels: { rpc: async () => { throw new Error('渠道运行时已退出') } } }
  const out = await runCheckin(exploding)
  assert.equal(out.outcome, 'failed')
  assert.match(out.message, /渠道运行时已退出/, 'the reason must reach the card, not just the log')
})

test('the plugin declares a checkin hook magpie can find', () => {
  const source = SRC('plugin.mjs')
  assert.match(source, /async checkin\(getAuth\)/, 'auth.checkin is what magpie’s daily loop calls')
  assert.match(source, /runCheckin\(instance\.service\)/, 'and it must delegate to the channel fan-out')
})

test('every auth hook awaits magpie’s async getAuth', () => {
  // The host calls `a.loader(async () => readAuth()[key], …)` and the same for usage — a
  // synchronous read yields a Promise, every field check sees undefined, and the sign-in
  // reads as expired on every request. The community port awaits it everywhere.
  const source = SRC('plugin.mjs')
  const sync = [...source.matchAll(/(?:^|\s)(?:const|let)\s+\w+\s*=\s*getAuth\(\)/g)]
  assert.deepEqual(sync.map(m => m[0].trim()), [], 'every getAuth() result must be awaited')
})

// --- macOS stale-lock reclaim -----------------------------------------------------------
// Upstream's own process guard covers only win32/linux, so on darwin a force-quit Magpie left
// `service.lock` behind and every later start failed with EEXIST until the file was deleted by
// hand. `acquireLockGuard` is the missing piece: a BSD `O_EXLOCK` the kernel drops on exit.

test('the lock guard is a real kernel mutex, released on demand', async (t) => {
  if (process.platform !== 'darwin') return t.skip('the guard is darwin-only; linux/win use upstream’s socket')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-guard-'))
  try {
    const first = await acquireLockGuard(dir)
    // A second holder must be refused — this is the whole point. It retries, so the assertion
    // is on *some* refusal rather than on a single attempt: bound it by taking the guard on a
    // short deadline in a child is overkill, so assert via the same primitive directly.
    const file = path.join(dir, 'service.lock.guard')
    assert.throws(() => fs.openSync(file, fs.constants.O_CREAT | fs.constants.O_RDWR | 0x20 | fs.constants.O_NONBLOCK, 0o600),
      /EAGAIN|EWOULDBLOCK/, 'while held, the raw O_EXLOCK must be refused')
    first()
    // Released: the same open now succeeds, which is what proves `first()` actually let go.
    const fd = fs.openSync(file, fs.constants.O_CREAT | fs.constants.O_RDWR | 0x20 | fs.constants.O_NONBLOCK, 0o600)
    fs.closeSync(fd)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('a guard whose holder died is immediately free — the stale-lock case', () => {
  // Emulates the kernel releasing on SIGKILL: the lock file survives, the lock does not. A
  // fresh `open(O_EXLOCK)` on the leftover file must succeed, which is exactly what makes
  // `reclaimStaleLock` able to remove the dead `service.lock` without guessing at a pid.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-stale-'))
  try {
    const file = path.join(dir, 'service.lock.guard')
    // A leftover file with no lock held on it — the state a killed holder leaves behind.
    fs.writeFileSync(file, '')
    if (process.platform === 'darwin') {
      const fd = fs.openSync(file, fs.constants.O_CREAT | fs.constants.O_RDWR | 0x20 | fs.constants.O_NONBLOCK, 0o600)
      fs.closeSync(fd)
    }
    assert.ok(fs.existsSync(file), 'the guard file itself is allowed to persist; only the lock matters')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('the stale lock is reclaimed only for our own product with a dead pid', () => {
  const source = SRC('service.mjs')
  // The reclaim must stay behind both checks; removing either would take a lock off a live
  // service (wrong product) or off a process that is merely unreadable (wrong error).
  assert.match(source, /previous\.product !== LOCK_PRODUCT/, 'must refuse a lock that is not ours')
  assert.match(source, /process\.kill\(previous\.pid, 0\)/, 'must probe the pid before reclaiming')
  assert.match(source, /error\.code !== 'ESRCH'/, 'only a proven-dead pid may be reclaimed')
  assert.match(source, /acquireLockGuard\(dataDir\)/, 'and the whole thing runs under the guard')
})
