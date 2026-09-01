import { z } from 'zod'
import type {
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

const OLLAMA_URL = 'http://127.0.0.1:11434'

export async function getOllamaStatus(
  fetcher: typeof fetch = fetch
): Promise<OllamaStatus> {
  try {
    const options = { signal: AbortSignal.timeout(2_000) }
    const [tagsResponse, versionResponse] = await Promise.all([
      fetcher(`${OLLAMA_URL}/api/tags`, options),
      fetcher(`${OLLAMA_URL}/api/version`, options)
    ])

    if (!tagsResponse.ok) {
      return {
        available: false,
        reason: `Ollama a répondu avec le statut ${tagsResponse.status}.`
      }
    }

    const tags = tagsResponseSchema.parse(await tagsResponse.json())
    const version = versionResponse.ok
      ? versionResponseSchema.safeParse(await versionResponse.json())
      : null

    return {
      available: true,
      version: version?.success ? version.data.version : null,
      models: tags.models.map((model) => ({
        name: model.name,
        size: model.size,
        modifiedAt: model.modified_at
      }))
    }
  } catch (error) {
    const reason =
      error instanceof Error && error.name === 'TimeoutError'
        ? "Ollama n'a pas répondu dans le délai prévu."
        : "Ollama n'est pas accessible sur cette machine."

    return { available: false, reason }
  }
}

export async function pullOllamaModel(
  model: string,
  onProgress: (progress: ModelPullProgress) => void,
  fetcher: typeof fetch = fetch
): Promise<ModelPullResult> {
  try {
    const response = await fetcher(`${OLLAMA_URL}/api/pull`, {
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
