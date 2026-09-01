import type { LocalAgentApi } from '../../shared/contracts'

declare global {
  interface Window {
    localAgent: LocalAgentApi
  }
}

export {}
