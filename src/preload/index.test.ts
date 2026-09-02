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
  it('exposes only thread and numeric port inputs, never an upstream host or URL', async () => {
    await api.startPortal({ threadId: 'thread', port: 3000 })
    await api.getPortal('thread')
    await api.stopPortal('thread')
    await api.copyPortalUrl('thread')
    await api.openPortal('thread')

    expect(mocks.invoke.mock.calls.slice(-5)).toEqual([
      ['portal:start', { threadId: 'thread', port: 3000 }],
      ['portal:get', 'thread'],
      ['portal:stop', 'thread'],
      ['portal:copy-url', 'thread'],
      ['portal:open', 'thread']
    ])
  })
})
