import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { ollamaExecutableCandidates } from './ollama-process'

describe('ollamaExecutableCandidates', () => {
  it('finds the standard per-user Windows installation before PATH entries', () => {
    const candidates = ollamaExecutableCandidates('win32', {
      LOCALAPPDATA: 'C:\\Users\\demo\\AppData\\Local',
      PATH: 'C:\\Windows\\System32'
    })

    expect(candidates[0]).toBe(path.win32.join(
      'C:\\Users\\demo\\AppData\\Local',
      'Programs',
      'Ollama',
      'ollama.exe'
    ))
    expect(candidates).toContain(path.win32.join('C:\\Windows\\System32', 'ollama.exe'))
  })

  it('includes standard Linux installation locations', () => {
    expect(ollamaExecutableCandidates('linux', { PATH: '/custom/bin' })).toEqual([
      '/usr/local/bin/ollama',
      '/usr/bin/ollama',
      '/custom/bin/ollama'
    ])
  })
})
