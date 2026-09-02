import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, stat } from 'node:fs/promises'
import path from 'node:path'
import type { RuntimeInfo, RuntimeToolInfo } from '../shared/contracts'

export type ContainerRuntime = 'docker' | 'podman'

export type CommandResult = {
  exitCode: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
  timedOut: boolean
  outputTruncated: boolean
}

export type CommandOptions = {
  cwd?: string
  timeoutMs?: number
  env?: NodeJS.ProcessEnv
  signal?: AbortSignal
  maxOutputBytes?: number
  input?: string
}

export type CommandRunner = (
  executable: string,
  args: readonly string[],
  options?: CommandOptions
) => Promise<CommandResult>

export type ContainerExecutionOptions = {
  runtime: ContainerRuntime
  threadId: string
  projectPath: string
  image: string
  command: readonly string[]
  cpuLimit: number
  memoryLimit: string
  network?: string
  timeoutMs?: number
  signal?: AbortSignal
  input?: string
  gitDirectory?: string
  gitCommonDirectory?: string
}

export type PersistentContainerOptions = Omit<ContainerExecutionOptions, 'command' | 'timeoutMs' | 'signal' | 'input'>

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/
const REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/
const IMAGE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/:@-]*$/
const NETWORK_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/
const MEMORY_PATTERN = /^[1-9][0-9]*(?:[bkmgBKMG])?$/
const workerContainerStarts = new Map<string, Promise<string>>()

export const runHostCommand: CommandRunner = (executable, args, options = {}) =>
  new Promise((resolve) => {
    if (options.signal?.aborted) {
      resolve({ exitCode: null, signal: null, stdout: '', stderr: '', timedOut: false, outputTruncated: false })
      return
    }
    const child = spawn(executable, [...args], {
      cwd: options.cwd,
      env: options.env,
      stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let outputTruncated = false
    let outputBytes = 0
    let settled = false
    const maxOutputBytes = options.maxOutputBytes ?? 2_000_000

    if (!child.stdout || !child.stderr || (options.input !== undefined && !child.stdin)) {
      child.kill()
      resolve({ exitCode: null, signal: null, stdout: '', stderr: 'Unable to open process streams', timedOut: false, outputTruncated: false })
      return
    }

    const appendOutput = (current: string, chunk: string): string => {
      const remaining = maxOutputBytes - outputBytes
      if (remaining <= 0) {
        outputTruncated = true
        return current
      }
      const buffer = Buffer.from(chunk)
      const accepted = buffer.subarray(0, remaining)
      outputBytes += accepted.byteLength
      if (accepted.byteLength < buffer.byteLength) outputTruncated = true
      return current + accepted.toString('utf8')
    }

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => { stdout = appendOutput(stdout, chunk) })
    child.stderr.on('data', (chunk: string) => { stderr = appendOutput(stderr, chunk) })
    if (options.input !== undefined) child.stdin?.end(options.input)

    const abort = (): void => { child.kill('SIGKILL') }
    options.signal?.addEventListener('abort', abort, { once: true })

    const timer = options.timeoutMs === undefined
      ? undefined
      : setTimeout(() => {
          timedOut = true
          child.kill('SIGKILL')
        }, options.timeoutMs)

    const finish = (exitCode: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      options.signal?.removeEventListener('abort', abort)
      resolve({ exitCode, signal, stdout, stderr, timedOut, outputTruncated })
    }

    child.once('error', (error) => {
      stderr += `${stderr ? '\n' : ''}${error.message}`
      finish(null, null)
    })
    child.once('close', finish)
  })

let managedDockerRunner: CommandRunner | null = null

export function configureManagedDockerRunner(runner: CommandRunner | null): void {
  managedDockerRunner = runner
}

export const runCommand: CommandRunner = (executable, args, options) =>
  executable === 'docker' && managedDockerRunner
    ? managedDockerRunner(executable, args, options)
    : runHostCommand(executable, args, options)

function validateIdentifier(value: string, label: string): void {
  if (!IDENTIFIER_PATTERN.test(value)) {
    throw new Error(`${label} must contain only letters, numbers, underscores, and hyphens`)
  }
}

function validateAbsolutePath(value: string, label: string): string {
  if (!path.isAbsolute(value) || value.includes('\0')) {
    throw new Error(`${label} must be an absolute path without NUL bytes`)
  }
  return path.resolve(value)
}

async function requireDirectory(value: string, label: string): Promise<void> {
  let details
  try {
    details = await stat(value)
  } catch {
    throw new Error(`${label} does not exist`)
  }
  if (!details.isDirectory()) throw new Error(`${label} must be a directory`)
}

function requireSuccess(result: CommandResult, operation: string): void {
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || 'unknown error'
    throw new Error(`${operation} failed: ${detail}`)
  }
}

function containerIsAlreadyRemoved(result: CommandResult): boolean {
  return result.exitCode === 0 || /no such container|no container with name|does not exist/i.test(
    `${result.stderr}\n${result.stdout}`
  )
}

export async function detectContainerRuntime(
  runner: CommandRunner = runCommand
): Promise<ContainerRuntime | null> {
  for (const runtime of ['docker', 'podman'] as const) {
    const result = await runner(runtime, ['info', '--format', '{{.Version}}'], {
      timeoutMs: 5_000
    })
    if (result.exitCode === 0 && !result.timedOut) return runtime
  }
  return null
}

async function inspectTool(
  executable: string,
  args: readonly string[],
  runner: CommandRunner
): Promise<RuntimeToolInfo> {
  const result = await runner(executable, args, { timeoutMs: 5_000 })
  if (result.exitCode !== 0 || result.timedOut) return { available: false, version: null }
  const output = result.stdout.trim() || result.stderr.trim()
  return { available: true, version: output ? output.slice(0, 200) : null }
}

export async function getRuntimeInfo(
  runner: CommandRunner = runCommand
): Promise<RuntimeInfo> {
  const [git, docker, podman] = await Promise.all([
    inspectTool('git', ['--version'], runner),
    inspectTool('docker', ['info', '--format', '{{.Version}}'], runner),
    inspectTool('podman', ['info', '--format', '{{.Version}}'], runner)
  ])

  return {
    git,
    docker,
    podman,
    recommendedContainerRuntime: docker.available ? 'docker' : podman.available ? 'podman' : null
  }
}

export async function createThreadWorktree(
  repositoryPath: string,
  workspaceRoot: string,
  threadId: string,
  ref = 'HEAD',
  runner: CommandRunner = runCommand
): Promise<string> {
  const repository = validateAbsolutePath(repositoryPath, 'repositoryPath')
  const root = validateAbsolutePath(workspaceRoot, 'workspaceRoot')
  validateIdentifier(threadId, 'threadId')
  if (
    !REF_PATTERN.test(ref) ||
    ref.includes('..') ||
    ref.includes('//') ||
    ref.includes('@{') ||
    ref.endsWith('/') ||
    ref.endsWith('.')
  ) {
    throw new Error('ref is not a safe Git reference')
  }

  await requireDirectory(repository, 'repositoryPath')
  await mkdir(root, { recursive: true })
  const disabledHooksPath = path.join(root, '.disabled-git-hooks')
  await mkdir(disabledHooksPath, { recursive: true })
  const environment = sanitizedGitEnvironment()
  const configuredFilters = await runner('git', [
    '-C', repository,
    'config', '--get-regexp', '^filter\\..*\\.(smudge|process)$'
  ], { env: environment })
  if (configuredFilters.exitCode === 0 && configuredFilters.stdout.trim()) {
    throw new Error('Git checkout filters are not allowed for isolated worktrees')
  }
  if (configuredFilters.exitCode !== 0 && configuredFilters.exitCode !== 1) {
    requireSuccess(configuredFilters, 'Git filter inspection')
  }
  const worktreePath = path.join(root, threadId)
  const result = await runner('git', [
    '-c', `core.hooksPath=${disabledHooksPath}`,
    '-c', 'core.fsmonitor=false',
    '-C', repository,
    'worktree', 'add', '--detach', worktreePath, ref
  ], { env: environment })
  requireSuccess(result, 'Git worktree creation')
  return worktreePath
}

export async function removeThreadWorktree(
  repositoryPath: string,
  workspaceRoot: string,
  threadId: string,
  force = false,
  runner: CommandRunner = runCommand
): Promise<void> {
  const repository = validateAbsolutePath(repositoryPath, 'repositoryPath')
  const root = validateAbsolutePath(workspaceRoot, 'workspaceRoot')
  validateIdentifier(threadId, 'threadId')
  await requireDirectory(repository, 'repositoryPath')

  const worktreePath = path.join(root, threadId)
  const environment = sanitizedGitEnvironment()
  const removeResult = await runner('git', [
    '-c', 'core.fsmonitor=false',
    '-C', repository,
    'worktree', 'remove', ...(force ? ['--force'] : []), worktreePath
  ], { env: environment })
  requireSuccess(removeResult, 'Git worktree removal')

  const pruneResult = await runner('git', [
    '-c', 'core.fsmonitor=false',
    '-C', repository, 'worktree', 'prune'
  ], { env: environment })
  requireSuccess(pruneResult, 'Git worktree pruning')
}

export async function executeInContainer(
  options: ContainerExecutionOptions,
  runner: CommandRunner = runCommand
): Promise<CommandResult> {
  validateIdentifier(options.threadId, 'threadId')
  const projectPath = validateAbsolutePath(options.projectPath, 'projectPath')
  if (projectPath.includes(',')) throw new Error('projectPath must not contain commas for container mounts')
  await requireDirectory(projectPath, 'projectPath')

  if (!IMAGE_PATTERN.test(options.image)) throw new Error('image is not a valid container image')
  if (!Number.isFinite(options.cpuLimit) || options.cpuLimit <= 0) {
    throw new Error('cpuLimit must be a positive number')
  }
  if (!MEMORY_PATTERN.test(options.memoryLimit)) {
    throw new Error('memoryLimit must be a positive integer with an optional b, k, m, or g suffix')
  }
  if (options.command.length === 0 || options.command.some((part) => part.includes('\0'))) {
    throw new Error('command must contain at least one argument and no NUL bytes')
  }
  if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)) {
    throw new Error('timeoutMs must be a positive number')
  }

  const network = options.network ?? 'none'
  if (!NETWORK_PATTERN.test(network)) throw new Error('network is not a valid container network')

  const containerName = `local-agent-${options.threadId}`
  const identityArgs = process.platform === 'linux'
    ? options.runtime === 'podman'
      ? ['--userns', 'keep-id']
      : typeof process.getuid === 'function' && typeof process.getgid === 'function'
        ? ['--user', `${process.getuid()}:${process.getgid()}`]
        : []
    : []
  const args = [
    'run', '--rm',
    '--name', containerName,
    '--pull', 'never',
    '--cpus', String(options.cpuLimit),
    '--memory', options.memoryLimit,
    '--network', network,
    ...identityArgs,
    '--read-only',
    '--security-opt', 'no-new-privileges',
    '--cap-drop', 'ALL',
    '--pids-limit', '256',
    '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m',
    '--mount', `type=bind,source=${projectPath},target=/workspace`,
    '--workdir', '/workspace',
    '--', options.image,
    ...options.command
  ]

  try {
    return await runner(options.runtime, args, {
      timeoutMs: options.timeoutMs,
      signal: options.signal,
      maxOutputBytes: 2_000_000
    })
  } finally {
    let cleanupResult: CommandResult | null = null
    for (let attempt = 0; attempt < 2; attempt += 1) {
      cleanupResult = await runner(
        options.runtime,
        ['rm', '--force', containerName],
        { timeoutMs: 10_000 }
      )
      if (containerIsAlreadyRemoved(cleanupResult) && !cleanupResult.timedOut) break
    }
    if (!cleanupResult || !containerIsAlreadyRemoved(cleanupResult) || cleanupResult.timedOut) {
      requireSuccess(cleanupResult ?? {
        exitCode: null,
        signal: null,
        stdout: '',
        stderr: 'container cleanup did not run',
        timedOut: false,
        outputTruncated: false
      }, 'Container cleanup')
    }
  }
}

export function workerContainerName(threadId: string): string {
  validateIdentifier(threadId, 'threadId')
  return `local-agent-worker-${threadId}`
}

export function workerDataVolumeName(threadId: string): string {
  validateIdentifier(threadId, 'threadId')
  return `local-agent-worker-data-${threadId}`
}

function workerContainerConfig(options: PersistentContainerOptions, projectPath: string): string {
  return createHash('sha256').update(JSON.stringify({
    projectPath,
    image: options.image,
    cpuLimit: options.cpuLimit,
    memoryLimit: options.memoryLimit,
    network: options.network ?? 'none',
    gitDirectory: options.gitDirectory,
    gitCommonDirectory: options.gitCommonDirectory
  })).digest('hex')
}

async function ensureWorkerContainerUnlocked(
  options: PersistentContainerOptions,
  runner: CommandRunner
): Promise<string> {
  const projectPath = validateAbsolutePath(options.projectPath, 'projectPath')
  await requireDirectory(projectPath, 'projectPath')
  if (projectPath.includes(',')) throw new Error('projectPath must not contain commas for container mounts')
  if (!IMAGE_PATTERN.test(options.image)) throw new Error('image is not a valid container image')
  if (!Number.isFinite(options.cpuLimit) || options.cpuLimit <= 0) throw new Error('cpuLimit must be positive')
  if (!MEMORY_PATTERN.test(options.memoryLimit)) throw new Error('memoryLimit is invalid')
  const network = options.network ?? 'none'
  if (!NETWORK_PATTERN.test(network)) throw new Error('network is not valid')
  const gitDirectory = options.gitDirectory
    ? validateAbsolutePath(options.gitDirectory, 'gitDirectory')
    : null
  const gitCommonDirectory = options.gitCommonDirectory
    ? validateAbsolutePath(options.gitCommonDirectory, 'gitCommonDirectory')
    : null
  if (Boolean(gitDirectory) !== Boolean(gitCommonDirectory)) {
    throw new Error('gitDirectory and gitCommonDirectory must be provided together')
  }
  if (gitDirectory) await requireDirectory(gitDirectory, 'gitDirectory')
  if (gitCommonDirectory && gitCommonDirectory !== gitDirectory) {
    await requireDirectory(gitCommonDirectory, 'gitCommonDirectory')
  }
  if (gitDirectory?.includes(',') || gitCommonDirectory?.includes(',')) {
    throw new Error('Git paths must not contain commas for container mounts')
  }

  const name = workerContainerName(options.threadId)
  const config = workerContainerConfig(options, projectPath)
  const inspected = await runner(options.runtime, [
    'inspect', '--format', '{{.State.Running}}|{{index .Config.Labels "com.local-agent.worker-config"}}', name
  ], {
    timeoutMs: 15_000
  })
  if (inspected.exitCode === 0) {
    const [running, existingConfig] = inspected.stdout.trim().split('|')
    if (existingConfig === config) {
      if (running === 'true') return name
      const started = await runner(options.runtime, ['start', name], { timeoutMs: 60_000 })
      requireSuccess(started, 'Persistent worker container start')
      return name
    }
    const removed = await runner(options.runtime, ['rm', '--force', name], { timeoutMs: 30_000 })
    requireSuccess(removed, 'Outdated worker container removal')
  }

  const identityArgs = process.platform === 'linux'
    ? options.runtime === 'podman'
      ? ['--userns', 'keep-id']
      : typeof process.getuid === 'function' && typeof process.getgid === 'function'
        ? ['--user', `${process.getuid()}:${process.getgid()}`]
        : []
    : []
  const created = await runner(options.runtime, [
    'run', '--detach',
    '--name', name,
    '--label', `com.local-agent.worker-config=${config}`,
    '--pull', 'missing',
    '--cpus', String(options.cpuLimit),
    '--memory', options.memoryLimit,
    '--network', network,
    ...identityArgs,
    '--read-only',
    '--security-opt', 'no-new-privileges',
    '--cap-drop', 'ALL',
    '--pids-limit', '256',
    '--tmpfs', '/tmp:rw,noexec,nosuid,size=256m',
    '--mount', `type=bind,source=${projectPath},target=/workspace`,
    ...(gitDirectory ? [
      '--mount', `type=bind,source=${gitDirectory},target=/repo-git`,
      ...(gitCommonDirectory !== gitDirectory
        ? ['--mount', `type=bind,source=${gitCommonDirectory},target=/repo-git-common`]
        : []),
      '--env', 'GIT_DIR=/repo-git',
      '--env', `GIT_COMMON_DIR=${gitCommonDirectory === gitDirectory ? '/repo-git' : '/repo-git-common'}`,
      '--env', 'GIT_WORK_TREE=/workspace'
    ] : []),
    '--mount', `type=volume,source=${workerDataVolumeName(options.threadId)},target=/worker-data`,
    '--workdir', '/workspace',
    '--', options.image,
    'tail', '-f', '/dev/null'
  ], { timeoutMs: 600_000, maxOutputBytes: 100_000 })
  requireSuccess(created, 'Persistent worker container creation')
  return name
}

export function ensureWorkerContainer(
  options: PersistentContainerOptions,
  runner: CommandRunner = runCommand
): Promise<string> {
  const key = `${options.runtime}:${workerContainerName(options.threadId)}`
  const active = workerContainerStarts.get(key)
  if (active) return active
  const started = ensureWorkerContainerUnlocked(options, runner)
  workerContainerStarts.set(key, started)
  void started.finally(() => {
    if (workerContainerStarts.get(key) === started) workerContainerStarts.delete(key)
  }).catch(() => undefined)
  return started
}

export async function executeInWorkerContainer(
  options: ContainerExecutionOptions,
  runner: CommandRunner = runCommand
): Promise<CommandResult> {
  if (options.command.length === 0 || options.command.some((part) => part.includes('\0'))) {
    throw new Error('command must contain at least one argument and no NUL bytes')
  }
  const name = await ensureWorkerContainer(options, runner)
  const execution = await runner(options.runtime, [
    'exec', ...(options.input === undefined ? [] : ['--interactive']),
    '--workdir', '/workspace', name, ...options.command
  ], {
    timeoutMs: options.timeoutMs,
    signal: options.signal,
    maxOutputBytes: 2_000_000,
    input: options.input
  })
  if (execution.timedOut || options.signal?.aborted) {
    const removed = await runner(options.runtime, ['rm', '--force', name], { timeoutMs: 30_000 })
    if (!containerIsAlreadyRemoved(removed) || removed.timedOut) {
      requireSuccess(removed, 'Cancelled worker container removal')
    }
  }
  return execution
}

export async function removeWorkerContainer(
  runtime: ContainerRuntime,
  threadId: string,
  runner: CommandRunner = runCommand
): Promise<void> {
  const result = await runner(runtime, ['rm', '--force', workerContainerName(threadId)], { timeoutMs: 30_000 })
  if (!containerIsAlreadyRemoved(result) || result.timedOut) requireSuccess(result, 'Worker container removal')
  const volume = await runner(runtime, ['volume', 'rm', workerDataVolumeName(threadId)], { timeoutMs: 30_000 })
  if (
    volume.exitCode !== 0
    && !/no such volume|does not exist|not found/i.test(`${volume.stderr}\n${volume.stdout}`)
  ) requireSuccess(volume, 'Worker data volume removal')
}

function sanitizedGitEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env }
  for (const key of Object.keys(environment)) {
    if (key.toUpperCase().startsWith('GIT_')) delete environment[key]
  }
  return environment
}
