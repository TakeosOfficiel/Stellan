import { describe, expect, it, vi } from 'vitest'
import { getOllamaStatus, modelSupportsTools, pullOllamaModel, streamOllamaChat } from './ollama'

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

describe('getOllamaStatus', () => {
  it('returns the installed models and version', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response({
        models: [{ name: 'coder:latest', size: 4_200_000_000, modified_at: '2026-01-01' }]
      }))
      .mockResolvedValueOnce(response({ version: '1.0.0' }))

    await expect(getOllamaStatus(fetcher)).resolves.toEqual({
      available: true,
      version: '1.0.0',
      models: [{ name: 'coder:latest', size: 4_200_000_000, modifiedAt: '2026-01-01' }]
    })
  })

  it('reports an unavailable local service without exposing implementation errors', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error('connection refused'))

    await expect(getOllamaStatus(fetcher)).resolves.toEqual({
      available: false,
      reason: "Le service isolé d'Ollama ne répond pas. Relancez le runtime privé puis réessayez."
    })
  })

  it('falls back to localhost and accepts a missing version route', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockRejectedValueOnce(new Error('IPv4 unavailable'))
      .mockResolvedValueOnce(response({
        models: [{ name: 'coder:latest', size: 4_200_000_000, modified_at: '2026-01-01' }]
      }))
      .mockRejectedValueOnce(new Error('version unavailable'))

    await expect(getOllamaStatus(fetcher)).resolves.toEqual({
      available: true,
      version: null,
      models: [{ name: 'coder:latest', size: 4_200_000_000, modifiedAt: '2026-01-01' }]
    })
    expect(fetcher).toHaveBeenNthCalledWith(
      2,
      'http://localhost:11435/api/tags',
      expect.any(Object)
    )
  })
})

describe('pullOllamaModel', () => {
  it('parses streamed progress updates', async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(
          '{"status":"pulling manifest"}\n{"status":"downloading","completed":50,"total":100}\n'
        ))
        controller.close()
      }
    })
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(stream, { status: 200 }))
    const onProgress = vi.fn()

    await expect(pullOllamaModel('qwen3.5:4b', onProgress, fetcher)).resolves.toEqual({
      success: true
    })
    expect(onProgress).toHaveBeenLastCalledWith({
      model: 'qwen3.5:4b',
      status: 'downloading',
      completed: 50,
      total: 100,
      percent: 50
    })
  })
})

describe('modelSupportsTools', () => {
  it('uses Ollama model capabilities instead of assuming every model supports tools', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({
      capabilities: ['completion', 'tools']
    }))

    await expect(modelSupportsTools('coder:latest', fetcher)).resolves.toBe(true)
    expect(fetcher).toHaveBeenCalledWith(
      'http://127.0.0.1:11435/api/show',
      expect.objectContaining({ body: JSON.stringify({ model: 'coder:latest' }) })
    )
  })
})

describe('streamOllamaChat', () => {
  it('streams content even when JSON lines span network chunks', async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"message":{"content":"Bon'))
        controller.enqueue(new TextEncoder().encode('jour "}}\n{"message":{"content":"!"},"done":true}\n'))
        controller.close()
      }
    })
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(stream, { status: 200 }))
    const onContent = vi.fn()

    await streamOllamaChat(
      'qwen3.5:4b',
      [{ role: 'user', content: 'Bonjour' }],
      onContent,
      undefined,
      fetcher
    )

    expect(onContent.mock.calls.flat()).toEqual(['Bonjour ', '!'])
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toMatchObject({
      model: 'qwen3.5:4b',
      stream: true,
      think: false
    })
  })

  it('accepts thinking chunks without exposing the private reasoning as the answer', async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(
          '{"message":{"thinking":"raisonnement interne"}}\n' +
          '{"message":{"content":"Réponse directe"},"done":true}\n'
        ))
        controller.close()
      }
    })
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(stream, { status: 200 }))
    const onContent = vi.fn()

    await expect(streamOllamaChat(
      'qwen3.5:4b',
      [{ role: 'user', content: 'Bonjour' }],
      onContent,
      undefined,
      fetcher
    )).resolves.toEqual({ content: 'Réponse directe', toolCalls: [] })
    expect(onContent).toHaveBeenCalledOnce()
    expect(onContent).toHaveBeenCalledWith('Réponse directe')
  })

  it('continues a response when Ollama closes the stream before the done chunk', async () => {
    const interrupted = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"message":{"content":"Ollama peut tourner sur le PC"}}\n'))
        controller.close()
      }
    })
    const completed = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"message":{"content":" et l’agent dans Docker."},"done":true}\n'))
        controller.close()
      }
    })
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(interrupted, { status: 200 }))
      .mockResolvedValueOnce(new Response(completed, { status: 200 }))
    const onContent = vi.fn()

    await expect(streamOllamaChat(
      'qwen3.5:4b',
      [{ role: 'user', content: 'Est-ce possible ?' }],
      onContent,
      undefined,
      fetcher
    )).resolves.toEqual({
      content: 'Ollama peut tourner sur le PC et l’agent dans Docker.',
      toolCalls: []
    })
    expect(onContent.mock.calls.flat()).toEqual([
      'Ollama peut tourner sur le PC',
      ' et l’agent dans Docker.'
    ])
    expect(String(fetcher.mock.calls[1]?.[1]?.body)).toContain('Continue exactement la réponse interrompue')
  })

  it('rejects an unavailable Ollama response', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 503 }))

    await expect(streamOllamaChat(
      'qwen3.5:4b',
      [{ role: 'user', content: 'Bonjour' }],
      vi.fn(),
      undefined,
      fetcher
    )).rejects.toThrow('statut 503')
  })
})
