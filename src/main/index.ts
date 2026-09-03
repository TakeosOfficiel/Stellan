import os from 'node:os'
import { randomUUID } from 'node:crypto'
import { cp, lstat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, shell } from 'electron'
import { z } from 'zod'
import type { OllamaStatus, RuntimeProgress } from '../shared/contracts'
import { compactConversation, normalizeWorkerPath, runCodingAgent, type AgentToolLifecycleEvent, type WorkerTask } from './agent'
import { createAgentProjectTools } from './container-project-tools'
import { transcribeDictation } from './dictation'
import { getBasicHardwareInfo, getHardwareInfo } from './hardware'
import { isTrustedMainFrame } from './ipc-security'
import { getModelCatalog, isCatalogModel } from './model-catalog'
import { configureOllamaUrl, getOllamaStatus, modelSupportsTools, pullOllamaModel, streamOllamaChat } from './ollama'
import { OLLAMA_HOST_PORT, startOllamaServer } from './ollama-process'
import { assertPortalAccess, PortalManager } from './portal'
import { ProjectTools } from './project-tools'
import { createThreadWorktree, ensureWorkerContainer, getRuntimeInfo, removeThreadWorktree, removeWorkerContainer } from './runtime'
import { ThreadStore, type AgentRun, type AgentRunSummary as StoredAgentRunSummary } from './storage'
import { TerminalManager } from './terminal'
import { createWorkerCommandExecutor } from './worker-runtime'
import { WorkerScheduler } from './worker-scheduler'
import {
  configureManagedWslRuntime,
  importPrivateProject,
  installWslFeature,
  isManagedProjectWindowsPath,
  managedLinuxPathToWindows,
  managedWslServiceUrl,
  runManagedWslCommand,
  stopManagedWslRuntime
} from './wsl-runtime'

const OLLAMA_STATUS_CHANNEL = 'ollama:get-status'
const OLLAMA_START_CHANNEL = 'ollama:start'
const HARDWARE_BASIC_CHANNEL = 'hardware:get-basic'
const SETUP_INFO_CHANNEL = 'setup:get-info'
const OLLAMA_DOWNLOAD_CHANNEL = 'ollama:open-download'
const RUNTIME_PROGRESS_CHANNEL = 'runtime:progress'
const MODEL_PULL_CHANNEL = 'ollama:pull-model'
const MODEL_PULL_PROGRESS_CHANNEL = 'ollama:pull-progress'
const DICTATION_TRANSCRIBE_CHANNEL = 'dictation:transcribe'
const DICTATION_PROGRESS_CHANNEL = 'dictation:progress'
const PROJECT_SELECT_CHANNEL = 'project:select'
const CHAT_START_CHANNEL = 'chat:start'
const CHAT_CANCEL_CHANNEL = 'chat:cancel'
const CHAT_LIST_ACTIVE_CHANNEL = 'chat:list-active'
const CHAT_LIST_THREAD_RUNS_CHANNEL = 'chat:list-thread-runs'
const CHAT_UPDATE_QUEUED_CHANNEL = 'chat:update-queued'
const CHAT_DELETE_QUEUED_CHANNEL = 'chat:delete-queued'
const CHAT_SEND_NOW_CHANNEL = 'chat:send-now'
const CHAT_EVENT_CHANNEL = 'chat:event'
const THREADS_LIST_CHANNEL = 'threads:list'
const THREADS_SET_ACTIVE_CHANNEL = 'threads:set-active'
const THREADS_CREATE_CHANNEL = 'threads:create'
const THREADS_MESSAGES_CHANNEL = 'threads:messages'
const THREADS_DELETE_CHANNEL = 'threads:delete'
const THREADS_EXPORT_PROJECT_CHANNEL = 'threads:export-project'
const THREADS_REVIEW_PROJECT_CHANNEL = 'threads:review-project'
const THREADS_LIST_PROJECT_FILES_CHANNEL = 'threads:list-project-files'
const THREADS_READ_PROJECT_FILE_CHANNEL = 'threads:read-project-file'
const THREADS_OPEN_PROJECT_FILE_CHANNEL = 'threads:open-project-file'
const TERMINAL_START_CHANNEL = 'terminal:start'
const TERMINAL_WRITE_CHANNEL = 'terminal:write'
const TERMINAL_RESIZE_CHANNEL = 'terminal:resize'
const TERMINAL_CLOSE_CHANNEL = 'terminal:close'
const TERMINAL_EVENT_CHANNEL = 'terminal:event'
const PORTAL_GET_CHANNEL = 'portal:get'
const PORTAL_START_CHANNEL = 'portal:start'
const PORTAL_STOP_CHANNEL = 'portal:stop'
const PORTAL_COPY_URL_CHANNEL = 'portal:copy-url'
const PORTAL_OPEN_CHANNEL = 'portal:open'
const WINDOW_MINIMIZE_CHANNEL = 'window:minimize'
const WINDOW_TOGGLE_MAXIMIZE_CHANNEL = 'window:toggle-maximize'
const WINDOW_CLOSE_CHANNEL = 'window:close'

const modelIdSchema = z.string().min(1).max(100).refine(isCatalogModel)
const dictationAudioSchema = z.custom<ArrayBuffer>((value) => value instanceof ArrayBuffer)
  .refine((audio) => audio.byteLength >= 6_400, 'La dictée est trop courte.')
  .refine((audio) => audio.byteLength <= 3_840_000, 'La dictée dépasse une minute.')
  .refine((audio) => audio.byteLength % 4 === 0, 'Le format audio est invalide.')
const chatRequestSchema = z.object({
  requestId: z.uuid(),
  threadId: z.uuid(),
  model: z.string().min(1).max(200),
  projectPath: z.string().min(1).max(10_000).nullable(),
  messages: z.array(z.object({
    role: z.enum(['system', 'user', 'assistant', 'tool']),
    content: z.string().max(200_000)
  })).min(1).max(200)
})
const requestIdSchema = z.uuid()
const projectFileRequestSchema = z.object({
  threadId: z.uuid(),
  path: z.string().min(1).max(10_000)
})
const updateQueuedMessageSchema = z.object({
  requestId: z.uuid(),
  content: z.string().trim().min(1).max(200_000)
})
const terminalStartSchema = z.object({
  threadId: z.uuid(),
  cols: z.number().int().min(2).max(500),
  rows: z.number().int().min(1).max(200)
})
const terminalWriteSchema = z.object({
  threadId: z.uuid(),
  data: z.string().max(65_536)
})
const terminalResizeSchema = terminalStartSchema
const portalStartSchema = z.discriminatedUnion('source', [
  z.object({
    threadId: z.uuid(),
    source: z.literal('project'),
    durationMinutes: z.union([z.literal(15), z.literal(60), z.literal(240), z.null()])
  }),
  z.object({
    threadId: z.uuid(),
    source: z.literal('port'),
    port: z.number().int().min(1).max(65_535),
    durationMinutes: z.union([z.literal(15), z.literal(60), z.literal(240), z.null()])
  })
])
const createThreadSchema = z.object({
  title: z.string().trim().min(1).max(200),
  projectName: z.string().trim().min(1).max(200),
  projectPath: z.string().min(1).max(10_000).nullable(),
  model: z.string().min(1).max(200).nullable()
})
let activeDownload: string | null = null
let dictationActive = false
const activeChats = new Map<string, AbortController>()
const activeThreadChats = new Map<string, string>()
const workerScheduler = new WorkerScheduler()
const activeThreadOwners = new Map<number, string>()
const approvedProjectPaths = new Map<string, 'git' | 'folder'>()
let recoveredQueueScheduled = false
let threadStore: ThreadStore | null = null
let mainWindow: BrowserWindow | null = null
let ollamaStartPromise: Promise<OllamaStatus> | null = null
let shutdownReady = false
let shutdownCleanup: Promise<void> | null = null
const pendingWindowCleanups = new Set<Promise<void>>()
const terminalManager = new TerminalManager((ownerId, terminalEvent) => {
  const contents = mainWindow?.webContents
  if (contents && !contents.isDestroyed() && contents.id === ownerId) {
    contents.send(TERMINAL_EVENT_CHANNEL, terminalEvent)
  }
})
const portalManager = new PortalManager()

function sendRuntimeProgress(progress: RuntimeProgress): void {
  const contents = mainWindow?.webContents
  if (contents && !contents.isDestroyed()) contents.send(RUNTIME_PROGRESS_CHANNEL, progress)
}

function ensureOllamaRunning(): Promise<OllamaStatus> {
  if (ollamaStartPromise) return ollamaStartPromise

  ollamaStartPromise = (async () => {
    sendRuntimeProgress({ step: 'Détection du matériel', detail: 'Vérification du GPU pour choisir le meilleur mode…', percent: 3 })
    const hardware = await getHardwareInfo()
    const started = await startOllamaServer({
      useNvidiaGpu: hardware.gpus.some((gpu) => /nvidia|geforce|quadro|rtx|gtx/i.test(gpu.model)),
      onProgress: sendRuntimeProgress
    })
    if (!started.success) return { available: false as const, reason: started.reason }
    configureOllamaUrl(managedWslServiceUrl(OLLAMA_HOST_PORT))

    for (let attempt = 0; attempt < 30; attempt += 1) {
      if (attempt === 0 || attempt % 5 === 0) {
        sendRuntimeProgress({
          step: 'Connexion à Ollama',
          detail: `Attente de l’API locale… ${attempt + 1}/30`,
          percent: Math.min(98, 91 + Math.floor(attempt / 4))
        })
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000))
      const status = await getOllamaStatus()
      if (status.available) {
        sendRuntimeProgress({ step: 'Runtime prêt', detail: 'Ollama répond et les modèles sont accessibles.', percent: 100 })
        return status
      }
    }
    return {
      available: false as const,
      reason: "Ollama a été lancé en arrière-plan mais son service local ne répond toujours pas."
    }
  })().finally(() => {
    ollamaStartPromise = null
  })

  return ollamaStartPromise
}

function getThreadStore(): ThreadStore {
  if (!threadStore) throw new Error('Le stockage local n’est pas prêt.')
  return threadStore
}

function isApprovedProject(projectPath: string): boolean {
  return approvedProjectPaths.has(projectPath) || getThreadStore().listThreads().some(
    (thread) => thread.projectPath === projectPath
  )
}

async function openThreadProject(threadId: string): Promise<ProjectTools> {
  const store = getThreadStore()
  const thread = store.getThread(threadId)
  if (!thread) throw new Error('Le thread local est introuvable.')
  if (thread.environmentStatus !== 'active') {
    throw new Error(thread.environmentError ?? 'L’environnement de ce thread n’est pas actif.')
  }

  const executionPath = thread.workspacePath ?? thread.projectPath
  if (!executionPath) throw new Error('L’environnement actif n’a pas de dossier de travail.')
  try {
    return await ProjectTools.create(executionPath)
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'Le dossier de travail est indisponible.'
    store.transitionEnvironment(thread.id, 'error', reason)
    throw new Error(`L’environnement de ce thread est indisponible : ${reason}`)
  }
}

async function resolveContainerGit(project: ProjectTools, projectPath?: string): Promise<{
  directory: string
  commonDirectory: string
} | null> {
  const managed = process.platform === 'win32' && projectPath && isManagedProjectWindowsPath(projectPath)
  const runGit = (args: readonly string[]) => managed
    ? runManagedWslCommand('git', ['-C', projectPath, ...args], { timeoutMs: 10_000, maxOutputBytes: 20_000 })
    : project.runCommand('git', args, { timeoutMs: 10_000, maxOutputBytes: 20_000 })
  const repository = await runGit(['rev-parse', '--is-inside-work-tree'])
  if (repository.exitCode !== 0 || repository.stdout.trim() !== 'true') return null
  const [directory, commonDirectory] = await Promise.all([
    runGit(['rev-parse', '--path-format=absolute', '--git-dir']),
    runGit(['rev-parse', '--path-format=absolute', '--git-common-dir'])
  ])
  if (directory.exitCode !== 0 || commonDirectory.exitCode !== 0) {
    throw new Error('Les métadonnées Git du worktree ne peuvent pas être montées dans le worker.')
  }
  return {
    directory: managed ? managedLinuxPathToWindows(directory.stdout.trim()) : directory.stdout.trim(),
    commonDirectory: managed ? managedLinuxPathToWindows(commonDirectory.stdout.trim()) : commonDirectory.stdout.trim()
  }
}

function requireActiveProjectThread(ownerId: number, threadId: string) {
  const thread = getThreadStore().getThread(threadId)
  assertPortalAccess(activeThreadOwners.get(ownerId), threadId, thread)
  return thread
}

async function defaultWorkerProfile(projectPath: string) {
  const cpuCores = os.cpus().length
  const totalMemoryMb = os.totalmem() / 1_000_000
  const runtime = await getRuntimeInfo()
  const containerRuntime = runtime.docker.available ? 'docker' as const : null
  const cpuLimit = Math.max(1, Math.min(4, Math.floor(cpuCores / 2)))
  const memoryMb = Math.max(1024, Math.min(8192, Math.floor(totalMemoryMb / 4)))
  return {
    projectPath,
    mode: containerRuntime ? 'container' as const : 'direct' as const,
    runtime: containerRuntime,
    cpuLimit,
    memoryMb,
    image: 'node:22-bookworm',
    network: 'none' as const,
    maxConcurrentWorkers: Math.max(1, Math.min(
      2,
      Math.floor(cpuCores / cpuLimit),
      Math.floor(totalMemoryMb / memoryMb)
    ))
  }
}

async function resolveWorkerProfile(store: ThreadStore, projectPath: string) {
  const defaults = await defaultWorkerProfile(projectPath)
  return store.saveWorkerProfile(defaults)
}

function handle<T extends unknown[], R>(
  channel: string,
  listener: (event: Electron.IpcMainInvokeEvent, ...args: T) => R
): void {
  ipcMain.handle(channel, (event, ...args) => {
    if (!isTrustedMainFrame(event, mainWindow?.webContents ?? null)) {
      throw new Error('Appel IPC refusé.')
    }
    return listener(event, ...(args as T))
  })
}

function sendChatEvent(run: AgentRun, payload: object): void {
  const contents = mainWindow?.webContents
  if (contents && !contents.isDestroyed()) {
    contents.send(CHAT_EVENT_CHANNEL, { requestId: run.requestId, threadId: run.threadId, ...payload })
  }
}

function toolDetail(value: unknown): string {
  const detail = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  return detail.length > 20_000 ? `${detail.slice(0, 20_000)}\n… détail tronqué` : detail
}

function toPublicRunSummary(run: StoredAgentRunSummary) {
  return {
    requestId: run.requestId,
    threadId: run.threadId,
    userMessageId: run.userMessageId,
    userContent: run.userContent,
    model: run.model,
    status: run.status,
    error: run.error,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt
  }
}

async function scheduleAgentRun(run: AgentRun): Promise<void> {
  if (workerScheduler.has(run.requestId)) return
  const store = getThreadStore()
  const thread = store.getThread(run.threadId)
  if (!thread) throw new Error('Le thread local est introuvable.')
  if (thread.environmentStatus !== 'active' && thread.projectPath) {
    throw new Error(thread.environmentError ?? 'L’environnement de ce thread n’est pas actif.')
  }
  const profile = thread.projectPath ? await resolveWorkerProfile(store, thread.projectPath) : null
  if (thread.projectPath && !profile) throw new Error('Le profil worker du projet est invalide.')
  // A conversation owns its queue. Separate chats may run concurrently even
  // when they reference the same project; only messages in one chat serialize.
  const projectKey = thread.id
  if (profile?.mode === 'container') {
    const runtime = await getRuntimeInfo()
    if (!profile.runtime || !runtime[profile.runtime].available) {
      throw new Error(`Le runtime ${profile.runtime ?? 'conteneur'} n’est pas disponible.`)
    }
  }

  const controller = new AbortController()
  sendChatEvent(run, { type: 'status', status: 'queued' })
  workerScheduler.enqueue({
    requestId: run.requestId,
    threadId: thread.id,
    projectKey,
    isolationKey: null,
    maxConcurrentWorkers: profile?.maxConcurrentWorkers ?? 1,
    cancelQueued: () => {
      store.finishAgentRun(run.id, 'interrupted', '', 'Génération annulée dans la file d’attente.')
      sendChatEvent(run, { type: 'error', reason: 'Génération annulée dans la file d’attente.' })
    },
    run: async () => {
      activeChats.set(run.requestId, controller)
      activeThreadChats.set(thread.id, run.requestId)
      let assistantContent = ''
      try {
        store.markAgentRunRunning(run.id)
        sendChatEvent(run, { type: 'status', status: 'running' })
        const summary = store.listAgentRunSummaries(thread.id).find(
          (candidate) => candidate.requestId === run.requestId
        )
        if (!summary) throw new Error('La génération active est introuvable.')
        sendChatEvent(run, {
          type: 'started',
          userMessageId: summary.userMessageId,
          userContent: summary.userContent
        })
        const executionPath = thread.workspacePath ?? thread.projectPath
        const promptMessages = store.listPromptMessages(thread.id, run.userMessageId)
        const onContent = (content: string): void => {
          assistantContent += content
          sendChatEvent(run, { type: 'content', content })
        }
        if (executionPath) {
          if (!await modelSupportsTools(run.model)) {
            throw new Error('Ce modèle ne prend pas en charge les outils nécessaires aux projets de code.')
          }
          const directProject = await openThreadProject(thread.id)
          const git = await resolveContainerGit(directProject, executionPath)
          const project = createAgentProjectTools(profile, thread.id, executionPath, directProject, git)
          await runCodingAgent({
            model: run.model,
            messages: promptMessages,
            project,
            signal: controller.signal,
            onContent,
            onTool: () => undefined,
            onToolEvent: async (toolEvent: AgentToolLifecycleEvent) => {
              const currentStore = getThreadStore()
              if (toolEvent.type === 'started') {
                currentStore.recordToolStarted(run.id, toolEvent)
                sendChatEvent(run, {
                  type: 'tool',
                  callId: toolEvent.callId,
                  tool: toolEvent.tool,
                  status: 'running',
                  input: toolDetail(toolEvent.arguments),
                  output: null
                })
              } else {
                currentStore.recordToolFinished(
                  run.id,
                  toolEvent.callId,
                  toolEvent.status,
                  toolEvent.result
                )
                sendChatEvent(run, {
                  type: 'tool',
                  callId: toolEvent.callId,
                  tool: toolEvent.tool,
                  status: toolEvent.status,
                  input: null,
                  output: toolDetail(toolEvent.result)
                })
              }
            },
            runCommand: createWorkerCommandExecutor(profile, thread.id, executionPath, git),
            isGitRepository: git !== null,
            spawnWorkers: thread.parentThreadId ? undefined : async (tasks: WorkerTask[]) => {
              const results: Array<{ title: string; summary: string; files: string[] }> = new Array(tasks.length)
              const batchController = new AbortController()
              const workers = tasks.map((task, taskIndex) => {
                const childController = new AbortController()
                const workerSignal = AbortSignal.any([controller.signal, batchController.signal, childController.signal])
                const directive = `${task.instructions}\n\nTu es responsable uniquement de ces fichiers :\n${task.files.join('\n')}`
                const createdChild = store.createThread({
                  title: task.title,
                  parentThreadId: thread.id,
                  projectName: thread.projectName,
                  projectPath: thread.projectPath,
                  workspacePath: thread.workspacePath,
                  workspaceMode: thread.workspaceMode,
                  model: run.model
                })
                const child = thread.projectPath
                  ? store.activateEnvironment(createdChild.id, thread.workspaceMode === 'worktree' ? 'worktree' : 'direct', thread.workspacePath)
                  : createdChild
                const childRun = store.startAgentRun(child.id, randomUUID(), run.model, directive)
                activeChats.set(childRun.requestId, childController)
                activeThreadChats.set(child.id, childRun.requestId)
                sendChatEvent(run, { type: 'thread-created', child })
                sendChatEvent(childRun, { type: 'status', status: 'queued' })

                return workerScheduler.runChild(
                  projectKey,
                  profile?.maxConcurrentWorkers ?? 1,
                  workerSignal,
                  async () => {
                  const toolName = `worker:${task.title}`
                  const callId = `worker:${child.id}`
                  let summary = ''
                  store.markAgentRunRunning(childRun.id)
                  sendChatEvent(childRun, { type: 'status', status: 'running' })
                  sendChatEvent(childRun, {
                    type: 'started',
                    userMessageId: childRun.userMessageId,
                    userContent: directive
                  })
                  sendChatEvent(run, {
                    type: 'tool',
                    callId,
                    tool: toolName,
                    status: 'running',
                    input: toolDetail({ instructions: task.instructions, files: task.files }),
                    output: null
                  })
                  try {
                    await runCodingAgent({
                      model: run.model,
                      messages: [{ role: 'user', content: directive }],
                      project,
                      signal: workerSignal,
                      onContent: (content) => {
                        summary += content
                        sendChatEvent(childRun, { type: 'content', content })
                      },
                      onTool: () => {},
                      onToolEvent: async (workerToolEvent) => {
                        if (workerToolEvent.type === 'started') {
                          getThreadStore().recordToolStarted(childRun.id, workerToolEvent)
                          sendChatEvent(childRun, {
                            type: 'tool',
                            callId: workerToolEvent.callId,
                            tool: workerToolEvent.tool,
                            status: 'running',
                            input: toolDetail(workerToolEvent.arguments),
                            output: null
                          })
                        } else {
                          getThreadStore().recordToolFinished(childRun.id, workerToolEvent.callId, workerToolEvent.status, workerToolEvent.result)
                          sendChatEvent(childRun, {
                            type: 'tool',
                            callId: workerToolEvent.callId,
                            tool: workerToolEvent.tool,
                            status: workerToolEvent.status,
                            input: null,
                            output: toolDetail(workerToolEvent.result)
                          })
                        }
                      },
                      authorize: async () => true,
                      writeScope: new Set(task.files.map((file) => normalizeWorkerPath(file))),
                      allowRunCommand: false,
                      isGitRepository: git !== null
                    })
                    getThreadStore().finishAgentRun(childRun.id, 'completed', summary)
                    sendChatEvent(childRun, { type: 'done' })
                    results[taskIndex] = { title: task.title, summary, files: task.files }
                    sendChatEvent(run, { type: 'tool', callId, tool: toolName, status: 'done', input: null, output: toolDetail(summary) })
                  } catch (error) {
                    const reason = workerSignal.aborted
                      ? 'Worker interrompu.'
                      : error instanceof Error ? error.message : 'Le worker a échoué.'
                    getThreadStore().finishAgentRun(childRun.id, workerSignal.aborted ? 'interrupted' : 'error', summary, reason)
                    sendChatEvent(childRun, { type: 'error', reason })
                    sendChatEvent(run, {
                      type: 'tool',
                      callId,
                      tool: toolName,
                      status: 'error',
                      input: null,
                      output: toolDetail(reason)
                    })
                    throw error
                  }
                  }
                ).catch((error) => {
                  const persisted = getThreadStore().getAgentRun(childRun.id)
                  if (persisted?.status === 'queued') {
                    const reason = workerSignal.aborted ? 'Worker annulé avant son démarrage.' : 'Le worker n’a pas pu démarrer.'
                    getThreadStore().finishAgentRun(childRun.id, workerSignal.aborted ? 'interrupted' : 'error', '', reason)
                    sendChatEvent(childRun, { type: 'error', reason })
                  }
                  throw error
                }).finally(() => {
                  activeChats.delete(childRun.requestId)
                  if (activeThreadChats.get(child.id) === childRun.requestId) activeThreadChats.delete(child.id)
                })
              })
              try {
                await Promise.all(workers)
              } catch (error) {
                batchController.abort(error)
                await Promise.allSettled(workers)
                throw error
              }
              return results
            },
            authorize: async () => !controller.signal.aborted
          })
        } else {
          await streamOllamaChat(
            run.model,
            compactConversation([
              {
                role: 'system',
                content: 'Tu es un assistant local utile, précis et concis. Aucun projet n’est ouvert. Si une demande nécessite de créer ou modifier des fichiers, demande d’abord à l’utilisateur d’ouvrir un projet. Ne présente jamais du code collé dans le chat comme une modification réellement effectuée.'
              },
              ...promptMessages.filter((message) => message.role !== 'system')
            ]),
            onContent,
            controller.signal
          )
        }
        getThreadStore().finishAgentRun(
          run.id,
          'completed',
          assistantContent
        )
        sendChatEvent(run, { type: 'done' })
      } catch (error) {
        const reason = controller.signal.aborted
          ? 'Génération interrompue.'
          : error instanceof Error ? error.message : 'La génération a échoué.'
        const finalContent = assistantContent
        getThreadStore().finishAgentRun(
          run.id,
          controller.signal.aborted ? 'interrupted' : 'error',
          finalContent
            ? `${finalContent}\n\n${controller.signal.aborted ? '[Réponse interrompue]' : '[Réponse incomplète]'}`
            : '',
          reason
        )
        sendChatEvent(run, { type: 'error', reason })
      } finally {
        activeChats.delete(run.requestId)
        if (activeThreadChats.get(thread.id) === run.requestId) activeThreadChats.delete(thread.id)
      }
    }
  })
}

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 880,
    minHeight: 600,
    backgroundColor: '#0c0d10',
    frame: false,
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  mainWindow = window
  window.webContents.session.setPermissionCheckHandler((webContents, permission, _origin, details) => (
    webContents === window.webContents
      && permission === 'media'
      && details.isMainFrame
      && details.mediaType === 'audio'
  ))
  window.webContents.session.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const mediaTypes = 'mediaTypes' in details ? details.mediaTypes : undefined
    callback(
      webContents === window.webContents
      && permission === 'media'
      && mediaTypes?.length === 1
      && mediaTypes[0] === 'audio'
    )
  })
  const ownerId = window.webContents.id
  window.once('closed', () => {
    activeThreadOwners.delete(ownerId)
    const cleanup = Promise.all([
      portalManager.closeOwner(ownerId),
      terminalManager.closeOwner(ownerId)
    ]).then(() => undefined)
    pendingWindowCleanups.add(cleanup)
    void cleanup.catch((error: unknown) => console.error(
      'Window resource cleanup failed:',
      error instanceof Error ? error.message : 'unknown error'
    )).finally(() => pendingWindowCleanups.delete(cleanup))
    if (mainWindow === window) mainWindow = null
  })

  window.once('ready-to-show', () => window.show())
  window.webContents.once('did-finish-load', () => {
    if (recoveredQueueScheduled) return
    recoveredQueueScheduled = true
    for (const run of getThreadStore().listQueuedAgentRuns()) {
      void scheduleAgentRun(run).catch((error: unknown) => {
        const reason = error instanceof Error ? error.message : 'La génération en attente n’a pas pu redémarrer.'
        getThreadStore().finishAgentRun(run.id, 'error', '', reason)
        sendChatEvent(run, { type: 'error', reason })
      })
    }
  })

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url)
    return { action: 'deny' }
  })
  window.webContents.on('will-navigate', (event, url) => {
    if (url !== window.webContents.getURL()) event.preventDefault()
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null)
  configureManagedWslRuntime(join(app.getPath('userData'), 'runtime'), sendRuntimeProgress)
  threadStore = new ThreadStore(join(app.getPath('userData'), 'local-agent.sqlite'))
  threadStore.recoverInterruptedEnvironments()
  threadStore.recoverInterruptedAgentRuns()
  handle(WINDOW_MINIMIZE_CHANNEL, () => mainWindow?.minimize())
  handle(WINDOW_TOGGLE_MAXIMIZE_CHANNEL, () => {
    if (!mainWindow) return
    if (mainWindow.isMaximized()) mainWindow.unmaximize()
    else mainWindow.maximize()
  })
  handle(WINDOW_CLOSE_CHANNEL, () => mainWindow?.close())
  handle(OLLAMA_STATUS_CHANNEL, () => getOllamaStatus())
  handle(OLLAMA_START_CHANNEL, () => ensureOllamaRunning())
  handle(HARDWARE_BASIC_CHANNEL, () => getBasicHardwareInfo())
  handle(SETUP_INFO_CHANNEL, async () => {
    const [hardware, runtime] = await Promise.all([getHardwareInfo(), getRuntimeInfo()])
    return { hardware, runtime, models: getModelCatalog(hardware) }
  })
  handle(OLLAMA_DOWNLOAD_CHANNEL, async () => {
    if (process.platform === 'win32') {
      sendRuntimeProgress({ step: 'Activation de WSL 2', detail: 'Acceptez la fenêtre Windows. L’opération peut durer plusieurs minutes…', percent: 2 })
      await installWslFeature()
      sendRuntimeProgress({ step: 'WSL 2 activé', detail: 'Vérification et préparation du runtime privé…', percent: 6 })
    }
    else await shell.openExternal('https://docs.docker.com/engine/install/')
  })
  handle(MODEL_PULL_CHANNEL, async (event, input: unknown) => {
    const parsedModel = modelIdSchema.safeParse(input)
    if (!parsedModel.success) {
      return { success: false, reason: 'Ce modèle ne fait pas partie du catalogue autorisé.' }
    }

    if (activeDownload) {
      return { success: false, reason: `Le téléchargement de ${activeDownload} est déjà en cours.` }
    }

    activeDownload = parsedModel.data
    try {
      const hardware = await getHardwareInfo()
      const model = getModelCatalog(hardware).find((entry) => entry.id === parsedModel.data)
      if (!model || model.compatibility === 'unsupported') {
        return { success: false, reason: "Ce modèle n'est pas disponible sur ce système." }
      }

      return await pullOllamaModel(model.id, (progress) => {
        if (!event.sender.isDestroyed()) {
          event.sender.send(MODEL_PULL_PROGRESS_CHANNEL, progress)
        }
      })
    } finally {
      activeDownload = null
    }
  })
  handle(DICTATION_TRANSCRIBE_CHANNEL, async (event, input: unknown) => {
    const audio = dictationAudioSchema.parse(input)
    if (dictationActive) throw new Error('Une dictée est déjà en cours de transcription.')
    dictationActive = true
    try {
      return await transcribeDictation(
        audio,
        join(app.getPath('userData'), 'models', 'transformers'),
        (progress) => {
          if (!event.sender.isDestroyed()) event.sender.send(DICTATION_PROGRESS_CHANNEL, progress)
        }
      )
    } finally {
      dictationActive = false
    }
  })
  handle(PROJECT_SELECT_CHANNEL, async () => {
    const result = await dialog.showOpenDialog({
      title: 'Choisir ou créer un projet',
      properties: ['openDirectory', 'createDirectory']
    })
    if (result.canceled || !result.filePaths[0]) return null
    let projectPath = result.filePaths[0]
    const tools = await ProjectTools.create(projectPath)
    const repository = await tools.runCommand('git', ['rev-parse', '--show-toplevel'], {
      timeoutMs: 10_000,
      maxOutputBytes: 20_000
    })
    let kind: 'git' | 'folder' = repository.exitCode === 0 && repository.stdout.trim() ? 'git' : 'folder'
    if (kind === 'git') {
      projectPath = repository.stdout.trim()
      await ProjectTools.create(projectPath)
    }
    const projectName = basename(projectPath)
    if (process.platform === 'win32') {
      sendRuntimeProgress({ step: 'Import du projet', detail: 'Copie dans un disque Linux privé de 20 Go…', percent: 80 })
      const privateProject = await importPrivateProject(randomUUID(), projectPath)
      projectPath = privateProject.repositoryPath
      kind = 'git'
      sendRuntimeProgress({ step: 'Projet privé prêt', detail: 'L’original restera inchangé.', percent: 100 })
    }
    approvedProjectPaths.set(projectPath, kind)
    return { path: projectPath, name: projectName }
  })
  handle(THREADS_LIST_CHANNEL, () => getThreadStore().listThreads())
  handle(THREADS_SET_ACTIVE_CHANNEL, async (event, input: unknown) => {
    const threadId = z.uuid().nullable().parse(input)
    if (threadId && !getThreadStore().getThread(threadId)) {
      throw new Error('Le thread local est introuvable.')
    }
    const previousThreadId = activeThreadOwners.get(event.sender.id)
    if (previousThreadId && previousThreadId !== threadId) {
      await terminalManager.close(previousThreadId, event.sender.id)
    }
    if (threadId) activeThreadOwners.set(event.sender.id, threadId)
    else activeThreadOwners.delete(event.sender.id)
  })
  handle(THREADS_CREATE_CHANNEL, async (event, input: unknown) => {
    const parsed = createThreadSchema.parse(input)
    if (!parsed.projectPath) throw new Error('Ouvrez ou créez un projet avant de démarrer un thread.')
    const store = getThreadStore()
    const isPersistedProject = parsed.projectPath && store.listThreads().some(
      (thread) => thread.projectPath === parsed.projectPath
    )
    if (parsed.projectPath && !approvedProjectPaths.has(parsed.projectPath) && !isPersistedProject) {
      throw new Error('Ce projet doit être choisi avec le sélecteur de dossier.')
    }
    const thread = store.createThread(parsed)
    const existingProjectThreads = store.listThreads().filter(
      (existing) => existing.id !== thread.id && existing.projectPath === parsed.projectPath
    )
    const managedProject = process.platform === 'win32' && isManagedProjectWindowsPath(parsed.projectPath)
    const projectKind = approvedProjectPaths.get(parsed.projectPath)
      ?? (existingProjectThreads.some((existing) => existing.workspaceMode === 'worktree') ? 'git' : 'folder')
    if (projectKind === 'folder') {
      if (process.platform === 'win32') {
        store.transitionEnvironment(thread.id, 'terminated')
        store.deleteThread(thread.id)
        throw new Error('Réimportez ce projet pour créer son environnement privé isolé.')
      }
      return store.activateEnvironment(thread.id, 'direct', null)
    }
    let workspacePath: string
    try {
      const workspaceRoot = managedProject
        ? join(dirname(parsed.projectPath), 'worktrees')
        : join(app.getPath('userData'), 'workspaces')
      workspacePath = managedProject
        ? await createThreadWorktree(parsed.projectPath, workspaceRoot, thread.id, 'HEAD', runManagedWslCommand)
        : await createThreadWorktree(parsed.projectPath, workspaceRoot, thread.id)
    } catch (error) {
      if (managedProject) {
        store.transitionEnvironment(thread.id, 'terminated')
        store.deleteThread(thread.id)
        throw new Error(`L’environnement privé n’a pas pu être créé : ${error instanceof Error ? error.message : 'erreur inconnue'}`)
      }
      const owner = BrowserWindow.fromWebContents(event.sender)
      const options = {
        type: 'warning' as const,
        title: 'Isolation Git indisponible',
        message: 'Continuer directement dans le dossier sélectionné ?',
        detail: `Le worktree isolé n’a pas pu être créé. Les modifications autorisées toucheront le dossier original.\n\n${error instanceof Error ? error.message : 'Erreur inconnue'}`,
        buttons: ['Annuler', 'Continuer en mode direct'],
        defaultId: 0,
        cancelId: 0,
        noLink: true
      }
      const result = owner
        ? await dialog.showMessageBox(owner, options)
        : await dialog.showMessageBox(options)
      if (result.response !== 1) {
        store.transitionEnvironment(thread.id, 'terminated')
        store.deleteThread(thread.id)
        throw new Error('Création annulée : l’isolation Git est indisponible.')
      }
      return store.activateEnvironment(thread.id, 'direct', null)
    }
    return store.activateEnvironment(thread.id, 'worktree', workspacePath)
  })
  handle(THREADS_MESSAGES_CHANNEL, (_event, input: unknown) => {
    const threadId = requestIdSchema.parse(input)
    return getThreadStore().listMessages(threadId)
  })
  handle(THREADS_DELETE_CHANNEL, async (event, input: unknown) => {
    const threadId = requestIdSchema.parse(input)
    const store = getThreadStore()
    const thread = store.getThread(threadId)
    if (!thread) return false
    if (workerScheduler.hasThread(threadId) || activeThreadChats.has(threadId)) {
      throw new Error('Arrêtez la génération avant de supprimer ce thread.')
    }
    const children = store.listThreads().filter((candidate) => candidate.parentThreadId === threadId)
    if (children.some((child) => workerScheduler.hasThread(child.id) || activeThreadChats.has(child.id))) {
      throw new Error('Attendez la fin des workers avant de supprimer ce thread.')
    }
    for (const child of children) {
      await portalManager.close(child.id, event.sender.id)
      await terminalManager.close(child.id, event.sender.id)
      const childProfile = child.projectPath ? store.getWorkerProfile(child.projectPath) : null
      if (childProfile?.mode === 'container' && childProfile.runtime) {
        await removeWorkerContainer(childProfile.runtime, child.id)
      }
    }
    await portalManager.close(threadId, event.sender.id)
    await terminalManager.close(threadId, event.sender.id)
    if (thread.parentThreadId) {
      const profile = thread.projectPath ? store.getWorkerProfile(thread.projectPath) : null
      if (profile?.mode === 'container' && profile.runtime) await removeWorkerContainer(profile.runtime, thread.id)
      return store.deleteThread(threadId)
    }
    if (thread.environmentStatus === 'terminated') {
      const profile = thread.projectPath ? store.getWorkerProfile(thread.projectPath) : null
      if (profile?.mode === 'container' && profile.runtime) await removeWorkerContainer(profile.runtime, thread.id)
      return store.deleteThread(threadId)
    }
    if (thread.projectPath && thread.workspacePath) {
      const project = thread.environmentStatus === 'active'
        ? await openThreadProject(thread.id)
        : await ProjectTools.create(thread.workspacePath)
      const managedProject = process.platform === 'win32' && isManagedProjectWindowsPath(thread.workspacePath)
      const managedStatus = managedProject
        ? await runManagedWslCommand('git', ['-C', thread.workspacePath, '-c', 'core.fsmonitor=false', 'status', '--short'], {
            timeoutMs: 10_000,
            maxOutputBytes: 20_000
          })
        : null
      if (managedStatus && managedStatus.exitCode !== 0) {
        throw new Error(managedStatus.stderr.trim() || 'Impossible de lire les changements du projet privé.')
      }
      const status = managedStatus?.stdout ?? await project.gitStatus()
      let force = false
      if (status.trim()) {
        const owner = BrowserWindow.fromWebContents(event.sender)
        const options = {
          type: 'warning' as const,
          title: 'Supprimer des modifications locales ?',
          message: 'Ce thread contient des changements non enregistrés.',
          detail: status.slice(0, 20_000),
          buttons: ['Conserver le thread', 'Supprimer définitivement'],
          defaultId: 0,
          cancelId: 0,
          noLink: true
        }
        const result = owner
          ? await dialog.showMessageBox(owner, options)
          : await dialog.showMessageBox(options)
        if (result.response !== 1) return false
        force = true
      }
      try {
        const workspaceRoot = process.platform === 'win32' && isManagedProjectWindowsPath(thread.projectPath)
          ? join(dirname(thread.projectPath), 'worktrees')
          : join(app.getPath('userData'), 'workspaces')
        await removeThreadWorktree(
          thread.projectPath,
          workspaceRoot,
          thread.id,
          force,
          process.platform === 'win32' && isManagedProjectWindowsPath(thread.projectPath)
            ? runManagedWslCommand
            : undefined
        )
      } catch (error) {
        if (thread.environmentStatus !== 'error') {
          store.transitionEnvironment(
            thread.id,
            'error',
            error instanceof Error ? error.message : 'Le nettoyage du worktree a échoué.'
          )
        }
        throw error
      }
    }
    const profile = thread.projectPath ? store.getWorkerProfile(thread.projectPath) : null
    if (profile?.mode === 'container' && profile.runtime) await removeWorkerContainer(profile.runtime, thread.id)
    if (thread.projectPath) store.transitionEnvironment(thread.id, 'terminated')
    return store.deleteThread(threadId)
  })
  handle(THREADS_EXPORT_PROJECT_CHANNEL, async (event, input: unknown) => {
    const threadId = requestIdSchema.parse(input)
    const thread = requireActiveProjectThread(event.sender.id, threadId)
    const source = thread.workspacePath ?? thread.projectPath
    if (!source) throw new Error('Ce thread ne possède aucun projet à exporter.')

    const owner = BrowserWindow.fromWebContents(event.sender)
    const options = {
      title: 'Choisir où exporter le projet',
      properties: ['openDirectory', 'createDirectory'] as Array<'openDirectory' | 'createDirectory'>
    }
    const selection = owner
      ? await dialog.showOpenDialog(owner, options)
      : await dialog.showOpenDialog(options)
    if (selection.canceled || !selection.filePaths[0]) return null

    const selectedRoot = resolve(selection.filePaths[0])
    const sourceRoot = resolve(source)
    const selectedFromSource = relative(sourceRoot, selectedRoot)
    if (!selectedFromSource.startsWith('..') && !isAbsolute(selectedFromSource)) {
      throw new Error('Choisissez un dossier situé hors du projet privé.')
    }

    const safeName = (thread.projectName ?? 'Projet')
      .normalize('NFKD')
      .replace(/[^A-Za-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'Projet'
    const destination = join(selectedRoot, `${safeName}-${new Date().toISOString().slice(0, 10)}-${thread.id.slice(0, 8)}`)
    await cp(sourceRoot, destination, {
      recursive: true,
      force: false,
      errorOnExist: true,
      filter: async (currentSource) => {
        const currentRelative = relative(sourceRoot, currentSource)
        if (currentRelative.split(/[\\/]/).includes('.git')) return false
        return !(await lstat(currentSource)).isSymbolicLink()
      }
    })
    const openError = await shell.openPath(destination)
    if (openError) throw new Error(`Le projet est exporté, mais son dossier n’a pas pu être ouvert : ${openError}`)
    return destination
  })
  handle(THREADS_REVIEW_PROJECT_CHANNEL, async (event, input: unknown) => {
    const threadId = requestIdSchema.parse(input)
    const thread = requireActiveProjectThread(event.sender.id, threadId)
    const project = await openThreadProject(thread.id)
    const executionPath = thread.workspacePath ?? thread.projectPath
    const profile = thread.projectPath ? await resolveWorkerProfile(getThreadStore(), thread.projectPath) : null
    const git = executionPath ? await resolveContainerGit(project, executionPath) : null
    const reviewProject = executionPath
      ? createAgentProjectTools(profile, thread.id, executionPath, project, git)
      : project
    const [status, diff] = git
      ? await Promise.all([reviewProject.gitStatus(), reviewProject.gitDiff()])
      : ['', '']
    return {
      status,
      diff,
      workspaceMode: thread.workspaceMode === 'worktree' ? 'worktree' as const : 'direct' as const
    }
  })
  handle(THREADS_LIST_PROJECT_FILES_CHANNEL, async (event, input: unknown) => {
    const threadId = requestIdSchema.parse(input)
    requireActiveProjectThread(event.sender.id, threadId)
    const project = await openThreadProject(threadId)
    const [files, directories] = await Promise.all([project.listFiles(), project.listDirectories()])
    return { files: files.slice(0, 5_000), directories, truncated: files.length > 5_000 }
  })
  handle(THREADS_READ_PROJECT_FILE_CHANNEL, async (event, input: unknown) => {
    const request = projectFileRequestSchema.parse(input)
    requireActiveProjectThread(event.sender.id, request.threadId)
    const preview = await (await openThreadProject(request.threadId)).readFilePreview(request.path)
    return { path: request.path, ...preview }
  })
  handle(THREADS_OPEN_PROJECT_FILE_CHANNEL, async (event, input: unknown) => {
    const request = projectFileRequestSchema.parse(input)
    requireActiveProjectThread(event.sender.id, request.threadId)
    const file = await (await openThreadProject(request.threadId)).resolveFilePath(request.path)
    const error = await shell.openPath(file)
    if (error) throw new Error(error)
  })
  handle(TERMINAL_START_CHANNEL, async (event, input: unknown) => {
    const request = terminalStartSchema.parse(input)
    if (activeThreadOwners.get(event.sender.id) !== request.threadId) {
      throw new Error('Le terminal doit appartenir au thread actuellement sélectionné.')
    }
    const store = getThreadStore()
    const thread = store.getThread(request.threadId)
    if (!thread) throw new Error('Le thread local est introuvable.')
    const project = await openThreadProject(thread.id)
    const cwd = thread.workspacePath ?? thread.projectPath
    if (!cwd || !thread.projectPath) {
      throw new Error('Un projet actif est requis pour ouvrir le terminal.')
    }
    const profile = await resolveWorkerProfile(store, thread.projectPath)
    if (profile.mode === 'container' && profile.runtime) {
      const git = await resolveContainerGit(project, cwd)
      await ensureWorkerContainer({
        runtime: profile.runtime,
        threadId: thread.id,
        projectPath: cwd,
        image: profile.image,
        cpuLimit: profile.cpuLimit,
        memoryLimit: `${profile.memoryMb}m`,
        network: profile.network,
        gitDirectory: git?.directory,
        gitCommonDirectory: git?.commonDirectory
      })
    }
    return terminalManager.start({
      ...request,
      ownerId: event.sender.id,
      cwd,
      profile
    })
  })
  handle(TERMINAL_WRITE_CHANNEL, (event, input: unknown) => {
    const request = terminalWriteSchema.parse(input)
    if (activeThreadOwners.get(event.sender.id) !== request.threadId) {
      throw new Error('Ce terminal n’appartient plus au thread sélectionné.')
    }
    terminalManager.write(request.threadId, event.sender.id, request.data)
  })
  handle(TERMINAL_RESIZE_CHANNEL, (event, input: unknown) => {
    const request = terminalResizeSchema.parse(input)
    if (activeThreadOwners.get(event.sender.id) !== request.threadId) {
      throw new Error('Ce terminal n’appartient plus au thread sélectionné.')
    }
    terminalManager.resize(request.threadId, event.sender.id, request.cols, request.rows)
  })
  handle(TERMINAL_CLOSE_CHANNEL, (event, input: unknown) => {
    const threadId = requestIdSchema.parse(input)
    return terminalManager.close(threadId, event.sender.id)
  })
  handle(PORTAL_GET_CHANNEL, (event, input: unknown) => {
    const threadId = requestIdSchema.parse(input)
    requireActiveProjectThread(event.sender.id, threadId)
    return portalManager.get(threadId, event.sender.id)
  })
  handle(PORTAL_START_CHANNEL, async (event, input: unknown) => {
    const request = portalStartSchema.parse(input)
    const thread = requireActiveProjectThread(event.sender.id, request.threadId)
    if (request.source === 'project') {
      const root = thread.workspacePath ?? thread.projectPath
      if (!root) throw new Error('Le dossier du projet est indisponible.')
      return portalManager.startProject(request.threadId, event.sender.id, root, request.durationMinutes)
    }
    return portalManager.start(
      request.threadId,
      event.sender.id,
      request.port,
      request.durationMinutes
    )
  })
  handle(PORTAL_STOP_CHANNEL, (event, input: unknown) => {
    const threadId = requestIdSchema.parse(input)
    requireActiveProjectThread(event.sender.id, threadId)
    return portalManager.close(threadId, event.sender.id)
  })
  handle(PORTAL_COPY_URL_CHANNEL, (event, input: unknown) => {
    const threadId = requestIdSchema.parse(input)
    requireActiveProjectThread(event.sender.id, threadId)
    const portal = portalManager.get(threadId, event.sender.id)
    if (!portal) throw new Error('Aucun portail actif pour ce thread.')
    clipboard.writeText(portal.url)
  })
  handle(PORTAL_OPEN_CHANNEL, async (event, input: unknown) => {
    const threadId = requestIdSchema.parse(input)
    requireActiveProjectThread(event.sender.id, threadId)
    const portal = portalManager.get(threadId, event.sender.id)
    if (!portal) throw new Error('Aucun portail actif pour ce thread.')
    await shell.openExternal(portal.url)
  })
  handle(CHAT_START_CHANNEL, async (_event, input: unknown) => {
    const parsed = chatRequestSchema.safeParse(input)
    if (!parsed.success) {
      throw new Error('La demande de conversation est invalide.')
    }
    if (activeChats.has(parsed.data.requestId)) {
      throw new Error('Cette génération est déjà active.')
    }

    const store = getThreadStore()
    const thread = store.getThread(parsed.data.threadId)
    if (!thread) throw new Error('Le thread local est introuvable.')
    if (!thread.projectPath || parsed.data.projectPath !== thread.projectPath) {
      throw new Error('Cette conversation doit appartenir au projet actuellement ouvert.')
    }
    if (thread.environmentStatus !== 'active') {
      throw new Error(thread.environmentError ?? 'L’environnement de ce thread n’est pas actif.')
    }
    const profile = await resolveWorkerProfile(store, thread.projectPath)
    if (profile?.mode === 'container') {
      const runtime = await getRuntimeInfo()
      if (!profile.runtime || !runtime[profile.runtime].available) {
        throw new Error(`Le runtime ${profile.runtime ?? 'conteneur'} n’est pas disponible.`)
      }
    }
    const latestUserMessage = [...parsed.data.messages].reverse().find((message) => message.role === 'user')
    if (!latestUserMessage) throw new Error('La demande ne contient aucun nouveau message utilisateur.')
    const run = store.startAgentRun(thread.id, parsed.data.requestId, parsed.data.model, latestUserMessage.content)
    try {
      await scheduleAgentRun(run)
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'La génération n’a pas pu être planifiée.'
      store.finishAgentRun(run.id, 'error', '', reason)
      sendChatEvent(run, { type: 'error', reason })
      throw error
    }
    return toPublicRunSummary(store.listAgentRunSummaries(thread.id).find(
      (summary) => summary.requestId === run.requestId
    ) as StoredAgentRunSummary)
  })
  handle(CHAT_CANCEL_CHANNEL, (_event, input: unknown) => {
    const parsed = requestIdSchema.safeParse(input)
    if (!parsed.success) return
    const state = workerScheduler.cancel(parsed.data)
    if (state !== 'queued') activeChats.get(parsed.data)?.abort()
  })
  handle(CHAT_LIST_ACTIVE_CHANNEL, () => getThreadStore().listActiveAgentRuns().map((run) => ({
    requestId: run.requestId,
    threadId: run.threadId,
    status: run.status as 'queued' | 'running'
  })))
  handle(CHAT_LIST_THREAD_RUNS_CHANNEL, (_event, input: unknown) => {
    const threadId = requestIdSchema.parse(input)
    if (!getThreadStore().getThread(threadId)) throw new Error('Le thread local est introuvable.')
    return getThreadStore().listAgentRunSummaries(threadId).map(toPublicRunSummary)
  })
  handle(CHAT_UPDATE_QUEUED_CHANNEL, (_event, input: unknown) => {
    const request = updateQueuedMessageSchema.parse(input)
    const store = getThreadStore()
    const run = store.listActiveAgentRuns().find((candidate) => candidate.requestId === request.requestId)
    if (run && store.getThread(run.threadId)?.parentThreadId) {
      throw new Error('La file d’attente d’un worker est gérée automatiquement.')
    }
    return toPublicRunSummary(store.updateQueuedAgentRun(request.requestId, request.content))
  })
  handle(CHAT_DELETE_QUEUED_CHANNEL, (_event, input: unknown) => {
    const requestId = requestIdSchema.parse(input)
    const store = getThreadStore()
    const run = store.listActiveAgentRuns().find((candidate) => candidate.requestId === requestId)
    if (run && store.getThread(run.threadId)?.parentThreadId) {
      throw new Error('La file d’attente d’un worker est gérée automatiquement.')
    }
    if (workerScheduler.has(requestId) && !workerScheduler.removeQueued(requestId)) return false
    return store.deleteQueuedAgentRun(requestId)
  })
  handle(CHAT_SEND_NOW_CHANNEL, async (_event, input: unknown) => {
    const requestId = requestIdSchema.parse(input)
    const store = getThreadStore()
    const activeRun = store.listActiveAgentRuns().find((candidate) => candidate.requestId === requestId)
    if (activeRun && store.getThread(activeRun.threadId)?.parentThreadId) {
      throw new Error('La file d’attente d’un worker est gérée automatiquement.')
    }
    const run = store.prioritizeQueuedAgentRun(requestId)
    if (!workerScheduler.has(requestId)) await scheduleAgentRun(run)
    workerScheduler.prioritize(requestId)
    const activeRequestId = activeThreadChats.get(run.threadId)
    if (activeRequestId && activeRequestId !== requestId) activeChats.get(activeRequestId)?.abort()
  })
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', (event) => {
  if (shutdownReady) return
  event.preventDefault()
  workerScheduler.shutdown(true)
  for (const controller of activeChats.values()) controller.abort()
  shutdownCleanup ??= Promise.all([
    portalManager.closeAll(),
    terminalManager.closeAll(),
    stopManagedWslRuntime(),
    ...pendingWindowCleanups
  ]).then(() => undefined)
  void shutdownCleanup
    .catch((error: unknown) => console.error(
      'Application resource cleanup failed:',
      error instanceof Error ? error.message : 'unknown error'
    ))
    .finally(() => {
      shutdownReady = true
      app.quit()
    })
})

app.on('will-quit', () => {
  ipcMain.removeHandler(WINDOW_MINIMIZE_CHANNEL)
  ipcMain.removeHandler(WINDOW_TOGGLE_MAXIMIZE_CHANNEL)
  ipcMain.removeHandler(WINDOW_CLOSE_CHANNEL)
  ipcMain.removeHandler(OLLAMA_STATUS_CHANNEL)
  ipcMain.removeHandler(OLLAMA_START_CHANNEL)
  ipcMain.removeHandler(SETUP_INFO_CHANNEL)
  ipcMain.removeHandler(OLLAMA_DOWNLOAD_CHANNEL)
  ipcMain.removeHandler(MODEL_PULL_CHANNEL)
  ipcMain.removeHandler(DICTATION_TRANSCRIBE_CHANNEL)
  ipcMain.removeHandler(PROJECT_SELECT_CHANNEL)
  ipcMain.removeHandler(CHAT_START_CHANNEL)
  ipcMain.removeHandler(CHAT_CANCEL_CHANNEL)
  ipcMain.removeHandler(CHAT_LIST_ACTIVE_CHANNEL)
  ipcMain.removeHandler(CHAT_LIST_THREAD_RUNS_CHANNEL)
  ipcMain.removeHandler(CHAT_UPDATE_QUEUED_CHANNEL)
  ipcMain.removeHandler(CHAT_DELETE_QUEUED_CHANNEL)
  ipcMain.removeHandler(CHAT_SEND_NOW_CHANNEL)
  ipcMain.removeHandler(THREADS_LIST_CHANNEL)
  ipcMain.removeHandler(THREADS_SET_ACTIVE_CHANNEL)
  ipcMain.removeHandler(THREADS_CREATE_CHANNEL)
  ipcMain.removeHandler(THREADS_MESSAGES_CHANNEL)
  ipcMain.removeHandler(THREADS_DELETE_CHANNEL)
  ipcMain.removeHandler(THREADS_EXPORT_PROJECT_CHANNEL)
  ipcMain.removeHandler(THREADS_REVIEW_PROJECT_CHANNEL)
  ipcMain.removeHandler(THREADS_LIST_PROJECT_FILES_CHANNEL)
  ipcMain.removeHandler(THREADS_READ_PROJECT_FILE_CHANNEL)
  ipcMain.removeHandler(THREADS_OPEN_PROJECT_FILE_CHANNEL)
  ipcMain.removeHandler(TERMINAL_START_CHANNEL)
  ipcMain.removeHandler(TERMINAL_WRITE_CHANNEL)
  ipcMain.removeHandler(TERMINAL_RESIZE_CHANNEL)
  ipcMain.removeHandler(TERMINAL_CLOSE_CHANNEL)
  ipcMain.removeHandler(PORTAL_GET_CHANNEL)
  ipcMain.removeHandler(PORTAL_START_CHANNEL)
  ipcMain.removeHandler(PORTAL_STOP_CHANNEL)
  ipcMain.removeHandler(PORTAL_COPY_URL_CHANNEL)
  ipcMain.removeHandler(PORTAL_OPEN_CHANNEL)
  workerScheduler.shutdown(true)
  for (const controller of activeChats.values()) controller.abort()
  activeChats.clear()
  threadStore?.recoverInterruptedAgentRuns()
  threadStore?.close()
  threadStore = null
})
