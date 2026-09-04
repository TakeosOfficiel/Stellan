import { runCommand, type CommandRunner, type CommandResult } from './runtime'
import type { HardwareInfo, RuntimeProgress } from '../shared/contracts'

export type OllamaGpuBackend = 'nvidia' | 'amd-rocm' | 'vulkan' | 'cpu'

export type OllamaStartResult =
  | { success: true; backend: OllamaGpuBackend; fallbackReason?: string }
  | { success: false; reason: string }

export type OllamaContainerOptions = {
  gpuBackend?: OllamaGpuBackend
  numParallel?: 1 | 2
  onProgress?: (progress: RuntimeProgress) => void
}

export const OLLAMA_CONTAINER_NAME = 'local-agent-ollama'
export const OLLAMA_MODELS_VOLUME = 'local-agent-ollama-models'
export const OLLAMA_IMAGE = 'ollama/ollama:latest'
export const OLLAMA_ROCM_IMAGE = 'ollama/ollama:rocm'
export const OLLAMA_HOST_PORT = 11435
const OLLAMA_MANAGED_LABEL = 'com.local-agent.service=ollama'
const OLLAMA_CONFIG_LABEL = 'com.local-agent.ollama-config'
const OLLAMA_CONFIG_VERSION = 'v7'

function failureDetail(result: CommandResult): string {
  return (result.stderr.trim() || result.stdout.trim()).slice(0, 500)
}

async function removeFailedContainer(runner: CommandRunner): Promise<void> {
  await runner('docker', ['rm', '--force', OLLAMA_CONTAINER_NAME], { timeoutMs: 30_000 })
}

async function pathExists(path: string, runner: CommandRunner): Promise<boolean> {
  const result = await runner('test', ['-e', path], { timeoutMs: 10_000 })
  return result.exitCode === 0 && !result.timedOut
}

export async function detectOllamaGpuBackend(
  hardware: HardwareInfo,
  deviceRunner: CommandRunner
): Promise<OllamaGpuBackend> {
  const gpuNames = hardware.gpus.map((gpu) => gpu.model).join(' ')
  const hasNvidia = /nvidia|geforce|quadro|rtx|gtx/i.test(gpuNames)
  const hasAmd = /amd|radeon/i.test(gpuNames)
  const hasOtherGpu = hardware.gpus.length > 0
  if (hasNvidia) return 'nvidia'
  if (!hasAmd && !hasOtherGpu) return 'cpu'

  const [hasDri, hasKfd] = await Promise.all([
    pathExists('/dev/dri', deviceRunner),
    hasAmd ? pathExists('/dev/kfd', deviceRunner) : Promise.resolve(false)
  ])
  if (hasAmd && hasDri && hasKfd) return 'amd-rocm'
  return hasDri ? 'vulkan' : 'cpu'
}

export async function startOllamaServer(
  options: OllamaContainerOptions = {},
  runner: CommandRunner = runCommand
): Promise<OllamaStartResult> {
  const requestedBackend = options.gpuBackend ?? 'cpu'
  const numParallel = options.numParallel ?? 1
  const expectedImage = requestedBackend === 'amd-rocm' ? OLLAMA_ROCM_IMAGE : OLLAMA_IMAGE
  const expectedConfig = `${OLLAMA_CONFIG_VERSION}-${requestedBackend}-p${numParallel}`
  options.onProgress?.({ step: 'Vérification du moteur privé', detail: 'Connexion à Docker…', percent: 79 })
  let docker: CommandResult
  try {
    docker = await runner('docker', ['info', '--format', '{{.ServerVersion}}'], {
      timeoutMs: 15_000
    })
  } catch (error) {
    return {
      success: false,
      reason: error instanceof Error ? error.message : 'Le runtime Linux privé n’a pas pu démarrer.'
    }
  }
  if (docker.exitCode !== 0 || docker.timedOut) {
    return {
      success: false,
      reason: failureDetail(docker)
        || 'Le runtime Linux privé ne répond pas. Vérifiez que WSL 2 est activé puis réessayez.'
    }
  }

  options.onProgress?.({ step: 'Vérification du service Ollama', detail: 'Recherche du conteneur et des modèles existants…', percent: 82 })
  const inspected = await runner('docker', [
    'inspect', '--format', '{{.State.Running}}|{{index .Config.Labels "com.local-agent.service"}}|{{index .Config.Labels "com.local-agent.ollama-config"}}|{{.Config.Image}}', OLLAMA_CONTAINER_NAME
  ], { timeoutMs: 15_000 })
  if (inspected.exitCode === 0) {
    const [running, service, config, image] = inspected.stdout.trim().split('|')
    if (service !== 'ollama') {
      return {
        success: false,
        reason: `Un conteneur non géré utilise déjà le nom ${OLLAMA_CONTAINER_NAME}. Supprimez-le avant de réessayer.`
      }
    }
    if (config === expectedConfig && image === expectedImage) {
      if (running === 'true') return { success: true, backend: requestedBackend }
      options.onProgress?.({ step: 'Redémarrage d’Ollama', detail: 'Le conteneur existant redémarre en arrière-plan…', percent: 88 })
      const started = await runner('docker', ['start', OLLAMA_CONTAINER_NAME], { timeoutMs: 60_000 })
      return started.exitCode === 0 && !started.timedOut
        ? { success: true, backend: requestedBackend }
        : { success: false, reason: `Le conteneur Ollama n’a pas pu redémarrer. ${failureDetail(started)}`.trim() }
    }
    options.onProgress?.({ step: 'Mise à niveau d’Ollama', detail: 'Remplacement automatique de l’ancien conteneur…', percent: 85 })
    const removed = await runner('docker', ['rm', '--force', OLLAMA_CONTAINER_NAME], { timeoutMs: 30_000 })
    if (removed.exitCode !== 0 || removed.timedOut) {
      return { success: false, reason: `Le conteneur Ollama obsolète n’a pas pu être remplacé. ${failureDetail(removed)}`.trim() }
    }
  }

  const baseArgs = [
    'run', '--detach',
    '--name', OLLAMA_CONTAINER_NAME,
    '--label', OLLAMA_MANAGED_LABEL,
    '--restart', 'unless-stopped',
    '--pull', 'always',
    '--publish', `127.0.0.1:${OLLAMA_HOST_PORT}:11434`,
    '--volume', `${OLLAMA_MODELS_VOLUME}:/root/.ollama`,
    '--env', 'OLLAMA_KEEP_ALIVE=30m',
    '--security-opt', 'no-new-privileges',
    '--cap-drop', 'ALL',
    '--pids-limit', '1024'
  ]
  const run = async (backend: OllamaGpuBackend, parallelism: 1 | 2, percent: number): Promise<CommandResult> => {
    const startedAt = Date.now()
    const elapsedProgress = setInterval(() => {
      const elapsedSeconds = Math.max(5, Math.round((Date.now() - startedAt) / 1_000))
      options.onProgress?.({
        step: 'Préparation d’Ollama',
        detail: `Téléchargement ou lancement en cours — ${elapsedSeconds} s écoulées. La première installation télécharge plusieurs Go.`,
        percent
      })
    }, 5_000)
    try {
      return await runner('docker', [
        ...baseArgs,
        '--label', `${OLLAMA_CONFIG_LABEL}=${OLLAMA_CONFIG_VERSION}-${backend}-p${parallelism}`,
        '--env', `OLLAMA_NUM_PARALLEL=${parallelism}`,
        ...(backend === 'nvidia' ? ['--gpus', 'all'] : []),
        ...(backend === 'amd-rocm' ? ['--device', '/dev/kfd', '--device', '/dev/dri'] : []),
        ...(backend === 'vulkan' ? ['--device', '/dev/dri'] : []),
        backend === 'amd-rocm' ? OLLAMA_ROCM_IMAGE : OLLAMA_IMAGE
      ], { timeoutMs: 600_000, maxOutputBytes: 50_000 })
    } finally {
      clearInterval(elapsedProgress)
    }
  }

  options.onProgress?.({
    step: 'Préparation d’Ollama',
    detail: 'Téléchargement de l’image Ollama si nécessaire. La première installation peut durer plusieurs minutes…',
    percent: 88
  })
  let activeBackend = requestedBackend
  let created = await run(activeBackend, numParallel, 88)
  let fallbackReason: string | undefined
  if ((created.exitCode !== 0 || created.timedOut) && requestedBackend === 'amd-rocm') {
    fallbackReason = failureDetail(created) || 'ROCm indisponible'
    options.onProgress?.({ step: 'Nouvel essai avec Vulkan', detail: 'ROCm est indisponible, essai du pilote graphique universel…', percent: 89 })
    await removeFailedContainer(runner)
    activeBackend = 'vulkan'
    created = await run(activeBackend, numParallel, 89)
  }
  if ((created.exitCode !== 0 || created.timedOut) && activeBackend !== 'cpu') {
    fallbackReason = failureDetail(created) || `${activeBackend} indisponible`
    options.onProgress?.({
      step: 'Nouvel essai sans GPU',
      detail: requestedBackend === 'nvidia'
        ? 'NVIDIA n’est pas accessible depuis Docker. Vérifiez NVIDIA Container Toolkit ; démarrage temporaire sur le processeur…'
        : 'Le mode GPU est indisponible, démarrage automatique sur le processeur…',
      percent: 89
    })
    await removeFailedContainer(runner)
    activeBackend = 'cpu'
    created = await run(activeBackend, 1, 89)
  }
  if (created.exitCode !== 0 || created.timedOut) {
    await removeFailedContainer(runner)
    return {
      success: false,
      reason: `Le conteneur Ollama n’a pas pu être créé. ${failureDetail(created)}`.trim()
    }
  }
  return { success: true, backend: activeBackend, ...(fallbackReason ? { fallbackReason } : {}) }
}
