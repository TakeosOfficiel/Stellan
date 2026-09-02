import { describe, expect, it } from 'vitest'
import { prepareWhisperAudio } from './dictation-audio'

describe('prepareWhisperAudio', () => {
  it('joins chunks and downsamples microphone audio to 16 kHz', () => {
    const audio = new Float32Array(prepareWhisperAudio([
      new Float32Array([1, 1, 1]),
      new Float32Array([-1, -1, -1])
    ], 48_000))

    expect([...audio]).toEqual([1, -1])
  })
})
