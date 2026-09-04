import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const updateDirectory = path.join(tmpdir(), `stellan-updater-test-${process.pid}`)

const mocks = vi.hoisted(() => {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>()
  const updater = {
    autoDownload: false,
    autoInstallOnAppQuit: true,
    setFeedURL: vi.fn(),
    checkForUpdates: vi.fn(async () => null),
    quitAndInstall: vi.fn(),
    on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
      listeners.set(event, [...(listeners.get(event) ?? []), listener])
      return updater
    })
  }
  return {
    updater,
    emit(event: string, value?: unknown) {
      for (const listener of listeners.get(event) ?? []) listener(value)
    }
  }
})

vi.mock('electron', () => ({
  app: { isPackaged: true, getVersion: () => '0.1.2', getPath: () => updateDirectory }
}))
vi.mock('electron-updater', () => ({ default: { autoUpdater: mocks.updater } }))

const { getUpdateState, isInstallingUpdate, startMandatoryUpdate } = await import('./app-updater')

describe('mandatory application updater', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mkdirSync(updateDirectory, { recursive: true })
  })
  afterEach(() => rmSync(updateDirectory, { recursive: true, force: true }))

  it('uses the platform VPS channel, downloads automatically and forces restart', async () => {
    const ready = startMandatoryUpdate()
    expect(mocks.updater.setFeedURL).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'generic',
      url: expect.stringMatching(/^https:\/\/update\.stellan\.takeos\.fr\/(?:windows|linux)$/)
    }))
    expect(mocks.updater.autoDownload).toBe(true)

    mocks.emit('update-available', { version: '0.1.2' })
    mocks.emit('download-progress', { percent: 42.4, bytesPerSecond: 2_500_000 })
    expect(getUpdateState()).toEqual({
      status: 'downloading', version: '0.1.2', percent: 42.4, bytesPerSecond: 2_500_000
    })

    mocks.emit('update-downloaded', { version: '0.1.2' })
    await expect(ready).resolves.toBe(false)
    expect(isInstallingUpdate()).toBe(true)
    expect(existsSync(path.join(updateDirectory, 'pending-update-restart.json'))).toBe(true)
    await vi.advanceTimersByTimeAsync(899)
    expect(mocks.updater.quitAndInstall).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(mocks.updater.quitAndInstall).toHaveBeenCalledWith(true, true)
  })
})
