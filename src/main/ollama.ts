import { z } from 'zod'
import type { OllamaStatus } from '../shared/contracts'

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
