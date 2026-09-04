import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createReliableEngineRegistry,
  ReliableActivityService
} from '../reliable-activities'
import { ThreadStore } from '../storage'

const temporaryDirectories: string[] = []

function setup(): {
  store: ThreadStore
  service: ReliableActivityService
  threadId: string
} {
  const directory = mkdtempSync(join(tmpdir(), 'stellan-budget-'))
  temporaryDirectories.push(directory)
  const store = new ThreadStore(join(directory, 'storage.sqlite'))
  const thread = store.createThread({ title: 'Budget fiable' })
  return {
    store,
    service: new ReliableActivityService(store, createReliableEngineRegistry()),
    threadId: thread.id
  }
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('budget reliable engine', () => {
  it('uses the unchanged generic service to track exact amounts', () => {
    const { store, service, threadId } = setup()
    try {
      expect(createReliableEngineRegistry().ids()).toEqual(['hangman', 'budget', 'neither-yes-nor-no'])
      expect(service.start(threadId, 'budget', { limitCents: 10_000, currency: 'eur' })).toMatchObject({
        ok: true,
        engineId: 'budget',
        version: 0,
        publicView: {
          currency: 'EUR',
          limitCents: 10_000,
          spentCents: 0,
          remainingCents: 10_000,
          expenses: []
        }
      })

      expect(service.apply(threadId, undefined, {
        type: 'add_expense',
        id: 'courses',
        label: 'Courses',
        amountCents: 3_499
      })).toMatchObject({
        ok: true,
        version: 1,
        publicView: {
          spentCents: 3_499,
          remainingCents: 6_501,
          expenses: [{ id: 'courses', label: 'Courses', amountCents: 3_499 }]
        }
      })
    } finally {
      store.close()
    }
  })

  it('refuses overspending without changing the persisted state or event log', () => {
    const { store, service, threadId } = setup()
    try {
      const started = service.start(threadId, 'budget', { limitCents: 5_000, currency: 'EUR' })
      expect(started.ok).toBe(true)
      service.apply(threadId, undefined, {
        type: 'add_expense',
        id: 'transport',
        label: 'Transport',
        amountCents: 2_000
      })

      expect(service.apply(threadId, undefined, {
        type: 'add_expense',
        id: 'hotel',
        label: 'Hôtel',
        amountCents: 3_001
      })).toEqual({
        ok: false,
        error: {
          code: 'BUDGET_EXCEEDED',
          message: 'Cette dépense dépasserait le budget de 1 centime.',
          retryable: true
        },
        publicView: {
          status: 'active',
          currency: 'EUR',
          limitCents: 5_000,
          spentCents: 2_000,
          remainingCents: 3_000,
          expenses: [{ id: 'transport', label: 'Transport', amountCents: 2_000 }]
        }
      })

      const activity = store.getActiveReliableActivity(threadId)
      expect(activity?.version).toBe(1)
      expect(store.listReliableActivityEvents(activity?.id as string)).toHaveLength(2)
    } finally {
      store.close()
    }
  })

  it('removes expenses and closes the workflow through generic transitions', () => {
    const { store, service, threadId } = setup()
    try {
      service.start(threadId, 'budget', { limitCents: 10_000, currency: 'EUR' })
      service.apply(threadId, undefined, {
        type: 'add_expense',
        id: 'meal',
        label: 'Repas',
        amountCents: 2_500
      })
      expect(service.apply(threadId, undefined, { type: 'remove_expense', id: 'meal' })).toMatchObject({
        ok: true,
        version: 2,
        publicView: { spentCents: 0, remainingCents: 10_000, expenses: [] }
      })
      expect(service.apply(threadId, undefined, { type: 'close' })).toMatchObject({
        ok: true,
        version: 3,
        status: 'completed',
        publicView: { status: 'closed' }
      })
      expect(store.getActiveReliableActivity(threadId)).toBeNull()
    } finally {
      store.close()
    }
  })
})
