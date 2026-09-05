import { createHash } from 'node:crypto'
import type { ReasoningMode } from '../shared/contracts'
import { runCommand, type CommandResult, type CommandRunner } from './runtime'

export type LlamaBackend = 'cpu' | 'cuda' | 'rocm' | 'vulkan'

export type LlamaStartResult =
  | { success: true; backend: LlamaBackend; fallbackReason?: string }
  | { success: false; reason: string }

export type LlamaContainerOptions = {
  backend: LlamaBackend
  /** A llama.cpp-compatible Hugging Face repository/artifact value, passed to --hf-repo. */
  modelArtifact: string
  /** Stable model name exposed by the OpenAI-compatible API. */
  modelAlias: string
  contextSize: number
  predictTokens: number
  parallel: number
  reasoningMode: ReasoningMode
}

export const LLAMA_CONTAINER_NAME = 'local-agent-llama-server'
export const LLAMA_MODELS_VOLUME = 'local-agent-llama-models'
export const LLAMA_CACHE_PATH = '/root/.cache/huggingface'
export const LLAMA_HOST_PORT = 11436
export const LLAMA_CONTAINER_PORT = 8080
export const LLAMA_MANAGED_LABEL = 'com.local-agent.service=llama.cpp'
export const LLAMA_CONFIG_LABEL = 'com.local-agent.llama-config'
export const LLAMA_CONFIG_VERSION = 'v4'
export const LLAMA_IMAGES: Readonly<Record<LlamaBackend, string>> = {
  cpu: 'ghcr.io/ggml-org/llama.cpp:server',
  cuda: 'ghcr.io/ggml-org/llama.cpp:server-cuda',
  rocm: 'ghcr.io/ggml-org/llama.cpp:server-rocm',
  vulkan: 'ghcr.io/ggml-org/llama.cpp:server-vulkan'
}

function detail(result: CommandResult): string {
  return (result.stderr.trim() || result.stdout.trim()).slice(0, 500)
}

function validPositiveInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0
}

function configFor(options: LlamaContainerOptions, backend: LlamaBackend): string {
  const artifactHash = createHash('sha256')
    .update(`${options.modelArtifact}\0${options.modelAlias}`)
    .digest('hex')
    .slice(0, 16)
  return `${LLAMA_CONFIG_VERSION}-${backend}-m${artifactHash}-c${options.contextSize}-n${options.predictTokens}-p${options.parallel}-r${options.reasoningMode}`
}

async function removeContainer(runner: CommandRunner): Promise<CommandResult> {
  return runner('docker', ['rm', '--force', LLAMA_CONTAINER_NAME], { timeoutMs: 30_000 })
}

export async function startLlamaServer(
  options: LlamaContainerOptions,
  runner: CommandRunner = runCommand
): Promise<LlamaStartResult> {
  if (!options.modelArtifact.trim()) {
    return { success: false, reason: 'Un modèle Hugging Face compatible avec llama.cpp est requis.' }
  }
  if (!options.modelAlias.trim()) {
    return { success: false, reason: 'Un identifiant local de modèle est requis.' }
  }
  if (![options.contextSize, options.predictTokens, options.parallel].every(validPositiveInteger)) {
    return { success: false, reason: 'Le contexte, la prédiction et le parallélisme doivent être des entiers positifs.' }
  }
  if (!['fast', 'auto', 'advanced'].includes(options.reasoningMode)) {
    return { success: false, reason: 'Le mode de raisonnement local est invalide.' }
  }

  let docker: CommandResult
  try {
    docker = await runner('docker', ['info', '--format', '{{.ServerVersion}}'], { timeoutMs: 15_000 })
  } catch (error) {
    return { success: false, reason: error instanceof Error ? error.message : 'Docker est indisponible.' }
  }
  if (docker.exitCode !== 0 || docker.timedOut) {
    return { success: false, reason: detail(docker) || 'Docker est indisponible.' }
  }

  const expectedConfig = configFor(options, options.backend)
  const inspected = await runner('docker', [
    'inspect', '--format',
    '{{.State.Running}}|{{index .Config.Labels "com.local-agent.service"}}|{{index .Config.Labels "com.local-agent.llama-config"}}|{{.Config.Image}}',
    LLAMA_CONTAINER_NAME
  ], { timeoutMs: 15_000 })
  if (inspected.exitCode === 0) {
    const [running, service, config, image] = inspected.stdout.trim().split('|')
    if (service !== 'llama.cpp') {
      return { success: false, reason: `Un conteneur non géré utilise déjà le nom ${LLAMA_CONTAINER_NAME}.` }
    }
    if (config === expectedConfig && image === LLAMA_IMAGES[options.backend]) {
      if (running === 'true') return { success: true, backend: options.backend }
      const started = await runner('docker', ['start', LLAMA_CONTAINER_NAME], { timeoutMs: 60_000 })
      return started.exitCode === 0 && !started.timedOut
        ? { success: true, backend: options.backend }
        : { success: false, reason: `Le conteneur llama.cpp n’a pas pu redémarrer. ${detail(started)}`.trim() }
    }
    const removed = await removeContainer(runner)
    if (removed.exitCode !== 0 || removed.timedOut) {
      return { success: false, reason: `L’ancien conteneur llama.cpp n’a pas pu être remplacé. ${detail(removed)}`.trim() }
    }
  }

  const run = (backend: LlamaBackend): Promise<CommandResult> => runner('docker', [
    'run', '--detach',
    '--name', LLAMA_CONTAINER_NAME,
    '--label', LLAMA_MANAGED_LABEL,
    '--label', `${LLAMA_CONFIG_LABEL}=${configFor(options, backend)}`,
    '--restart', 'unless-stopped',
    '--pull', 'missing',
    '--publish', `127.0.0.1:${LLAMA_HOST_PORT}:${LLAMA_CONTAINER_PORT}`,
    '--volume', `${LLAMA_MODELS_VOLUME}:${LLAMA_CACHE_PATH}`,
    '--security-opt', 'no-new-privileges',
    '--cap-drop', 'ALL',
    '--pids-limit', '1024',
    ...(backend === 'cuda' ? ['--gpus', 'all'] : []),
    ...(backend === 'rocm' ? ['--device', '/dev/kfd', '--device', '/dev/dri'] : []),
    ...(backend === 'vulkan' ? ['--device', '/dev/dri'] : []),
    LLAMA_IMAGES[backend],
    '--host', '0.0.0.0',
    '--port', String(LLAMA_CONTAINER_PORT),
    '--hf-repo', options.modelArtifact,
    '--alias', options.modelAlias,
    '--ctx-size', String(options.contextSize),
    '--n-predict', String(options.predictTokens),
    '--parallel', String(options.parallel),
    '--jinja',
    '--reasoning', options.reasoningMode === 'fast' ? 'off' : options.reasoningMode === 'advanced' ? 'on' : 'auto',
    '--reasoning-budget', options.reasoningMode === 'fast' ? '0' : options.reasoningMode === 'advanced' ? '2048' : '768',
    ...(options.reasoningMode === 'fast' ? [] : ['--reasoning-preserve']),
    ...(backend === 'cpu' ? [] : ['--n-gpu-layers', '-1'])
  ], { timeoutMs: 600_000, maxOutputBytes: 50_000 })

  let created = await run(options.backend)
  if ((created.exitCode !== 0 || created.timedOut) && options.backend !== 'cpu') {
    const fallbackReason = detail(created) || `Le backend ${options.backend} est indisponible.`
    await removeContainer(runner)
    created = await run('cpu')
    if (created.exitCode === 0 && !created.timedOut) {
      return { success: true, backend: 'cpu', fallbackReason }
    }
  }
  if (created.exitCode !== 0 || created.timedOut) {
    await removeContainer(runner)
    return { success: false, reason: `Le conteneur llama.cpp n’a pas pu être créé. ${detail(created)}`.trim() }
  }
  return { success: true, backend: options.backend }
}

export async function waitForLlamaServer(
  baseUrl: string,
  fetcher: typeof fetch = fetch,
  attempts = 900,
  intervalMs = 1_000
): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetcher(`${baseUrl}/health`, {
        signal: AbortSignal.timeout(5_000)
      })
      if (response.ok) return
      if (response.status !== 503) {
        throw new Error(`statut ${response.status}`)
      }
    } catch (error) {
      if (attempt === attempts - 1) {
        const reason = error instanceof Error ? error.message : 'réponse inconnue'
        throw new Error(`llama.cpp n’est pas devenu disponible : ${reason}`)
      }
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  throw new Error('llama.cpp n’est pas devenu disponible dans le délai prévu.')
}

export async function stopLlamaServer(runner: CommandRunner = runCommand): Promise<void> {
  const stopped = await runner('docker', ['stop', LLAMA_CONTAINER_NAME], { timeoutMs: 60_000 })
  if (stopped.exitCode !== 0 && !/no such (?:object|container)/i.test(`${stopped.stderr}\n${stopped.stdout}`)) {
    throw new Error(`Le conteneur llama.cpp n’a pas pu s’arrêter. ${detail(stopped)}`.trim())
  }
}

export async function deleteLlamaModelCache(
  modelArtifact: string,
  runner: CommandRunner = runCommand
): Promise<void> {
  const repository = modelArtifact.split(':', 1)[0] ?? ''
  const match = /^([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)$/.exec(repository)
  if (!match) throw new Error('L’artefact GGUF à supprimer est invalide.')

  const volume = await runner('docker', ['volume', 'inspect', LLAMA_MODELS_VOLUME], { timeoutMs: 15_000 })
  if (volume.exitCode !== 0) return

  let image: string | null = null
  for (const candidate of Object.values(LLAMA_IMAGES)) {
    const inspected = await runner('docker', ['image', 'inspect', candidate], { timeoutMs: 15_000 })
    if (inspected.exitCode === 0) {
      image = candidate
      break
    }
  }
  if (!image) throw new Error('Le cache GGUF existe, mais aucune image llama.cpp locale ne permet de le nettoyer.')

  const cacheDirectory = `${LLAMA_CACHE_PATH}/hub/models--${match[1]}--${match[2]}`
  const removed = await runner('docker', [
    'run', '--rm', '--entrypoint', '/bin/sh',
    '--volume', `${LLAMA_MODELS_VOLUME}:${LLAMA_CACHE_PATH}`,
    image, '-c', `rm -rf -- '${cacheDirectory}'`
  ], { timeoutMs: 120_000 })
  if (removed.exitCode !== 0 || removed.timedOut) {
    throw new Error(`Le cache GGUF n’a pas pu être supprimé. ${detail(removed)}`.trim())
  }
}
