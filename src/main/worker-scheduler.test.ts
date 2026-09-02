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

  it('serializes one thread and can prioritize or remove its queued messages', async () => {
    const scheduler = new WorkerScheduler()
    const first = deferred()
    const third = deferred()
    const starts: string[] = []
    const add = (requestId: string, run: () => Promise<void>): void => scheduler.enqueue({
      requestId,
      threadId: 'same-thread',
      projectKey: 'project',
      isolationKey: null,
      maxConcurrentWorkers: 3,
      run: () => { starts.push(requestId); return run() },
      cancelQueued: vi.fn()
    })

    add('first', () => first.promise)
    add('second', async () => undefined)
    add('third', () => third.promise)
    expect(starts).toEqual(['first'])
    expect(scheduler.prioritize('third')).toBe(true)
    expect(scheduler.removeQueued('second')).toBe(true)
    first.resolve()
    await vi.waitFor(() => expect(starts).toEqual(['first', 'third']))
    third.resolve()
  })

  it('globally bounds child workers per project and removes an aborted queued child', async () => {
    const scheduler = new WorkerScheduler()
    const first = deferred()
    const second = deferred()
    const starts: string[] = []
    const firstRun = scheduler.runChild('project', 2, new AbortController().signal, () => {
      starts.push('first')
      return first.promise
    })
    const secondRun = scheduler.runChild('project', 2, new AbortController().signal, () => {
      starts.push('second')
      return second.promise
    })
    const thirdController = new AbortController()
    const thirdRun = scheduler.runChild('project', 2, thirdController.signal, async () => {
      starts.push('third')
    })

    expect(starts).toEqual(['first', 'second'])
    const rejected = expect(thirdRun).rejects.toBe('cancelled')
    thirdController.abort('cancelled')
    await rejected
    first.resolve()
    second.resolve()
    await Promise.all([firstRun, secondRun])
    expect(starts).toEqual(['first', 'second'])
  })
})
