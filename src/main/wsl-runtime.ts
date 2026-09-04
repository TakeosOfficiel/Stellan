import { createHash } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { RuntimeProgress } from '../shared/contracts'
import {
  configureManagedDockerPtyBuilder,
  configureManagedDockerRunner,
  managedDockerPtyCommand,
  runHostCommand,
  type CommandOptions,
  type CommandResult
} from './runtime'

// Keep this legacy system identifier so installed runtimes, projects and models survive upgrades.
export const MANAGED_WSL_DISTRO = 'LocalAgentRuntime'
const ALPINE_VERSION = '3.24.1'
const ALPINE_FILE = `alpine-minirootfs-${ALPINE_VERSION}-x86_64.tar.gz`
const ALPINE_BASE_URL = 'https://dl-cdn.alpinelinux.org/alpine/v3.24/releases/x86_64'
const ALPINE_SHA256 = '41f73e3cf5fa919b8aa5ca6b30dc48f0da2720776d7423e2a7748211456fe081'
const RUNTIME_MARKER = '/etc/local-agent-runtime-v4'
const PRIVATE_PROJECTS_ROOT = '/var/lib/local-agent'
const PRIVATE_PROJECT_SIZE_BYTES = 20 * 1024 * 1024 * 1024
const IMPORT_PRIVATE_PROJECT_SCRIPT = `set -eu
source=$1; disk=$2; target=$3; bytes=$4
[ -d "$source" ]
[ ! -e "$disk" ]
mkdir -p "$(dirname "$disk")" "$target"
truncate -s "$bytes" "$disk"
mkfs.ext4 -F -q "$disk"
mount -o loop,nosuid,nodev "$disk" "$target"
mkdir -p "$target/worktrees"
if git -C "$source" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  git clone --no-local --no-hardlinks "$source" "$target/repository"
  find "$target/repository" -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf -- {} +
  tar -C "$source" --exclude=.git -cf - . | tar -C "$target/repository" -xf -
else
  mkdir -p "$target/repository"
  cp -a "$source"/. "$target/repository"/
fi
cd "$target/repository"
if [ ! -d .git ]; then git init; fi
rm -rf .git/hooks && mkdir -p .git/hooks
git config core.hooksPath /dev/null
git config core.fsmonitor false
git add -A
if ! git rev-parse --verify HEAD >/dev/null 2>&1 || ! git diff --cached --quiet; then
  git -c user.name="Stellan" -c user.email="stellan@localhost" commit --allow-empty --no-verify -m "Stellan snapshot"
fi`
export const MANAGED_RUNTIME_PACKAGES = ['openrc', 'docker', 'docker-cli', 'nodejs', 'npm', 'git', 'ripgrep', 'bash', 'coreutils', 'iproute2', 'e2fsprogs', 'util-linux'] as const
export const WSL_ADDRESS_COMMAND = ['/sbin/ip', '-o', '-4', 'addr', 'show', 'dev', 'eth0'] as const
export const DOCKER_SERVICE_START_SCRIPT = [
  'set -eu',
  'mkdir -p /run/openrc /var/log',
  'touch /run/openrc/softlevel',
  'rc-service --nodeps docker restart'
].join('; ')

let runtimeRoot: string | null = null
let startup: Promise<void> | null = null
let ready = false
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

export function isMissingManagedDistroDiskFailure(value: string): boolean {
  return /Wsl\/Service\/CreateInstance\/Mount(?:Disk|Vhd)\/HCS\/ERROR_PATH_NOT_FOUND/i.test(value)
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
    env: { ...process.env, ...options.env, WSL_UTF8: '1' },
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

async function installRuntimePackages(existingMarker?: CommandResult): Promise<void> {
  const marker = existingMarker ?? await distroCommand(['test', '-f', RUNTIME_MARKER], { timeoutMs: 15_000 })
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

function validateProjectId(projectId: string): void {
  if (!/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(projectId)) {
    throw new Error('Identifiant de projet privé invalide.')
  }
}

function managedLinuxPathFromWindows(value: string): string | null {
  const normalized = value.replaceAll('/', '\\')
  const prefixes = [
    `\\\\wsl.localhost\\${MANAGED_WSL_DISTRO}\\`,
    `\\\\wsl$\\${MANAGED_WSL_DISTRO}\\`
  ]
  const prefix = prefixes.find((candidate) => normalized.toLowerCase().startsWith(candidate.toLowerCase()))
  if (!prefix) return null
  return `/${normalized.slice(prefix.length).replaceAll('\\', '/')}`
}

function sourceLinuxPath(value: string): string {
  const managed = managedLinuxPathFromWindows(value)
  if (managed) return managed
  const drive = value.match(/^([A-Za-z]):[\\/](.*)$/)
  if (!drive) throw new Error('Seuls les dossiers situés sur un disque local Windows peuvent être importés.')
  return `/mnt/${drive[1]!.toLowerCase()}/${drive[2]!.replaceAll('\\', '/')}`
}

async function mountPrivateProjectDisks(): Promise<void> {
  const script = [
    'set -eu',
    `base=${PRIVATE_PROJECTS_ROOT}`,
    'mkdir -p "$base/disks" "$base/projects"',
    'for disk in "$base"/disks/*.img; do',
    '  [ -f "$disk" ] || continue',
    '  id=$(basename "$disk" .img)',
    '  target="$base/projects/$id"',
    '  mkdir -p "$target"',
    '  mountpoint -q "$target" || mount -o loop,nosuid,nodev "$disk" "$target"',
    'done'
  ].join('\n')
  await requireSuccess('Montage des projets privés', await distroCommand(
    ['/bin/sh', '-lc', script],
    { timeoutMs: 120_000, maxOutputBytes: 100_000 }
  ))
}

export function managedProjectWindowsPath(projectId: string, child = ''): string {
  validateProjectId(projectId)
  const suffix = child.split(/[\\/]/).filter(Boolean).join('\\')
  return `\\\\wsl.localhost\\${MANAGED_WSL_DISTRO}\\var\\lib\\local-agent\\projects\\${projectId}${suffix ? `\\${suffix}` : ''}`
}

export function managedLinuxPathToWindows(value: string): string {
  if (!value.startsWith('/')) return value
  return `\\\\wsl.localhost\\${MANAGED_WSL_DISTRO}${value.replaceAll('/', '\\')}`
}

export async function importPrivateProject(
  projectId: string,
  sourcePath: string,
  sizeBytes = PRIVATE_PROJECT_SIZE_BYTES
): Promise<{ repositoryPath: string; workspacesPath: string }> {
  validateProjectId(projectId)
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 1024 * 1024 * 1024) {
    throw new Error('La taille du projet privé doit être d’au moins 1 Go.')
  }
  await ensureManagedWslRuntime()
  const source = sourceLinuxPath(sourcePath)
  const disk = `${PRIVATE_PROJECTS_ROOT}/disks/${projectId}.img`
  const target = `${PRIVATE_PROJECTS_ROOT}/projects/${projectId}`
  const result = await distroCommand([
    '/bin/sh', '-lc', IMPORT_PRIVATE_PROJECT_SCRIPT, 'import-private-project', source, disk, target, String(sizeBytes)
  ], { timeoutMs: 900_000, maxOutputBytes: 500_000 })
  if (result.exitCode !== 0 || result.timedOut) {
    await distroCommand(['/bin/sh', '-lc', 'umount "$1" 2>/dev/null || true; rm -rf "$1" "$2"', 'cleanup-private-project', target, disk], { timeoutMs: 120_000 })
    await requireSuccess('Import du projet privé', result)
  }
  return {
    repositoryPath: managedProjectWindowsPath(projectId, 'repository'),
    workspacesPath: managedProjectWindowsPath(projectId, 'worktrees')
  }
}

export function isManagedProjectWindowsPath(value: string): boolean {
  return managedLinuxPathFromWindows(value)?.startsWith(`${PRIVATE_PROJECTS_ROOT}/projects/`) ?? false
}

export function managedPrivateProjectId(projectPath: string): string | null {
  const linuxPath = managedLinuxPathFromWindows(projectPath)
  const projectId = linuxPath?.match(new RegExp(`^${PRIVATE_PROJECTS_ROOT}/projects/([a-f\\d-]{36})(?:/|$)`, 'i'))?.[1]
  if (!projectId) return null
  validateProjectId(projectId)
  return projectId
}

export async function deletePrivateProject(projectPath: string): Promise<void> {
  const projectId = managedPrivateProjectId(projectPath)
  if (!projectId) throw new Error('Ce dossier n’est pas un projet privé géré par Stellan.')
  await ensureManagedWslRuntime()
  const target = `${PRIVATE_PROJECTS_ROOT}/projects/${projectId}`
  const disk = `${PRIVATE_PROJECTS_ROOT}/disks/${projectId}.img`
  await requireSuccess('Suppression du projet privé', await distroCommand([
    '/bin/sh', '-lc',
    'set -eu; target=$1; disk=$2; if mountpoint -q "$target"; then umount "$target"; fi; rm -rf -- "$target"; rm -f -- "$disk"',
    'delete-private-project', target, disk
  ], { timeoutMs: 120_000, maxOutputBytes: 100_000 }))
}

export async function resizePrivateProject(projectPath: string, storageGb: number): Promise<number> {
  if (!Number.isInteger(storageGb) || storageGb < 20 || storageGb > 4_096) {
    throw new Error('Le stockage doit être compris entre 20 et 4096 Go.')
  }
  const projectId = managedPrivateProjectId(projectPath)
  if (!projectId) throw new Error('Ce projet n’utilise pas un disque privé redimensionnable.')
  await ensureManagedWslRuntime()
  const bytes = storageGb * 1024 * 1024 * 1024
  const disk = `${PRIVATE_PROJECTS_ROOT}/disks/${projectId}.img`
  const current = await distroCommand(['stat', '-c', '%s', disk], { timeoutMs: 15_000 })
  await requireSuccess('Lecture de la taille du projet privé', current)
  const currentBytes = Number(current.stdout.trim())
  if (!Number.isSafeInteger(currentBytes) || currentBytes <= 0) {
    throw new Error('La taille actuelle du projet privé est invalide.')
  }
  if (bytes < currentBytes) {
    throw new Error('Un disque privé peut être agrandi, mais pas réduit sans risque de corruption.')
  }
  if (bytes === currentBytes) return storageGb
  const resized = await distroCommand([
    '/bin/sh', '-lc', 'disk=$1; target=$2; bytes=$3; loop=$(findmnt -n -o SOURCE --target "$target"); test -b "$loop"; truncate -s "$bytes" "$disk"; resize2fs "$loop"',
    'resize-private-project', disk, `${PRIVATE_PROJECTS_ROOT}/projects/${projectId}`, String(bytes)
  ], { timeoutMs: 600_000, maxOutputBytes: 100_000 })
  await requireSuccess('Agrandissement du projet privé', resized)
  return storageGb
}

export async function runManagedWslCommand(
  executable: string,
  args: readonly string[],
  options: CommandOptions = {}
): Promise<CommandResult> {
  if (process.platform !== 'win32') return runHostCommand(executable, args, options)
  await ensureManagedWslRuntime()
  return distroCommand([
    executable,
    ...args.map((argument) => {
      const assignment = argument.match(/^(.*?=)(\\\\wsl(?:\.localhost|\$)\\[^\\]+\\.*)$/i)
      if (assignment) return `${assignment[1]}${managedLinuxPathFromWindows(assignment[2]!) ?? assignment[2]}`
      return managedLinuxPathFromWindows(argument) ?? argument
    })
  ], options)
}

async function refreshDistroAddress(): Promise<void> {
  report('Configuration du réseau privé', 'Connexion sécurisée de Stellan au runtime…', 77)
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
  if (ready) return Promise.resolve()
  if (startup) return startup
  startup = (async () => {
    report('Vérification de WSL 2', 'Contrôle du composant de virtualisation Windows…', 8)
    const status = await wsl(['--status'], { timeoutMs: 30_000 })
    if (status.exitCode !== 0) {
      throw new Error('WSL 2 est requis. Activez le composant Windows WSL, redémarrez le PC, puis relancez Stellan.')
    }
    let exists = await distroExists()
    report(
      exists ? 'Linux privé détecté' : 'Préparation du Linux privé',
      exists ? 'Le système isolé de Stellan est déjà installé.' : 'Une première installation automatique est nécessaire.',
      exists ? 30 : 12
    )
    let marker: CommandResult | undefined
    if (exists) {
      marker = await distroCommand(['test', '-f', RUNTIME_MARKER], { timeoutMs: 15_000 })
      const markerFailure = `${marker.stderr}\n${marker.stdout}`
      if (isMissingManagedDistroDiskFailure(markerFailure)) {
        report('Réparation du Linux privé', 'Le disque du runtime a disparu. Stellan le recrée automatiquement…', 14)
        await requireSuccess('Réinitialisation du runtime introuvable', await wsl([
          '--unregister', MANAGED_WSL_DISTRO
        ], { timeoutMs: 60_000 }))
        await rm(path.join(runtimeRoot as string, 'wsl'), { recursive: true, force: true })
        exists = false
        marker = undefined
      }
    }
    if (!exists) await importDistro(runtimeRoot as string)
    await installRuntimePackages(marker)
    await startDockerDaemon()
    await mountPrivateProjectDisks()
    await refreshDistroAddress()
    ready = true
  })().finally(() => { startup = null })
  return startup
}

export function translateWindowsDockerArgument(argument: string): string {
  const managed = managedLinuxPathFromWindows(argument)
  if (managed) return managed
  const translated = argument.replace(/source=([A-Za-z]):\\([^,]*)/g, (_match, drive: string, rest: string) => (
    `source=/mnt/${drive.toLowerCase()}/${rest.replaceAll('\\', '/')}`
  ))
  const source = translated.match(/^(.*source=)(\\\\wsl(?:\.localhost|\$)\\[^\\]+\\[^,]*)(.*)$/i)
  const withManagedSource = source
    ? `${source[1]}${managedLinuxPathFromWindows(source[2]!) ?? source[2]}${source[3]}`
    : translated
  return withManagedSource.replace(/^127\.0\.0\.1:(\d+):(\d+)$/, '0.0.0.0:$1:$2')
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
  ready = false
  distroAddress = null
  progressReporter = onProgress
  configureManagedDockerRunner(process.platform === 'win32' ? runManagedDocker : null)
  configureManagedDockerPtyBuilder(process.platform === 'win32'
    ? (args) => ({
        executable: 'wsl.exe',
        args: ['--distribution', MANAGED_WSL_DISTRO, '--user', 'root', '--exec', 'docker', ...args]
      })
    : null)
}

export function managedContainerPtyCommand(args: readonly string[]): {
  executable: string
  args: string[]
  env?: NodeJS.ProcessEnv
} {
  return managedDockerPtyCommand(args)
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
  ready = false
  distroAddress = null
}
