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

const OLLAMA_URLS = ['http://127.0.0.1:11434', 'http://localhost:11434'] as const
let activeOllamaUrl: string = OLLAMA_URLS[0]

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
  const response = await fetcher(`${activeOllamaUrl}/api/show`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model }),
    signal: AbortSignal.timeout(5_000)
  })
  if (!response.ok) {
    throw new Error(`Ollama n’a pas pu vérifier les capacités du modèle (statut ${response.status}).`)
  }
  return showResponseSchema.parse(await response.json()).capabilities.includes('tools')
}

export async function getOllamaStatus(
  fetcher: typeof fetch = fetch
): Promise<OllamaStatus> {
  let lastStatus: number | null = null
  let timedOut = false

  for (const url of OLLAMA_URLS) {
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
      ? "Ollama n'a pas répondu dans le délai prévu. Vérifiez que l'application Ollama est démarrée."
      : "Le service local d'Ollama ne répond pas. Démarrez Ollama puis réessayez."
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
  const response = await fetcher(`${activeOllamaUrl}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, messages, stream: true, think: false, ...(tools ? { tools } : {}) }),
    signal
  })

  if (!response.ok || !response.body) {
    throw new Error(`Ollama n'a pas pu démarrer la réponse (statut ${response.status}).`)
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let content = ''
  const toolCalls: OllamaToolCall[] = []

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
    }

    if (done) break
  }

  return { content, toolCalls }
}
