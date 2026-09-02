import { describe, expect, it, vi } from 'vitest'
import {
  OLLAMA_CONTAINER_NAME,
  OLLAMA_HOST_PORT,
  OLLAMA_MODELS_VOLUME,
  startOllamaServer
} from './ollama-process'
import type { CommandResult, CommandRunner } from './runtime'

function result(exitCode: number, stdout = '', stderr = ''): CommandResult {
  return { exitCode, stdout, stderr, signal: null, timedOut: false, outputTruncated: false }
}

describe('startOllamaServer', () => {
  it('reuses the managed Docker container when it is already running', async () => {
    const runner = vi.fn<CommandRunner>()
      .mockResolvedValueOnce(result(0, '27.0.0'))
      .mockResolvedValueOnce(result(0, 'true|ollama|v3|ollama/ollama:latest'))

    await expect(startOllamaServer({}, runner)).resolves.toEqual({ success: true })
    expect(runner).toHaveBeenCalledTimes(2)
  })

  it('creates an isolated container whose models live in a Docker volume', async () => {
    const runner = vi.fn<CommandRunner>()
      .mockResolvedValueOnce(result(0, '27.0.0'))
      .mockResolvedValueOnce(result(1, '', 'No such object'))
      .mockResolvedValueOnce(result(0, 'container-id'))

    await expect(startOllamaServer({ useNvidiaGpu: true }, runner)).resolves.toEqual({ success: true })
    expect(runner).toHaveBeenNthCalledWith(3, 'docker', expect.arrayContaining([
      'run', '--detach',
      '--name', OLLAMA_CONTAINER_NAME,
      '--label', 'com.local-agent.service=ollama',
      '--label', 'com.local-agent.ollama-config=v3',
      '--publish', `127.0.0.1:${OLLAMA_HOST_PORT}:11434`,
      '--volume', `${OLLAMA_MODELS_VOLUME}:/root/.ollama`,
      '--env', 'OLLAMA_NUM_PARALLEL=2',
      '--gpus', 'all',
      'ollama/ollama:latest'
    ]), expect.objectContaining({ timeoutMs: 600_000 }))
  })

  it('reports Docker as the missing prerequisite', async () => {
    const runner = vi.fn<CommandRunner>().mockResolvedValue(result(1))

    await expect(startOllamaServer({}, runner)).resolves.toEqual({
      success: false,
      reason: expect.stringContaining('runtime Linux privé')
    })
  })

  it('does not take over a container that Local Agent does not manage', async () => {
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

    await expect(startOllamaServer({}, runner)).resolves.toEqual({ success: true })
    expect(runner).toHaveBeenNthCalledWith(3, 'docker', [
      'rm', '--force', OLLAMA_CONTAINER_NAME
    ], { timeoutMs: 30_000 })
    expect(runner).toHaveBeenCalledTimes(4)
  })
})
