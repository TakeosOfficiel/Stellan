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
  error: z.string().optional()
})

const showResponseSchema = z.object({
  capabilities: z.array(z.string()).default([])
})

const OLLAMA_URLS = ['http://127.0.0.1:11435', 'http://localhost:11435'] as const
let activeOllamaUrl: string = OLLAMA_URLS[0]
const toolSupportByModel = new Map<string, boolean>()

export function configureOllamaUrl(url: string | null): void {
  activeOllamaUrl = url ?? OLLAMA_URLS[0]
  toolSupportByModel.clear()
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

export async function modelSupportsTools(
  model: string,
  fetcher: typeof fetch = fetch
): Promise<boolean> {
  if (fetcher === fetch && toolSupportByModel.has(model)) return toolSupportByModel.get(model) as boolean
  const response = await fetcher(`${activeOllamaUrl}/api/show`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model }),
    signal: AbortSignal.timeout(5_000)
  })
  if (!response.ok) {
    throw new Error(`Ollama n’a pas pu vérifier les capacités du modèle (statut ${response.status}).`)
  }
  const supportsTools = showResponseSchema.parse(await response.json()).capabilities.includes('tools')
  if (fetcher === fetch) toolSupportByModel.set(model, supportsTools)
  return supportsTools
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

export async function streamOllamaChat(
  model: string,
  messages: OllamaMessage[],
  onContent: (content: string) => void,
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch,
  tools?: readonly unknown[]
): Promise<OllamaChatResult> {
  let content = ''
  const toolCalls: OllamaToolCall[] = []
  let requestMessages = messages
  const responseTimeout = AbortSignal.timeout(120_000)
  const requestSignal = signal ? AbortSignal.any([signal, responseTimeout]) : responseTimeout

  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await fetcher(`${activeOllamaUrl}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, messages: requestMessages, stream: true, think: false, ...(tools ? { tools } : {}) }),
      signal: requestSignal
    })

    if (!response.ok || !response.body) {
      throw new Error(`Ollama n'a pas pu démarrer la réponse (statut ${response.status}).`)
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let completed = false

    while (true) {
      const { done, value } = await reader.read()
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
        if (chunk.done === true) completed = true
      }

      if (done) break
    }

      if (completed) return { content, toolCalls }
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
    if (responseTimeout.aborted && !signal?.aborted) {
      throw new Error('Le modèle n’a pas répondu sous deux minutes. Réessayez ou choisissez un modèle plus léger.')
    }
    throw error
  }

  throw new Error('Le flux de réponse Ollama a été interrompu avant sa fin.')
}
