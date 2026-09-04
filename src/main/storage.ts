import { randomUUID } from 'node:crypto'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import type { OllamaMessage, OllamaToolCall } from './ollama'
import { MODEL_SELECTION_MESSAGE_PREFIX, type ChatImage } from '../shared/contracts'

export type Thread = {
  id: string
  parentThreadId: string | null
  title: string
  projectName: string | null
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
  parentThreadId?: string | null
  projectName?: string | null
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
  images: ChatImage[]
  createdAt: string
}

export type AppendMessageInput = {
  role: MessageRole
  content: string
  images?: ChatImage[]
}

export type AgentRunStatus = 'queued' | 'running' | 'completed' | 'interrupted' | 'error'

export type AgentRun = {
  id: string
  threadId: string
  requestId: string
  userMessageId: string
  model: string
  status: AgentRunStatus
  error: string | null
  priority: number
  assistantContent: string | null
  startedAt: string
  finishedAt: string | null
}

export type AgentRunSummary = AgentRun & {
  userContent: string
}

export type ToolEventStatus = 'running' | 'done' | 'denied' | 'error' | 'interrupted'

export type AgentToolEvent = {
  id: number
  runId: string
  sequence: number
  callId: string
  step: number
  callIndex: number
  tool: string
  status: ToolEventStatus
  arguments: Record<string, unknown> | null
  result: string | null
  assistantContent: string | null
  createdAt: string
}

export type WorkerProfile = {
  projectPath: string
  mode: 'direct' | 'container'
  runtime: 'docker' | 'podman' | null
  cpuLimit: number
  memoryMb: number
  storageGb: number
  automaticCpuMemory: boolean
  image: string
  network: 'none' | 'bridge'
  maxConcurrentWorkers: number
  updatedAt: string
}

export type SaveWorkerProfileInput = Omit<WorkerProfile, 'updatedAt'>

export type ThreadTodo = {
  id: string
  content: string
  status: 'pending' | 'in_progress' | 'completed'
  priority: 'low' | 'medium' | 'high'
}

export type StoredReliableActivity = {
  id: string
  threadId: string
  engineId: string
  state: unknown
  status: 'active' | 'completed'
  version: number
  createdAt: string
  updatedAt: string
}

export type StoredReliableActivityEvent = {
  sequence: number
  action: unknown
  result: unknown
  createdAt: string
}

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
  `,
  `
    CREATE TABLE agent_runs (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      request_id TEXT NOT NULL UNIQUE,
      user_message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      model TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'interrupted', 'error')),
      error TEXT,
      started_at TEXT NOT NULL,
      finished_at TEXT
    );

    CREATE TABLE agent_tool_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
      sequence INTEGER NOT NULL,
      call_id TEXT NOT NULL,
      step INTEGER NOT NULL,
      call_index INTEGER NOT NULL,
      tool TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('running', 'done', 'denied', 'error', 'interrupted')),
      arguments_json TEXT,
      result TEXT,
      assistant_content TEXT,
      created_at TEXT NOT NULL,
      UNIQUE (run_id, sequence)
    );

    CREATE INDEX agent_runs_thread_id_started_at
      ON agent_runs(thread_id, started_at);
    CREATE INDEX agent_tool_events_run_id_sequence
      ON agent_tool_events(run_id, sequence);
  `,
  `
    ALTER TABLE project_worker_profiles
      ADD COLUMN max_concurrent_workers INTEGER NOT NULL DEFAULT 1;

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK (role IN ('system', 'user', 'assistant', 'tool')),
      content TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE agent_runs_new (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      request_id TEXT NOT NULL UNIQUE,
      user_message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      model TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'interrupted', 'error')),
      error TEXT,
      started_at TEXT NOT NULL,
      finished_at TEXT
    );
    INSERT INTO agent_runs_new SELECT * FROM agent_runs;

    CREATE TABLE agent_tool_events_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL REFERENCES agent_runs_new(id) ON DELETE CASCADE,
      sequence INTEGER NOT NULL,
      call_id TEXT NOT NULL,
      step INTEGER NOT NULL,
      call_index INTEGER NOT NULL,
      tool TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('running', 'done', 'denied', 'error', 'interrupted')),
      arguments_json TEXT,
      result TEXT,
      assistant_content TEXT,
      created_at TEXT NOT NULL,
      UNIQUE (run_id, sequence)
    );
    INSERT INTO agent_tool_events_new SELECT * FROM agent_tool_events;
    DROP TABLE agent_tool_events;
    DROP TABLE agent_runs;
    ALTER TABLE agent_runs_new RENAME TO agent_runs;
    ALTER TABLE agent_tool_events_new RENAME TO agent_tool_events;
    CREATE INDEX agent_runs_thread_id_started_at ON agent_runs(thread_id, started_at);
    CREATE INDEX agent_tool_events_run_id_sequence ON agent_tool_events(run_id, sequence);
  `,
  `
    ALTER TABLE agent_runs ADD COLUMN priority INTEGER NOT NULL DEFAULT 0;
    CREATE INDEX agent_runs_thread_queue
      ON agent_runs(thread_id, status, priority DESC, started_at);
  `,
  `
    ALTER TABLE agent_runs ADD COLUMN assistant_content TEXT;

    UPDATE agent_runs
    SET assistant_content = (
      SELECT assistant.content
      FROM messages AS user_message
      JOIN messages AS assistant ON assistant.thread_id = user_message.thread_id
      WHERE user_message.id = agent_runs.user_message_id
        AND assistant.role = 'assistant'
        AND assistant.rowid > user_message.rowid
      ORDER BY assistant.rowid ASC
      LIMIT 1
    )
    WHERE status IN ('completed', 'interrupted', 'error');
  `,
  `
    ALTER TABLE threads ADD COLUMN parent_thread_id TEXT REFERENCES threads(id) ON DELETE CASCADE;
    CREATE INDEX threads_parent_thread_id ON threads(parent_thread_id, created_at);
  `,
  `
    ALTER TABLE threads ADD COLUMN project_name TEXT;
  `,
  `
    ALTER TABLE project_worker_profiles ADD COLUMN storage_gb INTEGER NOT NULL DEFAULT 20;
    ALTER TABLE project_worker_profiles ADD COLUMN automatic_cpu_memory INTEGER NOT NULL DEFAULT 1
      CHECK (automatic_cpu_memory IN (0, 1));
  `,
  `
    CREATE TABLE thread_todos (
      thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      id TEXT NOT NULL,
      content TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'in_progress', 'completed')),
      priority TEXT NOT NULL CHECK (priority IN ('low', 'medium', 'high')),
      position INTEGER NOT NULL,
      PRIMARY KEY (thread_id, id)
    );
  `,
  `
    ALTER TABLE messages ADD COLUMN images_json TEXT NOT NULL DEFAULT '[]';
  `,
  `
    CREATE TABLE reliable_activities (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      engine_id TEXT NOT NULL,
      state_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('active', 'completed')),
      version INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE UNIQUE INDEX reliable_activities_one_active_per_thread
      ON reliable_activities(thread_id) WHERE status = 'active';

    CREATE TABLE reliable_activity_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      activity_id TEXT NOT NULL REFERENCES reliable_activities(id) ON DELETE CASCADE,
      sequence INTEGER NOT NULL,
      action_json TEXT NOT NULL,
      result_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE (activity_id, sequence)
    );

    CREATE INDEX reliable_activity_events_activity_sequence
      ON reliable_activity_events(activity_id, sequence);
  `
]

function toThread(row: StorageRow): Thread {
  return {
    id: String(row.id),
    parentThreadId: row.parent_thread_id === null || row.parent_thread_id === undefined
      ? null
      : String(row.parent_thread_id),
    title: String(row.title),
    projectName: row.project_name === null || row.project_name === undefined ? null : String(row.project_name),
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
  const images = JSON.parse(String(row.images_json ?? '[]')) as ChatImage[]
  return {
    id: String(row.id),
    threadId: String(row.thread_id),
    role: String(row.role) as MessageRole,
    content: String(row.content),
    images,
    createdAt: String(row.created_at)
  }
}

function toWorkerProfile(row: StorageRow): WorkerProfile {
  const mode = row.mode === 'direct' || row.mode === 'container' ? row.mode : null
  const runtime = row.runtime === 'docker' || row.runtime === 'podman' ? row.runtime : null
  const cpuLimit = Number(row.cpu_limit)
  const memoryMb = Number(row.memory_mb)
  const storageGb = Number(row.storage_gb)
  const automaticCpuMemory = Number(row.automatic_cpu_memory)
  const maxConcurrentWorkers = Number(row.max_concurrent_workers)
  if (
    !mode || (mode === 'container' && !runtime) || (mode === 'direct' && runtime) ||
    !Number.isFinite(cpuLimit) || cpuLimit < 0.5 ||
    !Number.isInteger(memoryMb) || memoryMb < 512 ||
    !Number.isInteger(storageGb) || storageGb < 1 ||
    (automaticCpuMemory !== 0 && automaticCpuMemory !== 1) ||
    !Number.isInteger(maxConcurrentWorkers) || maxConcurrentWorkers < 1 || maxConcurrentWorkers > 32 ||
    (row.network !== 'none' && row.network !== 'bridge')
  ) {
    throw new Error(`Invalid persisted worker profile for ${String(row.project_path)}`)
  }
  return {
    projectPath: String(row.project_path),
    mode,
    runtime,
    cpuLimit,
    memoryMb,
    storageGb,
    automaticCpuMemory: automaticCpuMemory === 1,
    image: String(row.image),
    network: row.network,
    maxConcurrentWorkers,
    updatedAt: String(row.updated_at)
  }
}

function toAgentRun(row: StorageRow): AgentRun {
  return {
    id: String(row.id),
    threadId: String(row.thread_id),
    requestId: String(row.request_id),
    userMessageId: String(row.user_message_id),
    model: String(row.model),
    status: String(row.status) as AgentRunStatus,
    error: row.error === null ? null : String(row.error),
    priority: Number(row.priority ?? 0),
    assistantContent: row.assistant_content === null || row.assistant_content === undefined
      ? null
      : String(row.assistant_content),
    startedAt: String(row.started_at),
    finishedAt: row.finished_at === null ? null : String(row.finished_at)
  }
}

function toAgentToolEvent(row: StorageRow): AgentToolEvent {
  return {
    id: Number(row.id),
    runId: String(row.run_id),
    sequence: Number(row.sequence),
    callId: String(row.call_id),
    step: Number(row.step),
    callIndex: Number(row.call_index),
    tool: String(row.tool),
    status: String(row.status) as ToolEventStatus,
    arguments: row.arguments_json === null
      ? null
      : JSON.parse(String(row.arguments_json)) as Record<string, unknown>,
    result: row.result === null ? null : String(row.result),
    assistantContent: row.assistant_content === null ? null : String(row.assistant_content),
    createdAt: String(row.created_at)
  }
}

function toReliableActivity(row: StorageRow): StoredReliableActivity {
  return {
    id: String(row.id),
    threadId: String(row.thread_id),
    engineId: String(row.engine_id),
    state: JSON.parse(String(row.state_json)),
    status: String(row.status) as StoredReliableActivity['status'],
    version: Number(row.version),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  }
}

function toReliableActivityEvent(row: StorageRow): StoredReliableActivityEvent {
  return {
    sequence: Number(row.sequence),
    action: JSON.parse(String(row.action_json)),
    result: JSON.parse(String(row.result_json)),
    createdAt: String(row.created_at)
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

    if (input.parentThreadId && !this.getThread(input.parentThreadId)) {
      throw new Error(`Parent thread not found: ${input.parentThreadId}`)
    }

    const thread: Thread = {
      id: randomUUID(),
      parentThreadId: input.parentThreadId ?? null,
      title: input.title,
      projectName: input.projectName ?? null,
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
        id, parent_thread_id, title, project_name, project_path, workspace_path, workspace_mode,
        environment_status, environment_error, environment_updated_at,
        model, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      thread.id,
      thread.parentThreadId,
      thread.title,
      thread.projectName,
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
      SELECT id, parent_thread_id, title, project_name, project_path, workspace_path, workspace_mode,
             environment_status, environment_error, environment_updated_at,
             model, created_at, updated_at
      FROM threads
      ORDER BY created_at ASC, rowid ASC
    `).all().map(toThread)
  }

  getThread(id: string): Thread | null {
    this.assertOpen()

    const row = this.database.prepare(`
      SELECT id, parent_thread_id, title, project_name, project_path, workspace_path, workspace_mode,
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

  setThreadModel(id: string, model: string): { thread: Thread; message: Message | null } | null {
    this.assertOpen()
    const current = this.getThread(id)
    if (!current) return null
    if (current.model === model) return { thread: current, message: null }

    const updatedAt = new Date().toISOString()
    const message: Message = {
      id: randomUUID(),
      threadId: id,
      role: 'system',
      content: `${MODEL_SELECTION_MESSAGE_PREFIX}${model}`,
      images: [],
      createdAt: updatedAt
    }
    this.database.exec('BEGIN IMMEDIATE')
    try {
      this.database.prepare('UPDATE threads SET model = ?, updated_at = ? WHERE id = ?')
        .run(model, updatedAt, id)
      this.database.prepare(`
        INSERT INTO messages (id, thread_id, role, content, images_json, created_at)
        VALUES (?, ?, 'system', ?, '[]', ?)
      `).run(message.id, id, message.content, updatedAt)
      this.database.exec('COMMIT')
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    }
    return { thread: this.getThread(id) as Thread, message }
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
      images: input.images ?? [],
      createdAt: new Date().toISOString()
    }
    this.database.prepare(`
      INSERT INTO messages (id, thread_id, role, content, images_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(message.id, message.threadId, message.role, message.content, JSON.stringify(message.images), message.createdAt)

    return message
  }

  listMessages(threadId: string): Message[] {
    this.assertOpen()

    return this.database.prepare(`
      SELECT messages.id, messages.thread_id, messages.role, messages.content, messages.images_json, messages.created_at
      FROM messages
      LEFT JOIN agent_runs ON agent_runs.user_message_id = messages.id
      WHERE messages.thread_id = ?
        AND (agent_runs.id IS NULL OR agent_runs.status != 'queued')
      ORDER BY messages.created_at ASC, messages.rowid ASC
    `).all(threadId).map(toMessage)
  }

  listTodos(threadId: string): ThreadTodo[] {
    this.assertOpen()
    return this.database.prepare(`
      SELECT id, content, status, priority
      FROM thread_todos
      WHERE thread_id = ?
      ORDER BY position ASC
    `).all(threadId).map((row) => ({
      id: String(row.id),
      content: String(row.content),
      status: String(row.status) as ThreadTodo['status'],
      priority: String(row.priority) as ThreadTodo['priority']
    }))
  }

  replaceTodos(threadId: string, todos: ThreadTodo[]): ThreadTodo[] {
    this.assertOpen()
    if (!this.getThread(threadId)) throw new Error(`Thread not found: ${threadId}`)
    if (new Set(todos.map((todo) => todo.id)).size !== todos.length) throw new Error('Todo identifiers must be unique')
    this.database.exec('BEGIN')
    try {
      this.database.prepare('DELETE FROM thread_todos WHERE thread_id = ?').run(threadId)
      const insert = this.database.prepare(`
        INSERT INTO thread_todos (thread_id, id, content, status, priority, position)
        VALUES (?, ?, ?, ?, ?, ?)
      `)
      todos.forEach((todo, position) => {
        insert.run(threadId, todo.id, todo.content, todo.status, todo.priority, position)
      })
      this.database.exec('COMMIT')
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    }
    return this.listTodos(threadId)
  }

  createReliableActivity(input: {
    id: string
    threadId: string
    engineId: string
    state: unknown
    event: unknown
  }): StoredReliableActivity {
    this.assertOpen()
    if (!this.getThread(input.threadId)) throw new Error(`Thread not found: ${input.threadId}`)
    const createdAt = new Date().toISOString()
    this.database.exec('BEGIN IMMEDIATE')
    try {
      this.database.prepare(`
        INSERT INTO reliable_activities (
          id, thread_id, engine_id, state_json, status, version, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'active', 0, ?, ?)
      `).run(input.id, input.threadId, input.engineId, JSON.stringify(input.state), createdAt, createdAt)
      this.database.prepare(`
        INSERT INTO reliable_activity_events (
          activity_id, sequence, action_json, result_json, created_at
        ) VALUES (?, 0, ?, ?, ?)
      `).run(input.id, JSON.stringify({ type: 'create' }), JSON.stringify(input.event), createdAt)
      this.database.exec('COMMIT')
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    }
    return this.getReliableActivity(input.id) as StoredReliableActivity
  }

  getReliableActivity(id: string): StoredReliableActivity | null {
    this.assertOpen()
    const row = this.database.prepare(`
      SELECT id, thread_id, engine_id, state_json, status, version, created_at, updated_at
      FROM reliable_activities
      WHERE id = ?
    `).get(id)
    return row ? toReliableActivity(row) : null
  }

  getActiveReliableActivity(threadId: string): StoredReliableActivity | null {
    this.assertOpen()
    const row = this.database.prepare(`
      SELECT id, thread_id, engine_id, state_json, status, version, created_at, updated_at
      FROM reliable_activities
      WHERE thread_id = ? AND status = 'active'
    `).get(threadId)
    return row ? toReliableActivity(row) : null
  }

  listReliableActivityEvents(activityId: string): StoredReliableActivityEvent[] {
    this.assertOpen()
    return this.database.prepare(`
      SELECT sequence, action_json, result_json, created_at
      FROM reliable_activity_events
      WHERE activity_id = ?
      ORDER BY sequence ASC
    `).all(activityId).map(toReliableActivityEvent)
  }

  transitionReliableActivity(input: {
    id: string
    expectedVersion: number
    state: unknown
    completed: boolean
    action: unknown
    event: unknown
  }): StoredReliableActivity | null {
    this.assertOpen()
    const updatedAt = new Date().toISOString()
    this.database.exec('BEGIN IMMEDIATE')
    try {
      const update = this.database.prepare(`
        UPDATE reliable_activities
        SET state_json = ?, status = ?, version = version + 1, updated_at = ?
        WHERE id = ? AND status = 'active' AND version = ?
      `).run(
        JSON.stringify(input.state),
        input.completed ? 'completed' : 'active',
        updatedAt,
        input.id,
        input.expectedVersion
      )
      if (update.changes === 0) {
        this.database.exec('ROLLBACK')
        return null
      }
      this.database.prepare(`
        INSERT INTO reliable_activity_events (
          activity_id, sequence, action_json, result_json, created_at
        ) VALUES (?, ?, ?, ?, ?)
      `).run(
        input.id,
        input.expectedVersion + 1,
        JSON.stringify(input.action),
        JSON.stringify(input.event),
        updatedAt
      )
      this.database.exec('COMMIT')
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    }
    return this.getReliableActivity(input.id)
  }

  startAgentRun(
    threadId: string,
    requestId: string,
    model: string,
    userContent: string,
    images: ChatImage[] = []
  ): AgentRun {
    this.assertOpen()
    const runId = randomUUID()
    const startedAt = new Date().toISOString()

    this.database.exec('BEGIN')
    try {
      const userMessage = this.appendMessage(threadId, { role: 'user', content: userContent, images })
      this.database.prepare(`
        INSERT INTO agent_runs (
          id, thread_id, request_id, user_message_id, model, status, error, started_at, finished_at
        ) VALUES (?, ?, ?, ?, ?, 'queued', NULL, ?, NULL)
      `).run(runId, threadId, requestId, userMessage.id, model, startedAt)
      this.database.prepare('UPDATE threads SET model = ?, updated_at = ? WHERE id = ?')
        .run(model, startedAt, threadId)
      this.database.exec('COMMIT')
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    }

    return this.getAgentRun(runId) as AgentRun
  }

  markAgentRunRunning(runId: string): AgentRun {
    this.assertOpen()
    const result = this.database.prepare(`
      UPDATE agent_runs SET status = 'running' WHERE id = ? AND status = 'queued'
    `).run(runId)
    if (result.changes === 0) throw new Error(`Agent run is not queued: ${runId}`)
    return this.getAgentRun(runId) as AgentRun
  }

  listActiveAgentRuns(): AgentRun[] {
    this.assertOpen()
    return this.database.prepare(`
      SELECT id, thread_id, request_id, user_message_id, model, status, error, priority, assistant_content,
             started_at, finished_at
      FROM agent_runs WHERE status IN ('queued', 'running')
      ORDER BY CASE status WHEN 'running' THEN 0 ELSE 1 END, priority DESC, started_at ASC, rowid ASC
    `).all().map(toAgentRun)
  }

  listQueuedAgentRuns(): AgentRun[] {
    this.assertOpen()
    return this.database.prepare(`
      SELECT id, thread_id, request_id, user_message_id, model, status, error, priority, assistant_content,
             started_at, finished_at
      FROM agent_runs WHERE status = 'queued'
      ORDER BY priority DESC, started_at ASC, rowid ASC
    `).all().map(toAgentRun)
  }

  getAgentRun(id: string): AgentRun | null {
    this.assertOpen()
    const row = this.database.prepare(`
      SELECT id, thread_id, request_id, user_message_id, model, status, error, priority, assistant_content,
             started_at, finished_at
      FROM agent_runs
      WHERE id = ?
    `).get(id)
    return row ? toAgentRun(row) : null
  }

  listAgentRuns(threadId: string): AgentRun[] {
    this.assertOpen()
    return this.database.prepare(`
      SELECT id, thread_id, request_id, user_message_id, model, status, error, priority, assistant_content,
             started_at, finished_at
      FROM agent_runs
      WHERE thread_id = ?
      ORDER BY started_at ASC, rowid ASC
    `).all(threadId).map(toAgentRun)
  }

  listAgentRunSummaries(threadId: string): AgentRunSummary[] {
    this.assertOpen()
    return this.database.prepare(`
      SELECT runs.id, runs.thread_id, runs.request_id, runs.user_message_id, runs.model,
             runs.status, runs.error, runs.priority, runs.assistant_content, runs.started_at, runs.finished_at,
             messages.content AS user_content
      FROM agent_runs runs
      JOIN messages ON messages.id = runs.user_message_id
      WHERE runs.thread_id = ?
      ORDER BY CASE runs.status WHEN 'running' THEN 0 WHEN 'queued' THEN 1 ELSE 2 END,
               runs.priority DESC, runs.started_at ASC, runs.rowid ASC
    `).all(threadId).map((row) => ({ ...toAgentRun(row), userContent: String(row.user_content) }))
  }

  updateQueuedAgentRun(requestId: string, content: string): AgentRunSummary {
    this.assertOpen()
    const trimmed = content.trim()
    if (!trimmed) throw new Error('Le message en attente ne peut pas être vide.')
    const run = this.getAgentRunByRequestId(requestId)
    if (!run || run.status !== 'queued') throw new Error('Ce message n’est plus modifiable.')
    this.database.prepare('UPDATE messages SET content = ? WHERE id = ?').run(trimmed, run.userMessageId)
    return this.listAgentRunSummaries(run.threadId).find((entry) => entry.requestId === requestId) as AgentRunSummary
  }

  deleteQueuedAgentRun(requestId: string): boolean {
    this.assertOpen()
    const run = this.getAgentRunByRequestId(requestId)
    if (!run || run.status !== 'queued') return false
    this.database.exec('BEGIN')
    try {
      this.database.prepare('DELETE FROM agent_runs WHERE id = ? AND status = \'queued\'').run(run.id)
      this.database.prepare('DELETE FROM messages WHERE id = ?').run(run.userMessageId)
      this.database.exec('COMMIT')
      return true
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    }
  }

  prioritizeQueuedAgentRun(requestId: string): AgentRun {
    this.assertOpen()
    const run = this.getAgentRunByRequestId(requestId)
    if (!run || run.status !== 'queued') throw new Error('Ce message n’est plus en attente.')
    const row = this.database.prepare(`
      SELECT COALESCE(MAX(priority), 0) + 1 AS priority FROM agent_runs WHERE status = 'queued'
    `).get()
    this.database.prepare('UPDATE agent_runs SET priority = ? WHERE id = ? AND status = \'queued\'')
      .run(Number(row?.priority ?? 1), run.id)
    return this.getAgentRun(run.id) as AgentRun
  }

  recordToolStarted(
    runId: string,
    input: {
      callId: string
      step: number
      callIndex: number
      tool: string
      arguments: Record<string, unknown>
      assistantContent: string
    }
  ): AgentToolEvent {
    this.assertOpen()
    const run = this.getAgentRun(runId)
    if (!run) throw new Error(`Agent run not found: ${runId}`)
    if (run.status !== 'running') throw new Error(`Agent run is not active: ${runId}`)
    const sequence = this.nextToolEventSequence(runId)
    const createdAt = new Date().toISOString()
    const result = this.database.prepare(`
      INSERT INTO agent_tool_events (
        run_id, sequence, call_id, step, call_index, tool, status,
        arguments_json, result, assistant_content, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'running', ?, NULL, ?, ?)
    `).run(
      runId,
      sequence,
      input.callId,
      input.step,
      input.callIndex,
      input.tool,
      JSON.stringify(input.arguments),
      input.assistantContent,
      createdAt
    )
    return this.getAgentToolEvent(Number(result.lastInsertRowid)) as AgentToolEvent
  }

  recordToolFinished(
    runId: string,
    callId: string,
    status: Exclude<ToolEventStatus, 'running' | 'interrupted'>,
    result: string
  ): AgentToolEvent {
    this.assertOpen()
    const started = this.database.prepare(`
      SELECT tool, step, call_index
      FROM agent_tool_events
      WHERE run_id = ? AND call_id = ? AND status = 'running'
        AND NOT EXISTS (
          SELECT 1 FROM agent_tool_events terminal
          WHERE terminal.run_id = agent_tool_events.run_id
            AND terminal.call_id = agent_tool_events.call_id
            AND terminal.status != 'running'
        )
      ORDER BY sequence DESC
      LIMIT 1
    `).get(runId, callId)
    if (!started) throw new Error(`Tool call is not active: ${callId}`)
    const sequence = this.nextToolEventSequence(runId)
    const createdAt = new Date().toISOString()
    const insert = this.database.prepare(`
      INSERT INTO agent_tool_events (
        run_id, sequence, call_id, step, call_index, tool, status,
        arguments_json, result, assistant_content, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, ?)
    `).run(
      runId,
      sequence,
      callId,
      Number(started.step),
      Number(started.call_index),
      String(started.tool),
      status,
      result,
      createdAt
    )
    return this.getAgentToolEvent(Number(insert.lastInsertRowid)) as AgentToolEvent
  }

  listAgentToolEvents(runId: string): AgentToolEvent[] {
    this.assertOpen()
    return this.database.prepare(`
      SELECT id, run_id, sequence, call_id, step, call_index, tool, status,
             arguments_json, result, assistant_content, created_at
      FROM agent_tool_events
      WHERE run_id = ?
      ORDER BY sequence ASC
    `).all(runId).map(toAgentToolEvent)
  }

  finishAgentRun(
    runId: string,
    status: Exclude<AgentRunStatus, 'queued' | 'running'>,
    assistantContent: string,
    error?: string
  ): AgentRun {
    this.assertOpen()
    const run = this.getAgentRun(runId)
    if (!run) throw new Error(`Agent run not found: ${runId}`)
    if (run.status !== 'running' && run.status !== 'queued') return run
    const finishedAt = new Date().toISOString()

    this.database.exec('BEGIN')
    try {
      this.interruptOpenToolCalls(runId, finishedAt)
      if (assistantContent) {
        this.appendMessage(run.threadId, { role: 'assistant', content: assistantContent })
      }
      this.database.prepare(`
        UPDATE agent_runs
        SET status = ?, error = ?, assistant_content = ?, finished_at = ?
        WHERE id = ? AND status IN ('queued', 'running')
      `).run(status, error?.trim() || null, assistantContent || null, finishedAt, runId)
      this.database.exec('COMMIT')
    } catch (caught) {
      this.database.exec('ROLLBACK')
      throw caught
    }
    return this.getAgentRun(runId) as AgentRun
  }

  recoverInterruptedAgentRuns(): number {
    this.assertOpen()
    const runs = this.database.prepare(`
      SELECT runs.id
      FROM agent_runs runs
      JOIN threads ON threads.id = runs.thread_id
      WHERE runs.status = 'running'
         OR (runs.status = 'queued' AND threads.parent_thread_id IS NOT NULL)
      ORDER BY runs.started_at ASC, runs.rowid ASC
    `).all()
    if (runs.length === 0) return 0
    const finishedAt = new Date().toISOString()

    this.database.exec('BEGIN')
    try {
      const interrupt = this.database.prepare(`
        UPDATE agent_runs
        SET status = 'interrupted', error = 'Application fermée pendant la génération.', finished_at = ?
        WHERE id = ? AND status IN ('queued', 'running')
      `)
      for (const row of runs) {
        this.interruptOpenToolCalls(String(row.id), finishedAt)
        interrupt.run(finishedAt, String(row.id))
      }
      this.database.exec('COMMIT')
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    }
    return runs.length
  }

  listPromptMessages(threadId: string, throughUserMessageId?: string): OllamaMessage[] {
    this.assertOpen()
    const runs = this.listAgentRuns(threadId)
    const messages = new Map(this.database.prepare(`
      SELECT id, thread_id, role, content, images_json, created_at
      FROM messages
      WHERE thread_id = ?
      ORDER BY created_at ASC, rowid ASC
    `).all(threadId).map(toMessage).map((message) => [message.id, message]))
    const prompt: OllamaMessage[] = []

    for (const run of runs) {
      if (run.status === 'queued' && run.userMessageId !== throughUserMessageId) continue
      const userMessage = messages.get(run.userMessageId)
      if (!userMessage) continue
      prompt.push({
        role: 'user',
        content: userMessage.content,
        ...(userMessage.images.length > 0 ? { images: userMessage.images } : {})
      })

      const events = this.listAgentToolEvents(run.id)
      const starts = events.filter((event) => event.status === 'running')
      const terminalByCall = new Map(
        events.filter((event) => event.status !== 'running').map((event) => [event.callId, event])
      )
      const steps = new Map<number, AgentToolEvent[]>()
      for (const event of starts) {
        const step = steps.get(event.step) ?? []
        step.push(event)
        steps.set(event.step, step)
      }
      for (const stepEvents of [...steps.values()]) {
        stepEvents.sort((left, right) => left.callIndex - right.callIndex)
        const toolCalls: OllamaToolCall[] = stepEvents.map((event) => ({
          function: { name: event.tool, arguments: event.arguments ?? {} }
        }))
        prompt.push({
          role: 'assistant',
          content: stepEvents[0]?.assistantContent ?? '',
          tool_calls: toolCalls
        })
        for (const event of stepEvents) {
          const terminal = terminalByCall.get(event.callId)
          prompt.push({
            role: 'tool',
            tool_name: event.tool,
            content: terminal?.result ?? '[Appel d’outil interrompu]'
          })
        }
      }
      if (run.assistantContent) prompt.push({ role: 'assistant', content: run.assistantContent })
      if (run.userMessageId === throughUserMessageId) break
    }
    return prompt
  }

  getWorkerProfile(projectPath: string): WorkerProfile | null {
    this.assertOpen()
    const row = this.database.prepare(`
      SELECT project_path, mode, runtime, cpu_limit, memory_mb, storage_gb,
             automatic_cpu_memory, image, network,
             max_concurrent_workers, updated_at
      FROM project_worker_profiles
      WHERE project_path = ?
    `).get(projectPath)
    return row ? toWorkerProfile(row) : null
  }

  saveWorkerProfile(input: SaveWorkerProfileInput): WorkerProfile {
    this.assertOpen()
    if (
      !Number.isFinite(input.cpuLimit) || input.cpuLimit < 0.5 || input.cpuLimit > 128 ||
      !Number.isInteger(input.memoryMb) || input.memoryMb < 512 || input.memoryMb > 1_048_576 ||
      !Number.isInteger(input.storageGb) || input.storageGb < 1 || input.storageGb > 4_096 ||
      !Number.isInteger(input.maxConcurrentWorkers) ||
      input.maxConcurrentWorkers < 1 || input.maxConcurrentWorkers > 32 ||
      !/^[A-Za-z0-9][A-Za-z0-9._/:@-]*$/.test(input.image) || input.image.length > 300 ||
      (input.network !== 'none' && input.network !== 'bridge')
    ) {
      throw new Error('invalid worker profile resources')
    }
    const updatedAt = new Date().toISOString()
    this.database.prepare(`
      INSERT INTO project_worker_profiles (
        project_path, mode, runtime, cpu_limit, memory_mb, storage_gb, automatic_cpu_memory,
        image, network, max_concurrent_workers, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_path) DO UPDATE SET
        mode = excluded.mode,
        runtime = excluded.runtime,
        cpu_limit = excluded.cpu_limit,
        memory_mb = excluded.memory_mb,
        storage_gb = excluded.storage_gb,
        automatic_cpu_memory = excluded.automatic_cpu_memory,
        image = excluded.image,
        network = excluded.network,
        max_concurrent_workers = excluded.max_concurrent_workers,
        updated_at = excluded.updated_at
    `).run(
      input.projectPath,
      input.mode,
      input.runtime,
      input.cpuLimit,
      input.memoryMb,
      input.storageGb,
      input.automaticCpuMemory ? 1 : 0,
      input.image,
      input.network,
      input.maxConcurrentWorkers,
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

  private getAgentToolEvent(id: number): AgentToolEvent | null {
    const row = this.database.prepare(`
      SELECT id, run_id, sequence, call_id, step, call_index, tool, status,
             arguments_json, result, assistant_content, created_at
      FROM agent_tool_events
      WHERE id = ?
    `).get(id)
    return row ? toAgentToolEvent(row) : null
  }

  private getAgentRunByRequestId(requestId: string): AgentRun | null {
    const row = this.database.prepare(`
      SELECT id, thread_id, request_id, user_message_id, model, status, error, priority, assistant_content,
             started_at, finished_at
      FROM agent_runs WHERE request_id = ?
    `).get(requestId)
    return row ? toAgentRun(row) : null
  }

  private nextToolEventSequence(runId: string): number {
    const row = this.database.prepare(`
      SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence
      FROM agent_tool_events
      WHERE run_id = ?
    `).get(runId)
    return Number(row?.sequence ?? 1)
  }

  private interruptOpenToolCalls(runId: string, createdAt: string): void {
    const openCalls = this.database.prepare(`
      SELECT started.call_id, started.step, started.call_index, started.tool
      FROM agent_tool_events started
      WHERE started.run_id = ? AND started.status = 'running'
        AND NOT EXISTS (
          SELECT 1 FROM agent_tool_events terminal
          WHERE terminal.run_id = started.run_id
            AND terminal.call_id = started.call_id
            AND terminal.status != 'running'
        )
      ORDER BY started.sequence ASC
    `).all(runId)
    for (const call of openCalls) {
      this.database.prepare(`
        INSERT INTO agent_tool_events (
          run_id, sequence, call_id, step, call_index, tool, status,
          arguments_json, result, assistant_content, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'interrupted', NULL, ?, NULL, ?)
      `).run(
        runId,
        this.nextToolEventSequence(runId),
        String(call.call_id),
        Number(call.step),
        Number(call.call_index),
        String(call.tool),
        'Appel d’outil interrompu.',
        createdAt
      )
    }
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
