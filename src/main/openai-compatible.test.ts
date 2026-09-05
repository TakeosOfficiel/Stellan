import { describe, expect, it, vi } from 'vitest'
import { createLocalOpenAICompatibleProvider } from './openai-compatible'

function event(data: unknown): string {
  return `data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`
}

describe('createLocalOpenAICompatibleProvider', () => {
  it('only accepts a loopback inference server', () => {
    expect(() => createLocalOpenAICompatibleProvider({
      id: 'unsafe',
      baseUrl: 'https://api.example.com'
    })).toThrow('adresse locale loopback')
    expect(() => createLocalOpenAICompatibleProvider({
      id: 'llama.cpp',
      baseUrl: 'http://127.0.0.1:11436'
    })).not.toThrow()
  })

  it('accepts a private WSL address only when discovered by Stellan itself', () => {
    expect(() => createLocalOpenAICompatibleProvider({
      id: 'llama.cpp',
      baseUrl: 'http://172.20.10.2:11436'
    })).toThrow('adresse locale loopback')
    expect(() => createLocalOpenAICompatibleProvider({
      id: 'llama.cpp',
      baseUrl: 'http://172.20.10.2:11436',
      trustedRuntimeNetwork: true
    })).not.toThrow()
    expect(() => createLocalOpenAICompatibleProvider({
      id: 'unsafe',
      baseUrl: 'https://api.example.com',
      trustedRuntimeNetwork: true
    })).toThrow('adresse locale loopback')
  })

  it('streams content and reconstructs fragmented OpenAI tool calls', async () => {
    const body = [
      event({ choices: [{ index: 0, delta: { content: 'Je vérifie. ' }, finish_reason: null }] }),
      event({ choices: [{ index: 0, delta: { tool_calls: [{
        index: 0,
        id: 'call-42',
        function: { name: 'read_', arguments: '{"path":' }
      }] }, finish_reason: null }] }),
      event({ choices: [{ index: 0, delta: { tool_calls: [{
        index: 0,
        function: { name: 'file', arguments: '"src/index.ts"}' }
      }] }, finish_reason: 'tool_calls' }] }),
      event({ choices: [], usage: { completion_tokens: 8 } }),
      event('[DONE]')
    ].join('')
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(body, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' }
    }))
    const onContent = vi.fn()
    const onMetrics = vi.fn()
    const provider = createLocalOpenAICompatibleProvider({
      id: 'llama.cpp',
      baseUrl: 'http://localhost:11436/'
    })

    const result = await provider.streamChat(
      'local-model',
      [
        { role: 'assistant', content: '', tool_calls: [{
          id: 'previous-call',
          function: { name: 'list_files', arguments: {} }
        }] },
        {
          role: 'tool',
          content: 'index.ts',
          tool_name: 'list_files',
          tool_call_id: 'previous-call'
        },
        { role: 'user', content: 'Lis le fichier.' }
      ],
      onContent,
      undefined,
      fetcher,
      [{ type: 'function', function: { name: 'read_file' } }],
      1_000,
      128,
      8_192,
      undefined,
      onMetrics
    )

    expect(result).toEqual({
      content: 'Je vérifie. ',
      toolCalls: [{
        id: 'call-42',
        function: { name: 'read_file', arguments: { path: 'src/index.ts' } }
      }]
    })
    expect(onContent).toHaveBeenCalledWith('Je vérifie. ')
    expect(onMetrics).toHaveBeenCalledWith(expect.objectContaining({
      model: 'local-model',
      tokensPerSecond: expect.any(Number)
    }))
    const request = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body)) as {
      messages: Array<Record<string, unknown>>
      max_tokens: number
      tools: unknown[]
    }
    expect(request.messages[0]).toMatchObject({
      role: 'assistant',
      tool_calls: [{ id: 'previous-call', function: { arguments: '{}' } }]
    })
    expect(request.messages[1]).toMatchObject({
      role: 'tool',
      tool_call_id: 'previous-call'
    })
    expect(request.max_tokens).toBe(128)
    expect(request.tools).toHaveLength(1)
  })

  it('refuses invalid tool arguments instead of executing them', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response([
      event({ choices: [{ index: 0, delta: { tool_calls: [{
        index: 0,
        id: 'broken',
        function: { name: 'write_file', arguments: '{invalid' }
      }] }, finish_reason: 'tool_calls' }] }),
      event('[DONE]')
    ].join(''), { status: 200 }))
    const provider = createLocalOpenAICompatibleProvider({
      id: 'llama.cpp',
      baseUrl: 'http://127.0.0.1:11436'
    })

    await expect(provider.streamChat(
      'local-model',
      [{ role: 'user', content: 'Modifie le fichier.' }],
      () => undefined,
      undefined,
      fetcher
    )).rejects.toThrow('arguments JSON invalides')
  })
})
