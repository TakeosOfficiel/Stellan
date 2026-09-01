import { basename, join } from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { z } from 'zod'
import { runCodingAgent } from './agent'
import { getHardwareInfo } from './hardware'
import { getModelCatalog, isCatalogModel } from './model-catalog'
import { getOllamaStatus, pullOllamaModel, streamOllamaChat } from './ollama'
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
let threadStore: ThreadStore | null = null

function getThreadStore(): ThreadStore {
  if (!threadStore) throw new Error('Le stockage local n’est pas prêt.')
  return threadStore
}

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 880,
    minHeight: 600,
    backgroundColor: '#0c0d10',
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  window.once('ready-to-show', () => window.show())

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  threadStore = new ThreadStore(join(app.getPath('userData'), 'local-agent.sqlite'))
  ipcMain.handle(OLLAMA_STATUS_CHANNEL, () => getOllamaStatus())
  ipcMain.handle(SETUP_INFO_CHANNEL, async () => {
    const hardware = await getHardwareInfo()
    return { hardware, models: getModelCatalog(hardware) }
  })
  ipcMain.handle(OLLAMA_DOWNLOAD_CHANNEL, async () => {
    await shell.openExternal(OLLAMA_DOWNLOAD_URL)
  })
  ipcMain.handle(MODEL_PULL_CHANNEL, async (event, input: unknown) => {
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
  ipcMain.handle(PROJECT_SELECT_CHANNEL, async () => {
    const result = await dialog.showOpenDialog({
      title: 'Choisir un projet',
      properties: ['openDirectory', 'createDirectory']
    })
    if (result.canceled || !result.filePaths[0]) return null
    const path = result.filePaths[0]
    return { path, name: basename(path) }
  })
  ipcMain.handle(THREADS_LIST_CHANNEL, () => getThreadStore().listThreads())
  ipcMain.handle(THREADS_CREATE_CHANNEL, async (_event, input: unknown) => {
    const parsed = createThreadSchema.parse(input)
    const store = getThreadStore()
    const thread = store.createThread(parsed)
    if (!parsed.projectPath) return thread

    try {
      const workspacePath = await createThreadWorktree(
        parsed.projectPath,
        join(app.getPath('userData'), 'workspaces'),
        thread.id
      )
      return store.updateThread(thread.id, { workspacePath }) ?? thread
    } catch {
      return thread
    }
  })
  ipcMain.handle(THREADS_MESSAGES_CHANNEL, (_event, input: unknown) => {
    const threadId = requestIdSchema.parse(input)
    return getThreadStore().listMessages(threadId)
  })
  ipcMain.handle(THREADS_DELETE_CHANNEL, async (_event, input: unknown) => {
    const threadId = requestIdSchema.parse(input)
    const store = getThreadStore()
    const thread = store.getThread(threadId)
    if (!thread) return false
    if (thread.projectPath && thread.workspacePath) {
      await removeThreadWorktree(
        thread.projectPath,
        join(app.getPath('userData'), 'workspaces'),
        thread.id
      )
    }
    return store.deleteThread(threadId)
  })
  ipcMain.handle(CHAT_START_CHANNEL, async (event, input: unknown) => {
    const parsed = chatRequestSchema.safeParse(input)
    if (!parsed.success) {
      throw new Error('La demande de conversation est invalide.')
    }
    if (activeChats.has(parsed.data.requestId)) {
      throw new Error('Cette génération est déjà active.')
    }

    const controller = new AbortController()
    activeChats.set(parsed.data.requestId, controller)
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
      const reason = controller.signal.aborted
        ? 'Génération interrompue.'
        : error instanceof Error ? error.message : 'La génération a échoué.'
      send({ type: 'error', reason })
    } finally {
      activeChats.delete(parsed.data.requestId)
    }
  })
  ipcMain.handle(CHAT_CANCEL_CHANNEL, (_event, input: unknown) => {
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
  for (const controller of activeChats.values()) controller.abort()
  activeChats.clear()
  threadStore?.close()
  threadStore = null
})
