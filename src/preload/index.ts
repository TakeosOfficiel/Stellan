import { contextBridge, ipcRenderer } from 'electron'
import type { LocalAgentApi } from '../shared/contracts'

const api: LocalAgentApi = {
  getOllamaStatus: () => ipcRenderer.invoke('ollama:get-status')
}

contextBridge.exposeInMainWorld('localAgent', api)
