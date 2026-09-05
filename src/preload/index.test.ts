import type { LocalAgentApi } from '../shared/contracts'
import { describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  exposeInMainWorld: vi.fn(),
  invoke: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn()
}))

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: mocks.exposeInMainWorld },
  ipcRenderer: {
    invoke: mocks.invoke,
    on: mocks.on,
    removeListener: mocks.removeListener
  }
}))

await import('./index')
const api = mocks.exposeInMainWorld.mock.calls[0]?.[1] as LocalAgentApi

describe('portal preload IPC', () => {
  it('exposes the local llama.cpp benchmark and its progress stream', async () => {
    const listener = vi.fn()
    const unsubscribe = api.onInferenceBenchmarkProgress(listener)
    await api.benchmarkLlamaCpp('qwen3.5:4b')
    await api.openInferenceLog()
    unsubscribe()

    expect(mocks.invoke.mock.calls.slice(-2)).toEqual([
      ['inference:benchmark-llama-cpp', 'qwen3.5:4b'],
      ['inference:open-log']
    ])
    expect(mocks.on).toHaveBeenCalledWith('inference:benchmark-progress', expect.any(Function))
    expect(mocks.removeListener).toHaveBeenCalledWith('inference:benchmark-progress', expect.any(Function))
  })

  it('exposes project and numeric-port modes, never an upstream host or URL', async () => {
    await api.startPortal({ threadId: 'thread', source: 'project', durationMinutes: null })
    await api.startPortal({ threadId: 'thread', source: 'port', port: 3000, durationMinutes: 60 })
    await api.getPortal('thread')
    await api.stopPortal('thread')
    await api.copyPortalUrl('thread')
    await api.openPortal('thread')

    expect(mocks.invoke.mock.calls.slice(-6)).toEqual([
      ['portal:start', { threadId: 'thread', source: 'project', durationMinutes: null }],
      ['portal:start', { threadId: 'thread', source: 'port', port: 3000, durationMinutes: 60 }],
      ['portal:get', 'thread'],
      ['portal:stop', 'thread'],
      ['portal:copy-url', 'thread'],
      ['portal:open', 'thread']
    ])
  })

  it('exposes project file reads only through a thread id and relative path', async () => {
    await api.exportThreadProject('thread')
    await api.getProjectResources('thread')
    await api.saveProjectResources({
      threadId: 'thread', cpuLimit: 8, memoryMb: 16_384, storageGb: 100, automaticCpuMemory: false
    })
    await api.listProjectFiles('thread')
    await api.readProjectFile({ threadId: 'thread', path: 'src/index.ts' })
    await api.openProjectFile({ threadId: 'thread', path: 'src/index.ts' })
    await api.loadThreadToolActivities('thread')

    expect(mocks.invoke.mock.calls.slice(-7)).toEqual([
      ['threads:export-project', 'thread'],
      ['threads:get-project-resources', 'thread'],
      ['threads:save-project-resources', {
        threadId: 'thread', cpuLimit: 8, memoryMb: 16_384, storageGb: 100, automaticCpuMemory: false
      }],
      ['threads:list-project-files', 'thread'],
      ['threads:read-project-file', { threadId: 'thread', path: 'src/index.ts' }],
      ['threads:open-project-file', { threadId: 'thread', path: 'src/index.ts' }],
      ['threads:tool-activities', 'thread']
    ])
  })

  it('forwards explicit thread deletion confirmation', async () => {
    await api.deleteThread({ threadId: 'thread', discardChanges: false })
    await api.deleteThread({ threadId: 'thread', discardChanges: true })

    expect(mocks.invoke.mock.calls.slice(-2)).toEqual([
      ['threads:delete', { threadId: 'thread', discardChanges: false }],
      ['threads:delete', { threadId: 'thread', discardChanges: true }]
    ])
  })

  it('deletes a project through its persisted project path', async () => {
    await api.deleteProject({ projectPath: '/private/project' })

    expect(mocks.invoke.mock.calls.at(-1)).toEqual([
      'project:delete',
      { projectPath: '/private/project' }
    ])
  })

  it('persists an explicit primary model selection on the active thread', async () => {
    await api.setThreadModel({ threadId: 'thread', model: 'qwen3.5:4b' })

    expect(mocks.invoke.mock.calls.at(-1)).toEqual([
      'threads:set-model',
      { threadId: 'thread', model: 'qwen3.5:4b' }
    ])
  })
})
