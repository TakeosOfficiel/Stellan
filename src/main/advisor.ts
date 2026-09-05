import { z } from 'zod'
import type { InferenceMessage, InferenceProvider, InferenceToolCall } from './inference'
import { ollamaInferenceProvider } from './ollama'
import { compactConversation } from './agent'

export type AdvisorProjectTools = {
  listFiles: (path?: string) => Promise<string[]>
  readFile: (path: string) => Promise<string>
  search: (query: string, path?: string) => Promise<Array<{ path: string; line: number; column: number; text: string }>>
  gitStatus: () => Promise<string>
  gitDiff: (staged?: boolean) => Promise<string>
}

export type AdvisorTraceEntry = {
  tool: string
  label: string
  input: Record<string, unknown>
  status: 'done' | 'error'
  summary: string
}

export type AdvisorResult = {
  model: string
  advice: string
  trace: AdvisorTraceEntry[]
}

export type AdvisorOptions = {
  model: string
  inferenceProvider?: InferenceProvider
  question: string
  project: AdvisorProjectTools
  signal: AbortSignal
  isGitRepository: boolean
  fetcher?: typeof fetch
  onProgress?: (detail: string) => void
  onInferenceLog?: (message: string) => void
}

const MAX_INVESTIGATION_ROUNDS = 6
const MAX_TOOL_CALLS = 12
const MAX_TOOL_RESULT_CHARACTERS = 16_000

const ADVISOR_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'list_files',
      description: 'Liste les fichiers du projet ou d’un sous-dossier pour en comprendre la structure.',
      parameters: { type: 'object', properties: { path: { type: 'string' } } }
    }
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Lit un fichier texte du projet, en entier ou sur une plage de lignes.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          startLine: { type: 'integer', minimum: 1 },
          endLine: { type: 'integer', minimum: 1 }
        },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'search_files',
      description: 'Recherche un texte exact dans le projet et retourne les fichiers et lignes correspondants.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          path: { type: 'string' }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'git_status',
      description: 'Consulte l’état Git du projet sans le modifier.',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'git_diff',
      description: 'Consulte les changements Git sans les modifier. Utilise staged=false pour les changements non indexés et staged=true pour les changements indexés.',
      parameters: { type: 'object', properties: { staged: { type: 'boolean' } } }
    }
  }
] as const

const optionalPathSchema = z.object({ path: z.string().trim().min(1).max(2_000).optional() })
const readFileSchema = z.object({
  path: z.string().trim().min(1).max(2_000),
  startLine: z.number().int().min(1).optional(),
  endLine: z.number().int().min(1).optional()
}).refine(({ startLine, endLine }) => !startLine || !endLine || endLine >= startLine, {
  message: 'endLine doit être supérieur ou égal à startLine.'
})
const searchSchema = z.object({
  query: z.string().trim().min(1).max(1_000),
  path: z.string().trim().min(1).max(2_000).optional()
})
const gitDiffSchema = z.object({ staged: z.boolean().default(false) })

function compactToolResult(result: unknown): string {
  const serialized = typeof result === 'string' ? result : JSON.stringify(result)
  if (serialized.length <= MAX_TOOL_RESULT_CHARACTERS) return serialized
  return `${serialized.slice(0, MAX_TOOL_RESULT_CHARACTERS)}\n… résultat tronqué (${serialized.length} caractères au total)`
}

function lineCount(value: string): number {
  return value ? value.split(/\r?\n/).filter(Boolean).length : 0
}

function progressLabel(tool: string, input: Record<string, unknown>): string {
  if (tool === 'read_file') return `Conseiller · lecture de ${String(input.path ?? 'fichier')}`
  if (tool === 'search_files') return `Conseiller · recherche de « ${String(input.query ?? '')} »`
  if (tool === 'list_files') return `Conseiller · exploration de ${String(input.path ?? 'la structure')}`
  if (tool === 'git_status') return 'Conseiller · vérification de l’état Git'
  if (tool === 'git_diff') return input.staged === true
    ? 'Conseiller · lecture des changements Git indexés'
    : 'Conseiller · lecture des changements Git'
  return `Conseiller · outil refusé (${tool})`
}

function safeTraceInput(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    ['path', 'query', 'startLine', 'endLine', 'staged']
      .filter((key) => ['string', 'number', 'boolean'].includes(typeof input[key]))
      .map((key) => [key, typeof input[key] === 'string' ? String(input[key]).slice(0, 300) : input[key]])
  )
}

async function executeAdvisorTool(
  call: InferenceToolCall,
  options: AdvisorOptions
): Promise<{ content: string; trace: AdvisorTraceEntry }> {
  const tool = call.function.name
  const input = call.function.arguments
  options.onProgress?.(progressLabel(tool, input))

  try {
    if (tool === 'list_files') {
      const { path } = optionalPathSchema.parse(input)
      const files = await options.project.listFiles(path)
      return {
        content: compactToolResult(files),
        trace: {
          tool,
          label: path ? `Structure de ${path}` : 'Structure du projet',
          input: path ? { path } : {},
          status: 'done',
          summary: `${files.length} fichier${files.length > 1 ? 's' : ''} trouvé${files.length > 1 ? 's' : ''}.`
        }
      }
    }

    if (tool === 'read_file') {
      const { path, startLine, endLine } = readFileSchema.parse(input)
      const content = await options.project.readFile(path)
      const lines = content.split(/\r?\n/)
      const from = startLine ?? 1
      const to = Math.min(endLine ?? lines.length, lines.length)
      const excerpt = lines.slice(from - 1, to).join('\n')
      const range = startLine || endLine ? `, lignes ${from}–${to}` : ''
      return {
        content: compactToolResult(excerpt),
        trace: {
          tool,
          label: `Lecture de ${path}`,
          input: { path, ...(startLine ? { startLine } : {}), ...(endLine ? { endLine } : {}) },
          status: 'done',
          summary: `${excerpt.length} caractères consultés${range}.`
        }
      }
    }

    if (tool === 'search_files') {
      const { query, path } = searchSchema.parse(input)
      const matches = await options.project.search(query, path)
      return {
        content: compactToolResult(matches),
        trace: {
          tool,
          label: `Recherche de « ${query} »`,
          input: { query, ...(path ? { path } : {}) },
          status: 'done',
          summary: `${matches.length} résultat${matches.length > 1 ? 's' : ''}${path ? ` dans ${path}` : ''}.`
        }
      }
    }

    if (tool === 'git_status' || tool === 'git_diff') {
      if (!options.isGitRepository) throw new Error('Ce projet n’utilise pas Git.')
      const staged = tool === 'git_diff' ? gitDiffSchema.parse(input).staged : false
      const output = tool === 'git_status'
        ? await options.project.gitStatus()
        : await options.project.gitDiff(staged)
      return {
        content: compactToolResult(output || '(aucun changement)'),
        trace: {
          tool,
          label: tool === 'git_status' ? 'État Git' : staged ? 'Changements Git indexés' : 'Changements Git',
          input: tool === 'git_diff' ? { staged } : {},
          status: 'done',
          summary: output
            ? `${lineCount(output)} ligne${lineCount(output) > 1 ? 's' : ''} consultée${lineCount(output) > 1 ? 's' : ''}.`
            : 'Aucun changement détecté.'
        }
      }
    }

    throw new Error(`L’outil ${tool} n’est pas autorisé en lecture seule.`)
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'L’outil a échoué.'
    return {
      content: `Outil indisponible : ${reason}`,
      trace: {
        tool,
        label: `Action refusée · ${tool}`,
        input: safeTraceInput(input),
        status: 'error',
        summary: reason
      }
    }
  }
}

export async function runAdvisor(options: AdvisorOptions): Promise<AdvisorResult> {
  const trace: AdvisorTraceEntry[] = []
  const conversation: InferenceMessage[] = [
    {
      role: 'system',
      content: [
        'Tu es le Conseiller expert de Stellan, un second avis technique indépendant en lecture seule.',
        'Enquête dans le projet avec les outils fournis avant de conclure. Consulte les fichiers réellement pertinents. Si la question concerne les changements en cours, commence par git_status puis inspecte les diff non indexés et indexés qui existent.',
        'Tu ne peux ni écrire, ni supprimer, ni exécuter de commande, ni déléguer. N’invente jamais une inspection ou un résultat.',
        'Quand tu disposes de suffisamment de preuves, réponds sans appeler d’outil.',
        'Ton avis final doit être directement exploitable : conclusion en premier, preuves avec chemins de fichiers, risques ou limites, puis recommandation concrète.',
        'Ne révèle pas de raisonnement privé. Présente uniquement les constats vérifiables et la recommandation.',
        `Question à examiner :\n${options.question}`
      ].join('\n')
    },
    { role: 'user', content: 'Commence ton enquête puis fournis ton avis dès que les preuves sont suffisantes.' }
  ]

  let toolCallCount = 0
  for (let round = 0; round < MAX_INVESTIGATION_ROUNDS; round += 1) {
    const result = await (options.inferenceProvider ?? ollamaInferenceProvider).streamChat(
      options.model,
      compactConversation(conversation),
      () => undefined,
      options.signal,
      options.fetcher ?? fetch,
      ADVISOR_TOOLS,
      120_000,
      1_200,
      undefined,
      options.onInferenceLog
    )

    if (result.toolCalls.length === 0) {
      return {
        model: options.model,
        advice: result.content.trim() || 'Le conseiller n’a pas produit d’avis exploitable.',
        trace
      }
    }

    const normalizedToolCalls = result.toolCalls.map((call, callIndex) => ({
      ...call,
      id: call.id ?? `advisor-${round}:${callIndex}`
    }))
    conversation.push({ role: 'assistant', content: result.content, tool_calls: normalizedToolCalls })
    for (const call of normalizedToolCalls) {
      if (toolCallCount >= MAX_TOOL_CALLS) {
        conversation.push({
          role: 'tool',
          tool_name: call.function.name,
          tool_call_id: call.id,
          content: 'Limite d’investigation atteinte. Produis maintenant ton avis final avec les preuves déjà recueillies.'
        })
        continue
      }
      toolCallCount += 1
      const executed = await executeAdvisorTool(call, options)
      trace.push(executed.trace)
      conversation.push({
        role: 'tool',
        tool_name: call.function.name,
        tool_call_id: call.id,
        content: executed.content
      })
    }
  }

  options.onProgress?.('Conseiller · synthèse de l’avis')
  conversation.push({
    role: 'user',
    content: 'L’investigation est terminée. Produis maintenant l’avis final demandé avec les preuves recueillies. N’appelle plus aucun outil.'
  })
  const finalResult = await (options.inferenceProvider ?? ollamaInferenceProvider).streamChat(
    options.model,
    compactConversation(conversation),
    () => undefined,
    options.signal,
    options.fetcher ?? fetch,
    undefined,
    120_000,
    1_200,
    undefined,
    options.onInferenceLog
  )
  return {
    model: options.model,
    advice: finalResult.content.trim() || 'Le conseiller n’a pas produit d’avis exploitable.',
    trace
  }
}
