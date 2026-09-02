import { z } from 'zod'
import type { ChatMessage } from '../shared/contracts'
import {
  streamOllamaChat,
  type OllamaMessage,
  type OllamaToolCall
} from './ollama'
import { ProjectTools } from './project-tools'

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
      status: Exclude<ToolStatus, 'running'>
      result: string
    }

export const MAX_CONVERSATION_CHARACTERS = 60_000
const MAX_TOOL_ARGUMENT_CHARACTERS = 10_000
const MAX_SYSTEM_CHARACTERS = 10_000

export type CodingAgentOptions = {
  model: string
  messages: ChatMessage[]
  project: ProjectTools
  signal: AbortSignal
  onContent: (content: string) => void
  onTool: (tool: string, status: ToolStatus) => void
  onToolEvent?: (event: AgentToolLifecycleEvent) => Promise<void>
  authorize: (tool: string, summary: string) => Promise<boolean>
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
  tools: ProjectTools,
  authorize: CodingAgentOptions['authorize'],
  signal: AbortSignal,
  runCommand: CodingAgentOptions['runCommand']
): Promise<{ content: string; status: Exclude<ToolStatus, 'running'> }> {
  const name = call.function.name
  const input = call.function.arguments

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
      return { content: compactResult(await tools.gitStatus()), status: 'done' }
    }
    if (name === 'git_diff') {
      return { content: compactResult(await tools.gitDiff()), status: 'done' }
    }
    if (name === 'write_file') {
      const { path, content } = writeSchema.parse(input)
      if (!await authorize(name, `Écrire ${path}`)) {
        return { content: 'L’utilisateur a refusé cette écriture.', status: 'denied' }
      }
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
      await tools.writeFile(path, content)
      return { content: `Fichier ${path} écrit.`, status: 'done' }
    }
    if (name === 'run_command') {
      const { command, args } = commandSchema.parse(input)
      if (!await authorize(name, [command, ...args].join(' '))) {
        return { content: 'L’utilisateur a refusé cette commande.', status: 'denied' }
      }
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
      const result = await (runCommand
        ? runCommand(command, args, { timeoutMs: 120_000, signal })
        : tools.runCommand(command, args, { timeoutMs: 120_000, signal }))
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
      return { content: compactResult(result), status: 'done' }
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
      content: 'Tu es un agent de développement local. Inspecte le projet avec les outils avant de modifier. Utilise des chemins relatifs. Lance les tests pertinents après une modification et termine par un résumé concis.'
    },
    ...options.messages.filter((message) => message.role !== 'system')
  ]

  for (let step = 0; step < 12; step += 1) {
    if (options.signal.aborted) throw new DOMException('Aborted', 'AbortError')
    const result = await streamOllamaChat(
      options.model,
      compactConversation(conversation),
      options.onContent,
      options.signal,
      fetch,
      TOOL_DEFINITIONS
    )

    if (result.toolCalls.length === 0) return
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
        options.project,
        options.authorize,
        options.signal,
        options.runCommand
      )
      await options.onToolEvent?.({
        type: 'finished',
        callId,
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
