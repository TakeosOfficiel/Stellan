import { existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { join, posix, win32 } from 'node:path'
import { createInterface } from 'node:readline'
import spawn from 'cross-spawn'
import { claudeCodeModel } from '../shared/claude-code-models'
import { STELLAN_AGENT_OPERATING_POLICY } from './agent-policy'

export { CLAUDE_CODE_MODELS, isClaudeCodeModel } from '../shared/claude-code-models'

const MINIMUM_CLAUDE_VERSION = '2.1.259'
const BLOCKED_ENVIRONMENT_VARIABLES = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_PROFILE',
  'ANTHROPIC_FEDERATION_RULE_ID',
  'ANTHROPIC_ORGANIZATION_ID',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY'
] as const

export type ClaudeCodeStatus = {
  available: boolean
  version: string | null
  subscription: string | null
  reason: string | null
}

export type ClaudeToolEvent =
  | { type: 'started'; callId: string; tool: string; input: Record<string, unknown> }
  | { type: 'finished'; callId: string; status: 'done' | 'error'; output: string }

type RunClaudeCodeOptions = {
  model: string
  prompt: string
  cwd: string
  sessionId?: string | null
  signal: AbortSignal
  onContent: (content: string) => void
  onTool: (event: ClaudeToolEvent) => void
  onProgress: (detail: string) => void
  onSession: (sessionId: string) => void
}

type CommandResult = { exitCode: number | null; stdout: string; stderr: string }

export type ClaudeInstallCommand = { executable: string; args: string[]; display: string }

export function isClaudePermissionDenial(content: string): boolean {
  return /no approval surface|approval (?:is|was) required but unavailable|approbation (?:est|était) requise mais indisponible/i.test(content)
}

export function claudeRequestGuidance(content: string): string {
  const request = content.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase()
  const creation = /\b(?:cree|creer|construis|construire|realise|realiser|fais|faire|build|create|make)\b/.test(request)
  const website = /\bsite\b/.test(request)
    || /\bpage\s+(?:web|internet)\b/.test(request)
    || /\b(?:website|webpage|landing page|portfolio)\b/.test(request)
  if (!creation || !website) return ''
  return `STRUCTURE ATTENDUE POUR CETTE DEMANDE
- Respecte l’architecture existante si le projet utilise déjà un framework ou une convention claire.
- Pour un nouveau site statique dans un projet vide ou minimal, utilise index.html, assets/css/styles.css et assets/js/script.js, avec un README.md utile. Range aussi les images ou autres ressources locales sous assets au lieu de disperser les fichiers à la racine.
- Livre un vrai site abouti : contenu de démonstration crédible, HTML sémantique, direction visuelle cohérente, sections suffisamment riches, responsive mobile/desktop, états hover/focus et interactions fonctionnelles.
- N’ajoute pas de framework, de dépendances ou de dossiers vides sans nécessité. Vérifie les liens entre les fichiers et le rendu avant de conclure.`
}

function blockedEnvironmentVariable(env: NodeJS.ProcessEnv): string | null {
  return BLOCKED_ENVIRONMENT_VARIABLES.find((name) => Boolean(env[name]?.trim())) ?? null
}

function commandEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = { NO_COLOR: '1', LANG: 'C', LC_ALL: 'C' }
  const allowed = [
    'PATH', 'HOME', 'USER', 'USERPROFILE', 'USERNAME', 'HOMEDRIVE', 'HOMEPATH',
    'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'ProgramFiles', 'ProgramFiles(x86)',
    'SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT', 'TEMP', 'TMP', 'TMPDIR',
    'TERM', 'DISPLAY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS'
  ]
  for (const name of allowed) {
    if (env[name] !== undefined) clean[name] = env[name]
  }
  return clean
}

function claudeExecutable(): string {
  const candidates = process.platform === 'win32'
    ? [
        process.env.USERPROFILE ? join(process.env.USERPROFILE, '.local', 'bin', 'claude.exe') : '',
        process.env.APPDATA ? join(process.env.APPDATA, 'npm', 'claude.cmd') : ''
      ]
    : [process.env.HOME ? join(process.env.HOME, '.local', 'bin', 'claude') : '']
  return candidates.find((candidate) => candidate && existsSync(candidate)) ?? 'claude'
}

async function runCommand(args: string[], cwd?: string): Promise<CommandResult> {
  const child = spawn(claudeExecutable(), args, {
    cwd,
    env: commandEnvironment(process.env),
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  if (!child.stdout || !child.stderr) {
    child.kill()
    throw new Error('Claude Code n’a pas pu ouvrir ses flux de diagnostic.')
  }
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => { stdout += chunk })
  child.stderr.on('data', (chunk: string) => { stderr += chunk })
  const timeout = setTimeout(() => child.kill(), 10_000)
  try {
    const [exitCode] = await once(child, 'close') as [number | null]
    return { exitCode, stdout, stderr }
  } catch (error) {
    child.kill()
    throw error
  } finally {
    clearTimeout(timeout)
  }
}

export function claudeInstallCommand(platform: NodeJS.Platform = process.platform): ClaudeInstallCommand {
  if (platform === 'win32') {
    return {
      executable: 'powershell.exe',
      args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', 'irm https://claude.ai/install.ps1 | iex'],
      display: 'irm https://claude.ai/install.ps1 | iex'
    }
  }
  return {
    executable: '/bin/sh',
    args: ['-c', 'curl -fsSL https://claude.ai/install.sh | bash'],
    display: 'curl -fsSL https://claude.ai/install.sh | bash'
  }
}

async function runSetupCommand(executable: string, args: string[], timeoutMs: number): Promise<number | null> {
  const child = spawn(executable, args, {
    env: commandEnvironment(process.env),
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'ignore']
  })
  const timeout = setTimeout(() => child.kill(), timeoutMs)
  try {
    const [exitCode] = await once(child, 'close') as [number | null]
    return exitCode
  } catch (error) {
    child.kill()
    throw error
  } finally {
    clearTimeout(timeout)
  }
}

export async function installClaudeCode(): Promise<ClaudeCodeStatus> {
  const command = claudeInstallCommand()
  let exitCode: number | null
  try {
    exitCode = await runSetupCommand(command.executable, command.args, 10 * 60_000)
  } catch {
    throw new Error('L’installation automatique de Claude Code n’a pas pu démarrer.')
  }
  if (exitCode !== 0) {
    throw new Error('L’installateur officiel de Claude Code a échoué. Vérifiez votre connexion puis réessayez.')
  }
  return getClaudeCodeStatus()
}

export async function loginClaudeCode(): Promise<ClaudeCodeStatus> {
  const status = await getClaudeCodeStatus()
  if (!status.version) throw new Error('Installez Claude Code avant de connecter votre abonnement.')
  let exitCode: number | null
  try {
    exitCode = await runSetupCommand(claudeExecutable(), ['auth', 'login'], 10 * 60_000)
  } catch {
    throw new Error('La connexion Claude n’a pas pu démarrer.')
  }
  if (exitCode !== 0) {
    throw new Error('La connexion Claude n’a pas été terminée. Réessayez et validez la page ouverte dans votre navigateur.')
  }
  return getClaudeCodeStatus()
}

function parsedVersion(output: string): string | null {
  const match = output.match(/\b(\d+\.\d+\.\d+)\b/)
  return match?.[1] ?? null
}

function isOlderVersion(version: string, minimum: string): boolean {
  const parts = version.split('.').map(Number)
  const minimumParts = minimum.split('.').map(Number)
  for (let index = 0; index < minimumParts.length; index += 1) {
    const current = parts[index] ?? 0
    const required = minimumParts[index] ?? 0
    if (current !== required) return current < required
  }
  return false
}

export function subscriptionAuthReason(
  jsonOutput: string,
  textOutput: string,
  env: NodeJS.ProcessEnv = process.env
): { subscription: string | null; reason: string | null } {
  const blocked = blockedEnvironmentVariable(env)
  if (blocked) {
    return {
      subscription: null,
      reason: `${blocked} est défini. Stellan refuse Claude Code pour garantir qu’aucune facturation API ne soit utilisée.`
    }
  }
  let status: Record<string, unknown>
  try {
    status = JSON.parse(jsonOutput) as Record<string, unknown>
  } catch {
    return { subscription: null, reason: 'Claude Code n’a pas renvoyé un état de connexion vérifiable.' }
  }
  const subscription = typeof status.subscriptionType === 'string' && status.subscriptionType.trim()
    ? status.subscriptionType.trim()
    : null
  const subscriptionLogin = status.loggedIn === true
    && status.authMethod === 'claude.ai'
    && status.apiProvider === 'firstParty'
    && subscription !== null
  const textConfirmsLogin = /^Login method:\s+Claude\b/im.test(textOutput)
    && !/^\s*(?:API key|Profile|Gateway|Provider):/im.test(textOutput)
  if (!subscriptionLogin || !textConfirmsLogin) {
    return {
      subscription: null,
      reason: 'Connectez un abonnement Claude.ai. Les clés API, profils Console, passerelles et fournisseurs cloud sont refusés.'
    }
  }
  return { subscription, reason: null }
}

export async function getClaudeCodeStatus(): Promise<ClaudeCodeStatus> {
  const blocked = blockedEnvironmentVariable(process.env)
  if (blocked) {
    return {
      available: false,
      version: null,
      subscription: null,
      reason: `${blocked} est défini. Retirez cette variable pour utiliser uniquement l’abonnement Claude.`
    }
  }
  try {
    const versionResult = await runCommand(['--version'])
    const version = parsedVersion(versionResult.stdout || versionResult.stderr)
    if (versionResult.exitCode !== 0 || !version) {
      return {
        available: false,
        version,
        subscription: null,
        reason: 'Claude Code est absent. Utilisez l’installation automatique ci-dessus.'
      }
    }
    if (isOlderVersion(version, MINIMUM_CLAUDE_VERSION)) {
      return {
        available: false,
        version,
        subscription: null,
        reason: `Claude Code ${version} est trop ancien. Lancez « claude update » pour installer la version ${MINIMUM_CLAUDE_VERSION} ou supérieure, puis redémarrez Stellan.`
      }
    }
    const [jsonStatus, textStatus] = await Promise.all([
      runCommand(['auth', 'status']),
      runCommand(['auth', 'status', '--text'])
    ])
    const auth = subscriptionAuthReason(
      jsonStatus.stdout || jsonStatus.stderr,
      textStatus.stdout || textStatus.stderr,
      process.env
    )
    return {
      available: jsonStatus.exitCode === 0 && textStatus.exitCode === 0 && auth.reason === null,
      version,
      subscription: auth.subscription,
      reason: auth.reason
    }
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
    return {
      available: false,
      version: null,
      subscription: null,
      reason: code === 'ENOENT'
        ? 'Claude Code est absent. Utilisez l’installation automatique ci-dessus.'
        : 'Claude Code est inaccessible.'
    }
  }
}

function claudeModelAlias(model: string): string {
  const candidate = claudeCodeModel(model)
  if (!candidate) throw new Error('Ce modèle Claude Code n’est pas pris en charge.')
  return candidate.cliModel
}

function projectRelativePath(value: unknown, cwd?: string): unknown {
  if (typeof value !== 'string' || !cwd) return value
  const paths = /^\\\\|^[a-z]:[\\/]/i.test(cwd) ? win32 : posix
  if (!paths.isAbsolute(value)) return value
  const relative = paths.relative(cwd, value)
  if (relative === '') return '.'
  if (relative === '..' || relative.startsWith(`..${paths.sep}`) || paths.isAbsolute(relative)) return value
  return relative.replaceAll('\\', '/')
}

function normalizedTool(name: string, input: Record<string, unknown>, cwd?: string): { tool: string; input: Record<string, unknown> } {
  const withoutFilePath = { ...input }
  delete withoutFilePath.file_path
  if (name === 'Read') return { tool: 'read_file', input: { ...withoutFilePath, path: projectRelativePath(input.file_path, cwd) } }
  if (name === 'Write') return { tool: 'write_file', input: { ...withoutFilePath, path: projectRelativePath(input.file_path, cwd) } }
  if (name === 'Edit' || name === 'MultiEdit') {
    return {
      tool: 'edit_file',
      input: { ...withoutFilePath, path: projectRelativePath(input.file_path, cwd), oldText: input.old_string, newText: input.new_string }
    }
  }
  if (name === 'Glob') return { tool: 'list_files', input: { ...input, path: projectRelativePath(input.path ?? '.', cwd), query: input.pattern } }
  if (name === 'Grep') return { tool: 'search_files', input: { ...input, path: projectRelativePath(input.path ?? '.', cwd), query: input.pattern } }
  if (name === 'Bash') return { tool: 'run_command', input: { ...input, command: input.command, args: [] } }
  return { tool: `claude:${name}`, input }
}

function outputText(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map((item) => outputText(item)).filter(Boolean).join('\n')
  if (value && typeof value === 'object') {
    const item = value as Record<string, unknown>
    if (typeof item.text === 'string') return item.text
    if (typeof item.content === 'string') return item.content
  }
  return value === undefined ? '' : JSON.stringify(value, null, 2)
}

export class ClaudeStreamParser {
  private emittedPartialText = false
  private emittedAnyText = false
  private reportedThinking = false
  private readonly tools = new Map<string, string>()
  private readonly partialTools = new Map<number, { id: string; name: string; input: string }>()

  constructor(private readonly handlers: Pick<RunClaudeCodeOptions, 'onContent' | 'onTool' | 'onProgress' | 'onSession'> & Partial<Pick<RunClaudeCodeOptions, 'cwd'>>) {}

  consume(line: string): void {
    if (!line.trim()) return
    let event: Record<string, unknown>
    try {
      event = JSON.parse(line) as Record<string, unknown>
    } catch {
      return
    }
    if (typeof event.session_id === 'string') this.handlers.onSession(event.session_id)
    if (event.type === 'system') {
      if (event.subtype === 'init') this.handlers.onProgress('Claude Code analyse le projet…')
      return
    }
    if (event.type === 'stream_event') {
      const streamEvent = event.event as Record<string, unknown> | undefined
      const delta = streamEvent?.delta as Record<string, unknown> | undefined
      const block = streamEvent?.content_block as Record<string, unknown> | undefined
      const index = typeof streamEvent?.index === 'number' ? streamEvent.index : null
      if (
        streamEvent?.type === 'content_block_start' && index !== null && block?.type === 'tool_use'
        && typeof block.id === 'string' && typeof block.name === 'string'
      ) {
        this.partialTools.set(index, { id: block.id, name: block.name, input: '' })
        this.handlers.onProgress(`Claude prépare l’outil ${block.name}…`)
      }
      if (streamEvent?.type === 'content_block_delta' && index !== null && delta?.type === 'input_json_delta') {
        const tool = this.partialTools.get(index)
        if (tool && typeof delta.partial_json === 'string') tool.input += delta.partial_json
      }
      if (streamEvent?.type === 'content_block_stop' && index !== null) {
        const tool = this.partialTools.get(index)
        if (tool) {
          this.partialTools.delete(index)
          let input: Record<string, unknown> | null = tool.input ? null : {}
          try {
            const parsed = JSON.parse(tool.input || '{}') as unknown
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) input = parsed as Record<string, unknown>
          } catch { /* The complete assistant event remains a fallback for malformed partial input. */ }
          if (input) {
            const normalized = normalizedTool(tool.name, input, this.handlers.cwd)
            this.tools.set(tool.id, normalized.tool)
            this.handlers.onTool({ type: 'started', callId: tool.id, tool: normalized.tool, input: normalized.input })
          }
        }
      }
      if (streamEvent?.type === 'content_block_delta' && delta?.type === 'text_delta' && typeof delta.text === 'string') {
        this.emittedPartialText = true
        this.emittedAnyText = true
        this.handlers.onContent(delta.text)
      }
      if (streamEvent?.type === 'content_block_delta' && delta?.type === 'thinking_delta' && !this.reportedThinking) {
        this.reportedThinking = true
        this.handlers.onProgress('Claude raisonne sur la prochaine action…')
      }
      return
    }
    if (event.type === 'assistant') {
      const message = event.message as Record<string, unknown> | undefined
      const content = Array.isArray(message?.content) ? message.content : []
      for (const block of content) {
        if (!block || typeof block !== 'object') continue
        const item = block as Record<string, unknown>
        if (item.type === 'text' && typeof item.text === 'string' && !this.emittedPartialText) {
          this.emittedAnyText = true
          this.handlers.onContent(item.text)
        }
        if (item.type === 'tool_use' && typeof item.id === 'string' && typeof item.name === 'string') {
          if (this.tools.has(item.id)) continue
          const input = item.input && typeof item.input === 'object' && !Array.isArray(item.input)
            ? item.input as Record<string, unknown>
            : {}
          const normalized = normalizedTool(item.name, input, this.handlers.cwd)
          this.tools.set(item.id, normalized.tool)
          this.handlers.onTool({ type: 'started', callId: item.id, tool: normalized.tool, input: normalized.input })
        }
      }
      return
    }
    if (event.type === 'user') {
      const message = event.message as Record<string, unknown> | undefined
      const content = Array.isArray(message?.content) ? message.content : []
      for (const block of content) {
        if (!block || typeof block !== 'object') continue
        const item = block as Record<string, unknown>
        if (item.type !== 'tool_result' || typeof item.tool_use_id !== 'string' || !this.tools.has(item.tool_use_id)) continue
        this.handlers.onTool({
          type: 'finished',
          callId: item.tool_use_id,
          status: item.is_error === true ? 'error' : 'done',
          output: outputText(item.content)
        })
      }
      return
    }
    if (event.type === 'result') {
      if (!this.emittedAnyText && typeof event.result === 'string') {
        this.emittedAnyText = true
        this.handlers.onContent(event.result)
      }
      if (event.is_error === true || event.subtype !== 'success') {
        throw new Error(typeof event.result === 'string' ? event.result : 'Claude Code a interrompu son travail.')
      }
    }
  }
}

export async function runClaudeCode(options: RunClaudeCodeOptions): Promise<void> {
  const status = await getClaudeCodeStatus()
  if (!status.available) throw new Error(status.reason ?? 'Claude Code est indisponible.')
  const sessionId = options.sessionId ?? randomUUID()
  const shellTools = process.platform === 'win32' ? '' : ',Bash'
  const settings = JSON.stringify({
    sandbox: { enabled: process.platform !== 'win32', autoAllowBashIfSandboxed: true },
    permissions: { blockReadsOutsideWorkingDirectories: true }
  })
  const args = [
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--permission-mode', 'acceptEdits',
    '--permission-prompts', 'none',
    '--restricted',
    '--settings', settings,
    '--tools', `Edit,Read,Write,Glob,Grep${shellTools}`,
    '--disallowed-tools', 'Bash(git push *)', 'Bash(gh pr *)', 'Bash(gh release *)',
    '--model', claudeModelAlias(options.model),
    '--append-system-prompt', STELLAN_AGENT_OPERATING_POLICY,
    ...(options.sessionId ? ['--resume', options.sessionId] : ['--session-id', sessionId]),
    options.prompt
  ]
  const child = spawn(claudeExecutable(), args, {
    cwd: options.cwd,
    env: commandEnvironment(process.env),
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  if (!child.stdout || !child.stderr) {
    child.kill()
    throw new Error('Claude Code n’a pas pu ouvrir son flux de réponse.')
  }
  const abort = (): void => { child.kill() }
  options.signal.addEventListener('abort', abort, { once: true })
  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-20_000) })
  const parser = new ClaudeStreamParser(options)
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity })
  const completion = once(child, 'close') as Promise<[number | null]>
  try {
    for await (const line of lines) parser.consume(line)
    const [exitCode] = await completion
    if (options.signal.aborted) throw new Error('Génération interrompue.')
    if (exitCode !== 0) throw new Error(stderr.trim() || `Claude Code s’est arrêté avec le code ${exitCode ?? 'inconnu'}.`)
  } catch (error) {
    if (child.exitCode === null) child.kill()
    throw error
  } finally {
    options.signal.removeEventListener('abort', abort)
    lines.close()
  }
}
