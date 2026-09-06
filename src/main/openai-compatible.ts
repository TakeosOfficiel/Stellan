import { z } from 'zod'
import {
  InferenceIdleTimeoutError,
  type InferenceMessage,
  type InferencePerformanceMetrics,
  type InferenceProvider,
  type InferenceToolCall
} from './inference'

const streamChunkSchema = z.object({
  choices: z.array(z.object({
    index: z.number().int().nonnegative(),
    delta: z.object({
      content: z.string().nullable().optional(),
      tool_calls: z.array(z.object({
        index: z.number().int().nonnegative(),
        id: z.string().optional(),
        function: z.object({
          name: z.string().optional(),
          arguments: z.string().optional()
        }).optional()
      })).optional()
    }).default({}),
    finish_reason: z.string().nullable().optional()
  })).default([]),
  usage: z.object({
    completion_tokens: z.number().int().nonnegative().optional()
  }).optional(),
  error: z.object({ message: z.string() }).optional()
})

type PendingToolCall = {
  id: string
  name: string
  arguments: string
}

function localBaseUrl(input: string, trustedRuntimeNetwork = false): string {
  const url = new URL(input)
  const hostname = url.hostname.replace(/^\[|\]$/g, '')
  const privateRuntimeAddress = trustedRuntimeNetwork && (
    /^10\./.test(hostname)
    || /^192\.168\./.test(hostname)
    || /^172\.(?:1[6-9]|2\d|3[01])\./.test(hostname)
  )
  if (!['http:', 'https:'].includes(url.protocol)
    || (!['127.0.0.1', 'localhost', '::1'].includes(hostname) && !privateRuntimeAddress)
    || url.username
    || url.password
    || url.search
    || url.hash) {
    throw new Error('Le moteur d’inférence doit utiliser une adresse locale loopback sans identifiants.')
  }
  return url.toString().replace(/\/$/, '')
}

function requestMessages(messages: InferenceMessage[]): unknown[] {
  return messages.map((message, messageIndex) => {
    const content = message.images?.length
      ? [
          { type: 'text', text: message.content },
          ...message.images.map((image) => ({
            type: 'image_url',
            image_url: { url: `data:${image.mimeType};base64,${image.data}` }
          }))
        ]
      : message.content
    if (message.role === 'assistant' && message.tool_calls?.length) {
      return {
        role: message.role,
        content,
        tool_calls: message.tool_calls.map((call, callIndex) => ({
          id: call.id ?? `call-${messageIndex}-${callIndex}`,
          type: 'function',
          function: {
            name: call.function.name,
            arguments: JSON.stringify(call.function.arguments)
          }
        }))
      }
    }
    if (message.role === 'tool') {
      return {
        role: message.role,
        content,
        tool_call_id: message.tool_call_id,
        ...(message.tool_name ? { name: message.tool_name } : {})
      }
    }
    return { role: message.role, content }
  })
}

async function responseErrorDetail(response: Response): Promise<string | null> {
  const body = (await response.text()).trim()
  if (!body) return null
  try {
    const parsed = JSON.parse(body) as { error?: string | { message?: string }; message?: string }
    const detail = typeof parsed.error === 'string'
      ? parsed.error
      : parsed.error?.message ?? parsed.message
    if (detail) return detail.replace(/\s+/g, ' ').trim().slice(0, 500)
  } catch {
    return body.replace(/\s+/g, ' ').slice(0, 500)
  }
  return null
}

function completedToolCalls(pending: Map<number, PendingToolCall>): InferenceToolCall[] {
  return [...pending.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, call]) => {
      let parsed: unknown
      try {
        parsed = JSON.parse(call.arguments || '{}')
      } catch {
        throw new Error(`Le moteur local a produit des arguments JSON invalides pour l’outil ${call.name || 'inconnu'}.`)
      }
      const argumentsRecord = z.record(z.string(), z.unknown()).safeParse(parsed)
      if (!call.name || !argumentsRecord.success) {
        throw new Error('Le moteur local a produit un appel d’outil incomplet.')
      }
      return {
        id: call.id,
        function: { name: call.name, arguments: argumentsRecord.data }
      }
    })
}

export function createLocalOpenAICompatibleProvider(options: {
  id: string
  baseUrl: string
  /** Only for an address discovered from Stellan's private WSL runtime, never user input. */
  trustedRuntimeNetwork?: boolean
}): InferenceProvider {
  const baseUrl = localBaseUrl(options.baseUrl, options.trustedRuntimeNetwork)
  return {
    id: options.id,
    async streamChat(
      model,
      messages,
      onContent,
      signal,
      fetcher = fetch,
      tools,
      idleTimeoutMs = 120_000,
      numPredict,
      _numCtx,
      onDiagnostics,
      onMetrics
    ) {
      const idleController = new AbortController()
      let idleTimer: ReturnType<typeof setTimeout> | null = null
      const touch = (): void => {
        if (idleTimer) clearTimeout(idleTimer)
        idleTimer = setTimeout(() => idleController.abort(), idleTimeoutMs)
      }
      const requestSignal = signal
        ? AbortSignal.any([signal, idleController.signal])
        : idleController.signal
      const startedAt = performance.now()
      let firstResponseAt: number | null = null
      let completionTokens: number | null = null
      let content = ''
      const pendingToolCalls = new Map<number, PendingToolCall>()
      touch()
      try {
        const response = await fetcher(`${baseUrl}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model,
            messages: requestMessages(messages),
            stream: true,
            stream_options: { include_usage: true },
            ...(numPredict === undefined ? {} : { max_tokens: numPredict }),
            ...(tools ? { tools } : {})
          }),
          signal: requestSignal
        })
        touch()
        if (!response.ok || !response.body) {
          const detail = await responseErrorDetail(response)
          throw new Error(`Le moteur local ${options.id} n’a pas pu démarrer la réponse (statut ${response.status})${detail ? ` : ${detail}` : '.'}`)
        }

        const reader = response.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        let completed = false
        while (true) {
          const { done, value } = await reader.read()
          if (!done && value) touch()
          buffer += decoder.decode(value, { stream: !done })
          const events = buffer.split(/\r?\n\r?\n/)
          buffer = done ? '' : (events.pop() ?? '')
          for (const event of events) {
            const data = event.split(/\r?\n/)
              .filter((line) => line.startsWith('data:'))
              .map((line) => line.slice(5).trim())
              .join('\n')
            if (!data) continue
            if (data === '[DONE]') {
              completed = true
              continue
            }
            const chunk = streamChunkSchema.parse(JSON.parse(data))
            if (chunk.error) throw new Error(chunk.error.message)
            if (chunk.usage?.completion_tokens !== undefined) {
              completionTokens = chunk.usage.completion_tokens
            }
            for (const choice of chunk.choices) {
              const delta = choice.delta
              if (delta.content) {
                if (firstResponseAt === null) firstResponseAt = performance.now()
                content += delta.content
                onContent(delta.content)
              }
              for (const callChunk of delta.tool_calls ?? []) {
                if (firstResponseAt === null) firstResponseAt = performance.now()
                const existing = pendingToolCalls.get(callChunk.index) ?? {
                  id: callChunk.id ?? `call-${callChunk.index}`,
                  name: '',
                  arguments: ''
                }
                if (callChunk.id) existing.id = callChunk.id
                if (callChunk.function?.name) existing.name += callChunk.function.name
                if (callChunk.function?.arguments) existing.arguments += callChunk.function.arguments
                pendingToolCalls.set(callChunk.index, existing)
              }
              if (choice.finish_reason) completed = true
            }
          }
          if (done) break
        }
        if (!completed) throw new Error(`Le flux du moteur local ${options.id} a été interrompu avant sa fin.`)

        const wallMs = performance.now() - startedAt
        const tokensPerSecond = completionTokens !== null && wallMs > 0
          ? completionTokens / (wallMs / 1_000)
          : null
        const metrics: InferencePerformanceMetrics = {
          model,
          firstResponseMs: (firstResponseAt ?? performance.now()) - startedAt,
          wallMs,
          tokensPerSecond
        }
        onMetrics?.(metrics)
        onDiagnostics?.(
          `inference.metrics provider=${options.id} model=${model} wallMs=${wallMs.toFixed(1)} firstResponseMs=${metrics.firstResponseMs.toFixed(1)} generatedTokens=${completionTokens ?? 'unknown'} tokensPerSecond=${tokensPerSecond?.toFixed(1) ?? 'unknown'}`
        )
        return { content, toolCalls: completedToolCalls(pendingToolCalls) }
      } catch (error) {
        if (idleController.signal.aborted && !signal?.aborted) throw new InferenceIdleTimeoutError()
        throw error
      } finally {
        if (idleTimer) clearTimeout(idleTimer)
      }
    }
  }
}

/** TabbyAPI exposes the same local OpenAI protocol. It remains opt-in because
 * its maintainers explicitly describe the server as experimental. */
export function createTabbyApiProvider(baseUrl = 'http://127.0.0.1:5000'): InferenceProvider {
  return createLocalOpenAICompatibleProvider({ id: 'tabby-api', baseUrl })
}
