import { z } from 'zod'
import type { ActivityError, EngineTransition, ReliableEngine } from '../reliable-activities'

type Scalar = boolean | number | string
type State = Record<string, Scalar>
type Action = Record<string, Scalar> & { type: string }

const scalarSchema = z.union([z.boolean(), z.number().finite(), z.string()])
const variableSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('boolean'), initial: z.boolean() }).strict(),
  z.object({ kind: z.literal('integer'), initial: z.number().int(), min: z.number().int(), max: z.number().int() }).strict(),
  z.object({ kind: z.literal('enum'), initial: z.string(), values: z.array(z.string().min(1).max(80)).min(1).max(20) }).strict(),
  z.object({ kind: z.literal('string'), initial: z.string(), maxLength: z.number().int().min(1).max(500) }).strict()
])
const fieldSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('boolean') }).strict(),
  z.object({ kind: z.literal('integer'), min: z.number().int(), max: z.number().int() }).strict(),
  z.object({ kind: z.literal('enum'), values: z.array(z.string().min(1).max(80)).min(1).max(20) }).strict(),
  z.object({ kind: z.literal('string'), maxLength: z.number().int().min(1).max(500) }).strict()
])
const referenceSchema = z.object({
  source: z.enum(['state', 'action']),
  key: z.string().regex(/^[a-z][a-zA-Z0-9]{0,39}$/)
}).strict()
const conditionSchema = z.discriminatedUnion('operator', [
  z.object({ operator: z.literal('equals'), ref: referenceSchema, value: scalarSchema }).strict(),
  z.object({ operator: z.literal('lessThan'), ref: referenceSchema, value: z.number().finite() }).strict(),
  z.object({
    operator: z.literal('containsToken'),
    ref: referenceSchema,
    tokens: z.array(z.string().trim().min(1).max(40)).min(1).max(20)
  }).strict()
])
const effectSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('set'), variable: z.string(), value: scalarSchema }).strict(),
  z.object({ operation: z.literal('increment'), variable: z.string(), amount: z.number().int().min(-100).max(100) }).strict()
])
const declarativeSpecSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{1,39}$/),
  title: z.string().trim().min(1).max(100),
  variables: z.record(z.string().regex(/^[a-z][a-zA-Z0-9]{0,39}$/), variableSchema).refine((value) => Object.keys(value).length <= 20),
  actions: z.array(z.object({
    type: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/),
    fields: z.record(z.string().regex(/^[a-z][a-zA-Z0-9]{0,39}$/), fieldSchema).refine((value) => Object.keys(value).length <= 10)
  }).strict()).min(1).max(12),
  transitions: z.array(z.object({
    action: z.string(),
    when: z.array(conditionSchema).max(8),
    effects: z.array(effectSchema).min(1).max(8),
    completed: z.boolean(),
    message: z.string().trim().min(1).max(500)
  }).strict()).min(1).max(40),
  publicVariables: z.array(z.string()).max(20)
}).strict()

export type DeclarativeActivitySpec = z.infer<typeof declarativeSpecSchema>

function schemaForDescriptor(descriptor: z.infer<typeof variableSchema> | z.infer<typeof fieldSchema>): z.ZodType {
  if (descriptor.kind === 'boolean') return z.boolean()
  if (descriptor.kind === 'integer') return z.number().int().min(descriptor.min).max(descriptor.max)
  if (descriptor.kind === 'enum') return z.enum(descriptor.values as [string, ...string[]])
  return z.string().max(descriptor.maxLength)
}

function normalizeTokens(value: string): string[] {
  return value.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLocaleLowerCase('fr').match(/[a-z0-9]+/g) ?? []
}

function referencedValue(ref: z.infer<typeof referenceSchema>, state: State, action: Action): Scalar | undefined {
  return ref.source === 'state' ? state[ref.key] : action[ref.key]
}

function conditionMatches(
  condition: z.infer<typeof conditionSchema>,
  state: State,
  action: Action
): boolean {
  const value = referencedValue(condition.ref, state, action)
  if (condition.operator === 'equals') return value === condition.value
  if (condition.operator === 'lessThan') return typeof value === 'number' && value < condition.value
  const valueTokens = typeof value === 'string' ? new Set(normalizeTokens(value)) : null
  return valueTokens !== null
    && condition.tokens.some((token) => valueTokens.has(normalizeTokens(token)[0] ?? ''))
}

function applySpec(
  spec: DeclarativeActivitySpec,
  state: State,
  action: Action
): { transition: DeclarativeActivitySpec['transitions'][number]; state: State; index: number } | null {
  const index = spec.transitions.findIndex((transition) =>
    transition.action === action.type && transition.when.every((condition) => conditionMatches(condition, state, action)))
  if (index < 0) return null
  const transition = spec.transitions[index] as DeclarativeActivitySpec['transitions'][number]
  const next = { ...state }
  for (const effect of transition.effects) {
    if (effect.operation === 'set') next[effect.variable] = effect.value
    else next[effect.variable] = Number(next[effect.variable]) + effect.amount
  }
  return { transition, state: next, index }
}

function sampleActions(spec: DeclarativeActivitySpec): Action[] {
  return spec.actions.flatMap((definition) => {
    const base: Action = { type: definition.type }
    for (const [key, field] of Object.entries(definition.fields)) {
      base[key] = field.kind === 'boolean' ? false
        : field.kind === 'integer' ? field.min
          : field.kind === 'enum' ? field.values[0] as string
            : ''
    }
    const samples = [base]
    for (const transition of spec.transitions.filter((candidate) => candidate.action === definition.type)) {
      for (const condition of transition.when) {
        if (condition.operator === 'containsToken' && condition.ref.source === 'action') {
          for (const token of condition.tokens) samples.push({ ...base, [condition.ref.key]: token })
        }
      }
    }
    return samples
  })
}

function validateSemantics(spec: DeclarativeActivitySpec, stateSchema: z.ZodType<State>, actionSchema: z.ZodType<Action>): void {
  const actionTypes = new Set(spec.actions.map((action) => action.type))
  if (actionTypes.size !== spec.actions.length) throw new Error('Declarative activity action types must be unique')
  for (const variable of spec.publicVariables) {
    if (!spec.variables[variable]) throw new Error(`Unknown public variable: ${variable}`)
  }
  for (const action of spec.actions) {
    const transitions = spec.transitions.filter((transition) => transition.action === action.type)
    if (transitions.length === 0) throw new Error(`Action has no transition: ${action.type}`)
    const unconditional = transitions.map((transition, index) => ({ transition, index })).filter(({ transition }) => transition.when.length === 0)
    if (unconditional.length !== 1 || unconditional[0]?.index !== transitions.length - 1) {
      throw new Error(`Action must have exactly one final fallback transition: ${action.type}`)
    }
  }
  for (const transition of spec.transitions) {
    const action = spec.actions.find((candidate) => candidate.type === transition.action)
    if (!action) throw new Error(`Transition references unknown action: ${transition.action}`)
    for (const condition of transition.when) {
      const descriptor = condition.ref.source === 'state'
        ? spec.variables[condition.ref.key]
        : action.fields[condition.ref.key]
      if (!descriptor) throw new Error(`Condition references unknown value: ${condition.ref.source}.${condition.ref.key}`)
      if (condition.operator === 'lessThan' && descriptor.kind !== 'integer') throw new Error('lessThan requires an integer')
      if (condition.operator === 'containsToken' && descriptor.kind !== 'string') throw new Error('containsToken requires a string')
      if (condition.operator === 'containsToken'
        && condition.tokens.some((token) => normalizeTokens(token).length !== 1)) {
        throw new Error('containsToken accepts only individual normalized tokens')
      }
      if (condition.operator === 'equals' && !schemaForDescriptor(descriptor).safeParse(condition.value).success) {
        throw new Error(`Condition value has the wrong type: ${condition.ref.key}`)
      }
    }
    for (const effect of transition.effects) {
      const descriptor = spec.variables[effect.variable]
      if (!descriptor) throw new Error(`Effect references unknown variable: ${effect.variable}`)
      if (effect.operation === 'increment' && descriptor.kind !== 'integer') throw new Error('increment requires an integer')
      if (effect.operation === 'set' && !schemaForDescriptor(descriptor).safeParse(effect.value).success) {
        throw new Error(`Effect value has the wrong type: ${effect.variable}`)
      }
    }
  }

  const initial = stateSchema.parse(Object.fromEntries(Object.entries(spec.variables).map(([key, value]) => [key, value.initial])))
  const actions = sampleActions(spec).map((action) => actionSchema.parse(action))
  const queue = [initial]
  const visited = new Set([JSON.stringify(initial)])
  const reachedTransitions = new Set<number>()
  let terminalReached = false
  while (queue.length > 0) {
    const state = queue.shift() as State
    for (const action of actions) {
      const applied = applySpec(spec, state, action)
      if (!applied) continue
      reachedTransitions.add(applied.index)
      const next = stateSchema.safeParse(applied.state)
      if (!next.success) throw new Error(`Transition can create an invalid state: ${applied.transition.action}`)
      if (JSON.stringify(next.data) === JSON.stringify(state)) throw new Error(`Transition does not change state: ${applied.transition.action}`)
      if (applied.transition.completed) terminalReached = true
      else if (!visited.has(JSON.stringify(next.data))) {
        if (visited.size >= 10_000) throw new Error('Declarative activity state space exceeds 10000 states')
        visited.add(JSON.stringify(next.data))
        queue.push(next.data)
      }
    }
  }
  if (!terminalReached) throw new Error('Declarative activity has no reachable terminal state')
  if (reachedTransitions.size !== spec.transitions.length) throw new Error('Declarative activity contains an unreachable transition')
}

export function createDeclarativeEngine(input: unknown): ReliableEngine<State, Record<string, never>, Action> {
  const spec = declarativeSpecSchema.parse(input)
  const stateSchema = z.object(Object.fromEntries(
    Object.entries(spec.variables).map(([key, descriptor]) => [key, schemaForDescriptor(descriptor)])
  )).strict() as z.ZodType<State>
  const actionSchema = z.unknown().transform((input, context): Action => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      context.addIssue({ code: 'custom', message: 'Action must be an object' })
      return z.NEVER
    }
    const type = Reflect.get(input, 'type')
    const definition = spec.actions.find((action) => action.type === type)
    if (!definition) {
      context.addIssue({ code: 'custom', message: 'Unknown action type' })
      return z.NEVER
    }
    const parsed = z.object({
      type: z.literal(definition.type),
      ...Object.fromEntries(Object.entries(definition.fields).map(([key, descriptor]) => [key, schemaForDescriptor(descriptor)]))
    }).strict().safeParse(input)
    if (!parsed.success) {
      for (const issue of parsed.error.issues) context.addIssue({ code: 'custom', message: issue.message, path: issue.path })
      return z.NEVER
    }
    return parsed.data as Action
  }) as z.ZodType<Action>
  validateSemantics(spec, stateSchema, actionSchema)

  return {
    id: spec.id,
    createSchema: z.object({}).strict(),
    actionSchema,
    stateSchema,
    create: () => stateSchema.parse(Object.fromEntries(
      Object.entries(spec.variables).map(([key, descriptor]) => [key, descriptor.initial])
    )),
    apply: (state, action): EngineTransition<State> => {
      const applied = applySpec(spec, state, action)
      if (!applied) {
        const error: ActivityError = {
          code: 'NO_ACTIVITY_TRANSITION',
          message: 'Cette action ne correspond à aucune transition autorisée.',
          retryable: true
        }
        return { ok: false, error }
      }
      const nextState = stateSchema.parse(applied.state)
      return {
        ok: true,
        state: nextState,
        completed: applied.transition.completed,
        message: applied.transition.message,
        event: { type: action.type }
      }
    },
    publicView: (state) => ({
      activity: spec.title,
      ...Object.fromEntries(spec.publicVariables.map((variable) => [variable, state[variable]]))
    })
  }
}
