export type OllamaModel = {
  name: string
  size: number
  modifiedAt: string
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
  getOllamaStatus: () => Promise<OllamaStatus>
}
