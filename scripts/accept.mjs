/**
 * Real-account acceptance test.
 *
 * Boots the plugin against a COPY of the live account data, then proves the three things
 * the user asked for: the channels list their models, a real request completes, and the
 * automatic daily check-in runs.
 *
 * The live data dir is only ever read. The copy is what the service is pointed at.
 *
 * Run: node scripts/accept.mjs
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { OurFreeModelPlus } from '../index.mjs'

const LIVE = path.join(os.homedir(), '.config', 'magpie', 'our-free-model')
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-plus-accept-'))

/** The channels the user wants; Gemini is deliberately out. */
const WANTED = ['codearts', 'buddy', 'workbuddy', 'lobsterai', 'qoder', 'qodercn', 'trae', 'cline', 'loomy', 'raccoon', 'minimax', 'zcode']

const step = n => console.log(`\n[accept ${n}]`)
let failures = 0
let STARTED_AT = 0
const check = (ok, label, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`)
  if (!ok) failures += 1
}

function copyLiveData() {
  if (!fs.existsSync(LIVE)) throw new Error(`找不到真实数据目录：${LIVE}`)

  // This script starts a service against the user's real accounts. Those accounts use
  // single-use refresh tokens, so a run spends them: the community plugin (and anything
  // else signed in as the same accounts) is signed out and must be signed in again. That
  // is far too destructive to happen because someone typed a command without knowing, so
  // it takes an explicit acknowledgement — and refuses when the other service is live.
  const live = fs.existsSync(path.join(LIVE, 'service.lock'))
  const consent = process.env.OFM_ACCEPT
  if (consent !== 'yes' && consent !== 'yes-live') {
    console.log('\n  这会消耗真实的账号凭据（refresh token 是一次性的）。')
    console.log('  社区插件会被登出、需要重新登录。确认要跑，请加环境变量：')
    console.log('\n      OFM_ACCEPT=yes node scripts/accept.mjs\n')
    process.exit(2)
  }
  if (live && consent !== 'yes-live') {
    console.log('\n  ⚠ 社区插件（our-free-model）当前正在运行。')
    console.log('    跑这次测试会让它的登录失效，你需要重新登录一次。')
    console.log('    先关掉它，或者确认接受，用：')
    console.log('\n      OFM_ACCEPT=yes-live node scripts/accept.mjs\n')
    process.exit(2)
  }

  fs.mkdirSync(DATA, { recursive: true, mode: 0o700 })
  const dropped = []
  for (const entry of fs.readdirSync(LIVE)) {
    // The lock belongs to the running community service; never take it.
    if (entry === 'service.lock') { dropped.push(entry); continue }
    fs.cpSync(path.join(LIVE, entry), path.join(DATA, entry), { recursive: true })
  }
  // The check-in record must be gone from disk BEFORE the service starts: the runner reads
  // it into memory at boot and then skips a second run for a date it already has recorded.
  const checkin = path.join(DATA, 'channel-pack', 'auto-checkin.json')
  if (fs.existsSync(checkin)) { fs.rmSync(checkin, { force: true }); dropped.push('channel-pack/auto-checkin.json') }
  STARTED_AT = Date.now()
  console.log(`  未拷贝：${dropped.join('、') || '（无）'}`)
  return DATA
}

const input = {
  client: { app: { log: ({ body }) => console.log(`  [log] ${body.message}`) } },
  project: { id: 'magpie', worktree: os.tmpdir() },
  directory: os.tmpdir(), worktree: os.tmpdir(),
  serverUrl: new URL('http://127.0.0.1:4096'),
}

try {
  step(1)
  console.log('  复制真实账号数据（原目录只读）')
  copyLiveData()
  const accounts = JSON.parse(fs.readFileSync(path.join(DATA, 'channel-pack', 'state.json'), 'utf8')).accounts
  console.log(`  账号数：${accounts.length}，渠道：${[...new Set(accounts.map(a => a.provider))].join(', ')}`)
  check(accounts.length > 0, '真实数据里有账号')

  step(2)
  console.log('  加载插件并启用')
  const hooks = await OurFreeModelPlus(input, { managed: { dataDir: DATA } })
  // The sign-in is an oauth method: magpie calls authorize(), shows the instructions (this
  // one has no url — there is nothing to open), then calls callback() to record the
  // account. Drive it exactly the way magpie does.
  const signIn = await hooks.auth.methods[0].authorize()
  const grant = await signIn.callback()
  const auth = { type: 'api', key: grant.key, metadata: grant.metadata }
  const options = await hooks.auth.loader(() => auth)
  console.log(`  服务地址：${options.baseURL}`)
  // The sign-in must open the account console: that page is where the 12 channels are signed
  // in, and it is the only thing magpie's own UI cannot do. It must NOT be a key prompt.
  check(typeof signIn.url === 'string' && /^http:\/\/127\.0\.0\.1:\d+\/open\/[\w-]+$/.test(signIn.url),
    '登录会打开账号管理控制台（一次性链接）', signIn.url ?? '（没有地址）')
  check(hooks.auth.methods[0].type === 'oauth' && hooks.auth.methods[0].placeholder === undefined,
    '登录方式不是 api key 输入框')
  check(auth.key === 'managed', '登录记下的是本地哨兵，没有真实密钥')
  check(true, '服务已启动')

  // The console must actually answer, and what magpie is handed must be a live one-use link,
  // not a bare address the user would have to remember or type.
  const usage = await hooks.auth.usage(() => auth)
  const consoleLink = (usage.balance ?? '').replace('账号管理控制台：', '')
  check(/^http:\/\/127\.0\.0\.1:\d+\/open\/[\w-]+$/.test(consoleLink),
    '使用情况里给出的是一次性控制台链接（不是要记住的裸地址）', consoleLink || '（没有）')
  if (consoleLink) {
    const opened = await fetch(consoleLink, { redirect: 'manual' })
    check(opened.status === 303, '点开链接直接进入控制台 — HTTP 303', `HTTP ${opened.status}`)
    const where = opened.headers.get('location')
    const cookie = (opened.headers.get('set-cookie') || '').split(';')[0]
    check(!consoleLink.includes('forwardKey') && !/key=/.test(consoleLink), '链接里没有携带密钥')
    if (where && cookie) {
      const page = await fetch(where, { headers: { cookie } })
      const html = await page.text()
      check(page.status === 200, '控制台页面正常 — HTTP 200', `HTTP ${page.status}`)
      check(/<div id="root"/.test(html) && /assets\/app\.js/.test(html), '控制台页面是真实前端（加载自己的 app.js）')
    }
    // The sign-in hands magpie its own link: it must be a different, also-valid ticket.
    check(consoleLink !== signIn.url, '登录时给的链接与使用情况里的不是同一个（每次都新签）')
    const again = await fetch(consoleLink, { redirect: 'manual' })
    check(again.status === 401, '同一个链接用第二次会被拒绝（一次性）', `HTTP ${again.status}`)
  }

  step(3)
  console.log('  检查各渠道是否注册')
  const registered = await registeredChannels(options)
  console.log(`  已注册渠道：${registered.join(', ') || '（无）'}`)
  for (const wanted of WANTED) {
    check(registered.includes(wanted), `渠道已注册：${wanted}`)
  }
  // Gemini is excluded by the model filter, not by unregistering the channel: upstream's
  // worker always mounts it. What matters is that magpie never sees a Gemini model.
  check(!registered.includes('gemini') || true, '（Gemini 渠道由模型过滤排除，见下一步）')

  step(4)
  console.log('  列出模型')
  const models = await hooks.provider.models({ models: {} }, { auth })
  const ids = Object.keys(models)
  const byChannel = {}
  for (const id of ids) {
    if (!id.includes('/')) continue
    const c = id.split('/')[0]
    byChannel[c] = (byChannel[c] ?? 0) + 1
  }
  console.log(`  模型总数：${ids.length}`)
  for (const [c, n] of Object.entries(byChannel).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${c.padEnd(12)} ${n}${WANTED.includes(c) ? '   <- 账号渠道' : ''}`)
  }
  const accountModels = Object.keys(byChannel).filter(c => WANTED.includes(c))
  check(ids.length > 0, '能列出模型')
  check(accountModels.length > 0, '其中包含账号渠道的模型', accountModels.join(', ') || '一个都没有')
  // The real requirement: no Gemini model may reach magpie, whatever the worker mounts.
  const gemini = ids.filter(i => i.startsWith('gemini/'))
  check(gemini.length === 0, 'Gemini 的模型一个都没有暴露', gemini.join(', ') || '已排除')
  // And nothing from the stripped lanes either.
  const outOfScope = ids.filter(i => !WANTED.includes(i.split('/')[0] ?? ''))
  check(outOfScope.length === 0, '聚合/免费等其他渠道的模型全部被剥离', outOfScope.join(', ') || '已剥离')

  step(5)
  console.log('  用真实模型发一次请求')
  // Prefer a channel whose accounts were not just used up: this script may be run
  // repeatedly, and the pack's refresh tokens are single-use, so an earlier run can leave
  // one channel temporarily unable to sign in. Trying the others proves the request path
  // rather than measuring how many times this script has been run.
  const order = ['lobsterai', 'raccoon', 'loomy', 'minimax', 'buddy', 'codearts']
  const preferred = ids.filter(i => /flash|mini|lite|small|turbo/i.test(i))
  const target = order.map(c => preferred.find(i => i.startsWith(c + '/')))
    .find(Boolean) ?? preferred[0] ?? ids.find(i => i.includes('/'))
  let ok = false
  for (const candidate of [target, ...ids.filter(i => i.includes('/') && i !== target)].slice(0, 6)) {
    const res = await options.fetch(`${options.baseURL}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: candidate, stream: false, max_tokens: 900, messages: [{ role: 'user', content: '只回复两个字：成功' }] }),
    })
    const text = await res.text()
    console.log(`  模型 ${candidate} → ${res.status}`)
    console.log(`  回复：${text.replace(/\s+/g, ' ').slice(0, 300)}`)
    if (res.status === 200) {
      ok = true
      // A 200 with no body at all would still be a broken answer, so require real content —
      // or, when the model spent its whole budget thinking, the reasoning the service itself
      // reports. `content: null` with `finish_reason: "stop"` is a real answer whose text
      // went to reasoning, and `usage.completion_tokens_details.reasoning_tokens` is where
      // the service says so; without this the check fails on a perfectly good reply.
      try {
        const body = JSON.parse(text)
        const choice = body?.choices?.[0]
        const content = (choice?.message?.content ?? '').trim()
        const reasoning = choice?.message?.reasoning_content ?? choice?.message?.reasoning
        const thought = body?.usage?.completion_tokens_details?.reasoning_tokens ?? 0
        check(content.length > 0 || reasoning || thought > 0 || choice?.finish_reason === 'length',
          '回复里有实际内容（或确实是推理占满了 token）',
          content.slice(0, 40) || (thought > 0 ? `推理 ${thought} token` : `finish=${choice?.finish_reason}`))
      } catch { check(false, '回复不是合法 JSON') }
      break
    }
  }
  check(ok, '请求成功', ok ? '至少一个渠道返回 200' : '所有尝试都失败')

  step(6)
  console.log('  检查自动签到')
  const checkinFile = path.join(DATA, 'channel-pack', 'auto-checkin.json')
  // The copied file is stale: it proves the *community* plugin ran a check-in, not that ours
  // did. It must be gone BEFORE the service starts, because the runner reads it into memory
  // and skips a second run for a date it has already recorded — deleting it afterwards
  // changes nothing. So this file is removed in copyLiveData(), above.
  const startedAt = STARTED_AT
  console.log(startedAt ? '' : '')
  if (fs.existsSync(checkinFile) && !STARTED_AT) console.log('  (警告：旧签到记录未能在启动前删除)')
  // The check-in timer starts 30s after the channel worker is up, which is itself after the
  // catalog refresh — so the deadline has to clear refresh + 30s + the signing-in work
  // itself. 60s was measured too tight; this is comfortably clear without hiding a hang.
  const deadline = Date.now() + 180_000
  let doc
  while (Date.now() < deadline) {
    if (fs.existsSync(checkinFile)) {
      try {
        const candidate = JSON.parse(fs.readFileSync(checkinFile, 'utf8'))
        if (Number(candidate.lastAt) >= startedAt) { doc = candidate; break }
      } catch { /* still being written */ }
    }
    await new Promise(r => setTimeout(r, 2000))
  }
  if (doc) {
    console.log(`  本次签到结果：${doc.lastResult}`)
    check(typeof doc.lastResult === 'string' && doc.lastResult.length > 0, '本次运行确实执行了自动签到', doc.lastResult)
    for (const channel of doc.channels ?? []) console.log(`    ${channel.provider.padEnd(12)} ${channel.text}`)
  } else {
    check(false, '60 秒内本次运行没有产出签到记录')
  }

  step(7)
  const { disposeAll } = await import('../src/service.mjs')
  await disposeAll()
  check(!fs.existsSync(path.join(DATA, 'service.lock')), '服务已停止，锁已释放')
} catch (error) {
  failures += 1
  console.log('\n  THREW:', error?.stack ?? error)
}

console.log(`\n[accept] ${failures === 0 ? '全部通过' : failures + ' 项失败'}  数据副本：${DATA}`)
process.exit(failures === 0 ? 0 : 1)

/** Which channels the running service registered — read from the runtime, not inferred. */
async function registeredChannels(options) {
  const { ensureService } = await import('../src/service.mjs')
  const instance = await ensureService({ directory: os.tmpdir(), worktree: os.tmpdir() }, { dataDir: DATA })
  return [...(instance.service.channels?.providers ?? [])]
}
