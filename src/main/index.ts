import { basename, join } from 'node:path'
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, shell } from 'electron'
import { z } from 'zod'
import { compactConversation, runCodingAgent, type AgentToolLifecycleEvent } from './agent'
import { getHardwareInfo } from './hardware'
import { isTrustedMainFrame } from './ipc-security'
import { getModelCatalog, isCatalogModel } from './model-catalog'
import { getOllamaStatus, modelSupportsTools, pullOllamaModel, streamOllamaChat } from './ollama'
import { startOllamaServer } from './ollama-process'
import { assertPortalAccess, PortalManager } from './portal'
import { ProjectTools } from './project-tools'
import { createThreadWorktree, getRuntimeInfo, removeThreadWorktree } from './runtime'
import { ThreadStore, type AgentRun, type AgentRunSummary as StoredAgentRunSummary } from './storage'
import { TerminalManager } from './terminal'
import { createWorkerCommandExecutor } from './worker-runtime'
import { WorkerScheduler } from './worker-scheduler'

const OLLAMA_STATUS_CHANNEL = 'ollama:get-status'
const OLLAMA_START_CHANNEL = 'ollama:start'
const SETUP_INFO_CHANNEL = 'setup:get-info'
const OLLAMA_DOWNLOAD_CHANNEL = 'ollama:open-download'
const MODEL_PULL_CHANNEL = 'ollama:pull-model'
const MODEL_PULL_PROGRESS_CHANNEL = 'ollama:pull-progress'
const PROJECT_SELECT_CHANNEL = 'project:select'
const WORKER_PROFILE_GET_CHANNEL = 'worker-profile:get'
const WORKER_PROFILE_SAVE_CHANNEL = 'worker-profile:save'
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
const THREADS_REVIEW_PROJECT_CHANNEL = 'threads:review-project'
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
const OLLAMA_DOWNLOAD_URL = 'https://ollama.com/download'

const modelIdSchema = z.string().min(1).max(100).refine(isCatalogModel)
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
const portalStartSchema = z.object({
  threadId: z.uuid(),
  port: z.number().int().min(1).max(65_535)
})
const createThreadSchema = z.object({
  title: z.string().trim().min(1).max(200),
  projectPath: z.string().min(1).max(10_000).nullable(),
  model: z.string().min(1).max(200).nullable()
})
const workerProfileSchema = z.object({
  projectPath: z.string().min(1).max(10_000),
  mode: z.enum(['direct', 'container']),
  runtime: z.enum(['docker', 'podman']).nullable(),
  cpuLimit: z.number().min(0.5).max(128),
  memoryMb: z.number().int().min(512).max(1_048_576),
  image: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._/:@-]*$/).max(300),
  network: z.enum(['none', 'bridge']),
  maxConcurrentWorkers: z.number().int().min(1).max(32)
}).superRefine((profile, context) => {
  if (profile.mode === 'container' && !profile.runtime) {
    context.addIssue({ code: 'custom', message: 'Un runtime est requis pour le mode conteneur.' })
  }
  if (profile.mode === 'direct' && profile.runtime) {
    context.addIssue({ code: 'custom', message: 'Le mode direct ne doit pas définir de runtime.' })
  }
})
let activeDownload: string | null = null
const activeChats = new Map<string, AbortController>()
const activeThreadChats = new Map<string, string>()
const workerScheduler = new WorkerScheduler()
const activeThreadOwners = new Map<number, string>()
const approvedProjectPaths = new Set<string>()
let recoveredQueueScheduled = false
let threadStore: ThreadStore | null = null
let mainWindow: BrowserWindow | null = null
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

function requireActiveProjectThread(ownerId: number, threadId: string) {
  const thread = getThreadStore().getThread(threadId)
  assertPortalAccess(activeThreadOwners.get(ownerId), threadId, thread)
  return thread
}

async function defaultWorkerProfile(projectPath: string) {
  const hardware = await getHardwareInfo()
  const cpuLimit = Math.max(1, Math.min(4, Math.floor(hardware.cpuCores / 2)))
  const memoryMb = Math.max(1024, Math.min(8192, Math.floor(hardware.totalMemoryBytes / 4 / 1_000_000)))
  return {
    projectPath,
    mode: 'direct' as const,
    runtime: null,
    cpuLimit,
    memoryMb,
    image: 'node:22-bookworm',
    network: 'none' as const,
    maxConcurrentWorkers: Math.max(1, Math.min(
      2,
      Math.floor(hardware.cpuCores / cpuLimit),
      Math.floor(hardware.totalMemoryBytes / 1_000_000 / memoryMb)
    ))
  }
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
  const profile = thread.projectPath
    ? store.getWorkerProfile(thread.projectPath) ?? store.saveWorkerProfile(await defaultWorkerProfile(thread.projectPath))
    : null
  if (thread.projectPath && !profile) throw new Error('Le profil worker du projet est invalide.')
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
    projectKey: thread.projectPath ?? '__local-chat__',
    isolationKey: thread.workspaceMode === 'direct' ? thread.projectPath : null,
    maxConcurrentWorkers: profile?.maxConcurrentWorkers ?? 1,
    cancelQueued: () => {
      store.finishAgentRun(run.id, 'interrupted', '', 'Génération annulée dans la file d’attente.')
      sendChatEvent(run, { type: 'error', reason: 'Génération annulée dans la file d’attente.' })
    },
    run: async () => {
      activeChats.set(run.requestId, controller)
      activeThreadChats.set(thread.id, run.requestId)
      let assistantContent = ''
      let toolAssistantCharacters = 0
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
          const project = await openThreadProject(thread.id)
          await runCodingAgent({
            model: run.model,
            messages: promptMessages,
            project,
            signal: controller.signal,
            onContent,
            onTool: (tool, status) => sendChatEvent(run, { type: 'tool', tool, status }),
            onToolEvent: async (toolEvent: AgentToolLifecycleEvent) => {
              const currentStore = getThreadStore()
              if (toolEvent.type === 'started') {
                currentStore.recordToolStarted(run.id, toolEvent)
                if (toolEvent.callIndex === 0) toolAssistantCharacters += toolEvent.assistantContent.length
              } else {
                currentStore.recordToolFinished(
                  run.id,
                  toolEvent.callId,
                  toolEvent.status,
                  toolEvent.result
                )
              }
            },
            runCommand: createWorkerCommandExecutor(profile, thread.id, executionPath),
            authorize: async (tool, summary) => {
              const owner = mainWindow
              const options = {
                type: 'warning' as const,
                title: 'Autoriser une action',
                message: tool === 'write_file'
                  ? 'Autoriser la modification du projet ?'
                  : 'Autoriser cette commande ?',
                detail: summary,
                buttons: ['Refuser', 'Autoriser'],
                defaultId: 0,
                cancelId: 0,
                noLink: true
              }
              const result = owner
                ? await dialog.showMessageBox(owner, options)
                : await dialog.showMessageBox(options)
              return !controller.signal.aborted && result.response === 1
            }
          })
        } else {
          await streamOllamaChat(
            run.model,
            compactConversation([
              { role: 'system', content: 'Tu es un assistant local utile, précis et concis.' },
              ...promptMessages.filter((message) => message.role !== 'system')
            ]),
            onContent,
            controller.signal
          )
        }
        getThreadStore().finishAgentRun(
          run.id,
          'completed',
          assistantContent.slice(toolAssistantCharacters)
        )
        sendChatEvent(run, { type: 'done' })
      } catch (error) {
        const reason = controller.signal.aborted
          ? 'Génération interrompue.'
          : error instanceof Error ? error.message : 'La génération a échoué.'
        const finalContent = assistantContent.slice(toolAssistantCharacters)
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
  handle(OLLAMA_START_CHANNEL, async () => {
    const started = await startOllamaServer()
    if (!started.success) return { available: false as const, reason: started.reason }

    for (let attempt = 0; attempt < 12; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 500))
      const status = await getOllamaStatus()
      if (status.available) return status
    }
    return {
      available: false as const,
      reason: "Ollama a été lancé mais son service local ne répond toujours pas."
    }
  })
  handle(SETUP_INFO_CHANNEL, async () => {
    const [hardware, runtime] = await Promise.all([getHardwareInfo(), getRuntimeInfo()])
    return { hardware, runtime, models: getModelCatalog(hardware) }
  })
  handle(OLLAMA_DOWNLOAD_CHANNEL, async () => {
    await shell.openExternal(OLLAMA_DOWNLOAD_URL)
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
  handle(PROJECT_SELECT_CHANNEL, async () => {
    const result = await dialog.showOpenDialog({
      title: 'Choisir un projet',
      properties: ['openDirectory', 'createDirectory']
    })
    if (result.canceled || !result.filePaths[0]) return null
    const path = result.filePaths[0]
    approvedProjectPaths.add(path)
    return { path, name: basename(path) }
  })
  handle(WORKER_PROFILE_GET_CHANNEL, async (_event, input: unknown) => {
    const projectPath = z.string().min(1).max(10_000).parse(input)
    if (!isApprovedProject(projectPath)) throw new Error('Ce projet n’est pas autorisé.')
    const store = getThreadStore()
    return store.getWorkerProfile(projectPath) ?? store.saveWorkerProfile(await defaultWorkerProfile(projectPath))
  })
  handle(WORKER_PROFILE_SAVE_CHANNEL, async (_event, input: unknown) => {
    const profile = workerProfileSchema.parse(input)
    if (!isApprovedProject(profile.projectPath)) throw new Error('Ce projet n’est pas autorisé.')
    if (profile.mode === 'container') {
      const runtime = await getRuntimeInfo()
      if (!profile.runtime || !runtime[profile.runtime].available) {
        throw new Error(`Le runtime ${profile.runtime ?? 'conteneur'} n’est pas disponible.`)
      }
    }
    const saved = getThreadStore().saveWorkerProfile(profile)
    workerScheduler.updateProjectLimit(profile.projectPath, profile.maxConcurrentWorkers)
    return saved
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
    const store = getThreadStore()
    const isPersistedProject = parsed.projectPath && store.listThreads().some(
      (thread) => thread.projectPath === parsed.projectPath
    )
    if (parsed.projectPath && !approvedProjectPaths.has(parsed.projectPath) && !isPersistedProject) {
      throw new Error('Ce projet doit être choisi avec le sélecteur de dossier.')
    }
    const thread = store.createThread(parsed)
    if (!parsed.projectPath) return thread

    let workspacePath: string
    try {
      workspacePath = await createThreadWorktree(
        parsed.projectPath,
        join(app.getPath('userData'), 'workspaces'),
        thread.id
      )
    } catch (error) {
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
    if (workerScheduler.hasThread(threadId)) {
      throw new Error('Arrêtez la génération avant de supprimer ce thread.')
    }
    await portalManager.close(threadId, event.sender.id)
    await terminalManager.close(threadId, event.sender.id)
    if (thread.environmentStatus === 'terminated') return store.deleteThread(threadId)
    if (thread.projectPath && thread.workspacePath) {
      const project = thread.environmentStatus === 'active'
        ? await openThreadProject(thread.id)
        : await ProjectTools.create(thread.workspacePath)
      const status = await project.gitStatus()
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
        await removeThreadWorktree(
          thread.projectPath,
          join(app.getPath('userData'), 'workspaces'),
          thread.id,
          force
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
    if (thread.projectPath) store.transitionEnvironment(thread.id, 'terminated')
    return store.deleteThread(threadId)
  })
  handle(THREADS_REVIEW_PROJECT_CHANNEL, async (_event, input: unknown) => {
    const threadId = requestIdSchema.parse(input)
    const thread = getThreadStore().getThread(threadId)
    if (!thread || !thread.projectPath) return null
    const project = await openThreadProject(thread.id)
    const [status, diff] = await Promise.all([project.gitStatus(), project.gitDiff()])
    return {
      status,
      diff,
      workspaceMode: thread.workspaceMode === 'worktree' ? 'worktree' as const : 'direct' as const
    }
  })
  handle(TERMINAL_START_CHANNEL, async (event, input: unknown) => {
    const request = terminalStartSchema.parse(input)
    if (activeThreadOwners.get(event.sender.id) !== request.threadId) {
      throw new Error('Le terminal doit appartenir au thread actuellement sélectionné.')
    }
    const store = getThreadStore()
    const thread = store.getThread(request.threadId)
    if (!thread) throw new Error('Le thread local est introuvable.')
    await openThreadProject(thread.id)
    const cwd = thread.workspacePath ?? thread.projectPath
    if (!cwd || !thread.projectPath) {
      throw new Error('Un projet actif est requis pour ouvrir le terminal.')
    }
    const profile = store.getWorkerProfile(thread.projectPath)
      ?? store.saveWorkerProfile(await defaultWorkerProfile(thread.projectPath))
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
    requireActiveProjectThread(event.sender.id, request.threadId)
    return portalManager.start(request.threadId, event.sender.id, request.port)
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
    if (thread.environmentStatus !== 'active' && thread.projectPath) {
      throw new Error(thread.environmentError ?? 'L’environnement de ce thread n’est pas actif.')
    }
    const profile = thread.projectPath
      ? store.getWorkerProfile(thread.projectPath) ?? store.saveWorkerProfile(await defaultWorkerProfile(thread.projectPath))
      : null
    if (thread.projectPath && !profile) throw new Error('Le profil worker du projet est invalide.')
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
    if (state === 'running') activeChats.get(parsed.data)?.abort()
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
    return toPublicRunSummary(getThreadStore().updateQueuedAgentRun(request.requestId, request.content))
  })
  handle(CHAT_DELETE_QUEUED_CHANNEL, (_event, input: unknown) => {
    const requestId = requestIdSchema.parse(input)
    if (workerScheduler.has(requestId) && !workerScheduler.removeQueued(requestId)) return false
    return getThreadStore().deleteQueuedAgentRun(requestId)
  })
  handle(CHAT_SEND_NOW_CHANNEL, async (_event, input: unknown) => {
    const requestId = requestIdSchema.parse(input)
    const store = getThreadStore()
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
  shutdownCleanup ??= Promise.all([
    portalManager.closeAll(),
    terminalManager.closeAll(),
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
  ipcMain.removeHandler(PROJECT_SELECT_CHANNEL)
  ipcMain.removeHandler(WORKER_PROFILE_GET_CHANNEL)
  ipcMain.removeHandler(WORKER_PROFILE_SAVE_CHANNEL)
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
  ipcMain.removeHandler(THREADS_REVIEW_PROJECT_CHANNEL)
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
