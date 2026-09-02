import { randomUUID } from 'node:crypto'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'

export type Thread = {
  id: string
  title: string
  projectPath: string | null
  workspacePath: string | null
  workspaceMode: 'none' | 'worktree' | 'direct'
  environmentStatus: EnvironmentStatus
  environmentError: string | null
  environmentUpdatedAt: string
  model: string | null
  createdAt: string
  updatedAt: string
}

export type EnvironmentStatus = 'creating' | 'active' | 'error' | 'terminated'

export type CreateThreadInput = {
  title: string
  projectPath?: string | null
  workspacePath?: string | null
  workspaceMode?: Thread['workspaceMode']
  model?: string | null
}

export type UpdateThreadInput = {
  title?: string
  model?: string | null
}

export type MessageRole = 'system' | 'user' | 'assistant' | 'tool'

export type Message = {
  id: string
  threadId: string
  role: MessageRole
  content: string
  createdAt: string
}

export type AppendMessageInput = {
  role: MessageRole
  content: string
}

export type WorkerProfile = {
  projectPath: string
  mode: 'direct' | 'container'
  runtime: 'docker' | 'podman' | null
  cpuLimit: number
  memoryMb: number
  image: string
  network: 'none' | 'bridge'
  updatedAt: string
}

export type SaveWorkerProfileInput = Omit<WorkerProfile, 'updatedAt'>

type StorageRow = Record<string, SQLInputValue>

const migrations = [
  `
    CREATE TABLE threads (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      project_path TEXT,
      workspace_path TEXT,
      workspace_mode TEXT NOT NULL DEFAULT 'none' CHECK (workspace_mode IN ('none', 'worktree', 'direct')),
      model TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK (role IN ('system', 'user', 'assistant', 'tool')),
      content TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX messages_thread_id_created_at
      ON messages(thread_id, created_at);
  `,
  `
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
  `,
  `
    ALTER TABLE threads ADD COLUMN environment_status TEXT NOT NULL DEFAULT 'terminated'
      CHECK (environment_status IN ('creating', 'active', 'error', 'terminated'));
    ALTER TABLE threads ADD COLUMN environment_error TEXT;
    ALTER TABLE threads ADD COLUMN environment_updated_at TEXT NOT NULL DEFAULT '';

    UPDATE threads
    SET environment_status = CASE
          WHEN project_path IS NULL THEN 'terminated'
          WHEN workspace_mode IN ('worktree', 'direct') THEN 'active'
          ELSE 'error'
        END,
        environment_error = CASE
          WHEN project_path IS NOT NULL AND workspace_mode = 'none'
            THEN 'L’environnement hérité est incomplet.'
          ELSE NULL
        END,
        environment_updated_at = updated_at;
  `,
  `
    CREATE TRIGGER project_worker_profiles_validate_insert
    BEFORE INSERT ON project_worker_profiles
    WHEN (NEW.mode = 'direct' AND NEW.runtime IS NOT NULL)
      OR (NEW.mode = 'container' AND NEW.runtime IS NULL)
    BEGIN
      SELECT RAISE(ABORT, 'invalid worker profile mode/runtime');
    END;

    CREATE TRIGGER project_worker_profiles_validate_update
    BEFORE UPDATE ON project_worker_profiles
    WHEN (NEW.mode = 'direct' AND NEW.runtime IS NOT NULL)
      OR (NEW.mode = 'container' AND NEW.runtime IS NULL)
    BEGIN
      SELECT RAISE(ABORT, 'invalid worker profile mode/runtime');
    END;
  `
]

function toThread(row: StorageRow): Thread {
  return {
    id: String(row.id),
    title: String(row.title),
    projectPath: row.project_path === null ? null : String(row.project_path),
    workspacePath: row.workspace_path === null ? null : String(row.workspace_path),
    workspaceMode: row.workspace_mode === 'worktree' || row.workspace_mode === 'direct'
      ? row.workspace_mode
      : 'none',
    environmentStatus: String(row.environment_status) as EnvironmentStatus,
    environmentError: row.environment_error === null ? null : String(row.environment_error),
    environmentUpdatedAt: String(row.environment_updated_at),
    model: row.model === null ? null : String(row.model),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  }
}

function toMessage(row: StorageRow): Message {
  return {
    id: String(row.id),
    threadId: String(row.thread_id),
    role: String(row.role) as MessageRole,
    content: String(row.content),
    createdAt: String(row.created_at)
  }
}

function toWorkerProfile(row: StorageRow): WorkerProfile {
  const mode = row.mode === 'direct' || row.mode === 'container' ? row.mode : null
  const runtime = row.runtime === 'docker' || row.runtime === 'podman' ? row.runtime : null
  if (!mode || (mode === 'container' && !runtime) || (mode === 'direct' && runtime)) {
    throw new Error(`Invalid persisted worker profile for ${String(row.project_path)}`)
  }
  return {
    projectPath: String(row.project_path),
    mode,
    runtime,
    cpuLimit: Number(row.cpu_limit),
    memoryMb: Number(row.memory_mb),
    image: String(row.image),
    network: row.network === 'bridge' ? 'bridge' : 'none',
    updatedAt: String(row.updated_at)
  }
}

export class ThreadStore {
  private readonly database: DatabaseSync
  private closed = false

  constructor(path: string) {
    this.database = new DatabaseSync(path)

    try {
      this.database.exec('PRAGMA foreign_keys = ON')
      this.ensureThreadColumns()
      this.migrate()
    } catch (error) {
      this.database.close()
      this.closed = true
      throw error
    }
  }

  createThread(input: CreateThreadInput): Thread {
    this.assertOpen()

    const thread: Thread = {
      id: randomUUID(),
      title: input.title,
      projectPath: input.projectPath ?? null,
      workspacePath: input.workspacePath ?? null,
      workspaceMode: input.workspaceMode ?? 'none',
      environmentStatus: input.projectPath ? 'creating' : 'terminated',
      environmentError: null,
      environmentUpdatedAt: new Date().toISOString(),
      model: input.model ?? null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }
    this.database.prepare(`
      INSERT INTO threads (
        id, title, project_path, workspace_path, workspace_mode,
        environment_status, environment_error, environment_updated_at,
        model, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      thread.id,
      thread.title,
      thread.projectPath,
      thread.workspacePath,
      thread.workspaceMode,
      thread.environmentStatus,
      thread.environmentError,
      thread.environmentUpdatedAt,
      thread.model,
      thread.createdAt,
      thread.updatedAt
    )

    return thread
  }

  listThreads(): Thread[] {
    this.assertOpen()

    return this.database.prepare(`
      SELECT id, title, project_path, workspace_path, workspace_mode,
             environment_status, environment_error, environment_updated_at,
             model, created_at, updated_at
      FROM threads
      ORDER BY created_at ASC, rowid ASC
    `).all().map(toThread)
  }

  getThread(id: string): Thread | null {
    this.assertOpen()

    const row = this.database.prepare(`
      SELECT id, title, project_path, workspace_path, workspace_mode,
             environment_status, environment_error, environment_updated_at,
             model, created_at, updated_at
      FROM threads
      WHERE id = ?
    `).get(id)

    return row ? toThread(row) : null
  }

  updateThread(id: string, input: UpdateThreadInput): Thread | null {
    this.assertOpen()

    if (
      input.title === undefined &&
      input.model === undefined
    ) {
      return this.getThread(id)
    }

    const current = this.getThread(id)
    if (!current) return null

    const updatedAt = new Date().toISOString()
    const result = this.database.prepare(`
      UPDATE threads
      SET title = ?, model = ?, updated_at = ?
      WHERE id = ?
    `).run(
      input.title ?? current.title,
      input.model === undefined ? current.model : input.model,
      updatedAt,
      id
    )

    return result.changes === 0 ? null : this.getThread(id)
  }

  activateEnvironment(
    id: string,
    workspaceMode: 'worktree' | 'direct',
    workspacePath: string | null
  ): Thread {
    this.assertOpen()
    if (workspaceMode === 'worktree' && !workspacePath) {
      throw new Error('A worktree environment requires a workspace path')
    }

    const updatedAt = new Date().toISOString()
    const result = this.database.prepare(`
      UPDATE threads
      SET workspace_path = ?, workspace_mode = ?, environment_status = 'active',
          environment_error = NULL, environment_updated_at = ?, updated_at = ?
      WHERE id = ? AND project_path IS NOT NULL AND environment_status = 'creating'
    `).run(workspacePath, workspaceMode, updatedAt, updatedAt, id)
    if (result.changes === 0) this.throwInvalidEnvironmentTransition(id, 'active')
    return this.getThread(id) as Thread
  }

  transitionEnvironment(id: string, status: 'creating' | 'error' | 'terminated', error?: string): Thread {
    this.assertOpen()
    if (status === 'error' && !error?.trim()) {
      throw new Error('An error environment requires a reason')
    }

    const allowedFrom = status === 'creating' ? ['error'] : status === 'error'
      ? ['creating', 'active']
      : ['creating', 'active', 'error']
    const updatedAt = new Date().toISOString()
    const placeholders = allowedFrom.map(() => '?').join(', ')
    const result = this.database.prepare(`
      UPDATE threads
      SET environment_status = ?, environment_error = ?, environment_updated_at = ?, updated_at = ?
      WHERE id = ? AND environment_status IN (${placeholders})
    `).run(status, status === 'error' ? error?.trim() ?? null : null, updatedAt, updatedAt, id, ...allowedFrom)
    if (result.changes === 0) this.throwInvalidEnvironmentTransition(id, status)
    return this.getThread(id) as Thread
  }

  recoverInterruptedEnvironments(): number {
    this.assertOpen()
    const updatedAt = new Date().toISOString()
    const result = this.database.prepare(`
      UPDATE threads
      SET environment_status = 'error',
          environment_error = 'La création de l’environnement a été interrompue.',
          environment_updated_at = ?, updated_at = ?
      WHERE environment_status = 'creating'
    `).run(updatedAt, updatedAt)
    return Number(result.changes)
  }

  deleteThread(id: string): boolean {
    this.assertOpen()

    const result = this.database.prepare('DELETE FROM threads WHERE id = ?').run(id)
    return result.changes > 0
  }

  appendMessage(threadId: string, input: AppendMessageInput): Message {
    this.assertOpen()

    const message: Message = {
      id: randomUUID(),
      threadId,
      role: input.role,
      content: input.content,
      createdAt: new Date().toISOString()
    }
    this.database.prepare(`
      INSERT INTO messages (id, thread_id, role, content, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(message.id, message.threadId, message.role, message.content, message.createdAt)

    return message
  }

  listMessages(threadId: string): Message[] {
    this.assertOpen()

    return this.database.prepare(`
      SELECT id, thread_id, role, content, created_at
      FROM messages
      WHERE thread_id = ?
      ORDER BY created_at ASC, rowid ASC
    `).all(threadId).map(toMessage)
  }

  getWorkerProfile(projectPath: string): WorkerProfile | null {
    this.assertOpen()
    const row = this.database.prepare(`
      SELECT project_path, mode, runtime, cpu_limit, memory_mb, image, network, updated_at
      FROM project_worker_profiles
      WHERE project_path = ?
    `).get(projectPath)
    return row ? toWorkerProfile(row) : null
  }

  saveWorkerProfile(input: SaveWorkerProfileInput): WorkerProfile {
    this.assertOpen()
    const updatedAt = new Date().toISOString()
    this.database.prepare(`
      INSERT INTO project_worker_profiles (
        project_path, mode, runtime, cpu_limit, memory_mb, image, network, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_path) DO UPDATE SET
        mode = excluded.mode,
        runtime = excluded.runtime,
        cpu_limit = excluded.cpu_limit,
        memory_mb = excluded.memory_mb,
        image = excluded.image,
        network = excluded.network,
        updated_at = excluded.updated_at
    `).run(
      input.projectPath,
      input.mode,
      input.runtime,
      input.cpuLimit,
      input.memoryMb,
      input.image,
      input.network,
      updatedAt
    )
    return this.getWorkerProfile(input.projectPath) as WorkerProfile
  }

  close(): void {
    if (this.closed) return

    this.database.close()
    this.closed = true
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('ThreadStore is closed')
  }

  private throwInvalidEnvironmentTransition(id: string, status: EnvironmentStatus): never {
    const thread = this.getThread(id)
    if (!thread) throw new Error(`Thread not found: ${id}`)
    throw new Error(`Invalid environment transition: ${thread.environmentStatus} -> ${status}`)
  }

  private migrate(): void {
    const row = this.database.prepare('PRAGMA user_version').get()
    const currentVersion = Number(row?.user_version ?? 0)

    if (currentVersion > migrations.length) {
      throw new Error(`Unsupported database version: ${currentVersion}`)
    }

    for (let index = currentVersion; index < migrations.length; index += 1) {
      this.database.exec('BEGIN')
      try {
        this.database.exec(migrations[index] ?? '')
        this.database.exec(`PRAGMA user_version = ${index + 1}`)
        this.database.exec('COMMIT')
      } catch (error) {
        this.database.exec('ROLLBACK')
        throw error
      }
    }
  }

  private ensureThreadColumns(): void {
    const threadsTable = this.database.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'threads'
    `).get()
    if (!threadsTable) return

    const columns = new Set(
      this.database.prepare('PRAGMA table_info(threads)').all()
        .map((row) => String(row.name))
    )
    const missingColumns = [
      ['project_path', 'TEXT'],
      ['workspace_path', 'TEXT'],
      ['workspace_mode', "TEXT NOT NULL DEFAULT 'none' CHECK (workspace_mode IN ('none', 'worktree', 'direct'))"],
      ['model', 'TEXT']
    ] as const

    for (const [name, type] of missingColumns) {
      if (!columns.has(name)) this.database.exec(`ALTER TABLE threads ADD COLUMN ${name} ${type}`)
    }
  }
}
