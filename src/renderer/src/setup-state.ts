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

const RUNTIME_MISSING = 'WSL 2 est requis'
const START_FAILED = /^(?:Le conteneur Ollama n’a pas pu|Le moteur privé ne répond pas|Le runtime Linux privé ne répond pas)/

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
      running: START_FAILED.test(reason) ? 'incomplete' : 'unknown',
      reachable: 'incomplete',
      modelReady: 'incomplete',
      canStart: true,
      canOpenDownload: false
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
  return !status.available && status.reason.startsWith(RUNTIME_MISSING) ? 'missing' : 'detected'
}
