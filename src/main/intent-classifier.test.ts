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

  it('routes neither-yes-nor-no explicitly without assigning the hangman engine', async () => {
    await expect(classifyIntent({
      model: 'test-model',
      messages: [{ role: 'user', content: 'Viens, on joue au ni oui ni non.' }],
      signal: new AbortController().signal
    })).resolves.toEqual({
      intent: 'activity',
      clear: true,
      source: 'rule',
      reason: 'explicit-activity',
      activityEngine: 'neither-yes-nor-no'
    })
  })

  it('keeps explanations and software about neither-yes-nor-no outside its engine', () => {
    expect(classifyIntentByRule([
      { role: 'user', content: 'Explique-moi les règles du ni oui ni non.' }
    ])).toMatchObject({ intent: 'discussion', clear: true, source: 'rule' })
    expect(classifyIntentByRule([
      { role: 'user', content: 'Crée une page web de ni oui ni non.' }
    ])).toMatchObject({ intent: 'code', clear: true, source: 'rule' })
  })

  it('routes direct and follow-up image inspection as discussion', () => {
    const image = { mimeType: 'image/png' as const, data: 'aGVsbG8=' }
    expect(classifyIntentByRule([
      { role: 'user', content: 'Tu vois quoi sur cette image ?', images: [image] }
    ])).toMatchObject({ intent: 'discussion', clear: true, reason: 'attached-image-analysis' })
    expect(classifyIntentByRule([
      { role: 'user', content: 'Tu vois quoi sur cette image ?', images: [image] },
      { role: 'assistant', content: 'Je peux vous aider.' },
      { role: 'user', content: "Tu voit quoi sur l'image que j'ai envoyée ?" }
    ])).toMatchObject({ intent: 'discussion', clear: true, reason: 'attached-image-analysis' })
    expect(classifyIntentByRule([
      { role: 'user', content: 'cette iomage', images: [image] }
    ])).toMatchObject({ intent: 'discussion', clear: true, reason: 'attached-image-analysis' })
  })

  it('keeps an image-backed software modification in code mode', () => {
    expect(classifyIntentByRule([{
      role: 'user',
      content: 'Corrige le site selon cette capture.',
      images: [{ mimeType: 'image/png', data: 'aGVsbG8=' }]
    }])).toMatchObject({ intent: 'code', clear: true, reason: 'explicit-software-artifact' })
  })

  it('lets the isolated model classify implicit feedback on previous software work', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) => {
      if (String(url).endsWith('/api/ps')) return new Response(JSON.stringify({ models: [] }), { status: 200 })
      return streamResponse([{ message: { content: 'CODE' }, done: true }])
    })
    vi.stubGlobal('fetch', fetcher)

    await expect(classifyIntent({
      model: 'test-model',
      messages: [
        { role: 'assistant', content: 'J’ai créé index.html, styles.css et app.js pour le site.' },
        { role: 'user', content: 'Le site est moche !' }
      ],
      signal: new AbortController().signal
    })).resolves.toEqual({
      intent: 'code',
      clear: false,
      source: 'model',
      reason: 'model-classification'
    })
    const request = JSON.parse(String(fetcher.mock.calls.find((call) => String(call[0]).endsWith('/api/chat'))?.[1]?.body))
    expect(request.messages[0].content).toContain('demander implicitement de reprendre le résultat logiciel précédent')
  })

  it('routes normal answers to an active neither-yes-nor-no engine', () => {
    expect(classifyIntentByRule(
      [{ role: 'user', content: 'Absolument !' }],
      '{"engineId":"neither-yes-nor-no"}'
    )).toMatchObject({
      intent: 'activity',
      clear: true,
      activityEngine: 'neither-yes-nor-no'
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
