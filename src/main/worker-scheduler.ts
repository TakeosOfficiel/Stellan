export type ScheduledWorker = {
  requestId: string
  threadId: string
  projectKey: string
  isolationKey: string | null
  maxConcurrentWorkers: number
  run: () => Promise<void>
  cancelQueued: () => void
}

type WorkerState = 'queued' | 'running'
type ChildWorker = {
  signal: AbortSignal
  started: boolean
  run: () => Promise<unknown>
  resolve: (value: unknown) => void
  reject: (reason: unknown) => void
  onAbort: () => void
}

type ChildPool = {
  active: number
  limit: number
  queue: ChildWorker[]
}

export class WorkerScheduler {
  private readonly jobs = new Map<string, ScheduledWorker & { state: WorkerState }>()
  private readonly childPools = new Map<string, ChildPool>()
  private stopped = false

  enqueue(worker: ScheduledWorker): void {
    if (this.stopped) throw new Error('Le planificateur de workers est arrêté.')
    if (this.jobs.has(worker.requestId)) throw new Error('Cette génération est déjà planifiée.')
    this.jobs.set(worker.requestId, { ...worker, state: 'queued' })
    this.drain(worker.projectKey)
  }

  cancel(requestId: string): 'queued' | 'running' | null {
    const worker = this.jobs.get(requestId)
    if (!worker) return null
    if (worker.state === 'running') return 'running'
    this.jobs.delete(requestId)
    worker.cancelQueued()
    this.drain(worker.projectKey)
    return 'queued'
  }

  removeQueued(requestId: string): boolean {
    const worker = this.jobs.get(requestId)
    if (!worker || worker.state !== 'queued') return false
    this.jobs.delete(requestId)
    this.drain(worker.projectKey)
    return true
  }

  prioritize(requestId: string): boolean {
    const worker = this.jobs.get(requestId)
    if (!worker || worker.state !== 'queued') return false
    const queued = [...this.jobs.entries()]
    this.jobs.clear()
    this.jobs.set(requestId, worker)
    for (const [id, job] of queued) {
      if (id !== requestId) this.jobs.set(id, job)
    }
    this.drain(worker.projectKey)
    return true
  }

  hasThread(threadId: string): boolean {
    return [...this.jobs.values()].some((worker) => worker.threadId === threadId)
  }

  has(requestId: string): boolean {
    return this.jobs.has(requestId)
  }

  updateProjectLimit(projectKey: string, maxConcurrentWorkers: number): void {
    for (const worker of this.jobs.values()) {
      if (worker.projectKey === projectKey) worker.maxConcurrentWorkers = maxConcurrentWorkers
    }
    const pool = this.childPools.get(projectKey)
    if (pool) {
      pool.limit = maxConcurrentWorkers
      this.drainChildren(projectKey, pool)
    }
    this.drain(projectKey)
  }

  runChild<T>(
    projectKey: string,
    maxConcurrentWorkers: number,
    signal: AbortSignal,
    run: () => Promise<T>
  ): Promise<T> {
    if (this.stopped) return Promise.reject(new Error('Le planificateur de workers est arrêté.'))
    let pool = this.childPools.get(projectKey)
    if (!pool) {
      pool = { active: 0, limit: maxConcurrentWorkers, queue: [] }
      this.childPools.set(projectKey, pool)
    } else pool.limit = maxConcurrentWorkers

    return new Promise<T>((resolve, reject) => {
      const child: ChildWorker = {
        signal,
        started: false,
        run,
        resolve: (value) => resolve(value as T),
        reject,
        onAbort: () => {
          if (child.started) return
          const index = pool.queue.indexOf(child)
          if (index >= 0) pool.queue.splice(index, 1)
          reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
          if (pool.active === 0 && pool.queue.length === 0) this.childPools.delete(projectKey)
        }
      }
      signal.addEventListener('abort', child.onAbort, { once: true })
      pool.queue.push(child)
      this.drainChildren(projectKey, pool)
    })
  }

  shutdown(preserveQueued = false): void {
    this.stopped = true
    for (const worker of [...this.jobs.values()]) {
      if (worker.state === 'queued') {
        this.jobs.delete(worker.requestId)
        if (!preserveQueued) worker.cancelQueued()
      }
    }
    for (const pool of this.childPools.values()) {
      for (const child of pool.queue.splice(0)) {
        child.signal.removeEventListener('abort', child.onAbort)
        child.reject(new Error('Le planificateur de workers est arrêté.'))
      }
    }
  }

  private drainChildren(projectKey: string, pool: ChildPool): void {
    while (!this.stopped && pool.active < pool.limit) {
      const child = pool.queue.shift()
      if (!child) break
      if (child.signal.aborted) {
        child.signal.removeEventListener('abort', child.onAbort)
        child.reject(child.signal.reason ?? new DOMException('Aborted', 'AbortError'))
        continue
      }
      child.started = true
      pool.active += 1
      void child.run().then(child.resolve, child.reject).finally(() => {
        child.signal.removeEventListener('abort', child.onAbort)
        pool.active -= 1
        this.drainChildren(projectKey, pool)
        if (pool.active === 0 && pool.queue.length === 0) this.childPools.delete(projectKey)
      })
    }
  }

  private drain(projectKey: string): void {
    if (this.stopped) return
    const projectJobs = [...this.jobs.values()].filter((worker) => worker.projectKey === projectKey)
    const running = projectJobs.filter((worker) => worker.state === 'running')
    for (const worker of projectJobs) {
      if (worker.state !== 'queued') continue
      if (running.length >= worker.maxConcurrentWorkers) break
      if (running.some((active) => active.threadId === worker.threadId)) continue
      if (worker.isolationKey && running.some((active) => active.isolationKey === worker.isolationKey)) continue
      worker.state = 'running'
      running.push(worker)
      const complete = (): void => {
        this.jobs.delete(worker.requestId)
        this.drain(projectKey)
      }
      void worker.run().then(complete, complete)
    }
  }
}
