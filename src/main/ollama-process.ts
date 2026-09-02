import { runCommand, type CommandRunner, type CommandResult } from './runtime'
import type { RuntimeProgress } from '../shared/contracts'

export type OllamaStartResult =
  | { success: true }
  | { success: false; reason: string }

export type OllamaContainerOptions = {
  useNvidiaGpu?: boolean
  onProgress?: (progress: RuntimeProgress) => void
}

export const OLLAMA_CONTAINER_NAME = 'local-agent-ollama'
export const OLLAMA_MODELS_VOLUME = 'local-agent-ollama-models'
export const OLLAMA_IMAGE = 'ollama/ollama:latest'
export const OLLAMA_HOST_PORT = 11435
const OLLAMA_MANAGED_LABEL = 'com.local-agent.service=ollama'
const OLLAMA_CONFIG_LABEL = 'com.local-agent.ollama-config=v3'

function failureDetail(result: CommandResult): string {
  return (result.stderr.trim() || result.stdout.trim()).slice(0, 500)
}

async function removeFailedContainer(runner: CommandRunner): Promise<void> {
  await runner('docker', ['rm', '--force', OLLAMA_CONTAINER_NAME], { timeoutMs: 30_000 })
}

export async function startOllamaServer(
  options: OllamaContainerOptions = {},
  runner: CommandRunner = runCommand
): Promise<OllamaStartResult> {
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
    if (config === 'v3' && image === OLLAMA_IMAGE) {
      if (running === 'true') return { success: true }
      options.onProgress?.({ step: 'Redémarrage d’Ollama', detail: 'Le conteneur existant redémarre en arrière-plan…', percent: 88 })
      const started = await runner('docker', ['start', OLLAMA_CONTAINER_NAME], { timeoutMs: 60_000 })
      return started.exitCode === 0 && !started.timedOut
        ? { success: true }
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
    '--label', OLLAMA_CONFIG_LABEL,
    '--restart', 'unless-stopped',
    '--pull', 'missing',
    '--publish', `127.0.0.1:${OLLAMA_HOST_PORT}:11434`,
    '--volume', `${OLLAMA_MODELS_VOLUME}:/root/.ollama`,
    '--env', 'OLLAMA_NUM_PARALLEL=2',
    '--security-opt', 'no-new-privileges',
    '--cap-drop', 'ALL',
    '--pids-limit', '1024'
  ]
  const run = async (gpu: boolean): Promise<CommandResult> => runner('docker', [
    ...baseArgs,
    ...(gpu ? ['--gpus', 'all'] : []),
    OLLAMA_IMAGE
  ], { timeoutMs: 600_000, maxOutputBytes: 50_000 })

  options.onProgress?.({
    step: 'Préparation d’Ollama',
    detail: 'Téléchargement de l’image si nécessaire, puis lancement invisible du service…',
    percent: 88
  })
  let created = await run(Boolean(options.useNvidiaGpu))
  if (created.exitCode !== 0 && options.useNvidiaGpu) {
    options.onProgress?.({ step: 'Nouvel essai sans GPU', detail: 'Le mode GPU est indisponible, démarrage automatique sur le processeur…', percent: 89 })
    await removeFailedContainer(runner)
    created = await run(false)
  }
  if (created.exitCode !== 0 || created.timedOut) {
    await removeFailedContainer(runner)
    return {
      success: false,
      reason: `Le conteneur Ollama n’a pas pu être créé. ${failureDetail(created)}`.trim()
    }
  }
  return { success: true }
}
