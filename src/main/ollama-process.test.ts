import { describe, expect, it, vi } from 'vitest'
import {
  detectOllamaGpuBackend,
  OLLAMA_CONTAINER_NAME,
  OLLAMA_HOST_PORT,
  OLLAMA_MODELS_VOLUME,
  OLLAMA_ROCM_IMAGE,
  startOllamaServer
} from './ollama-process'
import type { CommandResult, CommandRunner } from './runtime'
import type { HardwareInfo } from '../shared/contracts'

function result(exitCode: number, stdout = '', stderr = ''): CommandResult {
  return { exitCode, stdout, stderr, signal: null, timedOut: false, outputTruncated: false }
}

const baseHardware: HardwareInfo = {
  platform: 'linux',
  cpuModel: 'Test CPU',
  cpuCores: 16,
  totalMemoryBytes: 32_000_000_000,
  gpus: []
}

describe('detectOllamaGpuBackend', () => {
  it('selects NVIDIA without requiring Linux device nodes', async () => {
    const runner = vi.fn<CommandRunner>()

    await expect(detectOllamaGpuBackend({
      ...baseHardware,
      gpus: [{ model: 'NVIDIA GeForce RTX 4090', vramBytes: 24_000_000_000 }]
    }, runner)).resolves.toBe('nvidia')
    expect(runner).not.toHaveBeenCalled()
  })

  it('selects ROCm for AMD only when both required devices exist', async () => {
    const runner = vi.fn<CommandRunner>()
      .mockResolvedValueOnce(result(0))
      .mockResolvedValueOnce(result(0))

    await expect(detectOllamaGpuBackend({
      ...baseHardware,
      gpus: [{ model: 'AMD Radeon RX 7900 XTX', vramBytes: 24_000_000_000 }]
    }, runner)).resolves.toBe('amd-rocm')
  })

  it('uses Vulkan for AMD or Intel when only the render device exists', async () => {
    const amdRunner = vi.fn<CommandRunner>()
      .mockResolvedValueOnce(result(0))
      .mockResolvedValueOnce(result(1))
    const intelRunner = vi.fn<CommandRunner>().mockResolvedValueOnce(result(0))

    await expect(detectOllamaGpuBackend({
      ...baseHardware,
      gpus: [{ model: 'AMD Radeon RX 6800', vramBytes: 16_000_000_000 }]
    }, amdRunner)).resolves.toBe('vulkan')
    await expect(detectOllamaGpuBackend({
      ...baseHardware,
      gpus: [{ model: 'Intel Arc A770', vramBytes: 16_000_000_000 }]
    }, intelRunner)).resolves.toBe('vulkan')
  })

  it('falls back to CPU when the GPU is not exposed to the runtime', async () => {
    const runner = vi.fn<CommandRunner>().mockResolvedValue(result(1))

    await expect(detectOllamaGpuBackend({
      ...baseHardware,
      platform: 'windows',
      gpus: [{ model: 'AMD Radeon RX 7900 XTX', vramBytes: 24_000_000_000 }]
    }, runner)).resolves.toBe('cpu')
  })
})

describe('startOllamaServer', () => {
  it('reuses the managed Docker container when it is already running', async () => {
    const runner = vi.fn<CommandRunner>()
      .mockResolvedValueOnce(result(0, '27.0.0'))
      .mockResolvedValueOnce(result(0, 'true|ollama|v6-cpu-p1|ollama/ollama:latest'))

    await expect(startOllamaServer({}, runner)).resolves.toEqual({ success: true, backend: 'cpu' })
    expect(runner).toHaveBeenCalledTimes(2)
  })

  it('creates an isolated container whose models live in a Docker volume', async () => {
    const runner = vi.fn<CommandRunner>()
      .mockResolvedValueOnce(result(0, '27.0.0'))
      .mockResolvedValueOnce(result(1, '', 'No such object'))
      .mockResolvedValueOnce(result(0, 'container-id'))

    await expect(startOllamaServer({ gpuBackend: 'nvidia', numParallel: 2 }, runner)).resolves.toEqual({ success: true, backend: 'nvidia' })
    expect(runner).toHaveBeenNthCalledWith(3, 'docker', expect.arrayContaining([
      'run', '--detach',
      '--name', OLLAMA_CONTAINER_NAME,
      '--label', 'com.local-agent.service=ollama',
      '--label', 'com.local-agent.ollama-config=v6-nvidia-p2',
      '--publish', `127.0.0.1:${OLLAMA_HOST_PORT}:11434`,
      '--volume', `${OLLAMA_MODELS_VOLUME}:/root/.ollama`,
      '--env', 'OLLAMA_NUM_PARALLEL=2',
      '--env', 'OLLAMA_KEEP_ALIVE=30m',
      '--gpus', 'all',
      'ollama/ollama:latest'
    ]), expect.objectContaining({ timeoutMs: 600_000 }))
  })

  it('uses the ROCm image and required AMD devices', async () => {
    const runner = vi.fn<CommandRunner>()
      .mockResolvedValueOnce(result(0, '27.0.0'))
      .mockResolvedValueOnce(result(1, '', 'No such object'))
      .mockResolvedValueOnce(result(0, 'container-id'))

    await expect(startOllamaServer({ gpuBackend: 'amd-rocm' }, runner))
      .resolves.toEqual({ success: true, backend: 'amd-rocm' })
    expect(runner).toHaveBeenNthCalledWith(3, 'docker', expect.arrayContaining([
      '--device', '/dev/kfd', '--device', '/dev/dri', OLLAMA_ROCM_IMAGE
    ]), expect.objectContaining({ timeoutMs: 600_000 }))
  })

  it('falls back from ROCm to Vulkan before using the CPU', async () => {
    const runner = vi.fn<CommandRunner>()
      .mockResolvedValueOnce(result(0, '27.0.0'))
      .mockResolvedValueOnce(result(1, '', 'No such object'))
      .mockResolvedValueOnce(result(1, '', 'ROCm unavailable'))
      .mockResolvedValueOnce(result(0))
      .mockResolvedValueOnce(result(0, 'container-id'))

    await expect(startOllamaServer({ gpuBackend: 'amd-rocm' }, runner))
      .resolves.toEqual({ success: true, backend: 'vulkan', fallbackReason: 'ROCm unavailable' })
    const fallbackArgs = runner.mock.calls[4]?.[1] ?? []
    expect(fallbackArgs).toContain('/dev/dri')
    expect(fallbackArgs).not.toContain('/dev/kfd')
  })

  it('exposes only the render device for Vulkan', async () => {
    const runner = vi.fn<CommandRunner>()
      .mockResolvedValueOnce(result(0, '27.0.0'))
      .mockResolvedValueOnce(result(1, '', 'No such object'))
      .mockResolvedValueOnce(result(0, 'container-id'))

    await expect(startOllamaServer({ gpuBackend: 'vulkan' }, runner))
      .resolves.toEqual({ success: true, backend: 'vulkan' })
    const args = runner.mock.calls[2]?.[1] ?? []
    expect(args).toContain('/dev/dri')
    expect(args).not.toContain('/dev/kfd')
    expect(args).not.toContain('--gpus')
  })

  it('retries safely on CPU with one inference when GPU startup fails', async () => {
    const runner = vi.fn<CommandRunner>()
      .mockResolvedValueOnce(result(0, '27.0.0'))
      .mockResolvedValueOnce(result(1, '', 'No such object'))
      .mockResolvedValueOnce(result(1, '', 'GPU unavailable'))
      .mockResolvedValueOnce(result(0))
      .mockResolvedValueOnce(result(1, '', 'Vulkan unavailable'))
      .mockResolvedValueOnce(result(0))
      .mockResolvedValueOnce(result(0, 'container-id'))

    await expect(startOllamaServer({ gpuBackend: 'amd-rocm', numParallel: 2 }, runner))
      .resolves.toEqual({ success: true, backend: 'cpu', fallbackReason: 'Vulkan unavailable' })
    const fallbackArgs = runner.mock.calls[6]?.[1] ?? []
    expect(fallbackArgs).toContain('OLLAMA_NUM_PARALLEL=1')
    expect(fallbackArgs).not.toContain('/dev/kfd')
    expect(fallbackArgs).not.toContain('/dev/dri')
    expect(fallbackArgs).not.toContain('--gpus')
  })

  it('preserves the NVIDIA startup failure when it falls back to CPU', async () => {
    const runner = vi.fn<CommandRunner>()
      .mockResolvedValueOnce(result(0, '27.0.0'))
      .mockResolvedValueOnce(result(1, '', 'No such object'))
      .mockResolvedValueOnce(result(1, '', 'could not select device driver "" with capabilities: [[gpu]]'))
      .mockResolvedValueOnce(result(0))
      .mockResolvedValueOnce(result(0, 'container-id'))
    const onProgress = vi.fn()

    await expect(startOllamaServer({ gpuBackend: 'nvidia', onProgress }, runner)).resolves.toEqual({
      success: true,
      backend: 'cpu',
      fallbackReason: 'could not select device driver "" with capabilities: [[gpu]]'
    })
    expect(onProgress).toHaveBeenCalledWith(expect.objectContaining({
      step: 'Nouvel essai sans GPU',
      detail: expect.stringContaining('NVIDIA Container Toolkit')
    }))
  })

  it('reports Docker as the missing prerequisite', async () => {
    const runner = vi.fn<CommandRunner>().mockResolvedValue(result(1))

    await expect(startOllamaServer({}, runner)).resolves.toEqual({
      success: false,
      reason: expect.stringContaining('runtime Linux privé')
    })
  })

  it('does not take over a container that Stellan does not manage', async () => {
    const runner = vi.fn<CommandRunner>()
      .mockResolvedValueOnce(result(0, '27.0.0'))
      .mockResolvedValueOnce(result(0, 'true|||ollama/ollama:latest'))

    await expect(startOllamaServer({}, runner)).resolves.toEqual({
      success: false,
      reason: expect.stringContaining('non géré')
    })
    expect(runner).toHaveBeenCalledTimes(2)
  })

  it('automatically replaces an obsolete managed container', async () => {
    const runner = vi.fn<CommandRunner>()
      .mockResolvedValueOnce(result(0, '27.0.0'))
      .mockResolvedValueOnce(result(0, 'true|ollama|v1|ollama/ollama:latest'))
      .mockResolvedValueOnce(result(0))
      .mockResolvedValueOnce(result(0, 'container-id'))

    await expect(startOllamaServer({}, runner)).resolves.toEqual({ success: true, backend: 'cpu' })
    expect(runner).toHaveBeenNthCalledWith(3, 'docker', [
      'rm', '--force', OLLAMA_CONTAINER_NAME
    ], { timeoutMs: 30_000 })
    expect(runner).toHaveBeenCalledTimes(4)
  })
})
