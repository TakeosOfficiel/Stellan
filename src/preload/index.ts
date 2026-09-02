import { contextBridge, ipcRenderer } from 'electron'
import type {
  ChatEvent,
  LocalAgentApi,
  ModelPullProgress
} from '../shared/contracts'

const api: LocalAgentApi = {
  minimizeWindow: () => ipcRenderer.invoke('window:minimize'),
  toggleMaximizeWindow: () => ipcRenderer.invoke('window:toggle-maximize'),
  closeWindow: () => ipcRenderer.invoke('window:close'),
  getOllamaStatus: () => ipcRenderer.invoke('ollama:get-status'),
  startOllama: () => ipcRenderer.invoke('ollama:start'),
  getSetupInfo: () => ipcRenderer.invoke('setup:get-info'),
  openOllamaDownload: () => ipcRenderer.invoke('ollama:open-download'),
  pullModel: (model) => ipcRenderer.invoke('ollama:pull-model', model),
  onModelPullProgress: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, progress: ModelPullProgress): void => {
      listener(progress)
    }
    ipcRenderer.on('ollama:pull-progress', handler)
    return () => ipcRenderer.removeListener('ollama:pull-progress', handler)
  },
  selectProject: () => ipcRenderer.invoke('project:select'),
  getWorkerProfile: (projectPath) => ipcRenderer.invoke('worker-profile:get', projectPath),
  saveWorkerProfile: (profile) => ipcRenderer.invoke('worker-profile:save', profile),
  startChat: (request) => ipcRenderer.invoke('chat:start', request),
  cancelChat: (requestId) => ipcRenderer.invoke('chat:cancel', requestId),
  onChatEvent: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, chatEvent: ChatEvent): void => {
      listener(chatEvent)
    }
    ipcRenderer.on('chat:event', handler)
    return () => ipcRenderer.removeListener('chat:event', handler)
  },
  listThreads: () => ipcRenderer.invoke('threads:list'),
  createThread: (request) => ipcRenderer.invoke('threads:create', request),
  loadThreadMessages: (threadId) => ipcRenderer.invoke('threads:messages', threadId),
  deleteThread: (threadId) => ipcRenderer.invoke('threads:delete', threadId),
  reviewThreadProject: (threadId) => ipcRenderer.invoke('threads:review-project', threadId)
}

contextBridge.exposeInMainWorld('localAgent', api)
