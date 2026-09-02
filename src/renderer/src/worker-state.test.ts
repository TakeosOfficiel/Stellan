import { describe, expect, it } from 'vitest'
import type { ChatEvent } from '../../shared/contracts'
import { applyMessageEvent, applyRunEvent, type ChatUiMessage } from './worker-state'

describe('parallel worker renderer state', () => {
  it('routes simultaneous queued/running events to their own threads while switching', () => {
    const queued: ChatEvent = { requestId: 'request-a', threadId: 'thread-a', type: 'status', status: 'queued' }
    const running: ChatEvent = { requestId: 'request-b', threadId: 'thread-b', type: 'status', status: 'running' }
    const content: ChatEvent = { requestId: 'request-b', threadId: 'thread-b', type: 'content', content: 'B result' }
    let runs = applyRunEvent({}, queued)
    runs = applyRunEvent(runs, running)
    let messages: Record<string, ChatUiMessage[]> = {}
    messages = applyMessageEvent(messages, queued)
    messages = applyMessageEvent(messages, running)
    messages = applyMessageEvent(messages, content)

    expect(runs).toEqual({
      'thread-a': { requestId: 'request-a', status: 'queued' },
      'thread-b': { requestId: 'request-b', status: 'running' }
    })
    expect(messages['thread-a']).toBeUndefined()
    expect(messages['thread-b']?.[0]?.content).toBe('B result')
  })

  it('finishes only the matching thread/request pair', () => {
    const current = {
      a: { requestId: 'one', status: 'running' as const },
      b: { requestId: 'two', status: 'queued' as const }
    }
    const stale: ChatEvent = { requestId: 'old', threadId: 'a', type: 'done' }
    const done: ChatEvent = { requestId: 'one', threadId: 'a', type: 'done' }
    expect(applyRunEvent(current, stale)).toBe(current)
    expect(applyRunEvent(current, done)).toEqual({ b: current.b })
  })
})
