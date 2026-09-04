import { contextBridge, ipcRenderer } from 'electron'
import type {
  ChatEvent,
  DictationProgress,
  LocalAgentApi,
  ModelPullProgress,
  RuntimeProgress,
  TerminalEvent,
  UpdateState
} from '../shared/contracts'

const api: LocalAgentApi = {
  minimizeWindow: () => ipcRenderer.invoke('window:minimize'),
  toggleMaximizeWindow: () => ipcRenderer.invoke('window:toggle-maximize'),
  closeWindow: () => ipcRenderer.invoke('window:close'),
  setStartupWindow: (active) => ipcRenderer.invoke('window:set-startup', active),
  getUpdateState: () => ipcRenderer.invoke('update:get-state'),
  onUpdateState: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, state: UpdateState): void => listener(state)
    ipcRenderer.on('update:state', handler)
    return () => ipcRenderer.removeListener('update:state', handler)
  },
  getOllamaStatus: () => ipcRenderer.invoke('ollama:get-status'),
  startOllama: () => ipcRenderer.invoke('ollama:start'),
  getBasicHardwareInfo: () => ipcRenderer.invoke('hardware:get-basic'),
  getSetupInfo: () => ipcRenderer.invoke('setup:get-info'),
  openOllamaDownload: () => ipcRenderer.invoke('ollama:open-download'),
  onRuntimeProgress: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, progress: RuntimeProgress): void => {
      listener(progress)
    }
    ipcRenderer.on('runtime:progress', handler)
    return () => ipcRenderer.removeListener('runtime:progress', handler)
  },
  pullModel: (model) => ipcRenderer.invoke('ollama:pull-model', model),
  warmModel: (model) => ipcRenderer.invoke('ollama:warm-model', model),
  onModelPullProgress: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, progress: ModelPullProgress): void => {
      listener(progress)
    }
    ipcRenderer.on('ollama:pull-progress', handler)
    return () => ipcRenderer.removeListener('ollama:pull-progress', handler)
  },
  transcribeDictation: (audio) => ipcRenderer.invoke('dictation:transcribe', audio),
  onDictationProgress: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, progress: DictationProgress): void => {
      listener(progress)
    }
    ipcRenderer.on('dictation:progress', handler)
    return () => ipcRenderer.removeListener('dictation:progress', handler)
  },
  selectProject: () => ipcRenderer.invoke('project:select'),
  createProject: (name) => ipcRenderer.invoke('project:create', name),
  startChat: (request) => ipcRenderer.invoke('chat:start', request),
  cancelChat: (requestId) => ipcRenderer.invoke('chat:cancel', requestId),
  listActiveRuns: () => ipcRenderer.invoke('chat:list-active'),
  listThreadRuns: (threadId) => ipcRenderer.invoke('chat:list-thread-runs', threadId),
  updateQueuedMessage: (request) => ipcRenderer.invoke('chat:update-queued', request),
  deleteQueuedMessage: (requestId) => ipcRenderer.invoke('chat:delete-queued', requestId),
  sendQueuedMessageNow: (requestId) => ipcRenderer.invoke('chat:send-now', requestId),
  onChatEvent: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, chatEvent: ChatEvent): void => {
      listener(chatEvent)
    }
    ipcRenderer.on('chat:event', handler)
    return () => ipcRenderer.removeListener('chat:event', handler)
  },
  listThreads: () => ipcRenderer.invoke('threads:list'),
  setActiveThread: (threadId) => ipcRenderer.invoke('threads:set-active', threadId),
  setThreadModel: (request) => ipcRenderer.invoke('threads:set-model', request),
  createThread: (request) => ipcRenderer.invoke('threads:create', request),
  loadThreadMessages: (threadId) => ipcRenderer.invoke('threads:messages', threadId),
  deleteThread: (request) => ipcRenderer.invoke('threads:delete', request),
  exportThreadProject: (threadId) => ipcRenderer.invoke('threads:export-project', threadId),
  getProjectResources: (threadId) => ipcRenderer.invoke('threads:get-project-resources', threadId),
  saveProjectResources: (request) => ipcRenderer.invoke('threads:save-project-resources', request),
  reviewThreadProject: (threadId) => ipcRenderer.invoke('threads:review-project', threadId),
  listProjectFiles: (threadId) => ipcRenderer.invoke('threads:list-project-files', threadId),
  readProjectFile: (request) => ipcRenderer.invoke('threads:read-project-file', request),
  openProjectFile: (request) => ipcRenderer.invoke('threads:open-project-file', request),
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
