import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import type { IPty } from 'node-pty'
import { describe, expect, it, vi } from 'vitest'
import { killProcessTree, TerminalManager, type PtyFactory, type TerminalEventSink } from './terminal'

function fakePty() {
  let dataListener: (data: string) => void = () => {}
  let exitListener: (event: { exitCode: number; signal?: number }) => void = () => {}
  const pty = {
    pid: 1234,
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    onData: vi.fn((listener: typeof dataListener) => { dataListener = listener; return { dispose() {} } }),
    onExit: vi.fn((listener: typeof exitListener) => { exitListener = listener; return { dispose() {} } })
  } as unknown as IPty
  return { pty, emitData: (data: string) => dataListener(data), emitExit: (exitCode: number) => exitListener({ exitCode }) }
}

const directLaunch = {
  threadId: '00000000-0000-4000-8000-000000000001',
  ownerId: 7,
  cwd: '/approved/worktree',
  cols: 80,
  rows: 24,
  profile: null
}

describe('TerminalManager', () => {
  it('starts one argv-based PTY per thread in the main-approved cwd and streams events', async () => {
    const fake = fakePty()
    const factory = vi.fn<PtyFactory>(() => fake.pty)
    const send = vi.fn<TerminalEventSink>()
    const kill = vi.fn(async () => {})
    const manager = new TerminalManager(send, factory, kill)

    expect(manager.start(directLaunch)).toEqual({
      threadId: directLaunch.threadId,
      mode: 'direct',
      reused: false
    })
    expect(factory).toHaveBeenCalledWith(
      expect.stringMatching(process.platform === 'win32' ? /cmd\.exe$/i : /^\/bin\/(?:ba)?sh$/),
      [],
      expect.objectContaining({ cwd: directLaunch.cwd, cols: 80, rows: 24 })
    )
    expect(manager.start(directLaunch).reused).toBe(true)
    expect(factory).toHaveBeenCalledOnce()

    manager.write(directLaunch.threadId, 7, 'echo safe\r')
    manager.resize(directLaunch.threadId, 7, 100, 30)
    expect(fake.pty.write).toHaveBeenCalledWith('echo safe\r')
    expect(fake.pty.resize).toHaveBeenCalledWith(100, 30)
    fake.emitData('hello')
    expect(send).toHaveBeenCalledWith(7, {
      threadId: directLaunch.threadId,
      type: 'data',
      data: 'hello'
    })

    await expect(manager.close(directLaunch.threadId, 7)).resolves.toBe(true)
    expect(kill).toHaveBeenCalledWith(1234)
    expect(fake.pty.kill).toHaveBeenCalledOnce()
  })

  it('enforces session ownership', () => {
    const fake = fakePty()
    const manager = new TerminalManager(() => {}, () => fake.pty)
    manager.start(directLaunch)

    expect(() => manager.write(directLaunch.threadId, 8, 'data')).toThrow('autre fenêtre')
    expect(() => manager.start({ ...directLaunch, ownerId: 8 })).toThrow('autre fenêtre')
  })

  it('uses fixed Docker argv for container profiles and force-removes the container', async () => {
    const fake = fakePty()
    const factory = vi.fn<PtyFactory>(() => fake.pty)
    const remove = vi.fn(async () => {})
    const manager = new TerminalManager(() => {}, factory, async () => {}, remove)
    const launch = {
      ...directLaunch,
      profile: {
        projectPath: '/approved/project',
        mode: 'container' as const,
        runtime: 'docker' as const,
        cpuLimit: 2,
        memoryMb: 2048,
        image: 'node:22-bookworm',
        network: 'none' as const,
        updatedAt: '2026-01-01T00:00:00.000Z'
      }
    }

    expect(manager.start(launch).mode).toBe('container')
    const args = factory.mock.calls[0]?.[1] ?? []
    expect(factory.mock.calls[0]?.[0]).toBe('docker')
    expect(args).toContain('--interactive')
    expect(args).toContain('--tty')
    expect(args).toContain(`type=bind,source=${launch.cwd},target=/workspace`)
    expect(args.slice(-3)).toEqual(['--', 'node:22-bookworm', '/bin/sh'])
    expect(args.join(' ')).not.toContain('docker.sock')

    await manager.close(launch.threadId, launch.ownerId)
    expect(remove).toHaveBeenCalledWith('docker', `local-agent-terminal-${launch.threadId}`)
  })

  it('cleans process trees and reports natural exits', async () => {
    const fake = fakePty()
    const send = vi.fn<TerminalEventSink>()
    const kill = vi.fn(async () => {})
    const manager = new TerminalManager(send, () => fake.pty, kill)
    manager.start(directLaunch)

    fake.emitExit(0)
    await vi.waitFor(() => expect(send).toHaveBeenCalledWith(7, {
      threadId: directLaunch.threadId,
      type: 'exit',
      exitCode: 0,
      signal: null
    }))
    expect(kill).not.toHaveBeenCalled()
    await expect(manager.close(directLaunch.threadId, 7)).resolves.toBe(false)
  })

  it('surfaces container cleanup failures instead of reporting a silent close', async () => {
    const fake = fakePty()
    const manager = new TerminalManager(
      () => {},
      () => fake.pty,
      async () => {},
      async () => { throw new Error('cleanup failed') }
    )
    manager.start({
      ...directLaunch,
      profile: {
        projectPath: '/approved/project',
        mode: 'container',
        runtime: 'docker',
        cpuLimit: 2,
        memoryMb: 2048,
        image: 'node:22-bookworm',
        network: 'none',
        updatedAt: '2026-01-01T00:00:00.000Z'
      }
    })

    await expect(manager.close(directLaunch.threadId, directLaunch.ownerId)).rejects.toThrow('cleanup failed')
  })
})

describe('killProcessTree', () => {
  it.skipIf(process.platform !== 'linux')('kills background jobs in separate process groups', async () => {
    const leader = spawn('/bin/sh', ['-c', 'sleep 1000 & echo $!; wait'], {
      detached: true,
      stdio: ['ignore', 'pipe', 'ignore']
    })
    const leaderPid = leader.pid
    if (!leaderPid || !leader.stdout) throw new Error('Unable to start test process session')
    const childPid = await new Promise<number>((resolve) => {
      leader.stdout?.once('data', (chunk: Buffer) => resolve(Number(chunk.toString().trim())))
    })

    await killProcessTree(leaderPid)

    await vi.waitFor(async () => {
      const stat = await readFile(`/proc/${childPid}/stat`, 'utf8').catch(() => '')
      expect(stat === '' || stat.slice(stat.lastIndexOf(')') + 2).startsWith('Z ')).toBe(true)
    }, { timeout: 2_000 })
  })
})
