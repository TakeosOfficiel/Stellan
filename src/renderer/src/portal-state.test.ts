import { describe, expect, it } from 'vitest'
import { applyPortalEvent, type PortalUiState } from './portal-state'

const threadId = '00000000-0000-4000-8000-000000000001'

describe('applyPortalEvent', () => {
  it('tracks a portal from startup through ready and closed', () => {
    let state: PortalUiState = {}
    state = applyPortalEvent(state, { threadId, type: 'starting' })
    expect(state[threadId]?.status).toBe('starting')

    state = applyPortalEvent(state, {
      threadId,
      type: 'ready',
      portal: {
        threadId,
        targetPort: 3000,
        status: 'ready',
        scope: 'loopback',
        url: 'http://127.0.0.1:45678'
      }
    })
    expect(state[threadId]).toMatchObject({ status: 'ready', error: null })

    state = applyPortalEvent(state, { threadId, type: 'stopping' })
    expect(state[threadId]?.portal?.targetPort).toBe(3000)
    state = applyPortalEvent(state, { threadId, type: 'closed' })
    expect(state[threadId]).toEqual({ status: 'closed', portal: null, error: null })
  })

  it('keeps failures scoped to their thread', () => {
    const state = applyPortalEvent({}, { threadId, type: 'error', error: 'Port indisponible' })
    expect(state[threadId]).toEqual({ status: 'error', portal: null, error: 'Port indisponible' })
  })
})
