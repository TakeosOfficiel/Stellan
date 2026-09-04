import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { createBudgetEngine } from './activity-engines/budget'
import { createHangmanEngine } from './activity-engines/hangman'
import type { ThreadStore } from './storage'

export const MAX_PUBLIC_VIEW_BYTES = 8 * 1024

export type ActivityError = {
  code: string
  message: string
  retryable: boolean
}

export type ActivityResult =
  | {
      ok: true
      activityId: string
      engineId: string
      version: number
      status: 'active' | 'completed'
      message: string
      publicView: unknown
    }
  | {
      ok: false
      error: ActivityError
      publicView?: unknown
    }

export type EngineTransition<State> =
  | { ok: true; state: State; completed: boolean; message: string; event: unknown }
  | { ok: false; error: ActivityError }

export type ReliableEngine<State, CreateInput, Action> = {
  id: string
  createSchema: z.ZodType<CreateInput>
  actionSchema: z.ZodType<Action>
  stateSchema: z.ZodType<State>
  create: (input: CreateInput) => State
  apply: (state: State, action: Action) => EngineTransition<State>
  publicView: (state: State) => unknown
}

type RegisteredEngine = ReliableEngine<unknown, unknown, unknown>

export class ReliableEngineRegistry {
  private readonly engines = new Map<string, RegisteredEngine>()

  register<State, CreateInput, Action>(engine: ReliableEngine<State, CreateInput, Action>): void {
    if (this.engines.has(engine.id)) throw new Error(`Reliable engine already registered: ${engine.id}`)
    this.engines.set(engine.id, engine as RegisteredEngine)
  }

  get(id: string): RegisteredEngine | null {
    return this.engines.get(id) ?? null
  }

  ids(): string[] {
    return [...this.engines.keys()]
  }
}

function safeError(code: string, message: string, retryable: boolean): ActivityResult {
  return { ok: false, error: { code, message, retryable } }
}

function checkedPublicView(engine: RegisteredEngine, state: unknown): unknown {
  const view = engine.publicView(state)
  const serialized = JSON.stringify(view)
  if (serialized === undefined || Buffer.byteLength(serialized, 'utf8') > MAX_PUBLIC_VIEW_BYTES) {
    throw new Error('Public activity view exceeds its size limit')
  }
  return view
}

export class ReliableActivityService {
  constructor(
    private readonly store: ThreadStore,
    private readonly registry: ReliableEngineRegistry
  ) {}

  start(threadId: string, engineId: string, input: unknown): ActivityResult {
    try {
      const engine = this.registry.get(engineId)
      if (!engine) return safeError('UNKNOWN_ACTIVITY', 'Cette activité fiable n’est pas disponible.', false)
      const existing = this.store.getActiveReliableActivity(threadId)
      if (existing) {
        return {
          ok: false,
          error: { code: 'ACTIVITY_ALREADY_ACTIVE', message: 'Une activité est déjà en cours dans cette conversation.', retryable: true },
          publicView: this.publicView(existing.engineId, existing.state)
        }
      }
      const parsed = engine.createSchema.safeParse(input)
      if (!parsed.success) return safeError('INVALID_START_INPUT', 'Les paramètres de démarrage de cette activité sont invalides.', true)
      const state = engine.stateSchema.parse(engine.create(parsed.data))
      const publicView = checkedPublicView(engine, state)
      const activity = this.store.createReliableActivity({
        id: randomUUID(),
        threadId,
        engineId,
        state,
        event: { type: 'started' }
      })
      return {
        ok: true,
        activityId: activity.id,
        engineId,
        version: activity.version,
        status: activity.status,
        message: 'L’activité est démarrée.',
        publicView
      }
    } catch {
      return safeError('ACTIVITY_START_FAILED', 'Cette activité n’a pas pu démarrer.', true)
    }
  }

  apply(threadId: string, activityId: string | undefined, action: unknown): ActivityResult {
    try {
      const activity = activityId
        ? this.store.getReliableActivity(activityId)
        : this.store.getActiveReliableActivity(threadId)
      if (!activity || activity.threadId !== threadId) return safeError('ACTIVITY_NOT_FOUND', 'Aucune activité correspondante n’est active.', true)
      const engine = this.registry.get(activity.engineId)
      if (!engine) return safeError('UNKNOWN_ACTIVITY', 'Le moteur de cette activité n’est plus disponible.', false)
      const parsedAction = engine.actionSchema.safeParse(action)
      if (!parsedAction.success) {
        return {
          ok: false,
          error: { code: 'INVALID_ACTION', message: 'Cette action ne respecte pas les règles de l’activité.', retryable: true },
          publicView: this.publicView(activity.engineId, activity.state)
        }
      }
      const state = engine.stateSchema.parse(activity.state)
      const transition = engine.apply(state, parsedAction.data)
      if (!transition.ok) {
        return { ok: false, error: transition.error, publicView: checkedPublicView(engine, state) }
      }
      const nextState = engine.stateSchema.parse(transition.state)
      const publicView = checkedPublicView(engine, nextState)
      const updated = this.store.transitionReliableActivity({
        id: activity.id,
        expectedVersion: activity.version,
        state: nextState,
        completed: transition.completed,
        action: parsedAction.data,
        event: transition.event
      })
      if (!updated) return safeError('ACTIVITY_CONFLICT', 'L’activité a changé entre-temps. Réessayez avec son nouvel état.', true)
      return {
        ok: true,
        activityId: updated.id,
        engineId: updated.engineId,
        version: updated.version,
        status: updated.status,
        message: transition.message,
        publicView
      }
    } catch {
      return safeError('ACTIVITY_ACTION_FAILED', 'Cette action n’a pas pu être appliquée.', true)
    }
  }

  context(threadId: string): string | null {
    const activity = this.store.getActiveReliableActivity(threadId)
    if (!activity) return null
    try {
      return JSON.stringify({
        activityId: activity.id,
        engineId: activity.engineId,
        version: activity.version,
        publicView: this.publicView(activity.engineId, activity.state)
      })
    } catch {
      return null
    }
  }

  private publicView(engineId: string, state: unknown): unknown {
    const engine = this.registry.get(engineId)
    if (!engine) throw new Error('Reliable engine not found')
    return checkedPublicView(engine, engine.stateSchema.parse(state))
  }
}

export function createReliableEngineRegistry(): ReliableEngineRegistry {
  const registry = new ReliableEngineRegistry()
  registry.register(createHangmanEngine())
  registry.register(createBudgetEngine())
  return registry
}
