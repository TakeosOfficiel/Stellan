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
  getOllamaStatus: () => Promise<OllamaStatus>
  getSetupInfo: () => Promise<SetupInfo>
  openOllamaDownload: () => Promise<void>
  pullModel: (model: string) => Promise<ModelPullResult>
  onModelPullProgress: (listener: (progress: ModelPullProgress) => void) => () => void
}
