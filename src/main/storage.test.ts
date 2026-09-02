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

  it('persists ordered tool lifecycle events and reconstructs completed prompt history', () => {
    const path = temporaryDatabase()
    const firstStore = new ThreadStore(path)
    const thread = firstStore.createThread({ title: 'Durable agent' })
    const run = firstStore.startAgentRun(thread.id, crypto.randomUUID(), 'local-model', 'Inspecte le projet')
    firstStore.markAgentRunRunning(run.id)
    firstStore.recordToolStarted(run.id, {
      callId: '0:0',
      step: 0,
      callIndex: 0,
      tool: 'read_file',
      arguments: { path: 'a.txt' },
      assistantContent: 'Je vérifie.'
    })
    firstStore.recordToolFinished(run.id, '0:0', 'done', 'contenu A')
    firstStore.recordToolStarted(run.id, {
      callId: '1:0',
      step: 1,
      callIndex: 0,
      tool: 'git_status',
      arguments: {},
      assistantContent: ''
    })
    firstStore.recordToolFinished(run.id, '1:0', 'done', 'M a.txt')
    firstStore.finishAgentRun(run.id, 'completed', 'Terminé.')
    firstStore.close()

    const reopened = new ThreadStore(path)
    try {
      expect(reopened.getAgentRun(run.id)).toMatchObject({ status: 'completed', error: null })
      expect(reopened.listAgentToolEvents(run.id).map((event) => ({
        sequence: event.sequence,
        callId: event.callId,
        status: event.status,
        result: event.result
      }))).toEqual([
        { sequence: 1, callId: '0:0', status: 'running', result: null },
        { sequence: 2, callId: '0:0', status: 'done', result: 'contenu A' },
        { sequence: 3, callId: '1:0', status: 'running', result: null },
        { sequence: 4, callId: '1:0', status: 'done', result: 'M a.txt' }
      ])
      expect(reopened.listPromptMessages(thread.id)).toEqual([
        { role: 'user', content: 'Inspecte le projet' },
        {
          role: 'assistant',
          content: 'Je vérifie.',
          tool_calls: [{ function: { name: 'read_file', arguments: { path: 'a.txt' } } }]
        },
        { role: 'tool', tool_name: 'read_file', content: 'contenu A' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [{ function: { name: 'git_status', arguments: {} } }]
        },
        { role: 'tool', tool_name: 'git_status', content: 'M a.txt' },
        { role: 'assistant', content: 'Terminé.' }
      ])
    } finally {
      reopened.close()
    }
  })

  it('atomically marks a canceled run and its in-flight tool interrupted', () => {
    const store = new ThreadStore(temporaryDatabase())
    try {
      const thread = store.createThread({ title: 'Canceled agent' })
      const run = store.startAgentRun(thread.id, crypto.randomUUID(), 'local-model', 'Lance la commande')
      store.markAgentRunRunning(run.id)
      store.recordToolStarted(run.id, {
        callId: '0:0',
        step: 0,
        callIndex: 0,
        tool: 'run_command',
        arguments: { command: 'pnpm', args: ['test'] },
        assistantContent: ''
      })

      store.finishAgentRun(run.id, 'interrupted', '', 'Génération interrompue.')

      expect(store.getAgentRun(run.id)).toMatchObject({
        status: 'interrupted',
        error: 'Génération interrompue.'
      })
      expect(store.listAgentToolEvents(run.id).map((event) => event.status)).toEqual([
        'running',
        'interrupted'
      ])
      expect(store.listPromptMessages(thread.id).at(-1)).toEqual({
        role: 'tool',
        tool_name: 'run_command',
        content: 'Appel d’outil interrompu.'
      })
    } finally {
      store.close()
    }
  })

  it('recovers running agent and tool state once after an app restart', () => {
    const path = temporaryDatabase()
    const firstStore = new ThreadStore(path)
    const thread = firstStore.createThread({ title: 'Restarted agent' })
    const run = firstStore.startAgentRun(thread.id, crypto.randomUUID(), 'local-model', 'Continue')
    firstStore.markAgentRunRunning(run.id)
    firstStore.recordToolStarted(run.id, {
      callId: '0:0',
      step: 0,
      callIndex: 0,
      tool: 'read_file',
      arguments: { path: 'README.md' },
      assistantContent: ''
    })
    firstStore.close()

    const reopened = new ThreadStore(path)
    try {
      expect(reopened.recoverInterruptedAgentRuns()).toBe(1)
      expect(reopened.getAgentRun(run.id)).toMatchObject({
        status: 'interrupted',
        error: 'Application fermée pendant la génération.'
      })
      expect(reopened.listAgentToolEvents(run.id).map((event) => event.status)).toEqual([
        'running',
        'interrupted'
      ])
      expect(reopened.recoverInterruptedAgentRuns()).toBe(0)
    } finally {
      reopened.close()
    }
  })

  it('keeps queued runs durable across restart while recovering only running work', () => {
    const path = temporaryDatabase()
    const firstStore = new ThreadStore(path)
    const thread = firstStore.createThread({ title: 'Queued agent' })
    const run = firstStore.startAgentRun(thread.id, crypto.randomUUID(), 'local-model', 'Wait')
    expect(firstStore.listActiveAgentRuns()).toEqual([run])
    firstStore.close()

    const reopened = new ThreadStore(path)
    try {
      expect(reopened.recoverInterruptedAgentRuns()).toBe(0)
      expect(reopened.getAgentRun(run.id)).toMatchObject({
        status: 'queued',
        error: null
      })
      expect(reopened.listQueuedAgentRuns()).toHaveLength(1)
    } finally {
      reopened.close()
    }
  })

  it('edits, deletes, prioritizes, and bounds prompt history for queued messages', () => {
    const store = new ThreadStore(temporaryDatabase())
    try {
      const thread = store.createThread({ title: 'Message queue' })
      const first = store.startAgentRun(thread.id, crypto.randomUUID(), 'local-model', 'Premier')
      const second = store.startAgentRun(thread.id, crypto.randomUUID(), 'local-model', 'Deuxième')

      expect(store.listPromptMessages(thread.id, first.userMessageId)).toEqual([
        { role: 'user', content: 'Premier' }
      ])
      expect(store.updateQueuedAgentRun(second.requestId, 'Deuxième modifié')).toMatchObject({
        requestId: second.requestId,
        userContent: 'Deuxième modifié'
      })
      store.prioritizeQueuedAgentRun(second.requestId)
      expect(store.listQueuedAgentRuns().map((run) => run.requestId)).toEqual([
        second.requestId,
        first.requestId
      ])
      store.markAgentRunRunning(first.id)
      store.finishAgentRun(first.id, 'completed', 'Réponse au premier')
      expect(store.listPromptMessages(thread.id, second.userMessageId)).toEqual([
        { role: 'user', content: 'Premier' },
        { role: 'assistant', content: 'Réponse au premier' },
        { role: 'user', content: 'Deuxième modifié' }
      ])
      expect(store.deleteQueuedAgentRun(second.requestId)).toBe(true)
      expect(store.deleteQueuedAgentRun(second.requestId)).toBe(false)
      expect(store.listMessages(thread.id).map((message) => message.content)).toEqual([
        'Premier',
        'Réponse au premier'
      ])
      expect(store.listAgentRunSummaries(thread.id).map((run) => run.requestId)).toEqual([first.requestId])
    } finally {
      store.close()
    }
  })

  it('enforces fail-closed environment state transitions', () => {
    const store = new ThreadStore(temporaryDatabase())
    try {
      const thread = store.createThread({ title: 'Worker', projectPath: '/project' })
      expect(thread).toMatchObject({
        workspaceMode: 'none',
        environmentStatus: 'creating',
        environmentError: null
      })

      const direct = store.activateEnvironment(thread.id, 'direct', null)
      expect(direct).toMatchObject({ workspaceMode: 'direct', environmentStatus: 'active' })
      expect(() => store.activateEnvironment(thread.id, 'direct', null)).toThrow(
        'Invalid environment transition: active -> active'
      )
      expect(() => store.transitionEnvironment(thread.id, 'error')).toThrow(
        'An error environment requires a reason'
      )

      expect(store.transitionEnvironment(thread.id, 'error', 'Workspace disappeared')).toMatchObject({
        environmentStatus: 'error',
        environmentError: 'Workspace disappeared'
      })
      expect(store.transitionEnvironment(thread.id, 'creating')).toMatchObject({
        environmentStatus: 'creating',
        environmentError: null
      })
      expect(store.activateEnvironment(thread.id, 'worktree', '/workspace')).toMatchObject({
        workspaceMode: 'worktree',
        workspacePath: '/workspace',
        environmentStatus: 'active'
      })
      expect(store.transitionEnvironment(thread.id, 'terminated')).toMatchObject({
        environmentStatus: 'terminated',
        environmentError: null
      })
      expect(() => store.transitionEnvironment(thread.id, 'error', 'Too late')).toThrow(
        'Invalid environment transition: terminated -> error'
      )
    } finally {
      store.close()
    }
  })

  it('marks interrupted environment creation as an error after reopening', () => {
    const path = temporaryDatabase()
    const firstStore = new ThreadStore(path)
    const interrupted = firstStore.createThread({ title: 'Interrupted', projectPath: '/project' })
    const active = firstStore.createThread({ title: 'Ready', projectPath: '/project' })
    firstStore.activateEnvironment(active.id, 'direct', null)
    firstStore.close()

    const reopenedStore = new ThreadStore(path)
    try {
      expect(reopenedStore.recoverInterruptedEnvironments()).toBe(1)
      expect(reopenedStore.getThread(interrupted.id)).toMatchObject({
        environmentStatus: 'error',
        environmentError: 'La création de l’environnement a été interrompue.'
      })
      expect(reopenedStore.getThread(active.id)).toMatchObject({
        environmentStatus: 'active',
        environmentError: null
      })
      expect(reopenedStore.recoverInterruptedEnvironments()).toBe(0)
    } finally {
      reopenedStore.close()
    }
  })

  it('upgrades a legacy database that predates project workspaces', () => {
    const path = temporaryDatabase()
    const legacy = new DatabaseSync(path)
    legacy.exec(`
      CREATE TABLE threads (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      PRAGMA user_version = 1;
    `)
    legacy.close()

    const store = new ThreadStore(path)
    try {
      expect(store.createThread({
        title: 'Upgraded',
        projectPath: '/project',
        workspacePath: '/workspace',
        model: 'local-model'
      })).toMatchObject({
        projectPath: '/project',
        workspacePath: '/workspace',
        environmentStatus: 'creating',
        model: 'local-model'
      })
      const version = new DatabaseSync(path, { readOnly: true })
      try {
        expect(version.prepare('PRAGMA user_version').get()?.user_version).toBe(8)
      } finally {
        version.close()
      }
    } finally {
      store.close()
    }
  })

  it('migrates existing workspace state into explicit environment state', () => {
    const path = temporaryDatabase()
    const legacy = new DatabaseSync(path)
    legacy.exec(`
      CREATE TABLE threads (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        project_path TEXT,
        workspace_path TEXT,
        workspace_mode TEXT NOT NULL DEFAULT 'none',
        model TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE project_worker_profiles (
        project_path TEXT PRIMARY KEY,
        mode TEXT NOT NULL CHECK (mode IN ('direct', 'container')),
        runtime TEXT CHECK (runtime IN ('docker', 'podman') OR runtime IS NULL),
        cpu_limit REAL NOT NULL,
        memory_mb INTEGER NOT NULL,
        image TEXT NOT NULL,
        network TEXT NOT NULL CHECK (network IN ('none', 'bridge')),
        updated_at TEXT NOT NULL
      );
      INSERT INTO threads VALUES
        ('worktree', 'Worktree', '/project', '/workspace', 'worktree', NULL, '2026-01-01', '2026-01-02'),
        ('direct', 'Direct', '/project', NULL, 'direct', NULL, '2026-01-01', '2026-01-02'),
        ('incomplete', 'Incomplete', '/project', NULL, 'none', NULL, '2026-01-01', '2026-01-02'),
        ('chat', 'Chat', NULL, NULL, 'none', NULL, '2026-01-01', '2026-01-02');
      PRAGMA user_version = 2;
    `)
    legacy.close()

    const store = new ThreadStore(path)
    try {
      expect(store.getThread('worktree')).toMatchObject({
        environmentStatus: 'active',
        environmentError: null,
        environmentUpdatedAt: '2026-01-02'
      })
      expect(store.getThread('direct')).toMatchObject({ environmentStatus: 'active' })
      expect(store.getThread('incomplete')).toMatchObject({
        environmentStatus: 'error',
        environmentError: 'L’environnement hérité est incomplet.'
      })
      expect(store.getThread('chat')).toMatchObject({ environmentStatus: 'terminated' })
    } finally {
      store.close()
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

  it('persists and updates one worker profile per project', () => {
    const path = temporaryDatabase()
    const store = new ThreadStore(path)
    try {
      expect(store.getWorkerProfile('/project')).toBeNull()
      const created = store.saveWorkerProfile({
        projectPath: '/project',
        mode: 'container',
        runtime: 'docker',
        cpuLimit: 2,
        memoryMb: 4096,
        image: 'node:22-bookworm',
        network: 'none',
        maxConcurrentWorkers: 2
      })
      expect(created).toMatchObject({
        projectPath: '/project', cpuLimit: 2, memoryMb: 4096, maxConcurrentWorkers: 2
      })
      expect(store.saveWorkerProfile({
        ...created,
        mode: 'direct',
        runtime: null,
        cpuLimit: 1,
        memoryMb: 2048,
        maxConcurrentWorkers: 3
      })).toMatchObject({ mode: 'direct', runtime: null, cpuLimit: 1, memoryMb: 2048 })
    } finally {
      store.close()
    }

    const reopened = new ThreadStore(path)
    try {
      expect(reopened.getWorkerProfile('/project')).toMatchObject({
        mode: 'direct',
        runtime: null,
        cpuLimit: 1,
        memoryMb: 2048,
        maxConcurrentWorkers: 3
      })
    } finally {
      reopened.close()
    }
  })

  it('rejects inconsistent worker mode and runtime at the database boundary', () => {
    const store = new ThreadStore(temporaryDatabase())
    try {
      expect(() => store.saveWorkerProfile({
        projectPath: '/invalid',
        mode: 'container',
        runtime: null,
        cpuLimit: 1,
        memoryMb: 1024,
        image: 'node:22-bookworm',
        network: 'none',
        maxConcurrentWorkers: 1
      })).toThrow('invalid worker profile mode/runtime')
      expect(() => store.saveWorkerProfile({
        projectPath: '/invalid-resources',
        mode: 'direct',
        runtime: null,
        cpuLimit: 1,
        memoryMb: 1024,
        image: 'node:22-bookworm',
        network: 'none',
        maxConcurrentWorkers: 0
      })).toThrow('invalid worker profile resources')
    } finally {
      store.close()
    }
  })
})
