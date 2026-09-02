import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'

const spawn = vi.hoisted(() => vi.fn())

vi.mock('node:child_process', () => ({ spawn }))

import { runCommand } from './runtime'

describe('runCommand process isolation', () => {
  it('never opens a Windows console or invokes a shell', async () => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn()
    })
    spawn.mockImplementationOnce(() => {
      queueMicrotask(() => child.emit('close', 0, null))
      return child
    })

    await expect(runCommand('git', ['--version'])).resolves.toMatchObject({ exitCode: 0 })
    expect(spawn).toHaveBeenCalledWith('git', ['--version'], expect.objectContaining({
      shell: false,
      windowsHide: true
    }))
  })
})
