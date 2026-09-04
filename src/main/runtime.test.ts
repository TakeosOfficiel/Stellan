import { chmod, mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createThreadWorktree,
  detectContainerRuntime,
  ensureWorkerContainer,
  exposeWorkerPort,
  executeInWorkerContainer,
  executeInContainer,
  getRuntimeInfo,
  removeWorkerContainer,
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
    outputTruncated: false,
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

describe('getRuntimeInfo', () => {
  it('reports Git and each running container engine independently', async () => {
    const runner = vi.fn<CommandRunner>()
      .mockResolvedValueOnce(result({ stdout: 'git version 2.48.0\n' }))
      .mockResolvedValueOnce(result({ stdout: '27.5.1\n' }))
      .mockResolvedValueOnce(result({ exitCode: null, stderr: 'not found' }))

    await expect(getRuntimeInfo(runner)).resolves.toEqual({
      git: { available: true, version: 'git version 2.48.0' },
      docker: { available: true, version: '27.5.1' },
      podman: { available: false, version: null },
      recommendedContainerRuntime: 'docker'
    })
    expect(runner).toHaveBeenCalledTimes(3)
  })

  it('recommends Podman when Docker is unavailable', async () => {
    const runner = vi.fn<CommandRunner>()
      .mockResolvedValueOnce(result({ stdout: 'git version 2.48.0' }))
      .mockResolvedValueOnce(result({ exitCode: 1 }))
      .mockResolvedValueOnce(result({ stdout: '5.4.0' }))

    await expect(getRuntimeInfo(runner)).resolves.toMatchObject({
      recommendedContainerRuntime: 'podman'
    })
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
      .mockResolvedValueOnce(result({ exitCode: 1, stderr: 'no such container' }))

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
      { timeoutMs: 10_000, signal: undefined, maxOutputBytes: 2_000_000 }
    ])
    expect(runArgs).toEqual([
      'run', '--rm',
      '--name', 'local-agent-thread-123',
      '--pull', 'never',
      '--cpus', '1.5',
      '--memory', '512m',
      '--network', 'none',
      '--userns', 'keep-id',
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
    expect(runArgs).toContain('never')
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

  it('forwards cancellation and output limits to the container process', async () => {
    const projectPath = await temporaryDirectory()
    const controller = new AbortController()
    const runner = vi.fn<CommandRunner>()
      .mockResolvedValueOnce(result())
      .mockResolvedValueOnce(result())

    await executeInContainer({
      runtime: 'docker',
      threadId: 'cancel-safe',
      projectPath,
      image: 'node:22-bookworm',
      command: ['npm', 'test'],
      cpuLimit: 2,
      memoryLimit: '4g',
      signal: controller.signal
    }, runner)

    expect(runner.mock.calls[0]?.[2]).toEqual({
      timeoutMs: undefined,
      signal: controller.signal,
      maxOutputBytes: 2_000_000
    })
  })

  it('retries cleanup and fails closed when the container cannot be removed', async () => {
    const projectPath = await temporaryDirectory()
    const cleanupFailure = result({ exitCode: 1, stderr: 'daemon unavailable' })
    const runner = vi.fn<CommandRunner>()
      .mockResolvedValueOnce(result())
      .mockResolvedValueOnce(cleanupFailure)
      .mockResolvedValueOnce(cleanupFailure)

    await expect(executeInContainer({
      runtime: 'docker',
      threadId: 'cleanup-failure',
      projectPath,
      image: 'node:22-bookworm',
      command: ['node', '--version'],
      cpuLimit: 1,
      memoryLimit: '1g'
    }, runner)).rejects.toThrow('Container cleanup failed: daemon unavailable')
    expect(runner).toHaveBeenCalledTimes(3)
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

describe('executeInWorkerContainer', () => {
  it('exposes only one requested port through an internal relay network and cleans it up', async () => {
    const runner = vi.fn<CommandRunner>()
      .mockResolvedValueOnce(result({ stdout: 'node:22-bookworm\n' }))
      .mockResolvedValueOnce(result())
      .mockResolvedValueOnce(result())
      .mockResolvedValueOnce(result())
      .mockResolvedValueOnce(result())
      .mockResolvedValueOnce(result({ stdout: '127.0.0.1:49152\n' }))
      .mockResolvedValue(result())

    const exposure = await exposeWorkerPort('docker', 'portal-worker', 3000, runner)

    expect(exposure.hostPort).toBe(49152)
    expect(runner.mock.calls[1]?.[1]).toEqual(expect.arrayContaining(['network', 'create', '--internal']))
    const relayArgs = runner.mock.calls[4]?.[1] ?? []
    expect(relayArgs).toContain('127.0.0.1::3000')
    expect(relayArgs).not.toContain('--network=host')
    await exposure.close()
    expect(runner.mock.calls.slice(-3).map((call) => call[1][0])).toEqual(['exec', 'network', 'network'])
  })

  it('creates one persistent resource-limited container then executes inside it', async () => {
    const projectPath = await temporaryDirectory()
    const runner = vi.fn<CommandRunner>()
      .mockResolvedValueOnce(result({ exitCode: 1, stderr: 'not found' }))
      .mockResolvedValueOnce(result({ stdout: 'container-id' }))
      .mockResolvedValueOnce(result({ stdout: 'v22\n' }))

    await expect(executeInWorkerContainer({
      runtime: 'docker',
      threadId: 'persistent-123',
      projectPath,
      image: 'node:22-bookworm',
      command: ['node', '--version'],
      cpuLimit: 2,
      memoryLimit: '4096m',
      network: 'none'
    }, runner)).resolves.toMatchObject({ stdout: 'v22\n' })

    expect(runner.mock.calls[1]?.[1]).toEqual(expect.arrayContaining([
      'run', '--detach', '--name', 'local-agent-worker-persistent-123',
      '--label', expect.stringMatching(/^com\.local-agent\.worker-config=[a-f0-9]{64}$/),
      '--cpus', '2', '--memory', '4096m', '--network', 'none',
      '--env', 'GIT_CONFIG_COUNT=1',
      '--env', 'GIT_CONFIG_KEY_0=safe.directory',
      '--env', 'GIT_CONFIG_VALUE_0=/workspace',
      '--mount', `type=bind,source=${projectPath},target=/workspace`,
      '--mount', 'type=volume,source=local-agent-worker-data-persistent-123,target=/worker-data'
    ]))
    expect(runner.mock.calls[2]?.[1]).toEqual([
      'exec', '--workdir', '/workspace', 'local-agent-worker-persistent-123', 'node', '--version'
    ])
  })

  it('recreates a persistent container when its saved profile changed', async () => {
    const projectPath = await temporaryDirectory()
    const runner = vi.fn<CommandRunner>()
      .mockResolvedValueOnce(result({ stdout: 'true|outdated-config' }))
      .mockResolvedValueOnce(result())
      .mockResolvedValueOnce(result({ stdout: 'new-container' }))

    await ensureWorkerContainer({
      runtime: 'docker', threadId: 'reconfigured', projectPath,
      image: 'node:22-bookworm', cpuLimit: 4, memoryLimit: '8192m', network: 'none'
    }, runner)

    expect(runner.mock.calls[1]).toEqual([
      'docker', ['rm', '--force', 'local-agent-worker-reconfigured'], { timeoutMs: 30_000 }
    ])
    expect(runner.mock.calls[2]?.[1]).toEqual(expect.arrayContaining([
      'run', '--detach', '--cpus', '4', '--memory', '8192m'
    ]))
  })

  it('mounts linked-worktree Git metadata at stable container paths', async () => {
    const root = await temporaryDirectory()
    const projectPath = path.join(root, 'worktree')
    const commonDirectory = path.join(root, 'repository', '.git')
    const gitDirectory = path.join(commonDirectory, 'worktrees', 'thread-git')
    await mkdir(projectPath, { recursive: true })
    await mkdir(gitDirectory, { recursive: true })
    const runner = vi.fn<CommandRunner>()
      .mockResolvedValueOnce(result({ exitCode: 1 }))
      .mockResolvedValueOnce(result())

    await ensureWorkerContainer({
      runtime: 'docker', threadId: 'thread-git', projectPath,
      image: 'node:22-bookworm', cpuLimit: 2, memoryLimit: '2048m', network: 'none',
      gitDirectory, gitCommonDirectory: commonDirectory
    }, runner)

    expect(runner.mock.calls[1]?.[1]).toEqual(expect.arrayContaining([
      '--mount', `type=bind,source=${gitDirectory},target=/repo-git`,
      '--mount', `type=bind,source=${commonDirectory},target=/repo-git-common`,
      '--env', 'GIT_DIR=/repo-git',
      '--env', 'GIT_COMMON_DIR=/repo-git-common',
      '--env', 'GIT_WORK_TREE=/workspace'
    ]))
  })

  it('removes the persistent container after a timed-out command so no process keeps running', async () => {
    const projectPath = await temporaryDirectory()
    const timedOut = result({ exitCode: null, signal: 'SIGKILL', timedOut: true })
    const runner = vi.fn<CommandRunner>()
      .mockResolvedValueOnce(result({ exitCode: 1, stderr: 'not found' }))
      .mockResolvedValueOnce(result())
      .mockResolvedValueOnce(timedOut)
      .mockResolvedValueOnce(result())

    await expect(executeInWorkerContainer({
      runtime: 'docker', threadId: 'cancelled-worker', projectPath,
      image: 'node:22-bookworm', command: ['npm', 'test'],
      cpuLimit: 2, memoryLimit: '2048m', network: 'none', timeoutMs: 25
    }, runner)).resolves.toEqual(timedOut)

    expect(runner.mock.calls[3]).toEqual([
      'docker', ['rm', '--force', 'local-agent-worker-cancelled-worker'], { timeoutMs: 30_000 }
    ])
    expect(runner.mock.calls.some((call) => call[1][0] === 'volume')).toBe(false)
  })

  it('removes both the worker container and its private data volume', async () => {
    const runner = vi.fn<CommandRunner>().mockResolvedValue(result())

    await removeWorkerContainer('docker', 'deleted-thread', runner)

    expect(runner.mock.calls).toEqual([
      ['docker', ['rm', '--force', 'local-agent-worker-deleted-thread'], { timeoutMs: 30_000 }],
      ['docker', ['volume', 'rm', 'local-agent-worker-data-deleted-thread'], { timeoutMs: 30_000 }]
    ])
  })
})
