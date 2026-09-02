import { createServer, get, request, type IncomingHttpHeaders, type Server } from 'node:http'
import { connect, type Socket } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import type { StoredThread } from '../shared/contracts'
import { assertPortalAccess, PortalManager } from './portal'

const THREAD = '00000000-0000-4000-8000-000000000001'
const OWNER = 7
const servers: Server[] = []
const serverSockets = new Map<Server, Set<Socket>>()
const managers: PortalManager[] = []
const activeThread: StoredThread = {
  id: THREAD,
  title: 'Portal test',
  projectPath: '/project',
  workspacePath: '/workspace',
  workspaceMode: 'worktree',
  environmentStatus: 'active',
  environmentError: null,
  environmentUpdatedAt: '2026-09-02T00:00:00.000Z',
  model: null,
  createdAt: '2026-09-02T00:00:00.000Z',
  updatedAt: '2026-09-02T00:00:00.000Z'
}

async function listen(server: Server): Promise<number> {
  servers.push(server)
  const sockets = new Set<Socket>()
  serverSockets.set(server, sockets)
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') reject(new Error('invalid address'))
      else resolve(address.port)
    })
  })
}

function portalPort(url: string): number {
  return Number(new URL(url).port)
}

async function httpCall(port: number, options: {
  path?: string
  method?: string
  host?: string
  headers?: IncomingHttpHeaders
} = {}): Promise<{ status: number; headers: IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({
      host: '127.0.0.1',
      port,
      path: options.path ?? '/',
      method: options.method ?? 'GET',
      headers: { host: options.host ?? `127.0.0.1:${port}`, ...options.headers }
    }, (response) => {
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => chunks.push(chunk))
      response.on('end', () => resolve({
        status: response.statusCode ?? 0,
        headers: response.headers,
        body: Buffer.concat(chunks).toString()
      }))
    })
    req.once('error', reject)
    req.end()
  })
}

async function rawCall(port: number, payload: string, afterHeaders?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1')
    let received = ''
    let sentExtra = false
    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(received)
    }
    socket.setEncoding('utf8')
    socket.setTimeout(1_000, finish)
    socket.once('error', reject)
    socket.on('data', (chunk) => {
      received += chunk
      if (afterHeaders && !sentExtra && received.includes('\r\n\r\n')) {
        sentExtra = true
        socket.write(afterHeaders)
        return
      }
      if (!afterHeaders || received.includes(afterHeaders)) finish()
    })
    socket.once('close', finish)
    socket.once('connect', () => socket.write(payload))
  })
}

afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.closeAll()))
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    for (const socket of serverSockets.get(server) ?? []) socket.destroy()
    serverSockets.delete(server)
    if (!server.listening) resolve()
    else server.close(() => resolve())
  })))
})

describe('PortalManager security', () => {
  it('requires the selected persisted project thread and an active environment', () => {
    expect(() => assertPortalAccess(THREAD, THREAD, activeThread)).not.toThrow()
    expect(() => assertPortalAccess(undefined, THREAD, activeThread)).toThrow('actuellement sélectionné')
    expect(() => assertPortalAccess(THREAD, THREAD, null)).toThrow('introuvable')
    expect(() => assertPortalAccess(THREAD, THREAD, { ...activeThread, projectPath: null })).toThrow('projet actif')
    expect(() => assertPortalAccess(THREAD, THREAD, {
      ...activeThread,
      environmentStatus: 'error',
      environmentError: 'Worktree indisponible'
    })).toThrow('Worktree indisponible')
  })

  it('uses a fixed loopback target and replaces untrusted forwarding and hop-by-hop headers', async () => {
    const upstream = createServer((req, res) => {
      res.setHeader('connection', 'x-upstream-secret')
      res.setHeader('x-upstream-secret', 'remove-me')
      res.setHeader('x-kept', 'yes')
      res.end(JSON.stringify(req.headers))
    })
    const targetPort = await listen(upstream)
    const manager = new PortalManager()
    managers.push(manager)
    const portal = await manager.start(THREAD, OWNER, targetPort)
    const port = portalPort(portal.url)

    const response = await httpCall(port, {
      path: '/headers',
      headers: {
        connection: 'keep-alive, x-remove-me',
        'x-remove-me': 'secret',
        forwarded: 'for=203.0.113.1;host=evil.example',
        'proxy-authorization': 'Basic secret',
        'x-forwarded-for': '203.0.113.1',
        'x-forwarded-host': 'evil.example',
        'x-forwarded-server': 'evil.example',
        'x-forwarded-proto': 'https'
      }
    })
    const received = JSON.parse(response.body) as IncomingHttpHeaders

    expect(received.host).toBe(`127.0.0.1:${targetPort}`)
    expect(received['x-forwarded-for']).toBe('127.0.0.1')
    expect(received['x-forwarded-host']).toBe(`127.0.0.1:${port}`)
    expect(received['x-forwarded-proto']).toBe('http')
    expect(received['x-forwarded-server']).toBeUndefined()
    expect(received.forwarded).toBeUndefined()
    expect(received['proxy-authorization']).toBeUndefined()
    expect(received['x-remove-me']).toBeUndefined()
    expect(response.headers['x-upstream-secret']).toBeUndefined()
    expect(response.headers['x-kept']).toBe('yes')
  })

  it('rejects Host confusion, absolute-form targets, CONNECT, and oversized requests', async () => {
    let requests = 0
    const targetPort = await listen(createServer((_req, res) => {
      requests += 1
      res.end('ok')
    }))
    const manager = new PortalManager()
    managers.push(manager)
    const portal = await manager.start(THREAD, OWNER, targetPort)
    const port = portalPort(portal.url)
    requests = 0 // Ignore the through-proxy health request.

    expect((await httpCall(port, { host: '169.254.169.254' })).status).toBe(400)
    const absolute = await rawCall(port, `GET http://169.254.169.254/latest HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`)
    expect(absolute).toContain('400 Bad Request')
    const connectResponse = await rawCall(port, `CONNECT 127.0.0.1:22 HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n\r\n`)
    expect(connectResponse).toContain('405 Method Not Allowed')
    expect((await httpCall(port, {
      method: 'POST',
      headers: { 'content-length': String(11 * 1024 * 1024) }
    })).status).toBe(400)
    expect(requests).toBe(0)
  })

  it('fails closed on unavailable targets and upstream timeouts', async () => {
    const unavailable = await listen(createServer((_req, res) => res.end('temporary')))
    await new Promise<void>((resolve) => servers.pop()?.close(() => resolve()))
    const manager = new PortalManager({ requestTimeoutMs: 100, healthTimeoutMs: 100 })
    managers.push(manager)
    await expect(manager.start(THREAD, OWNER, unavailable)).rejects.toThrow('Aucun serveur HTTP local')

    const targetPort = await listen(createServer((req, res) => {
      if (req.url === '/') res.end('healthy')
    }))
    const portal = await manager.start(THREAD, OWNER, targetPort)
    const response = await httpCall(portalPort(portal.url), { path: '/hang' })
    expect(response.status).toBe(504)
  })
})

describe('PortalManager protocol and lifecycle', () => {
  it('proxies HTTP and WebSocket upgrade traffic through its random loopback port', async () => {
    const upstream = createServer((_req, res) => res.end('http-ok'))
    upstream.on('upgrade', (_req, socket) => {
      socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n')
      socket.on('data', (chunk) => socket.write(chunk))
    })
    const targetPort = await listen(upstream)
    const manager = new PortalManager()
    managers.push(manager)
    const portal = await manager.start(THREAD, OWNER, targetPort)
    const port = portalPort(portal.url)

    expect((await httpCall(port)).body).toBe('http-ok')
    const websocket = await rawCall(
      port,
      `GET /hmr HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: dGVzdA==\r\nSec-WebSocket-Version: 13\r\n\r\n`,
      'HMR-PING'
    )
    expect(websocket).toContain('101 Switching Protocols')
    expect(websocket).toContain('HMR-PING')
  })

  it('enforces ownership and closes portals by thread, window owner, and application lifecycle', async () => {
    const targetPort = await listen(createServer((_req, res) => res.end('ok')))
    const manager = new PortalManager()
    managers.push(manager)
    const first = await manager.start(THREAD, OWNER, targetPort)
    const port = portalPort(first.url)

    expect(manager.get(THREAD, OWNER)).toEqual(first)
    expect(() => manager.get(THREAD, OWNER + 1)).toThrow('autre fenêtre')
    await expect(manager.close(THREAD, OWNER + 1)).rejects.toThrow('autre fenêtre')
    await manager.closeOwner(OWNER)
    await expect(new Promise((resolve, reject) => {
      get(first.url, resolve).once('error', reject)
    })).rejects.toBeDefined()
    await expect(manager.start(THREAD, OWNER, targetPort)).rejects.toThrow('fenêtre propriétaire')

    const secondManager = new PortalManager()
    managers.push(secondManager)
    const second = await secondManager.start(THREAD, OWNER + 2, targetPort)
    expect(await secondManager.close(THREAD, OWNER + 2)).toBe(true)
    expect(await secondManager.close(THREAD, OWNER + 2)).toBe(false)
    const third = await secondManager.start(THREAD, OWNER + 2, targetPort)
    await secondManager.closeAll()
    expect(secondManager.get(THREAD, OWNER + 2)).toBeNull()
    expect(second.url).not.toBe(third.url)
    expect(port).toBeGreaterThan(0)
  })
})
