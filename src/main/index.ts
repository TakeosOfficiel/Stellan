import { basename, join } from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron'
import { z } from 'zod'
import { runCodingAgent } from './agent'
import { getHardwareInfo } from './hardware'
import { getModelCatalog, isCatalogModel } from './model-catalog'
import { getOllamaStatus, modelSupportsTools, pullOllamaModel, streamOllamaChat } from './ollama'
import { ProjectTools } from './project-tools'
import { createThreadWorktree, removeThreadWorktree } from './runtime'
import { ThreadStore } from './storage'

const OLLAMA_STATUS_CHANNEL = 'ollama:get-status'
const SETUP_INFO_CHANNEL = 'setup:get-info'
const OLLAMA_DOWNLOAD_CHANNEL = 'ollama:open-download'
const MODEL_PULL_CHANNEL = 'ollama:pull-model'
const MODEL_PULL_PROGRESS_CHANNEL = 'ollama:pull-progress'
const PROJECT_SELECT_CHANNEL = 'project:select'
const CHAT_START_CHANNEL = 'chat:start'
const CHAT_CANCEL_CHANNEL = 'chat:cancel'
const CHAT_EVENT_CHANNEL = 'chat:event'
const THREADS_LIST_CHANNEL = 'threads:list'
const THREADS_CREATE_CHANNEL = 'threads:create'
const THREADS_MESSAGES_CHANNEL = 'threads:messages'
const THREADS_DELETE_CHANNEL = 'threads:delete'
const THREADS_REVIEW_PROJECT_CHANNEL = 'threads:review-project'
const WINDOW_MINIMIZE_CHANNEL = 'window:minimize'
const WINDOW_TOGGLE_MAXIMIZE_CHANNEL = 'window:toggle-maximize'
const WINDOW_CLOSE_CHANNEL = 'window:close'
const OLLAMA_DOWNLOAD_URL = 'https://ollama.com/download'

const modelIdSchema = z.string().min(1).max(100).refine(isCatalogModel)
const chatRequestSchema = z.object({
  requestId: z.uuid(),
  threadId: z.uuid().nullable(),
  model: z.string().min(1).max(200),
  projectPath: z.string().min(1).max(10_000).nullable(),
  messages: z.array(z.object({
    role: z.enum(['system', 'user', 'assistant', 'tool']),
    content: z.string().max(200_000)
  })).min(1).max(200)
})
const requestIdSchema = z.uuid()
const createThreadSchema = z.object({
  title: z.string().trim().min(1).max(200),
  projectPath: z.string().min(1).max(10_000).nullable(),
  model: z.string().min(1).max(200).nullable()
})
let activeDownload: string | null = null
const activeChats = new Map<string, AbortController>()
const activeThreadChats = new Map<string, string>()
const approvedProjectPaths = new Set<string>()
let threadStore: ThreadStore | null = null
let mainWindow: BrowserWindow | null = null

function getThreadStore(): ThreadStore {
  if (!threadStore) throw new Error('Le stockage local n’est pas prêt.')
  return threadStore
}

function handle<T extends unknown[], R>(
  channel: string,
  listener: (event: Electron.IpcMainInvokeEvent, ...args: T) => R
): void {
  ipcMain.handle(channel, (event, ...args) => {
    if (
      !mainWindow ||
      event.sender !== mainWindow.webContents ||
      event.senderFrame !== event.sender.mainFrame
    ) {
      throw new Error('Appel IPC refusé.')
    }
    return listener(event, ...(args as T))
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
  window.once('closed', () => {
    if (mainWindow === window) mainWindow = null
  })

  window.once('ready-to-show', () => window.show())

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
  handle(WINDOW_MINIMIZE_CHANNEL, () => mainWindow?.minimize())
  handle(WINDOW_TOGGLE_MAXIMIZE_CHANNEL, () => {
    if (!mainWindow) return
    if (mainWindow.isMaximized()) mainWindow.unmaximize()
    else mainWindow.maximize()
  })
  handle(WINDOW_CLOSE_CHANNEL, () => mainWindow?.close())
  handle(OLLAMA_STATUS_CHANNEL, () => getOllamaStatus())
  handle(SETUP_INFO_CHANNEL, async () => {
    const hardware = await getHardwareInfo()
    return { hardware, models: getModelCatalog(hardware) }
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
  handle(THREADS_LIST_CHANNEL, () => getThreadStore().listThreads())
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

    try {
      const workspacePath = await createThreadWorktree(
        parsed.projectPath,
        join(app.getPath('userData'), 'workspaces'),
        thread.id
      )
      return store.updateThread(thread.id, {
        workspacePath,
        workspaceMode: 'worktree'
      }) ?? thread
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
        store.deleteThread(thread.id)
        throw new Error('Création annulée : l’isolation Git est indisponible.')
      }
      return store.updateThread(thread.id, { workspaceMode: 'direct' }) ?? thread
    }
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
    if (activeThreadChats.has(threadId)) {
      throw new Error('Arrêtez la génération avant de supprimer ce thread.')
    }
    if (thread.projectPath && thread.workspacePath) {
      const project = await ProjectTools.create(thread.workspacePath)
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
      await removeThreadWorktree(
        thread.projectPath,
        join(app.getPath('userData'), 'workspaces'),
        thread.id,
        force
      )
    }
    return store.deleteThread(threadId)
  })
  handle(THREADS_REVIEW_PROJECT_CHANNEL, async (_event, input: unknown) => {
    const threadId = requestIdSchema.parse(input)
    const thread = getThreadStore().getThread(threadId)
    const executionPath = thread?.workspacePath ?? thread?.projectPath
    if (!thread || !executionPath) return null
    const project = await ProjectTools.create(executionPath)
    const [status, diff] = await Promise.all([project.gitStatus(), project.gitDiff()])
    return {
      status,
      diff,
      workspaceMode: thread.workspaceMode === 'worktree' ? 'worktree' as const : 'direct' as const
    }
  })
  handle(CHAT_START_CHANNEL, async (event, input: unknown) => {
    const parsed = chatRequestSchema.safeParse(input)
    if (!parsed.success) {
      throw new Error('La demande de conversation est invalide.')
    }
    if (activeChats.has(parsed.data.requestId)) {
      throw new Error('Cette génération est déjà active.')
    }
    if (parsed.data.threadId && activeThreadChats.has(parsed.data.threadId)) {
      throw new Error('Ce thread exécute déjà une génération.')
    }

    const controller = new AbortController()
    activeChats.set(parsed.data.requestId, controller)
    if (parsed.data.threadId) {
      activeThreadChats.set(parsed.data.threadId, parsed.data.requestId)
    }
    let assistantContent = ''
    const send = (payload: object): void => {
      if (!event.sender.isDestroyed()) {
        event.sender.send(CHAT_EVENT_CHANNEL, { requestId: parsed.data.requestId, ...payload })
      }
    }

    try {
      let executionPath = parsed.data.projectPath
      if (parsed.data.threadId) {
        const store = getThreadStore()
        const thread = store.getThread(parsed.data.threadId)
        if (!thread) throw new Error('Le thread local est introuvable.')
        executionPath = thread.workspacePath ?? thread.projectPath
        const latestUserMessage = [...parsed.data.messages].reverse().find((message) => message.role === 'user')
        if (latestUserMessage) store.appendMessage(parsed.data.threadId, latestUserMessage)
        store.updateThread(parsed.data.threadId, {
          model: parsed.data.model
        })
      }

      const onContent = (content: string): void => {
        assistantContent += content
        send({ type: 'content', content })
      }
      if (executionPath) {
        if (!await modelSupportsTools(parsed.data.model)) {
          throw new Error('Ce modèle ne prend pas en charge les outils nécessaires aux projets de code.')
        }
        const project = await ProjectTools.create(executionPath)
        await runCodingAgent({
          model: parsed.data.model,
          messages: parsed.data.messages,
          project,
          signal: controller.signal,
          onContent,
          onTool: (tool, status) => send({ type: 'tool', tool, status }),
          authorize: async (tool, summary) => {
            const owner = BrowserWindow.fromWebContents(event.sender)
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
            if (controller.signal.aborted) return false
            return result.response === 1
          }
        })
      } else {
        await streamOllamaChat(
          parsed.data.model,
          parsed.data.messages,
          onContent,
          controller.signal
        )
      }
      if (parsed.data.threadId && assistantContent) {
        getThreadStore().appendMessage(parsed.data.threadId, {
          role: 'assistant',
          content: assistantContent
        })
      }
      send({ type: 'done' })
    } catch (error) {
      if (parsed.data.threadId && assistantContent) {
        getThreadStore().appendMessage(parsed.data.threadId, {
          role: 'assistant',
          content: controller.signal.aborted
            ? `${assistantContent}\n\n[Réponse interrompue]`
            : `${assistantContent}\n\n[Réponse incomplète]`
        })
      }
      const reason = controller.signal.aborted
        ? 'Génération interrompue.'
        : error instanceof Error ? error.message : 'La génération a échoué.'
      send({ type: 'error', reason })
    } finally {
      activeChats.delete(parsed.data.requestId)
      if (parsed.data.threadId) activeThreadChats.delete(parsed.data.threadId)
    }
  })
  handle(CHAT_CANCEL_CHANNEL, (_event, input: unknown) => {
    const parsed = requestIdSchema.safeParse(input)
    if (parsed.success) activeChats.get(parsed.data)?.abort()
  })
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('will-quit', () => {
  ipcMain.removeHandler(WINDOW_MINIMIZE_CHANNEL)
  ipcMain.removeHandler(WINDOW_TOGGLE_MAXIMIZE_CHANNEL)
  ipcMain.removeHandler(WINDOW_CLOSE_CHANNEL)
  ipcMain.removeHandler(OLLAMA_STATUS_CHANNEL)
  ipcMain.removeHandler(SETUP_INFO_CHANNEL)
  ipcMain.removeHandler(OLLAMA_DOWNLOAD_CHANNEL)
  ipcMain.removeHandler(MODEL_PULL_CHANNEL)
  ipcMain.removeHandler(PROJECT_SELECT_CHANNEL)
  ipcMain.removeHandler(CHAT_START_CHANNEL)
  ipcMain.removeHandler(CHAT_CANCEL_CHANNEL)
  ipcMain.removeHandler(THREADS_LIST_CHANNEL)
  ipcMain.removeHandler(THREADS_CREATE_CHANNEL)
  ipcMain.removeHandler(THREADS_MESSAGES_CHANNEL)
  ipcMain.removeHandler(THREADS_DELETE_CHANNEL)
  ipcMain.removeHandler(THREADS_REVIEW_PROJECT_CHANNEL)
  for (const controller of activeChats.values()) controller.abort()
  activeChats.clear()
  threadStore?.close()
  threadStore = null
})
