import type { ChatMessage } from '../shared/contracts'

export type InferenceToolCall = {
  id?: string
  function: {
    name: string
    arguments: Record<string, unknown>
  }
}

export type InferenceMessage = ChatMessage & {
  tool_calls?: InferenceToolCall[]
  tool_name?: string
  tool_call_id?: string
}

export type InferenceChatResult = {
  content: string
  toolCalls: InferenceToolCall[]
}

export type InferencePerformanceMetrics = {
  model: string
  firstResponseMs: number
  wallMs: number
  tokensPerSecond: number | null
}

export type InferenceProvider = {
  id: string
  streamChat: (
    model: string,
    messages: InferenceMessage[],
    onContent: (content: string) => void,
    signal?: AbortSignal,
    fetcher?: typeof fetch,
    tools?: readonly unknown[],
    idleTimeoutMs?: number,
    numPredict?: number,
    numCtx?: number,
    onDiagnostics?: (message: string) => void,
    onMetrics?: (metrics: InferencePerformanceMetrics) => void
  ) => Promise<InferenceChatResult>
}

export class InferenceIdleTimeoutError extends Error {
  constructor() {
    super('Le modèle ne produit plus de réponse depuis deux minutes. Réessayez ou choisissez un modèle plus léger.')
    this.name = 'InferenceIdleTimeoutError'
  }
}
