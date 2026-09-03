import path from 'node:path'
import { z } from 'zod'
import type { ChatMessage } from '../shared/contracts'
import {
  OllamaIdleTimeoutError,
  streamOllamaChat,
  type OllamaMessage,
  type OllamaToolCall
} from './ollama'
import { ProjectTools } from './project-tools'

export type AgentProjectTools = Pick<ProjectTools,
  'listFiles' | 'readFile' | 'search' | 'writeFile' | 'deleteFile' | 'gitStatus' | 'gitDiff' | 'runCommand'
>

const TOOL_DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'list_files',
      description: 'Liste les fichiers du projet ou d’un sous-dossier.',
      parameters: { type: 'object', properties: { path: { type: 'string' } } }
    }
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Lit un fichier texte du projet.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'search_files',
      description: 'Recherche du texte dans le projet.',
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
      name: 'write_file',
      description: 'Écrit le contenu complet d’un fichier du projet. Demande une autorisation.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string' }
        },
        required: ['path', 'content']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'delete_file',
      description: 'Supprime un fichier du projet. Utilise cet outil au lieu de rm. Demande une autorisation.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'run_command',
      description: 'Exécute un programme sans shell dans le projet. Demande une autorisation.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string' },
          args: { type: 'array', items: { type: 'string' } }
        },
        required: ['command']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'git_status',
      description: 'Retourne le statut Git court du projet.',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'git_diff',
      description: 'Retourne le diff Git actuel.',
      parameters: { type: 'object', properties: {} }
    }
  }
] as const

const CREATE_WORKERS_TOOL = {
  type: 'function',
  function: {
    name: 'create_workers',
    description: 'Découpe une tâche en 2 à 4 workers locaux exécutés automatiquement en parallèle. Chaque worker doit recevoir une liste de fichiers exclusive pour éviter les conflits.',
    parameters: {
      type: 'object',
      properties: {
        tasks: {
          type: 'array',
          minItems: 2,
          maxItems: 4,
          items: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              instructions: { type: 'string' },
              files: { type: 'array', items: { type: 'string' }, minItems: 1 }
            },
            required: ['title', 'instructions', 'files']
          }
        }
      },
      required: ['tasks']
    }
  }
} as const

const pathSchema = z.object({ path: z.string().min(1).max(2_000) })
const optionalPathSchema = z.object({ path: z.string().min(1).max(2_000).optional() })
const searchSchema = z.object({
  query: z.string().min(1).max(1_000),
  path: z.string().min(1).max(2_000).optional()
})
const writeSchema = z.object({
  path: z.string().min(1).max(2_000),
  content: z.string().max(2_000_000)
})
const commandSchema = z.object({
  command: z.string().min(1).max(500).refine((value) => !/[\u0000-\u001f\u007f]/.test(value)),
  args: z.array(z.string().max(10_000).refine((value) => !/[\u0000-\u001f\u007f]/.test(value))).max(100).default([])
})
export function normalizeWorkerPath(
  value: string,
  platform: NodeJS.Platform = process.platform
): string {
  const normalized = path.posix.normalize(value.replaceAll('\\', '/').replace(/^\.\//, ''))
  if (platform !== 'win32') return normalized
  return normalized
    .split('/')
    .map((segment) => segment.replace(/[ .]+$/g, '').toLowerCase())
    .join('/')
}

const workerTasksSchema = z.object({
  tasks: z.array(z.object({
    title: z.string().trim().min(1).max(80),
    instructions: z.string().trim().min(1).max(4_000),
    files: z.array(z.string().min(1).max(2_000)).min(1).max(50)
  })).min(2).max(4)
}).superRefine(({ tasks }, context) => {
  const owners = new Map<string, number>()
  tasks.forEach((task, taskIndex) => task.files.forEach((file) => {
    const normalized = normalizeWorkerPath(file)
    const owner = owners.get(normalized)
    if (owner !== undefined) {
      context.addIssue({ code: 'custom', message: `Le fichier ${normalized} appartient déjà au worker ${owner + 1}.` })
    } else owners.set(normalized, taskIndex)
  }))
})

export type WorkerTask = z.infer<typeof workerTasksSchema>['tasks'][number]
export type WorkerResult = { title: string; summary: string; files: string[] }

type ToolStatus = 'running' | 'done' | 'denied' | 'error'

export type AgentToolLifecycleEvent =
  | {
      type: 'started'
      callId: string
      step: number
      callIndex: number
      tool: string
      arguments: Record<string, unknown>
      assistantContent: string
    }
  | {
      type: 'finished'
      callId: string
      tool: string
      status: Exclude<ToolStatus, 'running'>
      result: string
    }

export const MAX_CONVERSATION_CHARACTERS = 60_000
const MAX_TOOL_ARGUMENT_CHARACTERS = 10_000
const MAX_SYSTEM_CHARACTERS = 10_000

export type CodingAgentOptions = {
  model: string
  messages: ChatMessage[]
  project: AgentProjectTools
  signal: AbortSignal
  onContent: (content: string) => void
  onTool: (tool: string, status: ToolStatus) => void
  onToolEvent?: (event: AgentToolLifecycleEvent) => Promise<void>
  authorize: (tool: string, summary: string) => Promise<boolean>
  spawnWorkers?: (tasks: WorkerTask[]) => Promise<WorkerResult[]>
  writeScope?: ReadonlySet<string>
  allowRunCommand?: boolean
  isGitRepository?: boolean
  modelIdleTimeoutMs?: number
  runCommand?: (
    command: string,
    args: readonly string[],
    options: { timeoutMs: number; signal: AbortSignal }
  ) => Promise<unknown>
}

function compactResult(value: unknown): string {
  const result = typeof value === 'string' ? value : JSON.stringify(value)
  return result.length > 20_000 ? `${result.slice(0, 20_000)}\n… résultat tronqué` : result
}

function contextSize(messages: OllamaMessage[]): number {
  return JSON.stringify(messages).length
}

function compactToolArguments(message: OllamaMessage): OllamaMessage {
  if (!message.tool_calls) return { ...message }
  return {
    ...message,
    tool_calls: message.tool_calls.map((call) => {
      const serialized = JSON.stringify(call.function.arguments)
      return serialized.length <= MAX_TOOL_ARGUMENT_CHARACTERS
        ? call
        : {
            function: {
              name: call.function.name,
              arguments: { omitted: `Arguments tronqués (${serialized.length} caractères).` }
            }
          }
    })
  }
}

function fitNewestGroup(group: OllamaMessage[], available: number): OllamaMessage[] {
  const fitted = group.map(compactToolArguments)
  let excess = contextSize(fitted) - available
  for (const message of fitted) {
    if (excess <= 0) break
    const removable = Math.max(0, message.content.length - 80)
    const removed = Math.min(removable, excess)
    if (removed > 0) {
      message.content = `[début tronqué]\n${message.content.slice(removed + 17)}`
      excess = contextSize(fitted) - available
    }
  }
  return contextSize(fitted) <= available ? fitted : []
}

export function compactConversation(messages: OllamaMessage[]): OllamaMessage[] {
  const first = messages[0]
  const system = first?.role === 'system'
    ? {
        ...first,
        content: first.content.length > MAX_SYSTEM_CHARACTERS
          ? `${first.content.slice(0, MAX_SYSTEM_CHARACTERS)}\n[fin tronquée]`
          : first.content
      }
    : undefined
  const groups: OllamaMessage[][] = []

  for (const message of messages.slice(system ? 1 : 0)) {
    const current = groups.at(-1)
    if (message.role === 'tool' && current?.[0]?.tool_calls?.length) current.push(message)
    else groups.push([message])
  }

  const selected: OllamaMessage[][] = []
  let characters = contextSize(system ? [system] : [])
  for (let index = groups.length - 1; index >= 0; index -= 1) {
    const group = (groups[index] ?? []).map(compactToolArguments)
    const groupCharacters = contextSize(group)
    if (characters + groupCharacters > MAX_CONVERSATION_CHARACTERS) {
      if (selected.length === 0) {
        const fitted = fitNewestGroup(group, MAX_CONVERSATION_CHARACTERS - characters)
        if (fitted.length > 0) selected.unshift(fitted)
      }
      break
    }
    selected.unshift(group)
    characters += groupCharacters
  }

  return [...(system ? [system] : []), ...selected.flat()]
}

async function executeTool(
  call: OllamaToolCall,
  options: CodingAgentOptions
): Promise<{ content: string; status: Exclude<ToolStatus, 'running'> }> {
  const name = call.function.name
  const input = call.function.arguments
  const tools = options.project
  const signal = options.signal

  try {
    if (name === 'list_files') {
      const { path } = optionalPathSchema.parse(input)
      return { content: compactResult(await tools.listFiles(path)), status: 'done' }
    }
    if (name === 'read_file') {
      const { path } = pathSchema.parse(input)
      return { content: compactResult(await tools.readFile(path)), status: 'done' }
    }
    if (name === 'search_files') {
      const { query, path } = searchSchema.parse(input)
      return { content: compactResult(await tools.search(query, path)), status: 'done' }
    }
    if (name === 'git_status') {
      if (options.isGitRepository === false) return { content: 'Ce projet n’utilise pas Git.', status: 'denied' }
      return { content: compactResult(await tools.gitStatus()), status: 'done' }
    }
    if (name === 'git_diff') {
      if (options.isGitRepository === false) return { content: 'Ce projet n’utilise pas Git.', status: 'denied' }
      return { content: compactResult(await tools.gitDiff()), status: 'done' }
    }
    if (name === 'write_file' || name === 'delete_file') {
      const { path, content } = name === 'write_file' ? writeSchema.parse(input) : { ...pathSchema.parse(input), content: null }
      const normalizedPath = normalizeWorkerPath(path)
      if (options.writeScope && !options.writeScope.has(normalizedPath)) {
        return { content: `Ce worker n’est pas autorisé à modifier ${path}.`, status: 'denied' }
      }
      if (!await options.authorize(name, `${name === 'write_file' ? 'Écrire' : 'Supprimer'} ${path}`)) {
        return { content: `L’utilisateur a refusé ${name === 'write_file' ? 'cette écriture' : 'cette suppression'}.`, status: 'denied' }
      }
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
      const result = name === 'write_file'
        ? await tools.writeFile(path, content as string)
        : await tools.deleteFile(path)
      return { content: compactResult(result), status: 'done' }
    }
    if (name === 'run_command') {
      const { command, args } = commandSchema.parse(input)
      if (options.allowRunCommand === false) {
        return { content: 'Les commandes sont réservées au worker coordinateur.', status: 'denied' }
      }
      if (!await options.authorize(name, [command, ...args].join(' '))) {
        return { content: 'L’utilisateur a refusé cette commande.', status: 'denied' }
      }
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
      const result = await (options.runCommand
        ? options.runCommand(command, args, { timeoutMs: 120_000, signal })
        : tools.runCommand(command, args, { timeoutMs: 120_000, signal }))
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
      return { content: compactResult(result), status: 'done' }
    }
    if (name === 'create_workers') {
      if (!options.spawnWorkers) return { content: 'Les workers enfants ne sont pas disponibles ici.', status: 'denied' }
      const { tasks } = workerTasksSchema.parse(input)
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
      return { content: compactResult(await options.spawnWorkers(tasks)), status: 'done' }
    }
    return { content: `Outil inconnu : ${name}`, status: 'error' }
  } catch (error) {
    if (signal.aborted) throw error
    return {
      content: error instanceof Error ? error.message : 'L’outil a échoué.',
      status: 'error'
    }
  }
}

export async function runCodingAgent(options: CodingAgentOptions): Promise<void> {
  const conversation: OllamaMessage[] = [
    {
      role: 'system',
      content: `Tu es un agent de développement local. Inspecte le projet avec les outils avant de modifier. Utilise des chemins relatifs. Quand l’utilisateur demande une modification, effectue-la réellement avec write_file ou delete_file avant de conclure. Utilise delete_file pour supprimer un fichier, jamais rm. Ne crée jamais de commit Git sauf demande explicite de l’utilisateur. Ne prétends jamais avoir modifié un fichier sans résultat d’écriture ou suppression réussi. Lance les tests pertinents après une modification et termine par un résumé concis.${options.isGitRepository === false ? ' Ce projet n’est pas un dépôt Git : n’utilise jamais git_status, git_diff ou une commande git.' : ''}${options.spawnWorkers ? ' Utilise create_workers seulement pour une tâche importante répartie sur au moins 4 fichiers indépendants. Pour 3 fichiers ou moins, travaille directement sans workers enfants. Le coordinateur vérifie ensuite le résultat et lance les tests.' : ''}`
    },
    ...options.messages.filter((message) => message.role !== 'system')
  ]
  const completedWrites = new Set<string>()
  let completedActions = 0
  let failedActions = 0
  let silentRecoveryAttempted = false

  for (let step = 0; step < 12; step += 1) {
    if (options.signal.aborted) throw new DOMException('Aborted', 'AbortError')
    let turnContent = ''
    let result
    try {
      result = await streamOllamaChat(
        options.model,
        compactConversation(conversation),
        (content) => { turnContent += content },
        options.signal,
        fetch,
        options.spawnWorkers
          ? [...TOOL_DEFINITIONS.filter((tool) => options.isGitRepository !== false || !tool.function.name.startsWith('git_')), CREATE_WORKERS_TOOL]
          : TOOL_DEFINITIONS.filter((tool) => options.isGitRepository !== false || !tool.function.name.startsWith('git_')),
        completedWrites.size > 0
          ? Math.min(options.modelIdleTimeoutMs ?? 120_000, 30_000)
          : options.modelIdleTimeoutMs
      )
    } catch (error) {
      if (error instanceof OllamaIdleTimeoutError && completedWrites.size > 0) {
        const files = [...completedWrites]
        options.onContent(`Terminé. J’ai modifié ou supprimé ${files.length} fichier${files.length > 1 ? 's' : ''} : ${files.map((file) => `\`${file}\``).join(', ')}. Le modèle local n’a pas généré de résumé final.`)
        return
      }
      throw error
    }

    if (result.toolCalls.length === 0) {
      if (turnContent) options.onContent(turnContent)
      if (!result.content.trim() && completedActions + failedActions > 0) {
        const files = [...completedWrites]
        if (files.length === 0 && !silentRecoveryAttempted) {
          silentRecoveryAttempted = true
          conversation.push({
            role: 'user',
            content: 'Tu t’es arrêté sans réponse finale et sans modification de fichier confirmée. Reprends maintenant la demande originale. Si elle demande un changement, utilise write_file ou delete_file, puis explique précisément le résultat. Ne prétends pas avoir modifié le projet si aucun de ces outils ne réussit.'
          })
          continue
        }
        const fallback = files.length > 0
          ? `Terminé. J’ai modifié ou supprimé ${files.length} fichier${files.length > 1 ? 's' : ''} : ${files.map((file) => `\`${file}\``).join(', ')}.${failedActions > 0 ? ' Certaines autres actions ont échoué ; consultez les détails ci-dessus.' : ''}`
          : failedActions > 0
            ? 'Je n’ai pas pu terminer toutes les actions demandées. Consultez les détails ci-dessus.'
            : 'Le modèle s’est arrêté sans fournir de réponse finale. Aucune modification de fichier n’a été confirmée.'
        options.onContent(fallback)
      }
      return
    }
    conversation.push({
      role: 'assistant',
      content: result.content,
      tool_calls: result.toolCalls
    })

    for (const [callIndex, call] of result.toolCalls.entries()) {
      const tool = call.function.name
      const callId = `${step}:${callIndex}`
      await options.onToolEvent?.({
        type: 'started',
        callId,
        step,
        callIndex,
        tool,
        arguments: call.function.arguments,
        assistantContent: result.content
      })
      options.onTool(tool, 'running')
      const toolResult = await executeTool(
        call,
        options
      )
      if (toolResult.status === 'done') {
        completedActions += 1
        const path = call.function.arguments.path
        if ((tool === 'write_file' || tool === 'delete_file') && typeof path === 'string') completedWrites.add(path)
      } else {
        failedActions += 1
      }
      await options.onToolEvent?.({
        type: 'finished',
        callId,
        tool,
        status: toolResult.status,
        result: toolResult.content
      })
      options.onTool(tool, toolResult.status)
      conversation.push({
        role: 'tool',
        tool_name: tool,
        content: toolResult.content
      })
    }
  }

  throw new Error('L’agent a atteint sa limite de 12 étapes.')
}
