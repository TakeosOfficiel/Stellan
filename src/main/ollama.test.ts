import { beforeEach, describe, expect, it, vi } from 'vitest'
import { configureOllamaModelOptions, getOllamaStatus, getOllamaStatusAt, modelSupportsTools, modelSupportsVision, pullOllamaModel, streamOllamaChat, warmOllamaModel } from './ollama'

beforeEach(() => configureOllamaModelOptions({ numCtx: 8_192, numPredict: 1_024 }))

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

describe('getOllamaStatusAt', () => {
  it('checks only the candidate runtime URL and never accepts a localhost fallback', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error('candidate unavailable'))

    await expect(getOllamaStatusAt('http://172.20.1.2:11435', fetcher)).resolves.toEqual({
      available: false,
      reason: "Ollama n'est pas joignable."
    })
    expect(fetcher).toHaveBeenCalledOnce()
    expect(fetcher).toHaveBeenCalledWith('http://172.20.1.2:11435/api/tags', expect.any(Object))
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

  it('does not expose a raw network error when the runtime disappears', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('fetch failed'))

    await expect(modelSupportsTools('coder:latest', fetcher)).rejects.toThrow(
      'Le moteur local d’Ollama n’est plus joignable.'
    )
  })
})

describe('modelSupportsVision', () => {
  it('reads the vision capability reported by Ollama', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({ capabilities: ['completion', 'vision'] }))

    await expect(modelSupportsVision('vision:latest', fetcher)).resolves.toBe(true)
    expect(fetcher).toHaveBeenCalledWith(
      'http://127.0.0.1:11435/api/show',
      expect.objectContaining({ body: JSON.stringify({ model: 'vision:latest' }) })
    )
  })
})

describe('warmOllamaModel', () => {
  it('loads the model with the same context as chat and keeps it ready', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({ done: true }))

    await expect(warmOllamaModel('qwen3.5:4b', fetcher)).resolves.toBe(true)
    expect(fetcher).toHaveBeenCalledWith(
      'http://127.0.0.1:11435/api/generate',
      expect.objectContaining({
        body: JSON.stringify({
          model: 'qwen3.5:4b',
          prompt: '',
          stream: false,
          keep_alive: -1,
          options: { num_ctx: 8192, num_predict: 1024 }
        })
      })
    )
  })

  it('limits the context of a large model even on a high-memory computer', async () => {
    configureOllamaModelOptions({ numCtx: 32_768, numPredict: 2_048 })
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({ done: true }))

    await expect(warmOllamaModel('qwen3.8:27b', fetcher)).resolves.toBe(true)
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body)).options).toEqual({
      num_ctx: 8_192,
      num_predict: 2_048
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
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toMatchObject({
      model: 'qwen3.5:4b',
      stream: true,
      think: false,
      keep_alive: -1,
      options: { num_ctx: 8192, num_predict: 1024 }
    })
  })

  it('serializes image data in the Ollama multimodal message format', async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"message":{"content":"Une image"},"done":true}\n'))
        controller.close()
      }
    })
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(stream, { status: 200 }))

    await streamOllamaChat(
      'vision:latest',
      [{ role: 'user', content: 'Décris', images: [{ mimeType: 'image/png', data: 'aGVsbG8=' }] }],
      () => undefined,
      undefined,
      fetcher
    )

    const body = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))
    expect(body.messages).toEqual([{ role: 'user', content: 'Décris', images: ['aGVsbG8='] }])
  })

  it('allows a smaller per-request context without exceeding the hardware limit', async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"message":{"content":"OK"},"done":true}\n'))
        controller.close()
      }
    })
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(stream, { status: 200 }))

    await streamOllamaChat(
      'qwen3.5:4b',
      [{ role: 'user', content: 'A' }],
      () => undefined,
      undefined,
      fetcher,
      undefined,
      120_000,
      256,
      2_048
    )

    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body)).options).toEqual({
      num_ctx: 2_048,
      num_predict: 256
    })
  })

  it('caps large-model chat context while preserving the configured response budget', async () => {
    configureOllamaModelOptions({ numCtx: 32_768, numPredict: 2_048 })
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"message":{"content":"OK"},"done":true}\n'))
        controller.close()
      }
    })
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(stream, { status: 200 }))

    await streamOllamaChat(
      'qwen3.8:27b',
      [{ role: 'user', content: 'A' }],
      () => undefined,
      undefined,
      fetcher
    )

    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body)).options).toEqual({
      num_ctx: 8_192,
      num_predict: 2_048
    })
  })

  it('reports model residency, GPU allocation, and Ollama timing metrics', async () => {
    let psCall = 0
    const fetcher = vi.fn<typeof fetch>((url) => {
      if (String(url).endsWith('/api/ps')) {
        psCall += 1
        return Promise.resolve(response({
          models: psCall === 1 ? [] : [{
            name: 'qwen3.5:2b',
            size: 2_000_000_000,
            size_vram: 1_900_000_000,
            expires_at: '2099-01-01T00:00:00Z'
          }]
        }))
      }
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(
            '{"message":{"content":"OK"},"done":true,"total_duration":2500000000,"load_duration":100000000,"prompt_eval_count":500,"prompt_eval_duration":1000000000,"eval_count":20,"eval_duration":1000000000}\n'
          ))
          controller.close()
        }
      })
      return Promise.resolve(new Response(stream, { status: 200 }))
    })
    const diagnostics = vi.fn()

    await streamOllamaChat(
      'qwen3.5:2b',
      [{ role: 'user', content: 'A' }],
      () => undefined,
      undefined,
      fetcher,
      undefined,
      120_000,
      256,
      2_048,
      diagnostics
    )

    expect(diagnostics).toHaveBeenCalledWith('ollama.ps.before models=none')
    expect(diagnostics).toHaveBeenCalledWith(expect.stringContaining('ollama.metrics model=qwen3.5:2b'))
    expect(diagnostics).toHaveBeenCalledWith(expect.stringContaining('loadMs=100.0 promptEvalMs=1000.0'))
    expect(diagnostics).toHaveBeenCalledWith(expect.stringContaining('generationMs=1000.0 generatedTokens=20 tokensPerSecond=20.0'))
    expect(diagnostics).toHaveBeenCalledWith(expect.stringContaining('ollama.ps.after models=qwen3.5:2b'))
    expect(diagnostics).toHaveBeenCalledWith(expect.stringContaining('vramBytes=1900000000'))
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

  it('stops a model that stays completely idle', async () => {
    const fetcher = vi.fn<typeof fetch>((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
    }))

    await expect(streamOllamaChat(
      'qwen3.5:4b',
      [{ role: 'user', content: 'Bonjour' }],
      vi.fn(),
      undefined,
      fetcher,
      undefined,
      10
    )).rejects.toThrow('ne produit plus de réponse')
  })
})
