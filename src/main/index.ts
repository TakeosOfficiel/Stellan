import { join } from 'node:path'
import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { z } from 'zod'
import { getHardwareInfo } from './hardware'
import { getModelCatalog, isCatalogModel } from './model-catalog'
import { getOllamaStatus, pullOllamaModel } from './ollama'

const OLLAMA_STATUS_CHANNEL = 'ollama:get-status'
const SETUP_INFO_CHANNEL = 'setup:get-info'
const OLLAMA_DOWNLOAD_CHANNEL = 'ollama:open-download'
const MODEL_PULL_CHANNEL = 'ollama:pull-model'
const MODEL_PULL_PROGRESS_CHANNEL = 'ollama:pull-progress'
const OLLAMA_DOWNLOAD_URL = 'https://ollama.com/download'

const modelIdSchema = z.string().min(1).max(100).refine(isCatalogModel)
let activeDownload: string | null = null

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
})
