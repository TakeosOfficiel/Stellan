import { contextBridge, ipcRenderer } from 'electron'
import type { LocalAgentApi, ModelPullProgress } from '../shared/contracts'

const api: LocalAgentApi = {
  getOllamaStatus: () => ipcRenderer.invoke('ollama:get-status'),
  getSetupInfo: () => ipcRenderer.invoke('setup:get-info'),
  openOllamaDownload: () => ipcRenderer.invoke('ollama:open-download'),
  pullModel: (model) => ipcRenderer.invoke('ollama:pull-model', model),
  onModelPullProgress: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, progress: ModelPullProgress): void => {
      listener(progress)
    }
    ipcRenderer.on('ollama:pull-progress', handler)
    return () => ipcRenderer.removeListener('ollama:pull-progress', handler)
  }
}

contextBridge.exposeInMainWorld('localAgent', api)
