import { afterEach, describe, expect, it, vi } from 'vitest'
import { classifyIntent, classifyIntentByRule } from './intent-classifier'

function streamResponse(lines: unknown[]): Response {
  return new Response(`${lines.map((line) => JSON.stringify(line)).join('\n')}\n`, { status: 200 })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('intent classifier', () => {
  it('uses clear centralized rules for activity, software, and hangman explanations', () => {
    expect(classifyIntentByRule([
      { role: 'user', content: 'Viens, on joue une partie de pendu.' }
    ])).toMatchObject({ intent: 'activity', clear: true, source: 'rule', activityEngine: 'hangman' })
    expect(classifyIntentByRule([
      { role: 'user', content: 'Crée-moi une page web pour jouer au pendu.' }
    ])).toMatchObject({ intent: 'code', clear: true, source: 'rule' })
    expect(classifyIntentByRule([
      { role: 'user', content: 'Explique-moi les règles du pendu.' }
    ])).toMatchObject({ intent: 'discussion', clear: true, source: 'rule' })
  })

  it('does not assign the hangman engine to another conversational game', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockImplementation(async (url) => {
      if (String(url).endsWith('/api/ps')) return new Response(JSON.stringify({ models: [] }), { status: 200 })
      return streamResponse([{ message: { content: 'ACTIVITE' }, done: true }])
    }))

    await expect(classifyIntent({
      model: 'test-model',
      messages: [{ role: 'user', content: 'Viens, on joue au ni oui ni non.' }],
      signal: new AbortController().signal
    })).resolves.toEqual({
      intent: 'activity',
      clear: false,
      source: 'model',
      reason: 'model-classification'
    })
  })

  it('uses one isolated minimal model classification when no rule is clear', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) => {
      if (String(url).endsWith('/api/ps')) return new Response(JSON.stringify({ models: [] }), { status: 200 })
      return streamResponse([{ message: { content: 'CODE' }, done: true }])
    })
    vi.stubGlobal('fetch', fetcher)

    const result = await classifyIntent({
      model: 'test-model',
      messages: [{ role: 'user', content: 'Tu peux t’occuper de ça ?' }],
      signal: new AbortController().signal
    })

    expect(result).toEqual({
      intent: 'code',
      clear: false,
      source: 'model',
      reason: 'model-classification'
    })
    const request = fetcher.mock.calls
      .map((call) => JSON.parse(String(call[1]?.body ?? '{}')) as Record<string, unknown>)
      .find((body) => body.messages) as { messages: Array<{ content: string }>; options: { num_predict: number } }
    expect(request.messages[0]?.content).toContain('Réponds par exactement un mot')
    expect(request.options.num_predict).toBe(8)
    expect(request).not.toHaveProperty('tools')
  })

  it('treats an invalid classifier response as unknown without blocking normal handling', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockImplementation(async (url) => {
      if (String(url).endsWith('/api/ps')) return new Response(JSON.stringify({ models: [] }), { status: 200 })
      return streamResponse([{ message: { content: 'Je ne suis pas sûr.' }, done: true }])
    }))

    await expect(classifyIntent({
      model: 'test-model',
      messages: [{ role: 'user', content: 'Occupe-toi de ça.' }],
      signal: new AbortController().signal
    })).resolves.toMatchObject({ intent: 'unknown', clear: false, source: 'fallback' })
  })
})
