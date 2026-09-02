import { createHash } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { RuntimeProgress } from '../shared/contracts'
import {
  configureManagedDockerRunner,
  runHostCommand,
  type CommandOptions,
  type CommandResult
} from './runtime'

export const MANAGED_WSL_DISTRO = 'LocalAgentRuntime'
const ALPINE_VERSION = '3.24.1'
const ALPINE_FILE = `alpine-minirootfs-${ALPINE_VERSION}-x86_64.tar.gz`
const ALPINE_BASE_URL = 'https://dl-cdn.alpinelinux.org/alpine/v3.24/releases/x86_64'
const ALPINE_SHA256 = '41f73e3cf5fa919b8aa5ca6b30dc48f0da2720776d7423e2a7748211456fe081'
const RUNTIME_MARKER = '/etc/local-agent-runtime-v3'
export const MANAGED_RUNTIME_PACKAGES = ['openrc', 'docker', 'docker-cli', 'nodejs', 'npm', 'git', 'ripgrep', 'bash', 'coreutils', 'iproute2'] as const
export const WSL_ADDRESS_COMMAND = ['/sbin/ip', '-o', '-4', 'addr', 'show', 'dev', 'eth0'] as const
export const DOCKER_SERVICE_START_SCRIPT = [
  'set -eu',
  'mkdir -p /run/openrc /var/log',
  'touch /run/openrc/softlevel',
  'rc-service --nodeps docker restart'
].join('; ')

let runtimeRoot: string | null = null
let startup: Promise<void> | null = null
let stopping = false
let distroAddress: string | null = null
let progressReporter: ((progress: RuntimeProgress) => void) | null = null
const activeDockerCommands = new Set<Promise<CommandResult>>()

function report(step: string, detail: string, percent: number): void {
  progressReporter?.({ step, detail, percent })
}

function cleanWslOutput(value: string): string {
  return value.replaceAll('\0', '').replaceAll('\r', '')
}

function failure(result: CommandResult): string {
  return cleanWslOutput(result.stderr || result.stdout).trim().slice(0, 1_000)
}

async function requireSuccess(operation: string, result: CommandResult): Promise<void> {
  if (result.exitCode !== 0 || result.timedOut) {
    throw new Error(`${operation} : ${failure(result) || 'échec sans détail'}`)
  }
}

async function download(url: string, destination: string): Promise<void> {
  const response = await fetch(url)
  if (!response.ok || !response.body) throw new Error(`Téléchargement impossible (${response.status}) : ${url}`)
  await writeFile(destination, Buffer.from(await response.arrayBuffer()), { flag: 'wx' })
}

async function downloadVerifiedRootfs(destination: string): Promise<void> {
  await download(`${ALPINE_BASE_URL}/${ALPINE_FILE}`, destination)
  const actual = createHash('sha256').update(await readFile(destination)).digest('hex')
  if (actual.toLowerCase() !== ALPINE_SHA256) {
    await rm(destination, { force: true })
    throw new Error('Le système Linux téléchargé ne correspond pas à sa somme SHA-256.')
  }
}

async function wsl(args: readonly string[], options: CommandOptions = {}): Promise<CommandResult> {
  const result = await runHostCommand('wsl.exe', args, {
    ...options,
    maxOutputBytes: options.maxOutputBytes ?? 200_000
  })
  return {
    ...result,
    stdout: cleanWslOutput(result.stdout),
    stderr: cleanWslOutput(result.stderr)
  }
}

function distroCommand(args: readonly string[], options?: CommandOptions): Promise<CommandResult> {
  return wsl(['--distribution', MANAGED_WSL_DISTRO, '--user', 'root', '--exec', ...args], options)
}

async function distroExists(): Promise<boolean> {
  const listed = await wsl(['--list', '--quiet'], { timeoutMs: 15_000 })
  if (listed.exitCode !== 0) return false
  return listed.stdout.split('\n').some((name) => name.trim().toLowerCase() === MANAGED_WSL_DISTRO.toLowerCase())
}

async function importDistro(root: string): Promise<void> {
  const installDirectory = path.join(root, 'wsl')
  const archive = path.join(root, ALPINE_FILE)
  await mkdir(installDirectory, { recursive: true })
  await rm(archive, { force: true })
  try {
    report('Téléchargement du Linux privé', 'Récupération et vérification du système Alpine…', 18)
    await downloadVerifiedRootfs(archive)
    report('Installation du Linux privé', 'Importation du système dans WSL 2…', 28)
    await requireSuccess('Import du runtime Linux', await wsl([
      '--import', MANAGED_WSL_DISTRO, installDirectory, archive, '--version', '2'
    ], { timeoutMs: 600_000 }))
  } finally {
    await rm(archive, { force: true })
  }
}

async function installRuntimePackages(): Promise<void> {
  const marker = await distroCommand(['test', '-f', RUNTIME_MARKER], { timeoutMs: 15_000 })
  if (marker.exitCode === 0) {
    report('Outils du runtime déjà installés', 'Docker, Git et Node sont disponibles.', 58)
    return
  }
  report('Installation des outils du runtime', 'Installation de Docker, Git et Node dans Linux. Cette étape peut durer quelques minutes…', 38)
  const script = [
    'set -eu',
    "branch=$(sed -n 's#.*alpine/\\(v[0-9.]*\\)/main#\\1#p' /etc/apk/repositories | head -n1)",
    'test -n "$branch"',
    'grep -q "/community" /etc/apk/repositories || echo "https://dl-cdn.alpinelinux.org/alpine/$branch/community" >> /etc/apk/repositories',
    'apk update',
    `apk add --no-cache ${MANAGED_RUNTIME_PACKAGES.join(' ')}`,
    'mkdir -p /etc/docker /var/log /run/openrc',
    'touch /run/openrc/softlevel',
    `touch ${RUNTIME_MARKER}`
  ].join('\n')
  await requireSuccess('Installation du moteur de conteneurs privé', await distroCommand(
    ['/bin/sh', '-lc', script],
    { timeoutMs: 900_000, maxOutputBytes: 500_000 }
  ))
  report('Outils du runtime installés', 'Le moteur de conteneurs est prêt à démarrer.', 58)
}

async function startDockerDaemon(): Promise<void> {
  report('Vérification de Docker', 'Connexion au moteur de conteneurs privé…', 63)
  const available = await distroCommand(['docker', 'info'], { timeoutMs: 15_000 })
  if (available.exitCode === 0) {
    report('Docker est démarré', 'Le moteur de conteneurs privé répond.', 74)
    return
  }
  report('Démarrage de Docker', 'Lancement invisible du moteur dans WSL 2…', 68)
  await requireSuccess('Démarrage du moteur de conteneurs privé', await distroCommand(
    ['/bin/sh', '-lc', DOCKER_SERVICE_START_SCRIPT],
    { timeoutMs: 90_000, maxOutputBytes: 200_000 }
  ))
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 500))
    const ready = await distroCommand(['docker', 'info'], { timeoutMs: 10_000 })
    if (ready.exitCode === 0) {
      report('Docker est démarré', 'Le moteur de conteneurs privé répond.', 74)
      return
    }
  }
  const logs = await distroCommand([
    '/bin/sh', '-lc',
    'printf "Journal Docker :\\n"; tail -n 100 /var/log/docker.log 2>&1; printf "\\nProcessus :\\n"; ps 2>&1 | grep -E "dockerd|containerd" || true'
  ], { timeoutMs: 15_000, maxOutputBytes: 100_000 })
  throw new Error(`Le moteur privé ne répond pas. ${failure(logs)}`.trim())
}

async function refreshDistroAddress(): Promise<void> {
  report('Configuration du réseau privé', 'Connexion sécurisée de Local Agent au runtime…', 77)
  const address = await distroCommand(WSL_ADDRESS_COMMAND, { timeoutMs: 15_000 })
  await requireSuccess('Détection de l’adresse du runtime privé', address)
  const ipv4 = address.stdout.match(/\binet (\d{1,3}(?:\.\d{1,3}){3})\//)?.[1]
  if (!ipv4) throw new Error('Le runtime privé ne possède aucune adresse réseau IPv4 utilisable.')
  distroAddress = ipv4
}

export function ensureManagedWslRuntime(): Promise<void> {
  if (process.platform !== 'win32') return Promise.resolve()
  if (stopping) return Promise.reject(new Error('Le runtime privé est en cours d’arrêt.'))
  if (!runtimeRoot) return Promise.reject(new Error('Le dossier du runtime privé n’est pas configuré.'))
  if (startup) return startup
  startup = (async () => {
    report('Vérification de WSL 2', 'Contrôle du composant de virtualisation Windows…', 8)
    const status = await wsl(['--status'], { timeoutMs: 30_000 })
    if (status.exitCode !== 0) {
      throw new Error('WSL 2 est requis. Activez le composant Windows WSL, redémarrez le PC, puis relancez Local Agent.')
    }
    const exists = await distroExists()
    report(
      exists ? 'Linux privé détecté' : 'Préparation du Linux privé',
      exists ? 'Le système isolé de Local Agent est déjà installé.' : 'Une première installation automatique est nécessaire.',
      exists ? 30 : 12
    )
    if (!exists) await importDistro(runtimeRoot as string)
    await installRuntimePackages()
    await startDockerDaemon()
    await refreshDistroAddress()
  })().finally(() => { startup = null })
  return startup
}

export function translateWindowsDockerArgument(argument: string): string {
  const translated = argument.replace(/source=([A-Za-z]):\\([^,]*)/g, (_match, drive: string, rest: string) => (
    `source=/mnt/${drive.toLowerCase()}/${rest.replaceAll('\\', '/')}`
  ))
  return translated.replace(/^127\.0\.0\.1:(\d+):(\d+)$/, '0.0.0.0:$1:$2')
}

export function managedWslServiceUrl(port: number): string | null {
  return process.platform === 'win32' && distroAddress ? `http://${distroAddress}:${port}` : null
}

async function runManagedDocker(
  _executable: string,
  args: readonly string[],
  options?: CommandOptions
): Promise<CommandResult> {
  try {
    await ensureManagedWslRuntime()
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
  const command = distroCommand(['docker', ...args.map(translateWindowsDockerArgument)], options)
  activeDockerCommands.add(command)
  void command.finally(() => activeDockerCommands.delete(command)).catch(() => undefined)
  return command
}

export function configureManagedWslRuntime(
  root: string,
  onProgress: ((progress: RuntimeProgress) => void) | null = null
): void {
  runtimeRoot = root
  stopping = false
  distroAddress = null
  progressReporter = onProgress
  configureManagedDockerRunner(process.platform === 'win32' ? runManagedDocker : null)
}

export function managedContainerPtyCommand(args: readonly string[]): {
  executable: string
  args: string[]
} {
  return process.platform === 'win32'
    ? {
        executable: 'wsl.exe',
        args: ['--distribution', MANAGED_WSL_DISTRO, '--user', 'root', '--exec', 'docker', ...args]
      }
    : { executable: 'docker', args: [...args] }
}

export async function installWslFeature(): Promise<void> {
  if (process.platform !== 'win32') return
  const command = "Start-Process -FilePath 'wsl.exe' -Verb RunAs -Wait -ArgumentList @('--install','--no-distribution')"
  await requireSuccess('Activation de WSL', await runHostCommand(
    'powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { timeoutMs: 600_000 }
  ))
}

export async function stopManagedWslRuntime(): Promise<void> {
  if (process.platform !== 'win32') return
  stopping = true
  await startup?.catch(() => undefined)
  await Promise.allSettled(activeDockerCommands)
  await wsl(['--terminate', MANAGED_WSL_DISTRO], { timeoutMs: 30_000 })
  distroAddress = null
}
