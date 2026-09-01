export type OllamaModel = {
  name: string
  size: number
  modifiedAt: string
}

export type ModelCategory = 'fast' | 'general' | 'code' | 'vision' | 'image'

export type ModelCompatibility = 'recommended' | 'compatible' | 'demanding' | 'unsupported'

export type CatalogModel = {
  id: string
  name: string
  category: ModelCategory
  description: string
  downloadSizeBytes: number
  minimumMemoryBytes: number
  compatibility: ModelCompatibility
  compatibilityReason: string
  experimental?: boolean
}

export type GpuInfo = {
  model: string
  vramBytes: number | null
}

export type HardwareInfo = {
  platform: 'windows' | 'linux' | 'macos' | 'other'
  cpuModel: string
  cpuCores: number
  totalMemoryBytes: number
  gpus: GpuInfo[]
}

export type SetupInfo = {
  hardware: HardwareInfo
  models: CatalogModel[]
}

export type ModelPullProgress = {
  model: string
  status: string
  completed: number | null
  total: number | null
  percent: number | null
}

export type ModelPullResult =
  | { success: true }
  | { success: false; reason: string }

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool'

export type ChatMessage = {
  role: ChatRole
  content: string
}

export type ChatRequest = {
  requestId: string
  threadId: string | null
  model: string
  projectPath: string | null
  messages: ChatMessage[]
}

export type ChatEvent =
  | { requestId: string; type: 'content'; content: string }
  | { requestId: string; type: 'tool'; tool: string; status: 'running' | 'done' | 'denied' | 'error' }
  | { requestId: string; type: 'done' }
  | { requestId: string; type: 'error'; reason: string }

export type ProjectSelection = {
  path: string
  name: string
}

export type StoredThread = {
  id: string
  title: string
  projectPath: string | null
  workspacePath: string | null
  workspaceMode: 'none' | 'worktree' | 'direct'
  model: string | null
  createdAt: string
  updatedAt: string
}

export type StoredMessage = {
  id: string
  threadId: string
  role: ChatRole
  content: string
  createdAt: string
}

export type CreateThreadRequest = {
  title: string
  projectPath: string | null
  model: string | null
}

export type ProjectReview = {
  status: string
  diff: string
  workspaceMode: 'worktree' | 'direct'
}

export type OllamaStatus =
  | {
      available: true
      version: string | null
      models: OllamaModel[]
    }
  | {
      available: false
      reason: string
    }

export type LocalAgentApi = {
  minimizeWindow: () => Promise<void>
  toggleMaximizeWindow: () => Promise<void>
  closeWindow: () => Promise<void>
  getOllamaStatus: () => Promise<OllamaStatus>
  startOllama: () => Promise<OllamaStatus>
  getSetupInfo: () => Promise<SetupInfo>
  openOllamaDownload: () => Promise<void>
  pullModel: (model: string) => Promise<ModelPullResult>
  onModelPullProgress: (listener: (progress: ModelPullProgress) => void) => () => void
  selectProject: () => Promise<ProjectSelection | null>
  startChat: (request: ChatRequest) => Promise<void>
  cancelChat: (requestId: string) => Promise<void>
  onChatEvent: (listener: (event: ChatEvent) => void) => () => void
  listThreads: () => Promise<StoredThread[]>
  createThread: (request: CreateThreadRequest) => Promise<StoredThread>
  loadThreadMessages: (threadId: string) => Promise<StoredMessage[]>
  deleteThread: (threadId: string) => Promise<boolean>
  reviewThreadProject: (threadId: string) => Promise<ProjectReview | null>
}
