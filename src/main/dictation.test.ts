import { describe, expect, it } from 'vitest'
import { dictationInternals } from './dictation'

describe('dictation post-processing', () => {
  it('turns explicit French code punctuation into syntax without rewriting prose', () => {
    expect(dictationInternals.normalizeSpokenCode(
      'fonction test ouvre parenthèse ferme parenthèse ouvre accolade nouvelle ligne return 38 point-virgule nouvelle ligne ferme accolade'
    )).toBe('fonction test ( ) {\nreturn 38;\n}')
  })

  it('cleans punctuation spacing', () => {
    expect(dictationInternals.normalizeSpokenCode('Bonjour , monde !')).toBe('Bonjour, monde!')
  })
})
