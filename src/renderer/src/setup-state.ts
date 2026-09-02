import type { OllamaStatus } from '../../shared/contracts'

export type SetupStepState = 'complete' | 'incomplete' | 'unknown'
export type InstallationEvidence = 'unknown' | 'detected' | 'missing'

export type OllamaSetupState = {
  installed: SetupStepState
  running: SetupStepState
  reachable: SetupStepState
  modelReady: SetupStepState
  canStart: boolean
  canOpenDownload: boolean
}

const EXECUTABLE_MISSING = "L'exécutable Ollama est introuvable"
const START_FAILED = "Ollama n'a pas pu démarrer"

export function getOllamaSetupState(
  status: OllamaStatus | null,
  installation: InstallationEvidence
): OllamaSetupState {
  if (status?.available) {
    return {
      installed: 'complete',
      running: 'complete',
      reachable: 'complete',
      modelReady: status.models.length > 0 ? 'complete' : 'incomplete',
      canStart: false,
      canOpenDownload: false
    }
  }

  const reason = status?.reason ?? ''
  if (installation === 'missing') {
    return {
      installed: 'incomplete',
      running: 'incomplete',
      reachable: 'incomplete',
      modelReady: 'incomplete',
      canStart: false,
      canOpenDownload: true
    }
  }

  if (installation === 'detected') {
    return {
      installed: 'complete',
      running: reason.startsWith(START_FAILED) ? 'incomplete' : 'unknown',
      reachable: 'incomplete',
      modelReady: 'incomplete',
      canStart: true,
      canOpenDownload: true
    }
  }

  return {
    installed: 'unknown',
    running: 'unknown',
    reachable: status ? 'incomplete' : 'unknown',
    modelReady: status ? 'incomplete' : 'unknown',
    canStart: Boolean(status),
    canOpenDownload: Boolean(status)
  }
}

export function installationEvidenceFromStart(status: OllamaStatus): InstallationEvidence {
  return !status.available && status.reason.startsWith(EXECUTABLE_MISSING) ? 'missing' : 'detected'
}
