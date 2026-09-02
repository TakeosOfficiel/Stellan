import { contextBridge, ipcRenderer } from 'electron'
import type {
  ChatEvent,
  LocalAgentApi,
  ModelPullProgress,
  TerminalEvent
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
  listActiveRuns: () => ipcRenderer.invoke('chat:list-active'),
  onChatEvent: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, chatEvent: ChatEvent): void => {
      listener(chatEvent)
    }
    ipcRenderer.on('chat:event', handler)
    return () => ipcRenderer.removeListener('chat:event', handler)
  },
  listThreads: () => ipcRenderer.invoke('threads:list'),
  setActiveThread: (threadId) => ipcRenderer.invoke('threads:set-active', threadId),
  createThread: (request) => ipcRenderer.invoke('threads:create', request),
  loadThreadMessages: (threadId) => ipcRenderer.invoke('threads:messages', threadId),
  deleteThread: (threadId) => ipcRenderer.invoke('threads:delete', threadId),
  reviewThreadProject: (threadId) => ipcRenderer.invoke('threads:review-project', threadId),
  startTerminal: (request) => ipcRenderer.invoke('terminal:start', request),
  writeTerminal: (threadId, data) => ipcRenderer.invoke('terminal:write', { threadId, data }),
  resizeTerminal: (threadId, cols, rows) => ipcRenderer.invoke('terminal:resize', { threadId, cols, rows }),
  closeTerminal: (threadId) => ipcRenderer.invoke('terminal:close', threadId),
  onTerminalEvent: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, terminalEvent: TerminalEvent): void => {
      listener(terminalEvent)
    }
    ipcRenderer.on('terminal:event', handler)
    return () => ipcRenderer.removeListener('terminal:event', handler)
  },
  getPortal: (threadId) => ipcRenderer.invoke('portal:get', threadId),
  startPortal: (request) => ipcRenderer.invoke('portal:start', request),
  stopPortal: (threadId) => ipcRenderer.invoke('portal:stop', threadId),
  copyPortalUrl: (threadId) => ipcRenderer.invoke('portal:copy-url', threadId),
  openPortal: (threadId) => ipcRenderer.invoke('portal:open', threadId)
}

contextBridge.exposeInMainWorld('localAgent', api)
