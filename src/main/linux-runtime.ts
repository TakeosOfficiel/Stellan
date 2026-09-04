import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, constants as fsConstants } from 'node:fs'
import { access, chmod, mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { userInfo } from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { RuntimeProgress } from '../shared/contracts'
import {
  configureManagedDockerPtyBuilder,
  configureManagedDockerRunner,
  runHostCommand,
  type CommandOptions,
  type CommandResult
} from './runtime'

export const LINUX_DOCKER_VERSION = '29.7.2'
export const LINUX_DOCKER_ARCHIVES = [
  {
    name: `docker-${LINUX_DOCKER_VERSION}.tgz`,
    url: `https://download.docker.com/linux/static/stable/x86_64/docker-${LINUX_DOCKER_VERSION}.tgz`,
    sha256: '803d433f226db4776e1768fd319fc6c6e4935a456acf84fcc0080818b854bc8f'
  },
  {
    name: `docker-rootless-extras-${LINUX_DOCKER_VERSION}.tgz`,
    url: `https://download.docker.com/linux/static/stable/x86_64/docker-rootless-extras-${LINUX_DOCKER_VERSION}.tgz`,
    sha256: '15a5cb81f2c5cf15ea21427f2e8241eac0deb2221175f993b5e76926e705ec6a'
  }
] as const
export const LINUX_SLIRP4NETNS = {
  version: '1.3.5',
  url: 'https://github.com/rootless-containers/slirp4netns/releases/download/v1.3.5/slirp4netns-x86_64',
  sha256: '8e54132bc80fc60d53af4b544dae63a81151774b56f129e572f7f1a2e89a57cf'
} as const

const INSTALL_MARKER = 'installed.json'
const REQUIRED_EXECUTABLES = ['docker', 'dockerd', 'containerd', 'containerd-shim-runc-v2', 'runc', 'rootlesskit', 'dockerd-rootless.sh', 'slirp4netns']

let runtimeRoot: string | null = null
let progressReporter: ((progress: RuntimeProgress) => void) | null = null
let startup: Promise<void> | null = null
let daemon: ChildProcess | null = null
let daemonPid: number | null = null
let daemonFailure: Error | null = null
let ready = false
let stopping = false
let cgroupFallbackReported = false
const activeCommands = new Set<Promise<CommandResult>>()

function report(step: string, detail: string, percent: number): void {
  progressReporter?.({ step, detail, percent })
}

function paths(root = runtimeRoot): {
  root: string
  bin: string
  run: string
  socket: string
  data: string
  exec: string
  home: string
  config: string
  log: string
} {
  if (!root) throw new Error('Le runtime Linux privé de Stellan n’est pas configuré.')
  const privateRoot = path.join(root, 'linux-rootless')
  const run = path.join(privateRoot, 'run')
  return {
    root: privateRoot,
    bin: path.join(privateRoot, 'bin'),
    run,
    socket: path.join(run, 'docker.sock'),
    data: path.join(privateRoot, 'data'),
    exec: path.join(privateRoot, 'exec'),
    home: path.join(privateRoot, 'home'),
    config: path.join(privateRoot, 'home', '.config', 'docker', 'daemon.json'),
    log: path.join(privateRoot, 'dockerd.log')
  }
}

function privateEnvironment(): NodeJS.ProcessEnv {
  const runtime = paths()
  return {
    ...process.env,
    PATH: `${runtime.bin}:/usr/local/sbin:/usr/sbin:/sbin:${process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin'}`,
    HOME: runtime.home,
    XDG_RUNTIME_DIR: runtime.run,
    DOCKER_HOST: `unix://${runtime.socket}`,
    DOCKER_CONFIG: path.join(runtime.home, '.docker'),
    DOCKERD_ROOTLESS_ROOTLESSKIT_STATE_DIR: path.join(runtime.run, 'rootlesskit')
  }
}

async function fileSha256(file: string): Promise<string> {
  const hash = createHash('sha256')
  await pipeline(createReadStream(file), hash)
  return hash.digest('hex')
}

async function downloadVerified(url: string, destination: string, expectedSha256: string): Promise<void> {
  const response = await fetch(url)
  if (!response.ok || !response.body) throw new Error(`Téléchargement refusé (${response.status}) : ${url}`)
  await pipeline(Readable.fromWeb(response.body as never), createWriteStream(destination, { mode: 0o600 }))
  const actual = await fileSha256(destination)
  if (actual !== expectedSha256) {
    await rm(destination, { force: true })
    throw new Error(`Archive Docker invalide : SHA-256 ${actual}, attendu ${expectedSha256}.`)
  }
}

async function installed(root: string): Promise<boolean> {
  try {
    const marker = JSON.parse(await readFile(path.join(root, INSTALL_MARKER), 'utf8')) as { version?: string }
    if (marker.version !== LINUX_DOCKER_VERSION) return false
    await Promise.all(REQUIRED_EXECUTABLES.map((name) => access(path.join(root, 'bin', name), fsConstants.X_OK)))
    return true
  } catch {
    return false
  }
}

async function installRuntime(): Promise<void> {
  const runtime = paths()
  if (await installed(runtime.root)) return
  report('Installation du moteur privé', 'Téléchargement des binaires Docker officiels…', 12)
  const staging = `${runtime.root}.install-${process.pid}`
  await rm(staging, { recursive: true, force: true })
  await mkdir(path.join(staging, 'bin'), { recursive: true, mode: 0o700 })
  try {
    for (let index = 0; index < LINUX_DOCKER_ARCHIVES.length; index += 1) {
      const archive = LINUX_DOCKER_ARCHIVES[index]!
      const archivePath = path.join(staging, archive.name)
      report('Installation du moteur privé', `Téléchargement ${index + 1}/${LINUX_DOCKER_ARCHIVES.length}…`, 14 + index * 18)
      await downloadVerified(archive.url, archivePath, archive.sha256)
      const extracted = await runHostCommand('tar', [
        '-xzf', archivePath, '--strip-components=1', '-C', path.join(staging, 'bin')
      ], { timeoutMs: 120_000 })
      if (extracted.exitCode !== 0) {
        throw new Error(`Extraction Docker impossible : ${extracted.stderr.trim() || extracted.stdout.trim()}`)
      }
      await rm(archivePath, { force: true })
    }
    report('Installation du moteur privé', 'Installation du réseau rootless isolé…', 52)
    await downloadVerified(
      LINUX_SLIRP4NETNS.url,
      path.join(staging, 'bin', 'slirp4netns'),
      LINUX_SLIRP4NETNS.sha256
    )
    await Promise.all(REQUIRED_EXECUTABLES.map((name) => chmod(path.join(staging, 'bin', name), 0o700)))
    const marker = JSON.stringify({
      version: LINUX_DOCKER_VERSION,
      archives: LINUX_DOCKER_ARCHIVES.map(({ name, sha256 }) => ({ name, sha256 })),
      slirp4netns: LINUX_SLIRP4NETNS
    })
    await mkdir(runtime.root, { recursive: true, mode: 0o700 })
    const backup = `${runtime.bin}.previous`
    await rm(backup, { recursive: true, force: true })
    let previousMoved = false
    try {
      await rename(runtime.bin, backup)
      previousMoved = true
    } catch { /* There is no previous installation. */ }
    try {
      await rename(path.join(staging, 'bin'), runtime.bin)
      await writeFile(path.join(runtime.root, INSTALL_MARKER), marker, { mode: 0o600 })
      await rm(backup, { recursive: true, force: true })
    } catch (error) {
      await rm(runtime.bin, { recursive: true, force: true })
      if (previousMoved) await rename(backup, runtime.bin)
      throw error
    }
    await rm(staging, { recursive: true, force: true })
  } catch (error) {
    await rm(staging, { recursive: true, force: true })
    throw error
  }
}

async function executableOnPath(name: string): Promise<boolean> {
  const searchPath = `/usr/local/sbin:/usr/sbin:/sbin:${process.env.PATH ?? ''}`
  for (const directory of searchPath.split(path.delimiter)) {
    if (!directory) continue
    try {
      await access(path.join(directory, name), fsConstants.X_OK)
      return true
    } catch { /* Continue searching. */ }
  }
  return false
}

export function subIdConfigured(contents: string, username: string): boolean {
  return contents.split(/\r?\n/).some((line) => {
    const [owner, start, count] = line.split(':')
    return owner === username && Number(start) > 0 && Number(count) >= 65_536
  })
}

async function assertHostPrerequisites(): Promise<void> {
  const missing: string[] = []
  for (const executable of ['newuidmap', 'newgidmap', 'iptables']) {
    if (!await executableOnPath(executable)) missing.push(executable)
  }
  const username = userInfo().username
  for (const file of ['/etc/subuid', '/etc/subgid']) {
    try {
      if (!subIdConfigured(await readFile(file, 'utf8'), username)) missing.push(`${file} (${username})`)
    } catch {
      missing.push(`${file} (${username})`)
    }
  }
  try {
    await access('/dev/net/tun', fsConstants.R_OK | fsConstants.W_OK)
  } catch {
    missing.push('/dev/net/tun accessible en lecture/écriture')
  }
  if (missing.length > 0) {
    throw new Error(
      `Le moteur privé requiert la prise en charge rootless du noyau (${missing.join(', ')}). `
      + 'Sur Ubuntu/Debian : sudo apt install uidmap iptables, chargez le module tun si nécessaire, puis reconnectez-vous. Aucun Docker système n’est requis.'
    )
  }
}

async function configureNvidiaRuntime(): Promise<void> {
  if (!await executableOnPath('nvidia-ctk')) return
  const runtime = paths()
  const configured = await runHostCommand('nvidia-ctk', [
    'runtime', 'configure', '--runtime=docker', `--config=${runtime.config}`
  ], { env: privateEnvironment(), timeoutMs: 30_000 })
  if (configured.exitCode !== 0) {
    console.warn('[Stellan runtime] NVIDIA private runtime configuration failed:', configured.stderr.trim())
  }
}

async function waitForDaemon(): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (daemonFailure) throw daemonFailure
    if (daemon?.exitCode !== null) break
    const status = await runHostCommand(paths().bin + '/docker', ['info', '--format', '{{.ServerVersion}}'], {
      env: privateEnvironment(), timeoutMs: 2_000
    })
    if (status.exitCode === 0) return
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  let detail = ''
  try { detail = (await readFile(paths().log, 'utf8')).slice(-4_000) } catch { /* No log yet. */ }
  throw new Error(`Le moteur Docker privé n’a pas démarré.${detail ? `\n${detail}` : ''}`)
}

async function startDaemon(): Promise<void> {
  const runtime = paths()
  await Promise.all([
    mkdir(runtime.run, { recursive: true, mode: 0o700 }),
    mkdir(runtime.data, { recursive: true, mode: 0o700 }),
    mkdir(runtime.exec, { recursive: true, mode: 0o700 }),
    mkdir(path.dirname(runtime.config), { recursive: true, mode: 0o700 }),
    mkdir(path.join(runtime.home, '.docker'), { recursive: true, mode: 0o700 })
  ])
  await chmod(runtime.run, 0o700)
  try { await access(runtime.config) } catch { await writeFile(runtime.config, '{}\n', { mode: 0o600 }) }
  const existing = await runHostCommand(path.join(runtime.bin, 'docker'), ['info'], {
    env: privateEnvironment(), timeoutMs: 2_000
  })
  if (existing.exitCode === 0) {
    try {
      const candidate = Number.parseInt(await readFile(path.join(runtime.run, 'rootlesskit.pid'), 'utf8'), 10)
      process.kill(candidate, 0)
      const commandLine = await readFile(`/proc/${candidate}/cmdline`, 'utf8')
      const environment = await readFile(`/proc/${candidate}/environ`, 'utf8')
      if (!commandLine.includes('rootlesskit') || !environment.includes(runtime.socket)) {
        throw new Error('PID rootlesskit périmé')
      }
      daemonPid = candidate
    } catch { daemonPid = null }
    report('Moteur privé prêt', 'Le daemon rootless privé existant a été reconnecté.', 86)
    return
  }
  await Promise.all([
    rm(runtime.socket, { force: true }),
    rm(path.join(runtime.run, 'rootlesskit'), { recursive: true, force: true }),
    rm(path.join(runtime.run, 'dockerd.pid'), { force: true })
  ])
  await configureNvidiaRuntime()
  report('Démarrage du moteur privé', 'Lancement du daemon rootless isolé de Stellan…', 72)
  const log = await open(runtime.log, 'a', 0o600)
  daemonFailure = null
  daemon = spawn(path.join(runtime.bin, 'dockerd-rootless.sh'), [
    '--host', `unix://${runtime.socket}`,
    '--data-root', runtime.data,
    '--exec-root', runtime.exec,
    '--pidfile', path.join(runtime.run, 'dockerd.pid'),
    '--config-file', runtime.config,
    '--exec-opt', 'native.cgroupdriver=cgroupfs'
  ], {
    env: privateEnvironment(),
    stdio: ['ignore', log.fd, log.fd],
    shell: false,
    windowsHide: true
  })
  const child = daemon
  await log.close()
  daemonPid = child.pid ?? null
  if (daemonPid) await writeFile(path.join(runtime.run, 'rootlesskit.pid'), String(daemonPid), { mode: 0o600 })
  child.once('error', (error) => { daemonFailure = error })
  child.once('exit', () => {
    if (daemon !== child) return
    ready = false
    daemon = null
    daemonPid = null
  })
  try {
    await waitForDaemon()
  } catch (error) {
    if (daemonPid) {
      try { process.kill(daemonPid, 'SIGTERM') } catch { /* The failed process already exited. */ }
    }
    daemon = null
    daemonPid = null
    throw error
  }
  report('Moteur privé prêt', 'Docker rootless fonctionne uniquement pour Stellan.', 86)
}

export function ensureManagedLinuxRuntime(): Promise<void> {
  if (process.platform !== 'linux') return Promise.resolve()
  if (process.arch !== 'x64') {
    return Promise.reject(new Error('Le runtime Linux privé est actuellement disponible uniquement en x86_64.'))
  }
  if (stopping) return Promise.reject(new Error('Le runtime Linux privé est en cours d’arrêt.'))
  if (ready) return Promise.resolve()
  if (startup) return startup
  startup = (async () => {
    await assertHostPrerequisites()
    await installRuntime()
    await startDaemon()
    ready = true
  })().finally(() => { startup = null })
  return startup
}

async function runManagedDocker(
  _executable: string,
  args: readonly string[],
  options?: CommandOptions
): Promise<CommandResult> {
  try {
    await ensureManagedLinuxRuntime()
  } catch (error) {
    return {
      exitCode: 1,
      signal: null,
      stdout: '',
      stderr: error instanceof Error ? error.message : 'Le runtime Linux privé n’a pas pu démarrer.',
      timedOut: false,
      outputTruncated: false
    }
  }
  const execute = (commandArgs: readonly string[]) => runHostCommand(
    path.join(paths().bin, 'docker'), commandArgs, {
      ...options,
      // Socket/home isolation is invariant: callers cannot redirect Stellan to a host daemon.
      env: { ...options?.env, ...privateEnvironment() }
    }
  )
  const command = (async () => {
    const first = await execute(args)
    const detail = `${first.stderr}\n${first.stdout}`
    if (
      args[0] !== 'run'
      || first.exitCode === 0
      || !/NanoCPUs can not be set|cgroup is not mounted|does not support (?:CPU|memory|pids)/i.test(detail)
    ) return first
    const unsupported = new Set(['--cpus', '--memory', '--memory-swap', '--pids-limit'])
    const compatible = args.filter((argument, index) => !unsupported.has(argument) && !unsupported.has(args[index - 1] ?? ''))
    if (!cgroupFallbackReported) {
      cgroupFallbackReported = true
      console.warn('[Stellan runtime] cgroup limits are unavailable; container kernel limits were omitted.')
    }
    return execute(compatible)
  })()
  activeCommands.add(command)
  void command.finally(() => activeCommands.delete(command)).catch(() => undefined)
  return command
}

export function configureManagedLinuxRuntime(
  root: string,
  onProgress: ((progress: RuntimeProgress) => void) | null = null
): void {
  if (process.platform !== 'linux') return
  runtimeRoot = root
  progressReporter = onProgress
  startup = null
  daemon = null
  daemonPid = null
  daemonFailure = null
  ready = false
  stopping = false
  cgroupFallbackReported = false
  configureManagedDockerRunner(runManagedDocker)
  configureManagedDockerPtyBuilder((args) => ({
    executable: path.join(paths().bin, 'docker'),
    args: [...args],
    env: privateEnvironment()
  }))
}

export async function stopManagedLinuxRuntime(): Promise<void> {
  if (process.platform !== 'linux') return
  stopping = true
  await startup?.catch(() => undefined)
  await Promise.allSettled(activeCommands)
  const child = daemon
  const pid = child?.pid ?? daemonPid
  if (pid && (child?.exitCode ?? null) === null) {
    try { process.kill(pid, 'SIGTERM') } catch { /* The runtime already stopped. */ }
    for (let attempt = 0; attempt < 50; attempt += 1) {
      let running = true
      try { process.kill(pid, 0) } catch { running = false }
      if (!running) break
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    try { process.kill(pid, 'SIGKILL') } catch { /* The runtime stopped gracefully. */ }
  }
  daemon = null
  daemonPid = null
  ready = false
}
