/**
 * The OpenCode lane's exit pool: selection, cooldown and in-turn failover.
 *
 * The free tier counts its usage ceiling per egress IP, so a burned address
 * answers every request with `429 FreeUsageLimitError` and a multi-hour
 * `Retry-After`. One address is therefore not enough: the lane has to be able to
 * try another exit within the same turn. These checks pin the pool's behaviour
 * against loopback stand-in proxies, so nothing here reaches the real gateway.
 *
 * The stand-ins are minimal HTTP CONNECT proxies: they record that they were
 * dialled and answer the tunnel with whatever the test scripted. That is enough
 * to observe *which* exit a request walked and what the lane did with its answer.
 */
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import tls from 'node:tls'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// The lane's POST inference normally rides Bun so the upstream sees a real CLI
// client. These checks are about which exit a request walks, not about the
// transport, and they must not require Bun — pin the Node path, the same way the
// suite runner does for every other offline suite.
process.env.OUR_FREE_MODEL_FREE_TRANSPORT = 'node'

/**
 * The lane dials `https://opencode.ai/...`, and its tunnel dialer completes a
 * real TLS handshake before writing the request. A stand-in exit therefore has to
 * terminate TLS, or every attempt would hang on the handshake instead of
 * exercising the pool. A throwaway self-signed certificate is minted once for the
 * run and trusted only for this process.
 */
function mintCertificate() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-lane-exit-'))
  const keyPath = path.join(dir, 'key.pem')
  const certPath = path.join(dir, 'cert.pem')
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', keyPath, '-out', certPath,
    '-days', '1', '-subj', '/CN=opencode.ai',
    '-addext', 'subjectAltName=DNS:opencode.ai',
  ], { stdio: 'ignore' })
  const result = { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) }
  fs.rmSync(dir, { recursive: true, force: true })
  return result
}

const certificate = mintCertificate()
// The stub presents a self-signed certificate; trust it for this process only.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'

const {
  setFreeLaneProxies,
  setFreeLaneMaxTries,
  freeLaneExitSnapshot,
  clearLaneExits,
  freeLaneProxyActive,
  egressFetch,
} = await import('../src/egress.js')

let passed = 0
const failures = []
async function check(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ok  ${name}`)
  } catch (error) {
    failures.push({ name, error })
    console.log(`FAIL  ${name}\n       ${String(error?.message ?? error).split('\n')[0]}`)
  }
}

/**
 * A stand-in HTTP CONNECT exit that terminates TLS itself.
 *
 * The lane completes a real TLS handshake through the tunnel, so this stub wraps
 * the tunnelled socket in a TLS server and answers the HTTP request inside it.
 * That is the smallest thing that behaves like an exit from the lane's side, and
 * it keeps the assertions about *which* exit was walked rather than about TLS.
 *
 * `status` may be a function of the attempt number, which is how a test scripts
 * "this exit is spent, that one is not".
 */
async function startProxy({ status = 200, body = '{"ok":true}', headers = {}, delayMs = 0 } = {}) {
  const state = { dials: 0, requests: 0 }
  const timers = new Set()
  // CONNECT sockets are handed to the TLS wrapper, so `closeAllConnections()`
  // does not know about them and `server.close()` would wait forever on one a
  // cancelled turn left behind. Track them so close can tear the stub down.
  const sockets = new Set()
  const server = http.createServer((req, res) => {
    // Only CONNECT is used by the lane's tunnel dialer.
    res.writeHead(405)
    res.end()
  })
  server.on('connect', (req, clientSocket, head) => {
    state.dials += 1
    sockets.add(clientSocket)
    clientSocket.on('close', () => sockets.delete(clientSocket))
    clientSocket.on('error', () => sockets.delete(clientSocket))
    const resolved = typeof status === 'function' ? status(state.dials) : status
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
    const secure = new tls.TLSSocket(clientSocket, {
      isServer: true,
      key: certificate.key,
      cert: certificate.cert,
    })
    secure.on('error', () => clientSocket.destroy())
    let buffer = head?.length ? Buffer.from(head) : Buffer.alloc(0)
    const answer = () => {
      state.requests += 1
      const deliver = () => {
        const text = typeof body === 'function' ? body(state.dials) : body
        const payload = Buffer.from(text, 'utf8')
        const lines = [`HTTP/1.1 ${resolved} Stand-in`, `content-length: ${payload.length}`, 'content-type: application/json', 'connection: close']
        for (const [name, value] of Object.entries(headers)) lines.push(`${name}: ${value}`)
        secure.write(`${lines.join('\r\n')}\r\n\r\n`)
        secure.end(payload)
      }
      // `delayMs` lets a test hold the request open and observe cancellation:
      // the request has been read, so aborting now must tear the tunnel down
      // instead of waiting for this timer. `close()` cancels it, so the delay
      // does not outlive the check. (It is deliberately not unref'd: with the
      // tunnel torn down, an unref'd timer would let the event loop drain and
      // Node would exit on an unsettled top-level await.)
      if (delayMs > 0) {
        const timer = setTimeout(deliver, delayMs)
        timers.add(timer)
      } else deliver()
    }
    const onData = chunk => {
      buffer = Buffer.concat([buffer, chunk])
      if (buffer.includes('\r\n\r\n')) {
        secure.removeListener('data', onData)
        answer()
      }
    }
    if (buffer.includes('\r\n\r\n')) answer()
    else secure.on('data', onData)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  return {
    url: `http://127.0.0.1:${port}`,
    state,
    close: () => new Promise(resolve => {
      for (const timer of timers) clearTimeout(timer)
      timers.clear()
      // A CONNECT socket is already detached from the HTTP server, so it must be
      // destroyed explicitly or `server.close()` never reaches its callback.
      for (const socket of sockets) socket.destroy()
      sockets.clear()
      server.closeAllConnections?.()
      server.close(() => resolve())
    }),
  }
}

const LANE_URL = 'https://opencode.ai/inference/openai/v1/chat/completions'

/** One lane request through the pool, with a session header the pool can hash. */
const laneRequest = (session = 'ses_test') => egressFetch(LANE_URL, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-opencode-session': session },
  body: '{}',
  redirect: 'error',
})

console.log('\n=== 1. configuration ===')

await check('an empty list clears the pool', () => {
  setFreeLaneProxies([])
  assert.equal(freeLaneProxyActive(), false)
  assert.deepEqual(freeLaneExitSnapshot(), [])
})

await check('an unsupported scheme is refused at save time', () => {
  assert.throws(() => setFreeLaneProxies(['ftp://example.com']), /unsupported proxy scheme/)
})

await check('a typo fails the write instead of the first turn', () => {
  assert.throws(() => setFreeLaneProxies(['not a url']), /Invalid URL|unsupported/)
})

await check('a #pool suffix marks a rotating endpoint and is stripped from the URL', () => {
  setFreeLaneProxies(['http://127.0.0.1:1#pool'])
  const [exit] = freeLaneExitSnapshot()
  assert.equal(exit.pool, true)
  assert.match(exit.label, /127\.0\.0\.1:1$/)
})

await check('pool+ prefix marks the same thing', () => {
  setFreeLaneProxies(['pool+http://127.0.0.1:2'])
  assert.equal(freeLaneExitSnapshot()[0].pool, true)
})

await check('the same static endpoint listed twice is one exit', () => {
  setFreeLaneProxies(['http://127.0.0.1:3', 'http://127.0.0.1:3'])
  assert.equal(freeLaneExitSnapshot().length, 1)
})

await check('a #pool entry beside the same static address is kept as its own route', () => {
  // They are different routes, not two spellings of one: a pool endpoint rotates
  // its exit IP per connection and is never cooled, so collapsing them would
  // silently drop the pool.
  setFreeLaneProxies(['http://127.0.0.1:3', 'http://127.0.0.1:3#pool'])
  assert.equal(freeLaneExitSnapshot().length, 2)
})

await check('a snapshot never carries credentials', () => {
  setFreeLaneProxies(['http://user:secret@127.0.0.1:4'])
  const [exit] = freeLaneExitSnapshot()
  assert.equal(exit.label.includes('secret'), false)
  assert.equal(exit.label.includes('user'), false)
})

console.log('\n=== 2. in-turn failover ===')

await check('a 429 on the first exit moves to the second and succeeds', async () => {
  // The first proxy refuses the tunnel with 429 — that is what the lane's tunnel
  // dialer surfaces as a failed dial, which the pool treats as "this exit is
  // spent". The second answers normally.
  const spent = await startProxy({ status: 429 })
  const healthy = await startProxy({ status: 200 })
  try {
    setFreeLaneProxies([spent.url, healthy.url])
    setFreeLaneMaxTries(3)
    clearLaneExits()
    const response = await laneRequest('ses_failover')
    assert.equal(response.status, 200)
    assert.equal(healthy.state.dials > 0, true)
    // The spent exit is now cooled and says why.
    const snapshot = freeLaneExitSnapshot()
    const cooled = snapshot.find(exit => exit.coolingMs > 0)
    assert.ok(cooled, 'the refusing exit should be cooling')
    assert.match(cooled.lastError, /reach|quota|spent/i)
  } finally {
    await spent.close()
    await healthy.close()
  }
})

await check('a cooled exit is skipped on the next request', async () => {
  const spent = await startProxy({ status: 429 })
  const healthy = await startProxy({ status: 200 })
  try {
    setFreeLaneProxies([spent.url, healthy.url])
    setFreeLaneMaxTries(3)
    clearLaneExits()
    await laneRequest('ses_skip')
    const dialsAfterFirst = spent.state.dials
    await laneRequest('ses_skip')
    assert.equal(spent.state.dials, dialsAfterFirst, 'the cooled exit must not be dialled again')
  } finally {
    await spent.close()
    await healthy.close()
  }
})

await check('a #pool exit is never cooled', async () => {
  const pool = await startProxy({ status: 429 })
  try {
    setFreeLaneProxies([`${pool.url}#pool`])
    setFreeLaneMaxTries(3)
    clearLaneExits()
    await laneRequest('ses_pool').catch(() => {})
    const [exit] = freeLaneExitSnapshot()
    // A pool rotates its own exit IP per connection, so an upstream refusal says
    // nothing durable about it — cooling it would throw away the one route that
    // might already be somewhere else.
    assert.equal(exit.coolingMs, 0)
  } finally {
    await pool.close()
  }
})

await check('maxTries bounds how many exits one request walks', async () => {
  const exits = []
  try {
    for (let index = 0; index < 4; index++) exits.push(await startProxy({ status: 429 }))
    setFreeLaneProxies(exits.map(exit => exit.url))
    setFreeLaneMaxTries(2)
    clearLaneExits()
    await laneRequest('ses_bound').catch(() => {})
    const dialled = exits.filter(exit => exit.state.dials > 0).length
    assert.ok(dialled <= 2, `walked ${dialled} exits, expected at most 2`)
  } finally {
    for (const exit of exits) await exit.close()
  }
})

await check('clearing the cooldowns makes every exit usable again', async () => {
  const spent = await startProxy({ status: 429 })
  const healthy = await startProxy({ status: 200 })
  try {
    // Only the spent exit is configured, so the session affinity cannot route
    // around it — this check is about the cooldown bookkeeping, not selection.
    setFreeLaneProxies([spent.url])
    setFreeLaneMaxTries(3)
    clearLaneExits()
    await laneRequest('ses_clear')
    assert.ok(freeLaneExitSnapshot().some(exit => exit.coolingMs > 0), 'the 429 exit should be cooling')
    const cleared = clearLaneExits()
    assert.equal(cleared > 0, true)
    assert.equal(freeLaneExitSnapshot().every(exit => exit.coolingMs === 0), true)
  } finally {
    await spent.close()
    await healthy.close()
  }
})

await check('a huge Retry-After cannot cool an exit for the rest of the day', async () => {
  const spent = await startProxy({ status: 429, headers: { 'retry-after': '70411' } })
  try {
    setFreeLaneProxies([spent.url])
    setFreeLaneMaxTries(1)
    clearLaneExits()
    await laneRequest('ses_clamp').catch(() => {})
    const [exit] = freeLaneExitSnapshot()
    assert.ok(exit.coolingMs > 0, 'the 429 exit is cooling')
    // 70411s is ~19.6 hours. The header is taken from a CDN/WAF as often as
    // from the upstream, and an exit that recovers in minutes must not be
    // skipped until tomorrow.
    assert.ok(exit.coolingMs <= 30 * 60 * 1000 + 5000, `cooling ${exit.coolingMs}ms exceeds the 30-minute cap`)
  } finally {
    await spent.close()
  }
})

await check('cancelling a turn stops waiting on a pooled exit', async () => {
  const slow = await startProxy({ status: 200, delayMs: 5000 })
  try {
    setFreeLaneProxies([slow.url])
    setFreeLaneMaxTries(3)
    clearLaneExits()
    const controller = new AbortController()
    const started = Date.now()
    const pending = egressFetch(LANE_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-opencode-session': 'ses_abort' },
      body: '{}',
      redirect: 'error',
      signal: controller.signal,
    })
    // Wait until the exit has actually read the request, so the tunnel is up and
    // the only thing standing between us and an answer is the delay.
    const deadline = Date.now() + 8000
    while (slow.state.requests === 0) {
      if (Date.now() > deadline) throw new Error('the slow exit never received the request')
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    controller.abort(new Error('the user cancelled the turn'))
    await assert.rejects(pending)
    const elapsed = Date.now() - started
    assert.ok(elapsed < 3000, `the abort took ${elapsed}ms — it waited for the exit instead of cancelling`)
  } finally {
    await slow.close()
  }
})

console.log('\n=== 3. a non-exit failure is not retried on another exit ===')

await check('a 400 from the upstream is returned without walking the pool', async () => {
  const first = await startProxy({ status: 400, body: JSON.stringify({ error: { type: 'invalid_request_error', message: 'bad request' } }) })
  const second = await startProxy({ status: 200 })
  try {
    setFreeLaneProxies([first.url, second.url])
    setFreeLaneMaxTries(3)
    clearLaneExits()
    const response = await laneRequest('ses_400')
    assert.equal(response.status, 400)
    // Only the first exit was dialled: a request-level rejection is identical
    // everywhere, so spending the rest of the pool on it only wastes time.
    assert.equal(first.state.dials, 1)
    assert.equal(second.state.dials, 0)
  } finally {
    await first.close()
    await second.close()
  }
})

await check('a 200 is returned from the first exit without touching the rest', async () => {
  const first = await startProxy({ status: 200 })
  const second = await startProxy({ status: 200 })
  try {
    setFreeLaneProxies([first.url, second.url])
    setFreeLaneMaxTries(3)
    clearLaneExits()
    const response = await laneRequest('ses_ok')
    assert.equal(response.status, 200)
    assert.equal(first.state.dials, 1)
    assert.equal(second.state.dials, 0)
  } finally {
    await first.close()
    await second.close()
  }
})

console.log('\n=== 4. no pool configured ===')

await check('an empty pool consults no exit', async () => {
  const decoy = await startProxy({ status: 200 })
  try {
    setFreeLaneProxies([])
    // With no pool, no relay and no environment proxy, the request goes straight
    // out. The lane URL is not reachable from a test host, so the assertion is
    // that the decoy proxy was never dialled — not that the request succeeded.
    await laneRequest('ses_direct').catch(() => {})
    assert.equal(decoy.state.dials, 0)
  } finally {
    await decoy.close()
  }
})

console.log(`\n${failures.length === 0 ? 'all lane exit checks passed' : `${failures.length} lane exit check(s) failed`} (${passed} passed)`)
if (failures.length > 0) process.exitCode = 1
