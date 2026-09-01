import { chmod, mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createThreadWorktree,
  detectContainerRuntime,
  executeInContainer,
  removeThreadWorktree,
  runCommand,
  type CommandResult,
  type CommandRunner
} from './runtime'

const temporaryDirectories: string[] = []

function result(overrides: Partial<CommandResult> = {}): CommandResult {
  return {
    exitCode: 0,
    signal: null,
    stdout: '',
    stderr: '',
    timedOut: false,
    ...overrides
  }
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'local-agent-runtime-'))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ))
})

describe('detectContainerRuntime', () => {
  it('prefers Docker when its daemon responds', async () => {
    const runner = vi.fn<CommandRunner>().mockResolvedValue(result())

    await expect(detectContainerRuntime(runner)).resolves.toBe('docker')
    expect(runner).toHaveBeenCalledOnce()
    expect(runner).toHaveBeenCalledWith(
      'docker',
      ['info', '--format', '{{.Version}}'],
      { timeoutMs: 5_000 }
    )
  })

  it('falls back to Podman and reports when neither runtime is available', async () => {
    const podmanRunner = vi.fn<CommandRunner>()
      .mockResolvedValueOnce(result({ exitCode: null }))
      .mockResolvedValueOnce(result())
    await expect(detectContainerRuntime(podmanRunner)).resolves.toBe('podman')

    const unavailableRunner = vi.fn<CommandRunner>()
      .mockResolvedValue(result({ exitCode: 1 }))
    await expect(detectContainerRuntime(unavailableRunner)).resolves.toBeNull()
    expect(unavailableRunner).toHaveBeenCalledTimes(2)
  })
})

describe('runCommand', () => {
  it('captures output and terminates commands after their timeout', async () => {
    const completed = await runCommand(process.execPath, [
      '-e', "process.stdout.write('out'); process.stderr.write('err')"
    ])
    expect(completed).toMatchObject({
      exitCode: 0,
      stdout: 'out',
      stderr: 'err',
      timedOut: false
    })

    const timedOut = await runCommand(process.execPath, [
      '-e', 'setTimeout(() => {}, 10_000)'
    ], { timeoutMs: 20 })
    expect(timedOut.exitCode).toBeNull()
    expect(timedOut.signal).toBe('SIGKILL')
    expect(timedOut.timedOut).toBe(true)
  })
})

describe('Git worktree lifecycle', () => {
  it('creates and removes an isolated worktree under the workspace root', async () => {
    const root = await temporaryDirectory()
    const repository = path.join(root, 'repository')
    const workspaceRoot = path.join(root, 'workspaces')
    await mkdir(repository)

    expect((await runCommand('git', ['init', repository])).exitCode).toBe(0)
    expect((await runCommand('git', [
      '-C', repository, '-c', 'user.name=Runtime Test', '-c', 'user.email=runtime@example.test',
      'commit', '--allow-empty', '-m', 'initial'
    ])).exitCode).toBe(0)
    await writeFile(path.join(repository, 'project.txt'), 'isolated\n')
    expect((await runCommand('git', ['-C', repository, 'add', 'project.txt'])).exitCode).toBe(0)
    expect((await runCommand('git', [
      '-C', repository, '-c', 'user.name=Runtime Test', '-c', 'user.email=runtime@example.test',
      'commit', '-m', 'project'
    ])).exitCode).toBe(0)

    const hookMarker = path.join(root, 'hook-ran')
    if (process.platform !== 'win32') {
      const hooks = path.join(repository, '.untrusted-hooks')
      await mkdir(hooks)
      const hook = path.join(hooks, 'post-checkout')
      await writeFile(hook, `#!/bin/sh\ntouch "${hookMarker}"\n`)
      await chmod(hook, 0o755)
      expect((await runCommand('git', [
        '-C', repository, 'config', 'core.hooksPath', hooks
      ])).exitCode).toBe(0)
    }

    const worktree = await createThreadWorktree(
      repository,
      workspaceRoot,
      'thread-123'
    )
    expect(worktree).toBe(path.join(workspaceRoot, 'thread-123'))
    await expect(readFile(path.join(worktree, 'project.txt'), 'utf8')).resolves.toBe('isolated\n')
    if (process.platform !== 'win32') await expect(stat(hookMarker)).rejects.toThrow()

    await removeThreadWorktree(repository, workspaceRoot, 'thread-123')
    await expect(stat(worktree)).rejects.toThrow()
    const worktrees = await runCommand('git', ['-C', repository, 'worktree', 'list', '--porcelain'])
    expect(worktrees.stdout).not.toContain(worktree)
  })

  it('rejects unsafe identifiers and paths before invoking Git', async () => {
    const runner = vi.fn<CommandRunner>()
    await expect(createThreadWorktree(
      'relative/repository',
      '/tmp/workspaces',
      '../escape',
      'HEAD',
      runner
    )).rejects.toThrow('repositoryPath must be an absolute path')
    expect(runner).not.toHaveBeenCalled()
  })

  it('refuses repository-configured checkout filters before creating a worktree', async () => {
    const repository = await temporaryDirectory()
    const workspaceRoot = await temporaryDirectory()
    const runner = vi.fn<CommandRunner>().mockResolvedValue(result({
      stdout: 'filter.evil.process /tmp/untrusted-filter\n'
    }))

    await expect(createThreadWorktree(
      repository,
      workspaceRoot,
      'safe-thread',
      'HEAD',
      runner
    )).rejects.toThrow('checkout filters')
    expect(runner).toHaveBeenCalledOnce()
    expect(runner.mock.calls[0]?.[1]).toEqual([
      '-C', repository,
      'config', '--get-regexp', '^filter\\..*\\.(smudge|process)$'
    ])
  })

  it('detects checkout filters from real Git configuration', async () => {
    const root = await temporaryDirectory()
    const repository = path.join(root, 'repository')
    const workspaceRoot = path.join(root, 'workspaces')
    await mkdir(repository)
    expect((await runCommand('git', ['init', repository])).exitCode).toBe(0)
    expect((await runCommand('git', [
      '-C', repository, 'config', 'filter.untrusted.process', 'untrusted-filter'
    ])).exitCode).toBe(0)

    await expect(createThreadWorktree(
      repository,
      workspaceRoot,
      'safe-thread'
    )).rejects.toThrow('checkout filters')
  })

  it('overrides repository hooks and fsmonitor when creating a worktree', async () => {
    const repository = await temporaryDirectory()
    const workspaceRoot = await temporaryDirectory()
    const runner = vi.fn<CommandRunner>()
      .mockResolvedValueOnce(result({ exitCode: 1 }))
      .mockResolvedValueOnce(result())

    await createThreadWorktree(repository, workspaceRoot, 'safe-thread', 'HEAD', runner)

    const worktreeArgs = runner.mock.calls[1]?.[1] ?? []
    expect(worktreeArgs).toContain(`core.hooksPath=${path.join(workspaceRoot, '.disabled-git-hooks')}`)
    expect(worktreeArgs).toContain('core.fsmonitor=false')
  })
})

describe('executeInContainer', () => {
  it('builds a resource-limited, isolated command and always cleans up', async () => {
    const projectPath = await temporaryDirectory()
    const runner = vi.fn<CommandRunner>()
      .mockResolvedValueOnce(result({ stdout: 'done\n' }))
      .mockResolvedValueOnce(result({ exitCode: 1 }))

    await expect(executeInContainer({
      runtime: 'podman',
      threadId: 'thread-123',
      projectPath,
      image: 'node:22-alpine',
      command: ['node', '--version'],
      cpuLimit: 1.5,
      memoryLimit: '512m',
      timeoutMs: 10_000
    }, runner)).resolves.toEqual(result({ stdout: 'done\n' }))

    const runArgs = runner.mock.calls[0]?.[1]
    expect(runner.mock.calls[0]).toEqual([
      'podman',
      expect.any(Array),
      { timeoutMs: 10_000 }
    ])
    expect(runArgs).toEqual([
      'run', '--rm',
      '--name', 'local-agent-thread-123',
      '--cpus', '1.5',
      '--memory', '512m',
      '--network', 'none',
      '--read-only',
      '--security-opt', 'no-new-privileges',
      '--cap-drop', 'ALL',
      '--pids-limit', '256',
      '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m',
      '--mount', `type=bind,source=${projectPath},target=/workspace`,
      '--workdir', '/workspace',
      '--', 'node:22-alpine',
      'node', '--version'
    ])
    expect(runArgs?.filter((argument) => argument === '--mount')).toHaveLength(1)
    expect(runArgs?.join(' ')).not.toContain('docker.sock')
    expect(runner.mock.calls[1]).toEqual([
      'podman',
      ['rm', '--force', 'local-agent-thread-123'],
      { timeoutMs: 10_000 }
    ])
  })

  it('supports an explicit network and cleans up after a timed-out run', async () => {
    const projectPath = await temporaryDirectory()
    const timedOut = result({ exitCode: null, signal: 'SIGKILL', timedOut: true })
    const runner = vi.fn<CommandRunner>()
      .mockResolvedValueOnce(timedOut)
      .mockResolvedValueOnce(result())

    await expect(executeInContainer({
      runtime: 'docker',
      threadId: 'networked',
      projectPath,
      image: 'alpine@sha256:abc123',
      command: ['true'],
      cpuLimit: 1,
      memoryLimit: '1g',
      network: 'agent-net',
      timeoutMs: 25
    }, runner)).resolves.toEqual(timedOut)

    expect(runner.mock.calls[0]?.[1]).toContain('agent-net')
    expect(runner.mock.calls[1]).toEqual([
      'docker',
      ['rm', '--force', 'local-agent-networked'],
      { timeoutMs: 10_000 }
    ])
  })

  it('validates container inputs before command execution', async () => {
    const projectPath = await temporaryDirectory()
    const runner = vi.fn<CommandRunner>()

    await expect(executeInContainer({
      runtime: 'docker',
      threadId: '../escape',
      projectPath,
      image: 'alpine',
      command: ['true'],
      cpuLimit: 1,
      memoryLimit: '1g'
    }, runner)).rejects.toThrow('threadId')
    expect(runner).not.toHaveBeenCalled()
  })
})
