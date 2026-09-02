import { describe, expect, it, vi } from 'vitest'
import { WorkerScheduler } from './worker-scheduler'

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => undefined
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

describe('WorkerScheduler', () => {
  it('enforces limits per project while allowing another project to run', async () => {
    const scheduler = new WorkerScheduler()
    const first = deferred()
    const second = deferred()
    const other = deferred()
    const starts: string[] = []
    const add = (requestId: string, projectKey: string, gate: ReturnType<typeof deferred>): void => scheduler.enqueue({
      requestId, threadId: requestId, projectKey, isolationKey: null, maxConcurrentWorkers: 1,
      run: () => { starts.push(requestId); return gate.promise }, cancelQueued: vi.fn()
    })

    add('first', 'a', first)
    add('second', 'a', second)
    add('other', 'b', other)
    expect(starts).toEqual(['first', 'other'])
    first.resolve()
    await first.promise
    await vi.waitFor(() => expect(starts).toEqual(['first', 'other', 'second']))
    second.resolve()
    other.resolve()
  })

  it('removes queued jobs on cancellation and serializes a shared direct folder', async () => {
    const scheduler = new WorkerScheduler()
    const first = deferred()
    const cancelled = vi.fn()
    const starts: string[] = []
    scheduler.enqueue({
      requestId: 'first', threadId: 'one', projectKey: 'p', isolationKey: '/same', maxConcurrentWorkers: 2,
      run: () => { starts.push('first'); return first.promise }, cancelQueued: vi.fn()
    })
    scheduler.enqueue({
      requestId: 'second', threadId: 'two', projectKey: 'p', isolationKey: '/same', maxConcurrentWorkers: 2,
      run: async () => { starts.push('second') }, cancelQueued: cancelled
    })
    expect(starts).toEqual(['first'])
    expect(scheduler.cancel('second')).toBe('queued')
    expect(cancelled).toHaveBeenCalledOnce()
    expect(scheduler.hasThread('two')).toBe(false)
    first.resolve()
  })
})
