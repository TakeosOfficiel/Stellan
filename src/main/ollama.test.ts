import { describe, expect, it, vi } from 'vitest'
import { getOllamaStatus, pullOllamaModel, streamOllamaChat } from './ollama'

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
      reason: "Ollama n'est pas accessible sur cette machine."
    })
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
