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

  hasThread(threadId: string): boolean {
    return [...this.jobs.values()].some((worker) => worker.threadId === threadId)
  }

  updateProjectLimit(projectKey: string, maxConcurrentWorkers: number): void {
    for (const worker of this.jobs.values()) {
      if (worker.projectKey === projectKey) worker.maxConcurrentWorkers = maxConcurrentWorkers
    }
    this.drain(projectKey)
  }

  shutdown(): void {
    this.stopped = true
    for (const worker of [...this.jobs.values()]) {
      if (worker.state === 'queued') {
        this.jobs.delete(worker.requestId)
        worker.cancelQueued()
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
