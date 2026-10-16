/**
 * The account console's front door.
 *
 * The channels are signed in on the service's own management page, which needs a management
 * session. That page is reachable at a bare loopback URL only while the service is up, and
 * the session is a cookie — so a bookmark alone is not enough, and putting the service key
 * in a URL (or in browser JavaScript) would leak it.
 *
 * This mirrors what the community plugin does with its `createConsoleHandoff`: a tiny local
 * server that mints short-lived, single-use tickets. Opening `/open/<ticket>` runs the
 * key→session exchange server-side and redirects the browser on with the cookie already set.
 * The key never enters a URL. The ticket is used once and expires, so a leaked link is inert.
 *
 * A ticket is minted on demand through the plugin's `usage` hook, which magpie re-reads every
 * time it shows the provider — that is what keeps a way into the console available after the
 * one-time sign-in has already happened.
 *
 * @module src/console.mjs
 */

import http from 'node:http'
import crypto from 'node:crypto'
import fs from 'node:fs'

/** How long a minted ticket stays usable. Long enough to click, short enough to be inert. */
const TICKET_MS = 10 * 60_000

/** At most this many unused tickets exist at once; oldest are dropped first. */
const MAX_TICKETS = 32

const HEADERS = {
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  // The handoff page renders nothing and loads nothing; it only redirects.
  'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
}

/**
 * Start a loopback handoff server in front of a running service.
 *
 * @param {object} service - the object `startStandalone` returned.
 * @param {number} [port] - fix the port; 0 (default) lets the OS pick.
 * @returns {Promise<{url: string, ticket: () => string, close: () => Promise<void>}>}
 */
export async function createConsoleHandoff(service, port = 0) {
  /** ticket → the moment it stops working. */
  const tickets = new Map()
  let address

  /**
   * Exchange the service key for a management session and send the browser on with it.
   *
   * The exchange happens here, server-side: the key is never put in a URL and never reaches
   * browser JavaScript, which is the whole reason this exists instead of just linking to the
   * management page.
   */
  async function handOver(res) {
    const { forwardKey } = JSON.parse(fs.readFileSync(service.keyFile, 'utf8'))
    const session = await fetch(`${service.url}/api/management/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: service.url },
      body: JSON.stringify({ key: forwardKey }),
      redirect: 'error',
      signal: AbortSignal.timeout(5000),
    })
    const cookie = session.headers.get('set-cookie')
    await session.body?.cancel()
    if (!session.ok || !cookie) throw new Error('session exchange failed')
    res.writeHead(303, { ...HEADERS, 'set-cookie': cookie, location: `${service.url}/` })
    res.end()
  }

  const server = http.createServer(async (req, res) => {
    try {
      // Everything below assumes the request reached *this* server, on loopback, by GET.
      // A mismatched Host or Origin is a browser being pointed somewhere it should not be.
      if (req.headers.host !== new URL(address).host) throw new Error('bad host')
      if (req.method !== 'GET') throw new Error('bad method')
      if (req.headers.origin && req.headers.origin !== address) throw new Error('bad origin')

      const target = new URL(req.url, address)

      // Only ever a ticket, and only ever one use of it.
      //
      // There is deliberately no bare `GET /` entry here. It was the first idea — an address
      // to bookmark — and it was wrong: it is a link the user has to remember, and it hands
      // a management session to anyone who can reach the port, including another account on
      // the machine, which the 0600 settings file would not. magpie opens a ticket itself,
      // so the root has no user.
      const token = target.pathname.startsWith('/open/') ? target.pathname.slice('/open/'.length) : ''
      const until = tickets.get(token)
      tickets.delete(token) // single use, whether or not it is still valid
      if (!token || !until || until < Date.now() || target.search) throw new Error('expired')
      await handOver(res)
    } catch {
      res.writeHead(401, { ...HEADERS, 'content-type': 'text/plain; charset=utf-8' })
      res.end('管理链接已失效。请回 Magpie，在「供应商 → Our Free Model Plus」里再点一次登录，重新打开控制台。')
    }
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', resolve)
  })
  address = `http://127.0.0.1:${server.address().port}`

  return {
    url: address,
    /** A fresh single-use link into the console. */
    ticket() {
      for (const [id, until] of tickets) if (until < Date.now()) tickets.delete(id)
      while (tickets.size >= MAX_TICKETS) tickets.delete(tickets.keys().next().value)
      const token = crypto.randomBytes(32).toString('base64url')
      tickets.set(token, Date.now() + TICKET_MS)
      return `${address}/open/${token}`
    },
    close() {
      tickets.clear()
      server.closeAllConnections?.()
      return new Promise(resolve => server.close(resolve))
    },
  }
}
