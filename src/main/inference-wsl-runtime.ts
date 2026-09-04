import { createHash } from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { RuntimeProgress } from '../shared/contracts'
import { runHostCommand, type CommandOptions, type CommandResult, type CommandRunner } from './runtime'
import { MANAGED_WSL_DISTRO, runManagedWslCommand, translateWindowsDockerArgument } from './wsl-runtime'

export const INFERENCE_WSL_DISTRO = 'StellanInferenceRuntime'
const UBUNTU_RELEASE = '20260826'
const UBUNTU_FILE = 'ubuntu-24.04-minimal-cloudimg-amd64-root.tar.xz'
const UBUNTU_URL = `https://cloud-images.ubuntu.com/minimal/releases/noble/release-${UBUNTU_RELEASE}/${UBUNTU_FILE}`
const UBUNTU_SHA256 = '73ed3980e31f24d2060969c6e04d4b4e3df22b7cb977a7373e44857a0bebf369'
const RUNTIME_MARKER = '/etc/stellan-inference-runtime-v2'
const MODELS_MARKER = '/var/lib/stellan/models-migrated-v1'
const OLLAMA_MODELS_VOLUME = 'local-agent-ollama-models'
const OLLAMA_CONTAINER = 'local-agent-ollama'

let runtimeRoot: string | null = null
let distroAddress: string | null = null
let progressReporter: ((progress: RuntimeProgress) => void) | null = null
let startup: Promise<void> | null = null
let ready = false
let keepAliveProcess: ChildProcess | null = null

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

async function wsl(args: readonly string[], options: CommandOptions = {}): Promise<CommandResult> {
  const result = await runHostCommand('wsl.exe', args, {
    ...options,
    env: { ...process.env, ...options.env, WSL_UTF8: '1' },
    maxOutputBytes: options.maxOutputBytes ?? 500_000
  })
  return { ...result, stdout: cleanWslOutput(result.stdout), stderr: cleanWslOutput(result.stderr) }
}

function distroCommand(args: readonly string[], options?: CommandOptions): Promise<CommandResult> {
  return wsl(['--distribution', INFERENCE_WSL_DISTRO, '--user', 'root', '--exec', ...args], options)
}

export function inferenceKeepAliveCommand(): { executable: string; args: string[] } {
  return {
    executable: 'wsl.exe',
    args: ['--distribution', INFERENCE_WSL_DISTRO, '--user', 'root', '--exec', 'sleep', 'infinity']
  }
}

async function ensureKeepAlive(): Promise<void> {
  if (keepAliveProcess?.exitCode === null && !keepAliveProcess.killed) return
  const command = inferenceKeepAliveCommand()
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command.executable, command.args, {
      stdio: 'ignore',
      windowsHide: true
    })
    const failed = (error: Error): void => {
      keepAliveProcess = null
      reject(new Error(`Le runtime Ubuntu ne peut pas rester actif : ${error.message}`))
    }
    child.once('error', failed)
    child.once('spawn', () => {
      child.removeListener('error', failed)
      keepAliveProcess = child
      child.once('exit', () => {
        if (keepAliveProcess === child) keepAliveProcess = null
      })
      resolve()
    })
  })
}

async function distroExists(): Promise<boolean> {
  const listed = await wsl(['--list', '--quiet'], { timeoutMs: 15_000 })
  if (listed.exitCode !== 0) return false
  return listed.stdout.split('\n').some((name) => name.trim().toLowerCase() === INFERENCE_WSL_DISTRO.toLowerCase())
}

async function downloadVerifiedRootfs(destination: string): Promise<void> {
  const response = await fetch(UBUNTU_URL)
  if (!response.ok || !response.body) throw new Error(`Téléchargement Ubuntu impossible (${response.status}).`)
  const data = Buffer.from(await response.arrayBuffer())
  const checksum = createHash('sha256').update(data).digest('hex')
  if (checksum !== UBUNTU_SHA256) throw new Error('L’image Ubuntu téléchargée ne correspond pas à sa somme SHA-256 officielle.')
  await writeFile(destination, data, { flag: 'wx' })
}

async function importDistro(): Promise<void> {
  if (!runtimeRoot) throw new Error('Le dossier du runtime d’inférence n’est pas configuré.')
  const installDirectory = path.join(runtimeRoot, 'inference-wsl')
  const archive = path.join(runtimeRoot, UBUNTU_FILE)
  await mkdir(installDirectory, { recursive: true })
  await rm(archive, { force: true })
  try {
    report('Téléchargement du runtime GPU', 'Téléchargement et vérification d’Ubuntu 24.04…', 20)
    await downloadVerifiedRootfs(archive)
    report('Installation du runtime GPU', 'Importation d’Ubuntu dans WSL 2, sans modifier le runtime existant…', 30)
    await requireSuccess('Import du runtime Ubuntu', await wsl([
      '--import', INFERENCE_WSL_DISTRO, installDirectory, archive, '--version', '2'
    ], { timeoutMs: 600_000 }))
  } finally {
    await rm(archive, { force: true })
  }
}

async function installNvidiaRuntime(): Promise<boolean> {
  const marker = await distroCommand(['test', '-f', RUNTIME_MARKER], { timeoutMs: 15_000 })
  if (marker.exitCode === 0) return false
  report('Installation du support NVIDIA', 'Installation de Docker et du NVIDIA Container Toolkit officiel…', 42)
  const script = `set -eu
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends ca-certificates curl gnupg docker.io iproute2 systemd systemd-sysv
install -m 0755 -d /usr/share/keyrings
curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey | gpg --dearmor --yes -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
curl -fsSL https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list | sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' > /etc/apt/sources.list.d/nvidia-container-toolkit.list
apt-get update
apt-get install -y --no-install-recommends nvidia-container-toolkit
nvidia-ctk runtime configure --runtime=docker
printf '[boot]\nsystemd=true\n' > /etc/wsl.conf
systemctl enable docker.service
mkdir -p /var/lib/stellan
touch ${RUNTIME_MARKER}`
  await requireSuccess('Installation du runtime NVIDIA', await distroCommand(
    ['/bin/sh', '-lc', script],
    { timeoutMs: 1_200_000, maxOutputBytes: 1_000_000 }
  ))
  return true
}

async function startDocker(): Promise<void> {
  report('Démarrage du runtime GPU', 'Démarrage du moteur Docker Ubuntu…', 58)
  await requireSuccess('Démarrage de Docker dans Ubuntu', await distroCommand(
    ['/bin/sh', '-lc', 'test "$(cat /proc/1/comm)" = systemd && systemctl restart docker.service'],
    { timeoutMs: 90_000, maxOutputBytes: 200_000 }
  ))
  let dockerReady = false
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const status = await distroCommand(['docker', 'info'], { timeoutMs: 10_000 })
    if (status.exitCode === 0) {
      dockerReady = true
      break
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  if (!dockerReady) throw new Error('Docker Ubuntu ne répond pas après son redémarrage.')
  await requireSuccess('Vérification du GPU WSL', await distroCommand(
    ['/bin/sh', '-lc', 'test -c /dev/dxg && command -v nvidia-container-runtime >/dev/null && nvidia-container-cli info >/dev/null'],
    { timeoutMs: 15_000 }
  ))
}

export function inferenceLinuxPathFromWindows(value: string): string {
  const drive = value.match(/^([A-Za-z]):[\\/](.*)$/)
  if (!drive) throw new Error('Le runtime GPU doit être installé sur un disque Windows local.')
  return `/mnt/${drive[1]!.toLowerCase()}/${drive[2]!.replaceAll('\\', '/')}`
}

async function streamModelsBetweenDistros(sourceRoot: string, targetRoot: string, totalBytes: number): Promise<void> {
  const receivedDigest = '/var/lib/stellan/models-transfer.sha256'
  await requireSuccess('Préparation du volume Ollama Ubuntu', await distroCommand([
    '/bin/sh', '-lc', 'set -eu; target=$1; find "$target" -mindepth 1 -delete; rm -f "$2"',
    'prepare-models', targetRoot, receivedDigest
  ], { timeoutMs: 120_000 }))

  await new Promise<void>((resolve, reject) => {
    const source = spawn('wsl.exe', [
      '--distribution', MANAGED_WSL_DISTRO, '--user', 'root', '--exec',
      'tar', '-C', sourceRoot, '-cf', '-', '.'
    ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    const target = spawn('wsl.exe', [
      '--distribution', INFERENCE_WSL_DISTRO, '--user', 'root', '--exec',
      '/bin/bash', '-lc', 'set -o pipefail; tee >(sha256sum | cut -d" " -f1 > "$2") | tar -C "$1" -xf -',
      'receive-models', targetRoot, receivedDigest
    ], { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true })
    const digest = createHash('sha256')
    let copiedBytes = 0
    let sourceError = ''
    let targetError = ''
    let sourceExit: number | null = null
    let targetExit: number | null = null
    let settled = false
    let lastProgressAt = 0
    const timer = setTimeout(() => {
      source.kill('SIGKILL')
      target.kill('SIGKILL')
    }, 2 * 60 * 60 * 1_000)
    const appendError = (current: string, chunk: Buffer): string => (current + chunk.toString('utf8')).slice(-20_000)
    const finish = (): void => {
      if (settled || sourceExit === null || targetExit === null) return
      settled = true
      clearTimeout(timer)
      if (sourceExit !== 0 || targetExit !== 0) {
        reject(new Error(`La copie directe des modèles a échoué. ${(targetError || sourceError).trim()}`.trim()))
        return
      }
      void distroCommand(['cat', receivedDigest], { timeoutMs: 15_000 }).then((result) => {
        if (result.exitCode !== 0 || result.stdout.trim() !== digest.digest('hex')) {
          reject(new Error('La vérification du flux de modèles a échoué ; l’ancien volume reste intact.'))
          return
        }
        resolve()
      }, reject)
    }
    source.stdout.on('data', (chunk: Buffer) => {
      digest.update(chunk)
      copiedBytes += chunk.byteLength
      const now = Date.now()
      if (now - lastProgressAt >= 1_000) {
        lastProgressAt = now
        const copiedGb = copiedBytes / 1_000_000_000
        const totalGb = totalBytes / 1_000_000_000
        report('Migration des modèles', `Copie directe vérifiée : ${copiedGb.toFixed(1)} / ${totalGb.toFixed(1)} Go…`, Math.min(79, 72 + Math.floor((copiedBytes / Math.max(1, totalBytes)) * 7)))
      }
      if (!target.stdin.write(chunk)) source.stdout.pause()
    })
    target.stdin.on('drain', () => source.stdout.resume())
    source.stdout.on('end', () => target.stdin.end())
    source.stderr.on('data', (chunk: Buffer) => { sourceError = appendError(sourceError, chunk) })
    target.stderr.on('data', (chunk: Buffer) => { targetError = appendError(targetError, chunk) })
    source.on('error', reject)
    target.on('error', reject)
    source.on('close', (code) => { sourceExit = code ?? -1; finish() })
    target.on('close', (code) => { targetExit = code ?? -1; finish() })
  })
}

async function migrateModels(): Promise<void> {
  if (!runtimeRoot) throw new Error('Le dossier du runtime d’inférence n’est pas configuré.')
  const migrated = await distroCommand(['test', '-f', MODELS_MARKER], { timeoutMs: 15_000 })
  if (migrated.exitCode === 0) return

  report('Migration des modèles', 'Préparation de la copie vérifiée des modèles Ollama existants…', 66)
  await requireSuccess('Création du volume Ollama Ubuntu', await distroCommand(
    ['docker', 'volume', 'create', OLLAMA_MODELS_VOLUME], { timeoutMs: 30_000 }
  ))
  const sourceVolume = await runManagedWslCommand('docker', ['volume', 'inspect', '--format', '{{.Mountpoint}}', OLLAMA_MODELS_VOLUME], { timeoutMs: 30_000 })
  if (sourceVolume.exitCode !== 0) {
    if (!/no such volume/i.test(`${sourceVolume.stderr}\n${sourceVolume.stdout}`)) {
      await requireSuccess('Localisation de l’ancien volume Ollama', sourceVolume)
    }
    await requireSuccess('Finalisation du volume Ollama vide', await distroCommand(['touch', MODELS_MARKER], { timeoutMs: 15_000 }))
    return
  }

  const sourceContainer = await runManagedWslCommand('docker', ['inspect', '--format', '{{.State.Running}}', OLLAMA_CONTAINER], { timeoutMs: 30_000 })
  const restartSourceContainer = sourceContainer.exitCode === 0 && sourceContainer.stdout.trim() === 'true'
  if (sourceContainer.exitCode !== 0 && !/no such (?:object|container)/i.test(`${sourceContainer.stderr}\n${sourceContainer.stdout}`)) {
    await requireSuccess('Vérification de l’ancien conteneur Ollama', sourceContainer)
  }
  if (restartSourceContainer) {
    await requireSuccess('Arrêt temporaire de l’ancien Ollama', await runManagedWslCommand(
      'docker', ['stop', OLLAMA_CONTAINER], { timeoutMs: 60_000 }
    ))
  }
  const targetVolume = await distroCommand(['docker', 'volume', 'inspect', '--format', '{{.Mountpoint}}', OLLAMA_MODELS_VOLUME], { timeoutMs: 30_000 })
  await requireSuccess('Localisation du volume Ollama Ubuntu', targetVolume)
  try {
    const sourceRoot = sourceVolume.stdout.trim()
    const targetRoot = targetVolume.stdout.trim()
    const measured = await runManagedWslCommand('du', ['-sb', sourceRoot], { timeoutMs: 120_000, maxOutputBytes: 10_000 })
    await requireSuccess('Mesure des modèles Ollama', measured)
    const totalBytes = Number(measured.stdout.trim().split(/\s+/)[0])
    if (!Number.isSafeInteger(totalBytes) || totalBytes < 0) throw new Error('La taille des modèles Ollama est invalide.')
    await streamModelsBetweenDistros(sourceRoot, targetRoot, totalBytes)
    await requireSuccess('Validation de la migration des modèles', await distroCommand(['touch', MODELS_MARKER], { timeoutMs: 15_000 }))
  } finally {
    if (restartSourceContainer) {
      await runManagedWslCommand('docker', ['start', OLLAMA_CONTAINER], { timeoutMs: 60_000 })
    }
  }
}

async function refreshAddress(): Promise<void> {
  const result = await distroCommand(['/sbin/ip', '-o', '-4', 'addr', 'show', 'dev', 'eth0'], { timeoutMs: 15_000 })
  await requireSuccess('Détection de l’adresse du runtime GPU', result)
  const address = result.stdout.match(/\binet (\d{1,3}(?:\.\d{1,3}){3})\//)?.[1]
  if (!address) throw new Error('Le runtime GPU ne possède aucune adresse IPv4 utilisable.')
  distroAddress = address
}

export function configureInferenceWslRuntime(
  root: string,
  onProgress: ((progress: RuntimeProgress) => void) | null = null
): void {
  runtimeRoot = root
  distroAddress = null
  progressReporter = onProgress
  ready = false
}

export function ensureNvidiaInferenceRuntime(): Promise<void> {
  if (process.platform !== 'win32') return Promise.reject(new Error('Le runtime GPU WSL est réservé à Windows.'))
  if (ready) return Promise.resolve()
  if (startup) return startup
  startup = (async () => {
    if (!await distroExists()) await importDistro()
    const requiresSystemdRestart = await installNvidiaRuntime()
    if (requiresSystemdRestart) {
      report('Activation de systemd', 'Redémarrage isolé du nouveau runtime Ubuntu…', 54)
      await requireSuccess('Redémarrage du runtime Ubuntu', await wsl([
        '--terminate', INFERENCE_WSL_DISTRO
      ], { timeoutMs: 30_000 }))
    }
    await ensureKeepAlive()
    await startDocker()
    await migrateModels()
    await refreshAddress()
    ready = true
    report('Runtime NVIDIA prêt', 'Ubuntu, Docker et le GPU NVIDIA sont prêts pour Ollama.', 80)
  })().finally(() => { startup = null })
  return startup
}

export const runInferenceWslCommand: CommandRunner = (executable, args, options) =>
  process.platform === 'win32'
    ? distroCommand([executable, ...args], options)
    : runHostCommand(executable, args, options)

export const runInferenceDockerCommand: CommandRunner = (_executable, args, options) =>
  runInferenceWslCommand('docker', args.map(translateWindowsDockerArgument), options)

export async function verifyNvidiaInferenceContainer(): Promise<void> {
  const result = await runInferenceDockerCommand('docker', [
    'exec', OLLAMA_CONTAINER, 'nvidia-smi', '-L'
  ], { timeoutMs: 30_000, maxOutputBytes: 20_000 })
  await requireSuccess('Vérification NVIDIA dans le conteneur Ollama', result)
  if (!/GPU\s+0:/i.test(result.stdout)) throw new Error('Le conteneur Ollama ne voit aucun GPU NVIDIA.')
}

export function inferenceWslServiceUrl(port: number): string | null {
  return process.platform === 'win32' && distroAddress ? `http://${distroAddress}:${port}` : null
}

export async function stopInferenceWslRuntime(): Promise<void> {
  if (process.platform !== 'win32') return
  await startup?.catch(() => undefined)
  keepAliveProcess?.kill()
  keepAliveProcess = null
  await wsl(['--terminate', INFERENCE_WSL_DISTRO], { timeoutMs: 30_000 })
  ready = false
  distroAddress = null
}
