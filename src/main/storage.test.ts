import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { ThreadStore } from './storage'

const temporaryDirectories: string[] = []

function temporaryDatabase(): string {
  const directory = mkdtempSync(join(tmpdir(), 'local-agent-storage-'))
  temporaryDirectories.push(directory)
  return join(directory, 'storage.sqlite')
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('ThreadStore', () => {
  it('creates, lists, gets, updates, and deletes threads', () => {
    const store = new ThreadStore(temporaryDatabase())

    try {
      const first = store.createThread({ title: 'First thread' })
      const second = store.createThread({ title: 'Second thread' })

      expect(first.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
      expect(store.listThreads().map((thread) => thread.id)).toEqual([first.id, second.id])
      expect(store.getThread(first.id)).toEqual(first)
      expect(store.updateThread(first.id, { title: 'Renamed thread' })).toMatchObject({
        id: first.id,
        title: 'Renamed thread',
        createdAt: first.createdAt
      })
      expect(store.updateThread('missing', { title: 'No thread' })).toBeNull()
      expect(store.deleteThread(second.id)).toBe(true)
      expect(store.deleteThread(second.id)).toBe(false)
      expect(store.getThread(second.id)).toBeNull()
    } finally {
      store.close()
    }
  })

  it('appends messages in stable chronological order', () => {
    const store = new ThreadStore(temporaryDatabase())

    try {
      const thread = store.createThread({ title: 'Conversation' })
      const first = store.appendMessage(thread.id, { role: 'user', content: 'Hello' })
      const second = store.appendMessage(thread.id, { role: 'assistant', content: 'Hi' })

      expect(store.listMessages(thread.id)).toEqual([first, second])
      expect(() => store.appendMessage('missing', { role: 'user', content: 'No parent' })).toThrow()
    } finally {
      store.close()
    }
  })

  it('persists threads and messages after reopening the database', () => {
    const path = temporaryDatabase()
    const firstStore = new ThreadStore(path)
    const thread = firstStore.createThread({ title: 'Persistent thread' })
    const message = firstStore.appendMessage(thread.id, { role: 'user', content: 'Keep me' })
    firstStore.close()

    const reopenedStore = new ThreadStore(path)
    try {
      expect(reopenedStore.getThread(thread.id)).toEqual(thread)
      expect(reopenedStore.listMessages(thread.id)).toEqual([message])
    } finally {
      reopenedStore.close()
    }
  })

  it('cascade deletes a thread\'s messages and closes safely more than once', () => {
    const path = temporaryDatabase()
    const store = new ThreadStore(path)
    const thread = store.createThread({ title: 'Disposable thread' })
    store.appendMessage(thread.id, { role: 'user', content: 'Delete me' })

    expect(store.deleteThread(thread.id)).toBe(true)
    store.close()
    store.close()

    const database = new DatabaseSync(path)
    try {
      const row = database.prepare('SELECT COUNT(*) AS count FROM messages').get()
      expect(row?.count).toBe(0)
    } finally {
      database.close()
    }

    expect(() => store.listThreads()).toThrow('ThreadStore is closed')
  })
})
