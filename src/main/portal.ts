import { createConnection } from 'node:net'
import type { Duplex } from 'node:stream'
import {
  createServer,
  get as httpGet,
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse
} from 'node:http'
import type { PortalInfo, StoredThread } from '../shared/contracts'

const MAX_REQUEST_BYTES = 10 * 1024 * 1024
const MAX_CONNECTIONS = 64
const MAX_REQUESTS_PER_SOCKET = 100
const MAX_HEADER_BYTES = 16 * 1024
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000
const DEFAULT_HEALTH_TIMEOUT_MS = 3_000
const PROXY_ERROR_HEADER = 'x-local-agent-proxy-error'

const STRIPPED_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'forwarded',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-port',
  'x-forwarded-proto',
  PROXY_ERROR_HEADER
])

type PortalSession = {
  ownerId: number
  targetHost: '127.0.0.1' | '::1'
  info: PortalInfo
  server: Server
  resources: Set<{ destroy(error?: Error): void }>
}

type PortalManagerOptions = {
  requestTimeoutMs?: number
  healthTimeoutMs?: number
}

export function assertPortalAccess(
  selectedThreadId: string | undefined,
  requestedThreadId: string,
  thread: StoredThread | null
): asserts thread is StoredThread {
  if (selectedThreadId !== requestedThreadId) {
    throw new Error('Le portail doit appartenir au thread actuellement sélectionné.')
  }
  if (!thread) throw new Error('Le thread local est introuvable.')
  if (!thread.projectPath || thread.environmentStatus !== 'active') {
    throw new Error(thread.environmentError ?? 'Un environnement projet actif est requis pour ce portail.')
  }
}

function connectionTokens(headers: IncomingHttpHeaders): Set<string> {
  const value = headers.connection
  const joined = Array.isArray(value) ? value.join(',') : value ?? ''
  return new Set(joined.split(',').map((token) => token.trim().toLowerCase()).filter(Boolean))
}

export function sanitizedRequestHeaders(
  headers: IncomingHttpHeaders,
  targetHost: '127.0.0.1' | '::1',
  targetPort: number,
  originalHost: string
): IncomingHttpHeaders {
  const dynamic = connectionTokens(headers)
  const result: IncomingHttpHeaders = {}
  for (const [name, value] of Object.entries(headers)) {
    const lowerName = name.toLowerCase()
    if (
      !STRIPPED_HEADERS.has(lowerName) &&
      !lowerName.startsWith('x-forwarded-') &&
      !dynamic.has(lowerName)
    ) result[lowerName] = value
  }
  result.host = targetHost === '::1' ? `[::1]:${targetPort}` : `127.0.0.1:${targetPort}`
  result['x-forwarded-for'] = '127.0.0.1'
  result['x-forwarded-host'] = originalHost
  result['x-forwarded-proto'] = 'http'
  return result
}

function sanitizedResponseHeaders(headers: IncomingHttpHeaders): IncomingHttpHeaders {
  const dynamic = connectionTokens(headers)
  const result: IncomingHttpHeaders = {}
  for (const [name, value] of Object.entries(headers)) {
    const lowerName = name.toLowerCase()
    if (!STRIPPED_HEADERS.has(lowerName) && !dynamic.has(lowerName)) result[lowerName] = value
  }
  return result
}

function validateRequest(request: IncomingMessage, portalPort: number): string | null {
  if (request.method === 'CONNECT') return 'La méthode CONNECT est interdite.'
  const target = request.url ?? ''
  if (!target.startsWith('/') || target.startsWith('//') || /^[a-z][a-z\d+.-]*:/i.test(target)) {
    return 'La cible de requête doit être un chemin relatif.'
  }
  if (request.headers.host !== `127.0.0.1:${portalPort}`) {
    return 'L’en-tête Host ne correspond pas à ce portail.'
  }
  const contentLength = request.headers['content-length']
  if (Array.isArray(contentLength) || (contentLength !== undefined && (
    !/^\d+$/.test(contentLength) || Number(contentLength) > MAX_REQUEST_BYTES
  ))) return 'Le corps de la requête dépasse la limite autorisée.'
  return null
}

function reject(response: ServerResponse, status: number, reason: string): void {
  response.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'close'
  })
  response.end(reason)
}

function rejectSocket(socket: Duplex, status: number, reason: string): void {
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
}

async function canConnect(host: '127.0.0.1' | '::1', port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port })
    let settled = false
    const finish = (connected: boolean): void => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(connected)
    }
    socket.setTimeout(timeoutMs, () => finish(false))
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
  })
}

async function checkThroughProxy(port: number, timeoutMs: number): Promise<void> {
  await new Promise<void>((resolve, rejectHealth) => {
    const request = httpGet({
      host: '127.0.0.1',
      port,
      path: '/',
      headers: { host: `127.0.0.1:${port}`, connection: 'close' },
      agent: false
    }, (response) => {
      response.resume()
      if (response.headers[PROXY_ERROR_HEADER]) rejectHealth(new Error('Le serveur du projet ne répond pas.'))
      else resolve()
    })
    request.setTimeout(timeoutMs, () => request.destroy(new Error('Le contrôle de disponibilité a expiré.')))
    request.once('error', rejectHealth)
  })
}

export class PortalManager {
  private readonly sessions = new Map<string, PortalSession>()
  private readonly closedOwners = new Set<number>()
  private readonly requestTimeoutMs: number
  private readonly healthTimeoutMs: number
  private shuttingDown = false

  constructor(options: PortalManagerOptions = {}) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    this.healthTimeoutMs = options.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS
  }

  get(threadId: string, ownerId: number): PortalInfo | null {
    const session = this.sessions.get(threadId)
    if (!session) return null
    this.requireOwner(session, ownerId)
    return session.info
  }

  async start(threadId: string, ownerId: number, targetPort: number): Promise<PortalInfo> {
    this.requireActiveOwner(ownerId)
    const existing = this.sessions.get(threadId)
    if (existing) {
      this.requireOwner(existing, ownerId)
      if (existing.info.targetPort === targetPort) return existing.info
      throw new Error('Arrêtez le portail actif avant de choisir un autre port.')
    }

    let targetHost: '127.0.0.1' | '::1' | null = null
    for (const host of ['127.0.0.1', '::1'] as const) {
      if (await canConnect(host, targetPort, this.healthTimeoutMs)) {
        targetHost = host
        break
      }
    }
    if (!targetHost) throw new Error(`Aucun serveur HTTP local ne répond sur le port ${targetPort}.`)
    this.requireActiveOwner(ownerId)

    const resources = new Set<{ destroy(error?: Error): void }>()
    let portalPort = 0
    const server = createServer({ maxHeaderSize: MAX_HEADER_BYTES }, (request, response) => {
      const invalid = validateRequest(request, portalPort)
      if (invalid) {
        reject(response, request.method === 'CONNECT' ? 405 : 400, invalid)
        return
      }

      const headers = sanitizedRequestHeaders(request.headers, targetHost, targetPort, request.headers.host ?? '')
      const upstream = httpRequest({
        host: targetHost,
        port: targetPort,
        method: request.method,
        path: request.url,
        headers,
        setHost: false,
        agent: false
      }, (upstreamResponse) => {
        response.writeHead(
          upstreamResponse.statusCode ?? 502,
          upstreamResponse.statusMessage,
          sanitizedResponseHeaders(upstreamResponse.headers)
        )
        upstreamResponse.pipe(response)
      })
      resources.add(upstream)
      upstream.once('close', () => resources.delete(upstream))
      let bytes = 0
      request.on('data', (chunk: Buffer) => {
        bytes += chunk.length
        if (bytes > MAX_REQUEST_BYTES) {
          upstream.destroy()
          request.destroy()
          response.destroy()
        }
      })
      upstream.setTimeout(this.requestTimeoutMs, () => upstream.destroy(new Error('upstream timeout')))
      upstream.once('error', (error) => {
        if (!response.headersSent) {
          response.setHeader(PROXY_ERROR_HEADER, '1')
          reject(response, error.message === 'upstream timeout' ? 504 : 502, 'Le serveur du projet ne répond pas.')
        } else response.destroy(error)
      })
      request.pipe(upstream)
    })

    server.on('upgrade', (request, socket, head) => {
      const invalid = validateRequest(request, portalPort)
      if (invalid || request.method !== 'GET' || request.headers.upgrade?.toLowerCase() !== 'websocket') {
        rejectSocket(socket, 400, 'Bad Request')
        return
      }
      const headers = sanitizedRequestHeaders(request.headers, targetHost, targetPort, request.headers.host ?? '')
      headers.connection = 'Upgrade'
      headers.upgrade = 'websocket'
      const upstreamRequest = httpRequest({
        host: targetHost,
        port: targetPort,
        method: 'GET',
        path: request.url,
        headers,
        setHost: false,
        agent: false
      })
      resources.add(upstreamRequest)
      upstreamRequest.once('close', () => resources.delete(upstreamRequest))
      upstreamRequest.setTimeout(this.requestTimeoutMs, () => upstreamRequest.destroy(new Error('upstream timeout')))
      upstreamRequest.once('upgrade', (response, upstreamSocket, upstreamHead) => {
        resources.add(upstreamSocket)
        upstreamSocket.once('close', () => resources.delete(upstreamSocket))
        const responseHeaders = sanitizedResponseHeaders(response.headers)
        responseHeaders.connection = 'Upgrade'
        responseHeaders.upgrade = 'websocket'
        const lines = [`HTTP/1.1 ${response.statusCode ?? 101} ${response.statusMessage ?? 'Switching Protocols'}`]
        for (const [name, value] of Object.entries(responseHeaders)) {
          if (value === undefined) continue
          for (const item of Array.isArray(value) ? value : [value]) lines.push(`${name}: ${item}`)
        }
        socket.write(`${lines.join('\r\n')}\r\n\r\n`)
        if (upstreamHead.length) socket.write(upstreamHead)
        if (head.length) upstreamSocket.write(head)
        upstreamSocket.pipe(socket).pipe(upstreamSocket)
        socket.once('close', () => upstreamSocket.destroy())
        upstreamSocket.once('close', () => socket.destroy())
      })
      upstreamRequest.once('response', (response) => {
        response.resume()
        rejectSocket(socket, response.statusCode ?? 502, 'WebSocket Upgrade Failed')
      })
      upstreamRequest.once('error', () => rejectSocket(socket, 502, 'Bad Gateway'))
      upstreamRequest.end()
    })
    server.on('connect', (_request, socket) => {
      rejectSocket(socket, 405, 'Method Not Allowed')
    })

    server.maxConnections = MAX_CONNECTIONS
    server.maxRequestsPerSocket = MAX_REQUESTS_PER_SOCKET
    server.headersTimeout = Math.min(10_000, this.requestTimeoutMs)
    server.requestTimeout = this.requestTimeoutMs
    server.keepAliveTimeout = 5_000
    server.on('connection', (socket) => {
      resources.add(socket)
      socket.once('close', () => resources.delete(socket))
    })

    try {
      portalPort = await new Promise<number>((resolve, rejectListen) => {
        server.once('error', rejectListen)
        server.listen(0, '127.0.0.1', () => {
          server.removeListener('error', rejectListen)
          const address = server.address()
          if (!address || typeof address === 'string') rejectListen(new Error('Adresse de portail invalide.'))
          else resolve(address.port)
        })
      })
      this.requireActiveOwner(ownerId)
      const info: PortalInfo = {
        threadId,
        targetPort,
        status: 'ready',
        scope: 'loopback',
        url: `http://127.0.0.1:${portalPort}`
      }
      const session: PortalSession = { ownerId, targetHost, info, server, resources }
      this.sessions.set(threadId, session)
      await checkThroughProxy(portalPort, this.healthTimeoutMs)
      this.requireActiveOwner(ownerId)
      return info
    } catch (error) {
      this.sessions.delete(threadId)
      await this.closeServer(server, resources)
      throw error
    }
  }

  async close(threadId: string, ownerId: number): Promise<boolean> {
    const session = this.sessions.get(threadId)
    if (!session) return false
    this.requireOwner(session, ownerId)
    this.sessions.delete(threadId)
    await this.closeServer(session.server, session.resources)
    return true
  }

  async closeOwner(ownerId: number): Promise<void> {
    this.closedOwners.add(ownerId)
    await Promise.all([...this.sessions.entries()]
      .filter(([, session]) => session.ownerId === ownerId)
      .map(async ([threadId, session]) => {
        this.sessions.delete(threadId)
        await this.closeServer(session.server, session.resources)
      }))
  }

  async closeAll(): Promise<void> {
    this.shuttingDown = true
    const sessions = [...this.sessions.values()]
    this.sessions.clear()
    await Promise.all(sessions.map((session) => this.closeServer(session.server, session.resources)))
  }

  private requireOwner(session: PortalSession, ownerId: number): void {
    if (session.ownerId !== ownerId) throw new Error('Ce portail appartient à une autre fenêtre.')
  }

  private requireActiveOwner(ownerId: number): void {
    if (this.shuttingDown || this.closedOwners.has(ownerId)) {
      throw new Error('La fenêtre propriétaire de ce portail est fermée.')
    }
  }

  private async closeServer(server: Server, resources: Set<{ destroy(error?: Error): void }>): Promise<void> {
    for (const resource of resources) resource.destroy()
    if (!server.listening) return
    await new Promise<void>((resolve, rejectClose) => server.close((error) => error ? rejectClose(error) : resolve()))
  }
}
