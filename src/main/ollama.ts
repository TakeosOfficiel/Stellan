import { z } from 'zod'
import type {
  ChatMessage,
  ModelPullProgress,
  ModelPullResult,
  OllamaStatus
} from '../shared/contracts'

const tagsResponseSchema = z.object({
  models: z.array(
    z.object({
      name: z.string(),
      size: z.number().nonnegative(),
      modified_at: z.string()
    })
  )
})

const versionResponseSchema = z.object({
  version: z.string()
})

const pullProgressSchema = z.object({
  status: z.string(),
  completed: z.number().nonnegative().optional(),
  total: z.number().positive().optional(),
  error: z.string().optional()
})

const chatChunkSchema = z.object({
  message: z.object({
    content: z.string().optional(),
    thinking: z.string().optional(),
    tool_calls: z.array(z.object({
      function: z.object({
        name: z.string(),
        arguments: z.record(z.string(), z.unknown())
      })
    })).optional()
  }).optional(),
  done: z.boolean().optional(),
  total_duration: z.number().nonnegative().optional(),
  load_duration: z.number().nonnegative().optional(),
  prompt_eval_count: z.number().nonnegative().optional(),
  prompt_eval_duration: z.number().nonnegative().optional(),
  eval_count: z.number().nonnegative().optional(),
  eval_duration: z.number().nonnegative().optional(),
  error: z.string().optional()
})

const runningModelsSchema = z.object({
  models: z.array(z.object({
    name: z.string().optional(),
    model: z.string().optional(),
    size: z.number().nonnegative().optional(),
    size_vram: z.number().nonnegative().optional(),
    expires_at: z.string().optional()
  })).default([])
})

const showResponseSchema = z.object({
  capabilities: z.array(z.string()).default([])
})

const OLLAMA_URLS = ['http://127.0.0.1:11435', 'http://localhost:11435'] as const
let modelOptions = { num_ctx: 8192, num_predict: 1024 }
let activeOllamaUrl: string = OLLAMA_URLS[0]
const toolSupportByModel = new Map<string, boolean>()
const visionSupportByModel = new Map<string, boolean>()

function modelContextOptions(model: string, numCtx?: number): typeof modelOptions {
  const parameterCount = model.match(/(?:^|[:_-])(\d+(?:\.\d+)?)b(?:$|[_-])/i)?.[1]
  const modelLimit = parameterCount !== undefined && Number(parameterCount) >= 20 ? 8_192 : modelOptions.num_ctx
  return {
    num_ctx: Math.max(1_024, Math.min(modelLimit, numCtx === undefined ? modelOptions.num_ctx : Math.floor(numCtx))),
    num_predict: modelOptions.num_predict
  }
}

export function configureOllamaUrl(url: string | null): void {
  activeOllamaUrl = url ?? OLLAMA_URLS[0]
  toolSupportByModel.clear()
  visionSupportByModel.clear()
}

export function configureOllamaModelOptions(options: { numCtx: number; numPredict: number }): void {
  modelOptions = { num_ctx: options.numCtx, num_predict: options.numPredict }
}

export type OllamaToolCall = {
  function: {
    name: string
    arguments: Record<string, unknown>
  }
}

export type OllamaMessage = ChatMessage & {
  tool_calls?: OllamaToolCall[]
  tool_name?: string
}

export type OllamaChatResult = {
  content: string
  toolCalls: OllamaToolCall[]
}

type OllamaTimings = {
  totalDuration?: number
  loadDuration?: number
  promptEvalCount?: number
  promptEvalDuration?: number
  evalCount?: number
  evalDuration?: number
}

export class OllamaIdleTimeoutError extends Error {
  constructor() {
    super('Le modèle ne produit plus de réponse depuis deux minutes. Réessayez ou choisissez un modèle plus léger.')
    this.name = 'OllamaIdleTimeoutError'
  }
}

function durationMs(nanoseconds: number | undefined): string {
  return nanoseconds === undefined ? 'unknown' : (nanoseconds / 1_000_000).toFixed(1)
}

async function reportRunningModels(
  phase: 'before' | 'after',
  report: ((message: string) => void) | undefined,
  fetcher: typeof fetch,
  signal?: AbortSignal
): Promise<void> {
  if (!report) return
  try {
    const timeoutSignal = AbortSignal.timeout(2_000)
    const response = await fetcher(`${activeOllamaUrl}/api/ps`, {
      signal: signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal
    })
    if (!response.ok) {
      report(`ollama.ps.${phase} unavailable status=${response.status}`)
      return
    }
    const { models } = runningModelsSchema.parse(await response.json())
    const summary = models.length === 0
      ? 'none'
      : models.map((running) => {
          const name = running.name ?? running.model ?? 'unknown'
          return `${name}[sizeBytes=${running.size ?? 'unknown'},vramBytes=${running.size_vram ?? 'unknown'},expiresAt=${running.expires_at ?? 'unknown'}]`
        }).join(',')
    report(`ollama.ps.${phase} models=${summary}`)
  } catch (error) {
    const reason = error instanceof Error ? error.name : 'unknown'
    report(`ollama.ps.${phase} unavailable reason=${reason}`)
  }
}

export async function modelSupportsTools(
  model: string,
  fetcher: typeof fetch = fetch
): Promise<boolean> {
  if (fetcher === fetch && toolSupportByModel.has(model)) return toolSupportByModel.get(model) as boolean
  let response: Response
  try {
    response = await fetcher(`${activeOllamaUrl}/api/show`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model }),
      signal: AbortSignal.timeout(5_000)
    })
  } catch {
    throw new Error("Le moteur local d’Ollama n’est plus joignable. Relancez Stellan pour rétablir la connexion.")
  }
  if (!response.ok) {
    throw new Error(`Ollama n’a pas pu vérifier les capacités du modèle (statut ${response.status}).`)
  }
  const supportsTools = showResponseSchema.parse(await response.json()).capabilities.includes('tools')
  if (fetcher === fetch) toolSupportByModel.set(model, supportsTools)
  return supportsTools
}

export async function modelSupportsVision(
  model: string,
  fetcher: typeof fetch = fetch
): Promise<boolean> {
  if (fetcher === fetch && visionSupportByModel.has(model)) return visionSupportByModel.get(model) as boolean
  const response = await fetcher(`${activeOllamaUrl}/api/show`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model }),
    signal: AbortSignal.timeout(5_000)
  })
  if (!response.ok) {
    throw new Error(`Ollama n’a pas pu vérifier les capacités visuelles du modèle (statut ${response.status}).`)
  }
  const supportsVision = showResponseSchema.parse(await response.json()).capabilities.includes('vision')
  if (fetcher === fetch) visionSupportByModel.set(model, supportsVision)
  return supportsVision
}

export async function getOllamaStatus(
  fetcher: typeof fetch = fetch
): Promise<OllamaStatus> {
  let lastStatus: number | null = null
  let timedOut = false

  for (const url of [...new Set([activeOllamaUrl, ...OLLAMA_URLS])]) {
    try {
      const options = { signal: AbortSignal.timeout(5_000) }
      const tagsResponse = await fetcher(`${url}/api/tags`, options)
      if (!tagsResponse.ok) {
        lastStatus = tagsResponse.status
        continue
      }

      const tags = tagsResponseSchema.parse(await tagsResponse.json())
      let version: string | null = null
      try {
        const versionResponse = await fetcher(`${url}/api/version`, options)
        if (versionResponse.ok) {
          const parsedVersion = versionResponseSchema.safeParse(await versionResponse.json())
          if (parsedVersion.success) version = parsedVersion.data.version
        }
      } catch {
        // Older or starting Ollama versions may expose the model list before their version route.
      }

      if (fetcher === fetch) activeOllamaUrl = url

      return {
        available: true,
        version,
        models: tags.models.map((model) => ({
          name: model.name,
          size: model.size,
          modifiedAt: model.modified_at
        }))
      }
    } catch (error) {
      timedOut ||= error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')
    }
  }

  if (lastStatus !== null) {
    return { available: false, reason: `Ollama a répondu avec le statut ${lastStatus}.` }
  }
  return {
    available: false,
    reason: timedOut
      ? "Le conteneur Ollama n'a pas répondu dans le délai prévu."
      : "Le service isolé d'Ollama ne répond pas. Relancez le runtime privé puis réessayez."
  }
}

export async function getOllamaStatusAt(
  url: string,
  fetcher: typeof fetch = fetch
): Promise<OllamaStatus> {
  try {
    const options = { signal: AbortSignal.timeout(5_000) }
    const tagsResponse = await fetcher(`${url}/api/tags`, options)
    if (!tagsResponse.ok) return { available: false, reason: `Ollama a répondu avec le statut ${tagsResponse.status}.` }
    const tags = tagsResponseSchema.parse(await tagsResponse.json())
    let version: string | null = null
    try {
      const versionResponse = await fetcher(`${url}/api/version`, options)
      if (versionResponse.ok) {
        const parsedVersion = versionResponseSchema.safeParse(await versionResponse.json())
        if (parsedVersion.success) version = parsedVersion.data.version
      }
    } catch {
      // The tags endpoint is sufficient to establish readiness.
    }
    return {
      available: true,
      version,
      models: tags.models.map((model) => ({ name: model.name, size: model.size, modifiedAt: model.modified_at }))
    }
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')
    return {
      available: false,
      reason: timedOut ? "Ollama n'a pas répondu à temps." : "Ollama n'est pas joignable."
    }
  }
}

export async function pullOllamaModel(
  model: string,
  onProgress: (progress: ModelPullProgress) => void,
  fetcher: typeof fetch = fetch
): Promise<ModelPullResult> {
  try {
    const response = await fetcher(`${activeOllamaUrl}/api/pull`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, stream: true })
    })

    if (!response.ok || !response.body) {
      return {
        success: false,
        reason: `Le téléchargement n'a pas démarré (statut ${response.status}).`
      }
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    while (true) {
      const { done, value } = await reader.read()
      buffer += decoder.decode(value, { stream: !done })
      const lines = buffer.split('\n')
      buffer = done ? '' : (lines.pop() ?? '')

      for (const line of lines) {
        if (!line.trim()) continue
        const progress = pullProgressSchema.parse(JSON.parse(line))
        if (progress.error) return { success: false, reason: progress.error }

        const completed = progress.completed ?? null
        const total = progress.total ?? null
        onProgress({
          model,
          status: progress.status,
          completed,
          total,
          percent: completed !== null && total !== null
            ? Math.min(100, Math.round((completed / total) * 100))
            : null
        })
      }

      if (done) break
    }

    return { success: true }
  } catch {
    return {
      success: false,
      reason: "Le téléchargement a échoué. Vérifiez qu'Ollama fonctionne et que le réseau est disponible."
    }
  }
}

export async function warmOllamaModel(
  model: string,
  fetcher: typeof fetch = fetch
): Promise<boolean> {
  try {
    const response = await fetcher(`${activeOllamaUrl}/api/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        prompt: '',
        stream: false,
        keep_alive: -1,
        options: modelContextOptions(model)
      }),
      signal: AbortSignal.timeout(300_000)
    })
    return response.ok
  } catch {
    return false
  }
}

export async function streamOllamaChat(
  model: string,
  messages: OllamaMessage[],
  onContent: (content: string) => void,
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch,
  tools?: readonly unknown[],
  idleTimeoutMs = 120_000,
  numPredict?: number,
  numCtx?: number,
  onDiagnostics?: (message: string) => void
): Promise<OllamaChatResult> {
  let content = ''
  const toolCalls: OllamaToolCall[] = []
  let requestMessages = messages
  let timings: OllamaTimings = {}
  const idleController = new AbortController()
  let idleTimeout: ReturnType<typeof setTimeout> | null = null
  const touch = (): void => {
    if (idleTimeout) clearTimeout(idleTimeout)
    idleTimeout = setTimeout(() => idleController.abort(), idleTimeoutMs)
  }
  const requestSignal = signal ? AbortSignal.any([signal, idleController.signal]) : idleController.signal
  await reportRunningModels('before', onDiagnostics, fetcher, signal)
  const chatStartedAt = performance.now()

  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
    touch()
    const response = await fetcher(`${activeOllamaUrl}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: requestMessages.map(({ images, ...message }) => ({
          ...message,
          ...(images?.length ? { images: images.map((image) => image.data) } : {})
        })),
        stream: true,
        think: false,
        keep_alive: -1,
        options: {
          ...modelContextOptions(model, numCtx),
          ...(numPredict === undefined
            ? {}
            : { num_predict: Math.max(1, Math.min(modelOptions.num_predict, Math.floor(numPredict))) })
        },
        ...(tools ? { tools } : {})
      }),
      signal: requestSignal
    })
    touch()

    if (!response.ok || !response.body) {
      throw new Error(`Ollama n'a pas pu démarrer la réponse (statut ${response.status}).`)
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let completed = false

    while (true) {
      const { done, value } = await reader.read()
      if (!done && value) touch()
      buffer += decoder.decode(value, { stream: !done })
      const lines = buffer.split('\n')
      buffer = done ? '' : (lines.pop() ?? '')

      for (const line of lines) {
        if (!line.trim()) continue
        const chunk = chatChunkSchema.parse(JSON.parse(line))
        if (chunk.error) throw new Error(chunk.error)
        if (chunk.message?.content) {
          content += chunk.message.content
          onContent(chunk.message.content)
        }
        if (chunk.message?.tool_calls) toolCalls.push(...chunk.message.tool_calls)
        if (chunk.done === true) {
          completed = true
          timings = {
            totalDuration: chunk.total_duration,
            loadDuration: chunk.load_duration,
            promptEvalCount: chunk.prompt_eval_count,
            promptEvalDuration: chunk.prompt_eval_duration,
            evalCount: chunk.eval_count,
            evalDuration: chunk.eval_duration
          }
        }
      }

      if (done) break
    }

      if (completed) {
        const generationSeconds = (timings.evalDuration ?? 0) / 1_000_000_000
        const tokensPerSecond = generationSeconds > 0 && timings.evalCount !== undefined
          ? (timings.evalCount / generationSeconds).toFixed(1)
          : 'unknown'
        onDiagnostics?.(
          `ollama.metrics model=${model} wallMs=${(performance.now() - chatStartedAt).toFixed(1)} loadMs=${durationMs(timings.loadDuration)} promptEvalMs=${durationMs(timings.promptEvalDuration)} promptTokens=${timings.promptEvalCount ?? 'unknown'} generationMs=${durationMs(timings.evalDuration)} generatedTokens=${timings.evalCount ?? 'unknown'} tokensPerSecond=${tokensPerSecond} totalMs=${durationMs(timings.totalDuration)}`
        )
        return { content, toolCalls }
      }
      if (attempt === 0 && toolCalls.length === 0) {
        requestMessages = content
          ? [
              ...messages,
              { role: 'assistant', content },
              { role: 'user', content: 'Continue exactement la réponse interrompue, sans répéter le texte déjà écrit.' }
            ]
          : messages
        continue
      }
      throw new Error('Le flux de réponse Ollama a été interrompu avant sa fin.')
    }
  } catch (error) {
    if (idleController.signal.aborted && !signal?.aborted) throw new OllamaIdleTimeoutError()
    if (error instanceof TypeError && /fetch failed/i.test(error.message)) {
      throw new Error("Le moteur local d’Ollama n’est plus joignable. Relancez Stellan pour rétablir la connexion.")
    }
    throw error
  } finally {
    if (idleTimeout) clearTimeout(idleTimeout)
    await reportRunningModels('after', onDiagnostics, fetcher, signal)
  }

  throw new Error('Le flux de réponse Ollama a été interrompu avant sa fin.')
}
