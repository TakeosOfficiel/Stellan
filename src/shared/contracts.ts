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
  categories: ModelCategory[]
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

export type RuntimeToolInfo = {
  available: boolean
  version: string | null
}

export type RuntimeInfo = {
  git: RuntimeToolInfo
  docker: RuntimeToolInfo
  podman: RuntimeToolInfo
  recommendedContainerRuntime: 'docker' | 'podman' | null
}

export type SetupInfo = {
  hardware: HardwareInfo
  runtime: RuntimeInfo
  models: CatalogModel[]
}

export type RuntimeProgress = {
  step: string
  detail: string
  percent: number
}

export type UpdateState =
  | { status: 'checking' }
  | { status: 'current'; version: string; updatedFrom?: string }
  | { status: 'downloading'; version: string; percent: number; bytesPerSecond: number }
  | { status: 'restarting'; version: string }
  | { status: 'error'; message: string }

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

export type DictationProgress = {
  status: 'loading' | 'downloading' | 'transcribing'
  file?: string
  percent?: number
}

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool'

export type ChatImage = {
  mimeType: 'image/jpeg' | 'image/png' | 'image/webp'
  data: string
}

export type ChatMessage = {
  role: ChatRole
  content: string
  images?: ChatImage[]
}

export type ChatRequest = {
  requestId: string
  threadId: string
  model: string
  projectPath: string | null
  messages: ChatMessage[]
}

export type ChatEvent =
  | { requestId: string; threadId: string; type: 'status'; status: 'queued' | 'running' }
  | { requestId: string; threadId: string; type: 'progress'; detail: string; percent: number | null }
  | { requestId: string; threadId: string; type: 'thread-created'; child: StoredThread }
  | {
      requestId: string
      threadId: string
      type: 'started'
      userMessageId: string
      userContent: string
      images: ChatImage[]
    }
  | { requestId: string; threadId: string; type: 'content'; content: string }
  | {
      requestId: string
      threadId: string
      type: 'tool'
      callId: string
      tool: string
      status: 'running' | 'done' | 'denied' | 'error'
      input: string | null
      output: string | null
    }
  | { requestId: string; threadId: string; type: 'done' }
  | { requestId: string; threadId: string; type: 'error'; reason: string }

export type ProjectSelection = {
  path: string
  name: string
}

export type WorkerProfile = {
  projectPath: string
  mode: 'direct' | 'container'
  runtime: 'docker' | 'podman' | null
  cpuLimit: number
  memoryMb: number
  storageGb: number
  automaticCpuMemory: boolean
  image: string
  network: 'none' | 'bridge'
  maxConcurrentWorkers: number
  updatedAt: string
}

export type ProjectResourceSettings = {
  cpuLimit: number
  memoryMb: number
  storageGb: number
  automaticCpuMemory: boolean
  maxCpu: number
  maxMemoryMb: number
  maxStorageGb: number
}

export type SaveProjectResourceSettingsRequest = Pick<
  ProjectResourceSettings,
  'cpuLimit' | 'memoryMb' | 'storageGb' | 'automaticCpuMemory'
> & { threadId: string }

export type ActiveRun = {
  requestId: string
  threadId: string
  status: 'queued' | 'running'
}

export type AgentRunSummary = {
  requestId: string
  threadId: string
  userMessageId: string
  userContent: string
  model: string
  status: 'queued' | 'running' | 'completed' | 'interrupted' | 'error'
  error: string | null
  startedAt: string
  finishedAt: string | null
}

export type StoredToolActivity = {
  requestId: string
  callId: string
  tool: string
  status: 'running' | 'done' | 'denied' | 'error' | 'interrupted'
  input: string | null
  output: string | null
}

export type UpdateQueuedMessageRequest = {
  requestId: string
  content: string
}

export type StoredThread = {
  id: string
  parentThreadId: string | null
  title: string
  projectName: string | null
  projectPath: string | null
  workspacePath: string | null
  workspaceMode: 'none' | 'worktree' | 'direct'
  environmentStatus: 'creating' | 'active' | 'error' | 'terminated'
  environmentError: string | null
  environmentUpdatedAt: string
  model: string | null
  createdAt: string
  updatedAt: string
}

export type DeleteThreadRequest = {
  threadId: string
  discardChanges: boolean
}

export type DeleteThreadResult = {
  deleted: boolean
  pendingChanges: string | null
}

export type DeleteProjectRequest = {
  projectPath: string
}

export type DeleteProjectResult = {
  deleted: boolean
  deletedPrivateData: boolean
}

export type StoredMessage = {
  id: string
  threadId: string
  role: ChatRole
  content: string
  images: ChatImage[]
  createdAt: string
}

export const MODEL_SELECTION_MESSAGE_PREFIX = 'stellan:model-selection:'

export type SetThreadModelRequest = {
  threadId: string
  model: string
}

export type SetThreadModelResult = {
  thread: StoredThread
  message: StoredMessage | null
}

export type CreateThreadRequest = {
  title: string
  projectName: string
  projectPath: string | null
  model: string | null
}

export type ProjectReview = {
  status: string
  diff: string
  changes: ProjectChange[]
  workspaceMode: 'worktree' | 'direct'
}

export type ProjectChange = {
  path: string
  kind: 'added' | 'modified' | 'deleted' | 'renamed'
  added: number
  removed: number
  diff: string
}

export type ProjectFileList = {
  files: string[]
  directories: string[]
  truncated: boolean
}

export type ProjectFilePreview = {
  path: string
  content: string
  truncated: boolean
}

export type ProjectFileRequest = {
  threadId: string
  path: string
}

export type TerminalStartRequest = {
  threadId: string
  cols: number
  rows: number
}

export type TerminalStartResult = {
  threadId: string
  mode: 'direct' | 'container'
  reused: boolean
}

export type TerminalEvent =
  | { threadId: string; type: 'data'; data: string }
  | { threadId: string; type: 'exit'; exitCode: number; signal: number | null }

export type PortalInfo = {
  threadId: string
  source: 'project' | 'port'
  targetPort: number | null
  status: 'ready'
  scope: 'loopback'
  url: string
  expiresAt: string | null
}

export type PortalStartRequest =
  | { threadId: string; source: 'project'; durationMinutes: 15 | 60 | 240 | null }
  | { threadId: string; source: 'port'; port: number; durationMinutes: 15 | 60 | 240 | null }

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
  setStartupWindow: (active: boolean) => Promise<void>
  getUpdateState: () => Promise<UpdateState>
  onUpdateState: (listener: (state: UpdateState) => void) => () => void
  getOllamaStatus: () => Promise<OllamaStatus>
  startOllama: () => Promise<OllamaStatus>
  getBasicHardwareInfo: () => Promise<HardwareInfo>
  getSetupInfo: () => Promise<SetupInfo>
  openOllamaDownload: () => Promise<void>
  onRuntimeProgress: (listener: (progress: RuntimeProgress) => void) => () => void
  pullModel: (model: string) => Promise<ModelPullResult>
  warmModel: (model: string) => Promise<boolean>
  onModelPullProgress: (listener: (progress: ModelPullProgress) => void) => () => void
  transcribeDictation: (audio: ArrayBuffer) => Promise<string>
  onDictationProgress: (listener: (progress: DictationProgress) => void) => () => void
  selectProject: () => Promise<ProjectSelection | null>
  createProject: (name: string) => Promise<ProjectSelection>
  deleteProject: (request: DeleteProjectRequest) => Promise<DeleteProjectResult>
  startChat: (request: ChatRequest) => Promise<AgentRunSummary>
  cancelChat: (requestId: string) => Promise<void>
  listActiveRuns: () => Promise<ActiveRun[]>
  listThreadRuns: (threadId: string) => Promise<AgentRunSummary[]>
  updateQueuedMessage: (request: UpdateQueuedMessageRequest) => Promise<AgentRunSummary>
  deleteQueuedMessage: (requestId: string) => Promise<boolean>
  sendQueuedMessageNow: (requestId: string) => Promise<void>
  onChatEvent: (listener: (event: ChatEvent) => void) => () => void
  listThreads: () => Promise<StoredThread[]>
  setActiveThread: (threadId: string | null) => Promise<void>
  setThreadModel: (request: SetThreadModelRequest) => Promise<SetThreadModelResult>
  createThread: (request: CreateThreadRequest) => Promise<StoredThread>
  loadThreadMessages: (threadId: string) => Promise<StoredMessage[]>
  loadThreadToolActivities: (threadId: string) => Promise<StoredToolActivity[]>
  deleteThread: (request: DeleteThreadRequest) => Promise<DeleteThreadResult>
  exportThreadProject: (threadId: string) => Promise<string | null>
  getProjectResources: (threadId: string) => Promise<ProjectResourceSettings>
  saveProjectResources: (request: SaveProjectResourceSettingsRequest) => Promise<ProjectResourceSettings>
  reviewThreadProject: (threadId: string) => Promise<ProjectReview | null>
  listProjectFiles: (threadId: string) => Promise<ProjectFileList>
  readProjectFile: (request: ProjectFileRequest) => Promise<ProjectFilePreview>
  openProjectFile: (request: ProjectFileRequest) => Promise<void>
  startTerminal: (request: TerminalStartRequest) => Promise<TerminalStartResult>
  writeTerminal: (threadId: string, data: string) => Promise<void>
  resizeTerminal: (threadId: string, cols: number, rows: number) => Promise<void>
  closeTerminal: (threadId: string) => Promise<boolean>
  onTerminalEvent: (listener: (event: TerminalEvent) => void) => () => void
  getPortal: (threadId: string) => Promise<PortalInfo | null>
  startPortal: (request: PortalStartRequest) => Promise<PortalInfo>
  stopPortal: (threadId: string) => Promise<boolean>
  copyPortalUrl: (threadId: string) => Promise<void>
  openPortal: (threadId: string) => Promise<void>
}
