import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  ReliableActivityService,
  ReliableEngineRegistry
} from './reliable-activities'
import { createHangmanEngine } from './activity-engines/hangman'
import { ThreadStore } from './storage'

const temporaryDirectories: string[] = []

function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'stellan-activities-'))
  temporaryDirectories.push(directory)
  return join(directory, 'storage.sqlite')
}

function setup(path = databasePath()): {
  store: ThreadStore
  service: ReliableActivityService
  threadId: string
  path: string
} {
  const store = new ThreadStore(path)
  const thread = store.createThread({ title: 'Activité fiable' })
  const registry = new ReliableEngineRegistry()
  registry.register(createHangmanEngine(() => 0))
  return { store, service: new ReliableActivityService(store, registry), threadId: thread.id, path }
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('ReliableActivityService', () => {
  it('keeps the secret outside the public view and applies hangman rules deterministically', () => {
    const { store, service, threadId } = setup()
    try {
      const started = service.start(threadId, 'hangman', { difficulty: 'facile' })
      expect(started).toMatchObject({
        ok: true,
        engineId: 'hangman',
        version: 0,
        status: 'active',
        publicView: { word: '_ _ _ _', letterCount: 4, remainingAttempts: 6 }
      })
      expect(JSON.stringify(started)).not.toContain('CHAT')

      const aliasThread = store.createThread({ title: 'Alias anglais' })
      const startedWithEnglishAlias = service.start(aliasThread.id, 'hangman', {
        difficulty: 'medium'
      })
      expect(startedWithEnglishAlias).toMatchObject({
        ok: true,
        engineId: 'hangman',
        publicView: { letterCount: 5, remainingAttempts: 6 }
      })
      const rejectedSecretThread = store.createThread({ title: 'Mot injecté' })
      expect(service.start(rejectedSecretThread.id, 'hangman', {
        language: 'fr',
        word: 'POMPES'
      })).toMatchObject({ ok: false, error: { code: 'INVALID_START_INPUT' } })

      const found = service.apply(threadId, undefined, { type: 'guess', letter: 'a' })
      expect(found).toMatchObject({
        ok: true,
        version: 1,
        publicView: { word: '_ _ A _', remainingAttempts: 6 }
      })

      const missed = service.apply(threadId, undefined, { type: 'guess', letter: 'z' })
      expect(missed).toMatchObject({
        ok: true,
        version: 2,
        publicView: { word: '_ _ A _', wrongLetters: ['Z'], remainingAttempts: 5, drawing: '  O' }
      })
      expect(JSON.stringify(missed)).not.toContain('CHAT')
      const activityId = store.getActiveReliableActivity(threadId)?.id as string
      expect(store.listReliableActivityEvents(activityId).map((event) => ({
        sequence: event.sequence,
        action: event.action,
        result: event.result
      }))).toEqual([
        { sequence: 0, action: { type: 'create' }, result: { type: 'started' } },
        { sequence: 1, action: { type: 'guess', letter: 'A' }, result: { type: 'guess', letter: 'A', hit: true } },
        { sequence: 2, action: { type: 'guess', letter: 'Z' }, result: { type: 'guess', letter: 'Z', hit: false } }
      ])
    } finally {
      store.close()
    }
  })

  it('returns a safe structured error without mutating state for an invalid action', () => {
    const { store, service, threadId } = setup()
    try {
      service.start(threadId, 'hangman', { difficulty: 'facile' })
      service.apply(threadId, undefined, { type: 'guess', letter: 'A' })
      const duplicate = service.apply(threadId, undefined, { type: 'guess', letter: 'A' })

      expect(duplicate).toEqual({
        ok: false,
        error: {
          code: 'LETTER_ALREADY_PLAYED',
          message: 'La lettre A a déjà été proposée.',
          retryable: true
        },
        publicView: {
          status: 'active',
          word: '_ _ A _',
          letterCount: 4,
          guessedLetters: ['A'],
          wrongLetters: [],
          hint: null,
          remainingAttempts: 6,
          drawing: ''
        }
      })
      expect(store.getActiveReliableActivity(threadId)?.version).toBe(1)
    } finally {
      store.close()
    }
  })

  it('returns a real private-state hint, rejects unsupported requests, and verifies complete words', () => {
    const { store, service, threadId } = setup()
    try {
      service.start(threadId, 'hangman', { difficulty: 'facile' })

      const hinted = service.apply(threadId, undefined, { type: 'hint' })
      expect(hinted).toMatchObject({
        ok: true,
        message: 'C’est un animal domestique connu pour ronronner.',
        publicView: {
          word: '_ _ _ _',
          hint: 'C’est un animal domestique connu pour ronronner.'
        }
      })
      expect(JSON.stringify(hinted)).not.toContain('CHAT')

      const unsupported = service.apply(threadId, undefined, { type: 'unsupported' })
      expect(unsupported).toMatchObject({
        ok: false,
        error: { code: 'UNSUPPORTED_ACTIVITY_REQUEST' }
      })
      expect(store.getActiveReliableActivity(threadId)?.version).toBe(1)

      const solved = service.apply(threadId, undefined, { type: 'solve', word: 'chat' })
      expect(solved).toMatchObject({
        ok: true,
        status: 'completed',
        publicView: { status: 'won', word: 'C H A T', remainingAttempts: 6 }
      })
    } finally {
      store.close()
    }
  })

  it('closes an active game without revealing its private word', () => {
    const { store, service, threadId } = setup()
    try {
      service.start(threadId, 'hangman', { difficulty: 'facile' })
      const exited = service.apply(threadId, undefined, { type: 'exit' })

      expect(exited).toMatchObject({
        ok: true,
        status: 'completed',
        message: 'La partie est arrêtée.',
        publicView: { status: 'cancelled', word: '_ _ _ _' }
      })
      expect(JSON.stringify(exited)).not.toContain('CHAT')
      expect(service.context(threadId)).toBeNull()
    } finally {
      store.close()
    }
  })

  it('persists private state across restarts and reveals it only when the activity finishes', () => {
    const { store, service, threadId, path } = setup()
    service.start(threadId, 'hangman', { difficulty: 'facile' })
    service.apply(threadId, undefined, { type: 'guess', letter: 'A' })
    store.close()

    const reopened = new ThreadStore(path)
    const registry = new ReliableEngineRegistry()
    registry.register(createHangmanEngine(() => 0))
    const resumed = new ReliableActivityService(reopened, registry)
    try {
      const context = resumed.context(threadId)
      expect(context).toContain('"word":"_ _ A _"')
      expect(context).not.toContain('CHAT')

      const finished = resumed.apply(threadId, undefined, { type: 'give_up' })
      expect(finished).toMatchObject({
        ok: true,
        status: 'completed',
        publicView: { status: 'lost', word: 'C H A T' }
      })
      expect(resumed.context(threadId)).toBeNull()
    } finally {
      reopened.close()
    }
  })

  it('rejects oversized public views without exposing internal failures', () => {
    const path = databasePath()
    const store = new ThreadStore(path)
    const thread = store.createThread({ title: 'Vue bornée' })
    const registry = new ReliableEngineRegistry()
    registry.register({
      id: 'oversized',
      createSchema: z.object({}),
      actionSchema: z.object({}),
      stateSchema: z.object({ secret: z.string() }),
      create: () => ({ secret: 'private' }),
      apply: (state) => ({ ok: true, state, completed: false, message: 'ok', event: {} }),
      publicView: () => ({ content: 'x'.repeat(9_000) })
    })
    try {
      expect(new ReliableActivityService(store, registry).start(thread.id, 'oversized', {})).toEqual({
        ok: false,
        error: {
          code: 'ACTIVITY_START_FAILED',
          message: 'Cette activité n’a pas pu démarrer.',
          retryable: true
        }
      })
      expect(store.getActiveReliableActivity(thread.id)).toBeNull()
    } finally {
      store.close()
    }
  })
})
