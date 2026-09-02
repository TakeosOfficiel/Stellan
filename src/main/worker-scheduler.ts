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

export class WorkerScheduler {
  private readonly jobs = new Map<string, ScheduledWorker & { state: WorkerState }>()
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
    this.drain(projectKey)
  }

  shutdown(preserveQueued = false): void {
    this.stopped = true
    for (const worker of [...this.jobs.values()]) {
      if (worker.state === 'queued') {
        this.jobs.delete(worker.requestId)
        if (!preserveQueued) worker.cancelQueued()
      }
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
