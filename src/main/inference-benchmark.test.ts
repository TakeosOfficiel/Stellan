import { describe, expect, it, vi } from 'vitest'
import type { InferenceProvider } from './inference'
import { compareInferenceMetrics, qualifyInferenceProvider } from './inference-benchmark'

describe('qualifyInferenceProvider', () => {
  it('checks text, structured tools, and tool-result correlation', async () => {
    const streamChat = vi.fn<InferenceProvider['streamChat']>()
      .mockImplementationOnce(async (...args) => {
        args[10]?.({ model: args[0], firstResponseMs: 10, wallMs: 20, tokensPerSecond: 5 })
        return { content: 'STELLAN_OK', toolCalls: [] }
      })
      .mockImplementationOnce(async (...args) => {
        args[10]?.({ model: args[0], firstResponseMs: 20, wallMs: 40, tokensPerSecond: 4 })
        return { content: '', toolCalls: [{ id: 'call-7', function: { name: 'stellan_probe', arguments: { value: 'ok' } } }] }
      })
      .mockImplementationOnce(async (...args) => {
        args[10]?.({ model: args[0], firstResponseMs: 30, wallMs: 60, tokensPerSecond: 3 })
        return { content: 'TOOL_RESULT_OK', toolCalls: [] }
      })
    const provider: InferenceProvider = { id: 'test', streamChat }

    await expect(qualifyInferenceProvider(provider, 'model')).resolves.toEqual({
      metrics: { firstResponseMs: 20, wallMs: 120, tokensPerSecond: 4 }
    })
    expect(streamChat.mock.calls[2]?.[1]).toContainEqual(expect.objectContaining({
      role: 'tool', tool_call_id: 'call-7'
    }))
  })

  it('rejects a provider that only narrates an intended tool call', async () => {
    const provider: InferenceProvider = {
      id: 'test',
      streamChat: vi.fn()
        .mockResolvedValueOnce({ content: 'STELLAN_OK', toolCalls: [] })
        .mockResolvedValueOnce({ content: 'Je vais appeler stellan_probe.', toolCalls: [] })
    }
    await expect(qualifyInferenceProvider(provider, 'model')).rejects.toThrow('appel d’outil structuré')
  })
})

describe('compareInferenceMetrics', () => {
  const base = { firstResponseMs: 100, wallMs: 1_000, tokensPerSecond: 10 }
  it('requires a meaningful ten-percent difference', () => {
    expect(compareInferenceMetrics({ ...base, wallMs: 800 }, base)).toBe('llama.cpp')
    expect(compareInferenceMetrics({ ...base, wallMs: 1_200 }, base)).toBe('ollama')
    expect(compareInferenceMetrics({ ...base, wallMs: 1_050 }, base)).toBe('equivalent')
    expect(compareInferenceMetrics(base, null)).toBe('llama.cpp')
  })
})
