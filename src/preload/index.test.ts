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
    await api.listProjectFiles('thread')
    await api.readProjectFile({ threadId: 'thread', path: 'src/index.ts' })
    await api.openProjectFile({ threadId: 'thread', path: 'src/index.ts' })

    expect(mocks.invoke.mock.calls.slice(-4)).toEqual([
      ['threads:export-project', 'thread'],
      ['threads:list-project-files', 'thread'],
      ['threads:read-project-file', { threadId: 'thread', path: 'src/index.ts' }],
      ['threads:open-project-file', { threadId: 'thread', path: 'src/index.ts' }]
    ])
  })
})
