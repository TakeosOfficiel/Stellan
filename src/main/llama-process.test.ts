import { describe, expect, it, vi } from 'vitest'
import {
  LLAMA_CONTAINER_NAME,
  LLAMA_CACHE_PATH,
  LLAMA_HOST_PORT,
  LLAMA_IMAGES,
  LLAMA_MODELS_VOLUME,
  deleteLlamaModelCache,
  startLlamaServer,
  stopLlamaServer,
  waitForLlamaServer,
  type LlamaContainerOptions
} from './llama-process'
import type { CommandResult, CommandRunner } from './runtime'

function result(exitCode: number, stdout = '', stderr = ''): CommandResult {
  return { exitCode, stdout, stderr, signal: null, timedOut: false, outputTruncated: false }
}

const options: LlamaContainerOptions = {
  backend: 'cuda', modelArtifact: 'owner/model-GGUF:Q4_K_M', modelAlias: 'model:4b', contextSize: 8192, predictTokens: 1024, parallel: 2, reasoningMode: 'fast'
}

describe('startLlamaServer', () => {
  it('uses the official image and an isolated, persistent, fully-offloaded server configuration', async () => {
    const runner = vi.fn<CommandRunner>()
      .mockResolvedValueOnce(result(0, '27'))
      .mockResolvedValueOnce(result(1, '', 'not found'))
      .mockResolvedValueOnce(result(0, 'id'))

    await expect(startLlamaServer(options, runner)).resolves.toEqual({ success: true, backend: 'cuda' })
    const args = runner.mock.calls[2]?.[1] ?? []
    expect(args).toEqual(expect.arrayContaining([
      'run', '--detach', '--name', LLAMA_CONTAINER_NAME,
      '--label', 'com.local-agent.service=llama.cpp',
      '--restart', 'unless-stopped', '--pull', 'missing',
      '--publish', `127.0.0.1:${LLAMA_HOST_PORT}:8080`,
      '--volume', `${LLAMA_MODELS_VOLUME}:${LLAMA_CACHE_PATH}`,
      '--security-opt', 'no-new-privileges', '--cap-drop', 'ALL', '--pids-limit', '1024',
      '--gpus', 'all', LLAMA_IMAGES.cuda,
      '--hf-repo', options.modelArtifact, '--alias', options.modelAlias,
      '--ctx-size', '8192', '--n-predict', '1024',
      '--parallel', '2', '--jinja',
      '--reasoning', 'off', '--reasoning-budget', '0',
      '--n-gpu-layers', '-1'
    ]))
    expect(args.find((arg) => arg.startsWith('com.local-agent.llama-config=v4-cuda-'))).toBeTruthy()
    expect(runner.mock.calls[2]?.[0]).toBe('docker')
  })

  it.each([
    ['auto', 'auto', '768'],
    ['advanced', 'on', '2048']
  ] as const)('enables preserved %s reasoning with a bounded budget', async (reasoningMode, flag, budget) => {
    const runner = vi.fn<CommandRunner>()
      .mockResolvedValueOnce(result(0)).mockResolvedValueOnce(result(1)).mockResolvedValueOnce(result(0))

    await startLlamaServer({ ...options, reasoningMode }, runner)

    const args = runner.mock.calls[2]?.[1] ?? []
    expect(args).toEqual(expect.arrayContaining([
      '--reasoning', flag,
      '--reasoning-budget', budget,
      '--reasoning-preserve'
    ]))
  })

  it.each([
    ['rocm', ['/dev/kfd', '/dev/dri']],
    ['vulkan', ['/dev/dri']]
  ] as const)('passes only the required %s devices', async (backend, devices) => {
    const runner = vi.fn<CommandRunner>()
      .mockResolvedValueOnce(result(0)).mockResolvedValueOnce(result(1)).mockResolvedValueOnce(result(0))
    await startLlamaServer({ ...options, backend }, runner)
    const args = runner.mock.calls[2]?.[1] ?? []
    for (const device of devices) expect(args).toContain(device)
    expect(args).not.toContain('--gpus')
    expect(args).toContain(LLAMA_IMAGES[backend])
  })

  it('refuses an unmanaged same-name container without modifying it', async () => {
    const runner = vi.fn<CommandRunner>()
      .mockResolvedValueOnce(result(0)).mockResolvedValueOnce(result(0, `true|||${LLAMA_IMAGES.cuda}`))
    await expect(startLlamaServer(options, runner)).resolves.toEqual({
      success: false, reason: expect.stringContaining('non géré')
    })
    expect(runner).toHaveBeenCalledTimes(2)
  })

  it('reuses a matching running managed container', async () => {
    const initial = vi.fn<CommandRunner>()
      .mockResolvedValueOnce(result(0)).mockResolvedValueOnce(result(1)).mockResolvedValueOnce(result(0))
    await startLlamaServer(options, initial)
    const label = (initial.mock.calls[2]?.[1] ?? []).find((arg) => arg.startsWith('com.local-agent.llama-config='))?.split('=')[1]
    const runner = vi.fn<CommandRunner>()
      .mockResolvedValueOnce(result(0)).mockResolvedValueOnce(result(0, `true|llama.cpp|${label}|${LLAMA_IMAGES.cuda}`))
    await expect(startLlamaServer(options, runner)).resolves.toEqual({ success: true, backend: 'cuda' })
    expect(runner).toHaveBeenCalledTimes(2)
  })

  it('replaces an obsolete managed container while retaining the named model volume', async () => {
    const runner = vi.fn<CommandRunner>()
      .mockResolvedValueOnce(result(0))
      .mockResolvedValueOnce(result(0, `true|llama.cpp|v0-old|${LLAMA_IMAGES.cpu}`))
      .mockResolvedValueOnce(result(0)).mockResolvedValueOnce(result(0))
    await expect(startLlamaServer(options, runner)).resolves.toMatchObject({ success: true })
    expect(runner).toHaveBeenNthCalledWith(3, 'docker', ['rm', '--force', LLAMA_CONTAINER_NAME], { timeoutMs: 30_000 })
    expect(runner.mock.calls.flatMap((call) => call[1])).not.toContain(LLAMA_MODELS_VOLUME)
    expect(runner.mock.calls[3]?.[1]).toContain(`${LLAMA_MODELS_VOLUME}:${LLAMA_CACHE_PATH}`)
  })

  it('falls directly and deterministically from GPU to CPU without deleting the model volume', async () => {
    const runner = vi.fn<CommandRunner>()
      .mockResolvedValueOnce(result(0)).mockResolvedValueOnce(result(1))
      .mockResolvedValueOnce(result(1, '', 'CUDA unavailable')).mockResolvedValueOnce(result(0))
      .mockResolvedValueOnce(result(0))
    await expect(startLlamaServer(options, runner)).resolves.toEqual({
      success: true, backend: 'cpu', fallbackReason: 'CUDA unavailable'
    })
    const fallback = runner.mock.calls[4]?.[1] ?? []
    expect(fallback).toContain(LLAMA_IMAGES.cpu)
    expect(fallback).toContain(`${LLAMA_MODELS_VOLUME}:${LLAMA_CACHE_PATH}`)
    expect(fallback).not.toContain('--gpus')
    expect(fallback).not.toContain('--n-gpu-layers')
    expect(runner.mock.calls.filter((call) => call[1][0] === 'rm')).toHaveLength(1)
  })
})

describe('llama.cpp lifecycle', () => {
  it('waits while a model loads and accepts the healthy server', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }))
    await expect(waitForLlamaServer('http://127.0.0.1:11436', fetcher, 2, 0)).resolves.toBeUndefined()
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('stops only the managed llama.cpp container', async () => {
    const runner = vi.fn<CommandRunner>().mockResolvedValue(result(0))
    await stopLlamaServer(runner)
    expect(runner).toHaveBeenCalledWith('docker', ['stop', LLAMA_CONTAINER_NAME], { timeoutMs: 60_000 })
  })
})

describe('deleteLlamaModelCache', () => {
  it('removes only the selected Hugging Face repository from the shared cache', async () => {
    const runner = vi.fn<CommandRunner>()
      .mockResolvedValueOnce(result(0))
      .mockResolvedValueOnce(result(1))
      .mockResolvedValueOnce(result(0))
      .mockResolvedValueOnce(result(0))

    await deleteLlamaModelCache('ggml-org/Qwen3.6-35B-A3B-GGUF:Q4_K_M', runner)

    expect(runner.mock.calls[3]?.[1]).toEqual([
      'run', '--rm', '--entrypoint', '/bin/sh',
      '--volume', `${LLAMA_MODELS_VOLUME}:${LLAMA_CACHE_PATH}`,
      LLAMA_IMAGES.cuda, '-c',
      `rm -rf -- '${LLAMA_CACHE_PATH}/hub/models--ggml-org--Qwen3.6-35B-A3B-GGUF'`
    ])
  })
})
