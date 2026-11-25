import crypto from 'node:crypto'
import assert from 'node:assert/strict'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import tls from 'node:tls'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { directFetch, lane, loadEacRootCa } from '../src/eac.js'
import { openTunnel } from '../src/egress.js'
import { CODE, UpstreamError } from '../src/http.js'

const aborted = error => error instanceof UpstreamError && error.code === CODE.aborted

await test('a pre-aborted request never invokes the injected EAC transport', async () => {
  const saved = lane.fetch
  let calls = 0
  try {
    lane.fetch = async () => { calls++; return new Response('unexpected') }
    const controller = new AbortController()
    controller.abort(new Error('synthetic cancellation'))
    await assert.rejects(directFetch('https://fixture.invalid', { signal: controller.signal }), aborted)
    assert.equal(calls, 0)
  } finally {
    lane.fetch = saved
  }
})

await test('pre-abort prevents URL parsing and native HTTP or HTTPS allocation', async () => {
  const saved = { fetch: lane.fetch, http: http.request, https: https.request }
  let calls = 0
  try {
    lane.fetch = null
    http.request = https.request = () => { calls++; throw new Error('unexpected socket allocation') }
    for (const url of ['http://fixture.invalid', 'https://fixture.invalid', 'not a URL']) {
      await assert.rejects(directFetch(url, { signal: AbortSignal.abort() }), aborted)
    }
    assert.equal(calls, 0)
  } finally {
    lane.fetch = saved.fetch
    http.request = saved.http
    https.request = saved.https
  }
})

await test('a live signal preserves the existing transport arguments and result', async () => {
  const saved = lane.fetch
  const signal = new AbortController().signal
  const headers = { 'content-type': 'application/json', 'x-synthetic-signature': 'unchanged' }
  const body = '{"synthetic":true}'
  const response = new Response('ok')
  try {
    lane.fetch = async (url, init) => {
      assert.equal(url, 'https://fixture.invalid')
      assert.deepEqual(init, { method: 'POST', headers, body, signal })
      assert.equal(init.headers, headers)
      return response
    }
    assert.equal(await directFetch('https://fixture.invalid', { method: 'POST', headers, body, signal }), response)
  } finally {
    lane.fetch = saved
  }
})

await test('the EAC transport preserves signed bytes through a selected HTTP proxy', async () => {
  const saved = { fetch: lane.fetch, proxy: lane.proxy }
  const proxy = http.createServer((req, res) => {
    assert.equal(req.url, 'http://unreachable.invalid/eac/auth/status')
    assert.equal(req.headers['x-synthetic-signature'], 'unchanged')
    const chunks = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => {
      assert.equal(Buffer.concat(chunks).toString('utf8'), '{"signed":true}')
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"ok":true}')
    })
  })
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve))
  try {
    lane.fetch = null
    lane.proxy = `http://127.0.0.1:${proxy.address().port}`
    const response = await directFetch('http://unreachable.invalid/eac/auth/status', {
      method: 'POST', headers: { 'x-synthetic-signature': 'unchanged' }, body: '{"signed":true}',
    })
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { ok: true })
  } finally {
    lane.fetch = saved.fetch
    lane.proxy = saved.proxy
    await new Promise(resolve => proxy.close(resolve))
  }
})

await test('cancelling EAC closes a stalled proxy CONNECT handshake', { timeout: 3000 }, async () => {
  const savedProxy = lane.proxy
  const proxy = http.createServer()
  let tunnel
  const connected = new Promise(resolve => proxy.once('connect', (req, socket) => {
    assert.equal(req.url, 'fixture.invalid:443')
    tunnel = socket
    const closed = new Promise(done => socket.once('close', done))
    socket.on('end', () => socket.destroy())
    resolve({ closed })
  }))
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve))
  const controller = new AbortController()
  try {
    lane.proxy = `http://127.0.0.1:${proxy.address().port}`
    const stopped = assert.rejects(directFetch('https://fixture.invalid', { signal: controller.signal }), aborted)
    const { closed } = await connected
    controller.abort()
    await stopped
    await closed
  } finally {
    lane.proxy = savedProxy
    tunnel?.destroy()
    await new Promise(resolve => proxy.close(resolve))
  }
})

await test('the EAC proxy tunnel hands the pinned root CA to target TLS', { timeout: 5000 }, async () => {
  const saved = { connect: tls.connect, request: http.request, proxy: lane.proxy, fetch: lane.fetch }
  const proxy = http.createServer()
  const tunnels = new Set()
  let connectSeen = false
  proxy.on('connect', (req, socket) => {
    connectSeen = true
    tunnels.add(socket)
    socket.on('close', () => tunnels.delete(socket))
    assert.equal(req.url, 'fixture.invalid:443')
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
  })
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve))
  let tlsOptions
  try {
    lane.fetch = null
    lane.proxy = `http://127.0.0.1:${proxy.address().port}`
    tls.connect = options => {
      tlsOptions = options
      const secured = new EventEmitter()
      secured.destroy = () => {}
      secured.setTimeout = () => secured
      secured.setNoDelay = () => secured
      process.nextTick(() => secured.emit('secureConnect'))
      return secured
    }
    http.request = (_options, callback) => {
      const request = new EventEmitter()
      request.write = () => {}
      request.destroy = error => { if (error) request.emit('error', error) }
      request.end = () => {
        const response = new Readable({ read() { this.push(null) } })
        response.statusCode = 200
        response.headers = { 'content-type': 'application/json' }
        callback(response)
        request.emit('close')
      }
      return request
    }

    const response = await directFetch('https://fixture.invalid/eac/v1/models')
    assert.equal(response.status, 200)
    assert.equal(connectSeen, true)
    assert.equal(tlsOptions?.servername, 'fixture.invalid')
    assert.equal(Object.hasOwn(tlsOptions, 'host'), false)
    assert.equal(tlsOptions?.ALPNProtocols?.includes('http/1.1'), true)
    const expected = new crypto.X509Certificate(loadEacRootCa()).fingerprint256
    const roots = Array.isArray(tlsOptions?.ca) ? tlsOptions.ca : []
    assert.equal(roots.some(entry => {
      try { return new crypto.X509Certificate(entry).fingerprint256 === expected } catch { return false }
    }), true, 'target TLS did not receive the pinned EAC root CA')
  } finally {
    tls.connect = saved.connect
    http.request = saved.request
    lane.proxy = saved.proxy
    lane.fetch = saved.fetch
    for (const socket of tunnels) socket.destroy()
    await new Promise(resolve => proxy.close(resolve))
  }
})

await test('an IP target through the EAC tunnel is verified with host, not SNI', { timeout: 5000 }, async () => {
  const saved = { connect: tls.connect, request: http.request, proxy: lane.proxy, fetch: lane.fetch }
  const proxy = http.createServer()
  const tunnels = new Set()
  let connectSeen = false
  proxy.on('connect', (req, socket) => {
    connectSeen = true
    tunnels.add(socket)
    socket.on('close', () => tunnels.delete(socket))
    assert.equal(req.url, '202.189.51.40:443')
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
  })
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve))
  let tlsOptions
  try {
    lane.fetch = null
    lane.proxy = 'http://127.0.0.1:' + proxy.address().port
    tls.connect = options => {
      tlsOptions = options
      const secured = new EventEmitter()
      secured.destroy = () => {}
      secured.setTimeout = () => secured
      secured.setNoDelay = () => secured
      process.nextTick(() => secured.emit('secureConnect'))
      return secured
    }
    http.request = (_options, callback) => {
      const request = new EventEmitter()
      request.write = () => {}
      request.destroy = error => { if (error) request.emit('error', error) }
      request.end = () => {
        const response = new Readable({ read() { this.push(null) } })
        response.statusCode = 200
        response.headers = { 'content-type': 'application/json' }
        callback(response)
        request.emit('close')
      }
      return request
    }

    const response = await directFetch('https://202.189.51.40/eac/v1/models')
    assert.equal(response.status, 200)
    assert.equal(connectSeen, true)
    assert.equal(tlsOptions?.host, '202.189.51.40')
    assert.equal(Object.hasOwn(tlsOptions, 'servername'), false)
    assert.equal(tlsOptions?.ALPNProtocols?.includes('http/1.1'), true)
    const expected = new crypto.X509Certificate(loadEacRootCa()).fingerprint256
    const roots = Array.isArray(tlsOptions?.ca) ? tlsOptions.ca : []
    assert.equal(roots.some(entry => {
      try { return new crypto.X509Certificate(entry).fingerprint256 === expected } catch { return false }
    }), true, 'IP target TLS did not receive the pinned EAC root CA')
  } finally {
    tls.connect = saved.connect
    http.request = saved.request
    lane.proxy = saved.proxy
    lane.fetch = saved.fetch
    for (const socket of tunnels) socket.destroy()
    await new Promise(resolve => proxy.close(resolve))
  }
})

await test('an HTTPS proxy named by DNS keeps SNI and gains no host override', { timeout: 5000 }, async () => {
  const saved = { net: net.connect, tls: tls.connect }
  const calls = []
  const raw = new EventEmitter()
  raw.destroyed = false
  raw.destroy = () => { raw.destroyed = true; raw.emit('close') }
  raw.resume = () => {}
  raw.setNoDelay = () => raw
  raw.setTimeout = () => raw
  raw.unshift = () => {}
  raw.write = () => true

  const proxyTls = new EventEmitter()
  proxyTls.destroyed = false
  proxyTls.destroy = () => { proxyTls.destroyed = true; proxyTls.emit('close') }
  proxyTls.resume = () => {}
  proxyTls.unshift = () => {}
  proxyTls.write = data => {
    assert.match(String(data), /^CONNECT fixture\.invalid:443 /)
    process.nextTick(() => proxyTls.emit('data', Buffer.from('HTTP/1.1 200 Connection Established\r\n\r\n')))
  }

  const targetTls = new EventEmitter()
  targetTls.destroyed = false
  targetTls.destroy = () => { targetTls.destroyed = true; targetTls.emit('close') }

  try {
    net.connect = options => {
      assert.deepEqual(options, { host: 'proxy.example.test', port: 8443 })
      process.nextTick(() => raw.emit('connect'))
      return raw
    }
    tls.connect = options => {
      calls.push(options)
      const secured = calls.length === 1 ? proxyTls : targetTls
      process.nextTick(() => secured.emit('secureConnect'))
      return secured
    }
    const socket = await openTunnel(
      new URL('https://fixture.invalid'),
      { kind: 'url', url: new URL('https://proxy.example.test:8443') },
    )
    assert.equal(socket, targetTls)
    assert.equal(calls.length, 2)
    assert.equal(calls[0].servername, 'proxy.example.test')
    assert.equal(Object.hasOwn(calls[0], 'host'), false)
    assert.equal(calls[1].servername, 'fixture.invalid')
    assert.equal(Object.hasOwn(calls[1], 'host'), false)
  } finally {
    net.connect = saved.net
    tls.connect = saved.tls
  }
})

await test('an IP HTTPS proxy is verified with host, not SNI', { timeout: 5000 }, async () => {
  const saved = { net: net.connect, tls: tls.connect }
  const calls = []
  const raw = new EventEmitter()
  raw.destroyed = false
  raw.destroy = () => { raw.destroyed = true; raw.emit('close') }
  raw.resume = () => {}
  raw.setNoDelay = () => raw
  raw.setTimeout = () => raw
  raw.unshift = () => {}
  raw.write = () => true

  const proxyTls = new EventEmitter()
  proxyTls.destroyed = false
  proxyTls.destroy = () => { proxyTls.destroyed = true; proxyTls.emit('close') }
  proxyTls.resume = () => {}
  proxyTls.unshift = () => {}
  proxyTls.write = data => {
    assert.match(String(data), /^CONNECT fixture\.invalid:443 /)
    process.nextTick(() => proxyTls.emit('data', Buffer.from('HTTP/1.1 200 Connection Established\r\n\r\n')))
  }

  try {
    net.connect = options => {
      assert.deepEqual(options, { host: '127.0.0.1', port: 8443 })
      process.nextTick(() => raw.emit('connect'))
      return raw
    }
    tls.connect = options => {
      calls.push(options)
      if (calls.length > 1) throw new Error('stop after proxy handshake')
      process.nextTick(() => proxyTls.emit('secureConnect'))
      return proxyTls
    }
    await assert.rejects(
      openTunnel(new URL('https://fixture.invalid'), { kind: 'url', url: new URL('https://127.0.0.1:8443') }),
      /stop after proxy handshake/,
    )
    assert.equal(calls.length, 2)
    assert.equal(calls[0].host, '127.0.0.1')
    assert.equal(Object.hasOwn(calls[0], 'servername'), false)
  } finally {
    net.connect = saved.net
    tls.connect = saved.tls
  }
})
