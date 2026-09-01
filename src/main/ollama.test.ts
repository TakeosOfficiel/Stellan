import { describe, expect, it, vi } from 'vitest'
import { getOllamaStatus } from './ollama'

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
