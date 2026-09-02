import { describe, expect, it } from 'vitest'
import { getOllamaSetupState, installationEvidenceFromStart } from './setup-state'

describe('getOllamaSetupState', () => {
  it('distinguishes a reachable runtime with no model from a model-ready runtime', () => {
    expect(getOllamaSetupState({ available: true, version: '0.11.0', models: [] }, 'unknown')).toEqual({
      installed: 'complete',
      running: 'complete',
      reachable: 'complete',
      modelReady: 'incomplete',
      canStart: false,
      canOpenDownload: false
    })

    expect(getOllamaSetupState({
      available: true,
      version: '0.11.0',
      models: [{ name: 'qwen3.5:4b', size: 3_000_000_000, modifiedAt: '2026-01-01' }]
    }, 'unknown').modelReady).toBe('complete')
  })

  it('does not claim that Ollama is missing before the executable check', () => {
    expect(getOllamaSetupState({
      available: false,
      reason: "Le service local d'Ollama ne répond pas. Démarrez Ollama puis réessayez."
    }, 'unknown')).toMatchObject({
      installed: 'unknown',
      running: 'unknown',
      reachable: 'incomplete',
      canStart: true,
      canOpenDownload: true
    })
  })

  it('only marks the installation missing after the start API cannot find the executable', () => {
    expect(getOllamaSetupState({
      available: false,
      reason: "L'exécutable Ollama est introuvable. Réinstallez Ollama ou ajoutez-le au PATH."
    }, 'missing')).toMatchObject({
      installed: 'incomplete',
      running: 'incomplete',
      canStart: false,
      canOpenDownload: true
    })
  })

  it('keeps installed separate from reachable when a detected executable does not become ready', () => {
    expect(getOllamaSetupState({
      available: false,
      reason: 'Ollama a été lancé mais son service local ne répond toujours pas.'
    }, 'detected')).toMatchObject({
      installed: 'complete',
      running: 'unknown',
      reachable: 'incomplete',
      modelReady: 'incomplete'
    })
  })

  it('retains truthful installation evidence from the start operation', () => {
    expect(installationEvidenceFromStart({
      available: false,
      reason: "L'exécutable Ollama est introuvable. Réinstallez Ollama ou ajoutez-le au PATH."
    })).toBe('missing')
    expect(installationEvidenceFromStart({
      available: false,
      reason: "Ollama n'a pas pu démarrer."
    })).toBe('detected')
  })
})
