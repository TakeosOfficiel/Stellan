import { describe, expect, it } from 'vitest'
import neitherYesNorNo from './neither-yes-nor-no.json'
import { createDeclarativeEngine } from './declarative'

describe('declarative activity engine', () => {
  it('executes the neither-yes-nor-no rules deterministically', () => {
    const engine = createDeclarativeEngine(neitherYesNorNo)
    let state = engine.create({})

    const accepted = engine.apply(state, { type: 'answer', text: 'Absolument !' })
    expect(accepted).toMatchObject({ ok: true, completed: false, state: { round: 1, status: 'active' } })
    if (accepted.ok) state = accepted.state

    const forbidden = engine.apply(state, { type: 'answer', text: 'NÖN, jamais !' })
    expect(forbidden).toMatchObject({
      ok: true,
      completed: true,
      state: { round: 1, status: 'lost' },
      message: expect.stringContaining('interdit')
    })
  })

  it('reaches the bounded victory and exposes only declared public variables', () => {
    const engine = createDeclarativeEngine(neitherYesNorNo)
    let state = engine.create({})
    for (let round = 0; round < 9; round += 1) {
      const result = engine.apply(state, { type: 'answer', text: 'Peut-être.' })
      expect(result.ok).toBe(true)
      if (result.ok) state = result.state
    }
    const won = engine.apply(state, { type: 'answer', text: 'Certainement.' })
    expect(won).toMatchObject({ ok: true, completed: true, state: { round: 10, status: 'won' } })
    if (won.ok) expect(engine.publicView(won.state)).toEqual({ activity: 'Ni oui ni non', round: 10, status: 'won' })
  })

  it('rejects syntactically valid but unreachable rules', () => {
    expect(() => createDeclarativeEngine({
      id: 'broken-game',
      title: 'Impossible',
      variables: {
        count: { kind: 'integer', initial: 0, min: 0, max: 2 },
        flag: { kind: 'boolean', initial: false }
      },
      actions: [{ type: 'tick', fields: {} }],
      transitions: [
        {
          action: 'tick',
          when: [{ operator: 'equals', ref: { source: 'state', key: 'count' }, value: 2 }],
          effects: [{ operation: 'set', variable: 'count', value: 2 }],
          completed: true,
          message: 'Terminé.'
        },
        {
          action: 'tick',
          when: [{ operator: 'equals', ref: { source: 'state', key: 'flag' }, value: false }],
          effects: [{ operation: 'set', variable: 'flag', value: true }],
          completed: false,
          message: 'Allumé.'
        },
        {
          action: 'tick', when: [],
          effects: [{ operation: 'set', variable: 'flag', value: false }],
          completed: false, message: 'Éteint.'
        }
      ],
      publicVariables: ['count', 'flag']
    })).toThrow(/invalid state|unreachable|terminal/i)
  })
})
