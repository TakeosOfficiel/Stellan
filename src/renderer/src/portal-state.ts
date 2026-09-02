import type { PortalInfo } from '../../shared/contracts'

export type PortalUiEntry = {
  status: 'closed' | 'starting' | 'ready' | 'stopping' | 'error'
  portal: PortalInfo | null
  error: string | null
}

export type PortalUiState = Record<string, PortalUiEntry>

export type PortalUiEvent =
  | { threadId: string; type: 'starting' }
  | { threadId: string; type: 'ready'; portal: PortalInfo }
  | { threadId: string; type: 'stopping' }
  | { threadId: string; type: 'closed' }
  | { threadId: string; type: 'error'; error: string }

export function applyPortalEvent(state: PortalUiState, event: PortalUiEvent): PortalUiState {
  const current = state[event.threadId] ?? { status: 'closed', portal: null, error: null }
  if (event.type === 'ready') {
    return { ...state, [event.threadId]: { status: 'ready', portal: event.portal, error: null } }
  }
  if (event.type === 'error') {
    return { ...state, [event.threadId]: { ...current, status: 'error', error: event.error } }
  }
  if (event.type === 'closed') {
    return { ...state, [event.threadId]: { status: 'closed', portal: null, error: null } }
  }
  return { ...state, [event.threadId]: { ...current, status: event.type, error: null } }
}
