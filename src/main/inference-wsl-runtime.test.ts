import { describe, expect, it } from 'vitest'
import {
  INFERENCE_WSL_DISTRO,
  inferenceKeepAliveCommand,
  inferenceLinuxPathFromWindows,
  inferenceWslServiceUrl
} from './inference-wsl-runtime'

describe('parallel inference WSL runtime', () => {
  it('uses a distinct distro and translates its Windows staging path', () => {
    expect(INFERENCE_WSL_DISTRO).toBe('StellanInferenceRuntime')
    expect(inferenceLinuxPathFromWindows('C:\\Users\\Alice Smith\\AppData\\Roaming\\Stellan\\runtime\\migration\\models.tar'))
      .toBe('/mnt/c/Users/Alice Smith/AppData/Roaming/Stellan/runtime/migration/models.tar')
    expect(() => inferenceLinuxPathFromWindows('relative/models.tar')).toThrow(/disque Windows local/)
  })

  it('keeps the inference distro alive for the lifetime of Stellan', () => {
    expect(inferenceKeepAliveCommand()).toEqual({
      executable: 'wsl.exe',
      args: ['--distribution', 'StellanInferenceRuntime', '--user', 'root', '--exec', 'sleep', 'infinity']
    })
  })

  it('never exposes a WSL-only service URL on another platform', () => {
    if (process.platform !== 'win32') expect(inferenceWslServiceUrl(11435)).toBeNull()
  })
})
