import type { InferenceBenchmarkMetrics } from '../shared/contracts'
import type { InferencePerformanceMetrics, InferenceProvider, InferenceToolCall } from './inference'

const PROBE_TOOL = {
  type: 'function',
  function: {
    name: 'stellan_probe',
    description: 'Valide le support des outils du moteur local.',
    parameters: {
      type: 'object',
      properties: { value: { type: 'string', enum: ['ok'] } },
      required: ['value'],
      additionalProperties: false
    }
  }
} as const

export type ProviderQualification = {
  metrics: InferenceBenchmarkMetrics
}

function aggregateMetrics(metrics: InferencePerformanceMetrics[]): InferenceBenchmarkMetrics {
  const tokens = metrics.map((entry) => entry.tokensPerSecond).filter((value): value is number => value !== null)
  return {
    firstResponseMs: Math.round(metrics.reduce((total, entry) => total + entry.firstResponseMs, 0) / metrics.length),
    wallMs: Math.round(metrics.reduce((total, entry) => total + entry.wallMs, 0)),
    tokensPerSecond: tokens.length
      ? Math.round((tokens.reduce((total, value) => total + value, 0) / tokens.length) * 10) / 10
      : null
  }
}

export async function qualifyInferenceProvider(
  provider: InferenceProvider,
  model: string,
  signal?: AbortSignal,
  onDiagnostics?: (message: string) => void
): Promise<ProviderQualification> {
  const metrics: InferencePerformanceMetrics[] = []
  const common = {
    signal,
    idleTimeoutMs: 120_000,
    numPredict: 64,
    numCtx: 4_096,
    onMetrics: (entry: InferencePerformanceMetrics) => metrics.push(entry)
  }
  const text = await provider.streamChat(
    model,
    [{ role: 'system', content: 'Test technique. Réponds uniquement STELLAN_OK.' }, { role: 'user', content: 'Réponds maintenant.' }],
    () => undefined,
    common.signal,
    undefined,
    undefined,
    common.idleTimeoutMs,
    common.numPredict,
    common.numCtx,
    onDiagnostics,
    common.onMetrics
  )
  if (!text.content.toUpperCase().includes('STELLAN_OK')) {
    throw new Error('Le moteur n’a pas respecté la réponse texte de contrôle.')
  }

  const tool = await provider.streamChat(
    model,
    [
      { role: 'system', content: 'Appelle obligatoirement l’outil demandé, sans répondre en texte.' },
      { role: 'user', content: 'Appelle stellan_probe avec value="ok".' }
    ],
    () => undefined,
    common.signal,
    undefined,
    [PROBE_TOOL],
    common.idleTimeoutMs,
    common.numPredict,
    common.numCtx,
    onDiagnostics,
    common.onMetrics
  )
  const call = tool.toolCalls.find((candidate) => candidate.function.name === 'stellan_probe')
  if (!call || call.function.arguments.value !== 'ok') {
    throw new Error('Le moteur n’a pas produit l’appel d’outil structuré attendu.')
  }

  const correlatedCall: InferenceToolCall = { ...call, id: call.id ?? 'stellan-probe-call' }
  const roundTrip = await provider.streamChat(
    model,
    [
      { role: 'system', content: 'Après le résultat de l’outil, réponds uniquement TOOL_RESULT_OK.' },
      { role: 'assistant', content: tool.content, tool_calls: [correlatedCall] },
      { role: 'tool', content: '{"accepted":true}', tool_name: 'stellan_probe', tool_call_id: correlatedCall.id }
    ],
    () => undefined,
    common.signal,
    undefined,
    [PROBE_TOOL],
    common.idleTimeoutMs,
    common.numPredict,
    common.numCtx,
    onDiagnostics,
    common.onMetrics
  )
  if (!roundTrip.content.toUpperCase().includes('TOOL_RESULT_OK')) {
    throw new Error('Le moteur n’a pas correctement relié le résultat à son appel d’outil.')
  }
  if (metrics.length !== 3) throw new Error('Le moteur n’a pas fourni toutes les mesures attendues.')
  return { metrics: aggregateMetrics(metrics) }
}

export function compareInferenceMetrics(
  llamaCpp: InferenceBenchmarkMetrics,
  ollama: InferenceBenchmarkMetrics | null
): 'llama.cpp' | 'ollama' | 'equivalent' {
  if (!ollama) return 'llama.cpp'
  if (llamaCpp.wallMs <= ollama.wallMs * 0.9) return 'llama.cpp'
  if (ollama.wallMs <= llamaCpp.wallMs * 0.9) return 'ollama'
  return 'equivalent'
}
