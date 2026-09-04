import { describe, expect, it, vi } from 'vitest'
import type { WorkerProfile } from '../shared/contracts'
import { createWorkerCommandExecutor } from './worker-runtime'

const profile: WorkerProfile = {
  projectPath: '/project',
  mode: 'container',
  runtime: 'docker',
  cpuLimit: 2,
  memoryMb: 4096,
  storageGb: 20,
  automaticCpuMemory: true,
  image: 'node:22-bookworm',
  network: 'none',
  maxConcurrentWorkers: 2,
  updatedAt: '2026-01-01'
}

describe('createWorkerCommandExecutor', () => {
  it('maps an agent command to the persisted container limits', async () => {
    const result = {
      exitCode: 0,
      signal: null,
      stdout: 'ok',
      stderr: '',
      timedOut: false,
      outputTruncated: false
    }
    const container = vi.fn().mockResolvedValue(result)
    const signal = new AbortController().signal
    const execute = createWorkerCommandExecutor(profile, 'thread-123', '/workspace', null, container)

    await expect(execute?.('pnpm', ['test'], { timeoutMs: 120_000, signal })).resolves.toEqual(result)
    expect(container).toHaveBeenCalledWith({
      runtime: 'docker',
      threadId: 'thread-123',
      projectPath: '/workspace',
      image: 'node:22-bookworm',
      command: ['pnpm', 'test'],
      cpuLimit: 2,
      memoryLimit: '4096m',
      network: 'none',
      timeoutMs: 120_000,
      signal
    })
  })

  it('fails closed instead of executing a direct profile on the host', () => {
    expect(() => createWorkerCommandExecutor(
      { ...profile, mode: 'direct', runtime: null },
      'thread',
      '/workspace'
    )).toThrow('exécution directe')
  })

  it('fails closed for an invalid persisted container profile', () => {
    expect(() => createWorkerCommandExecutor(
      { ...profile, runtime: null },
      'thread',
      '/workspace'
    )).toThrow('aucun runtime')
  })
})
