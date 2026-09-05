import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { HardwareInfo } from '../shared/contracts'
import { hardwarePerformanceKey, ModelPerformanceStore } from './model-performance'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('ModelPerformanceStore', () => {
  it('keeps a hardware-specific moving average and persists it atomically', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'stellan-performance-'))
    temporaryDirectories.push(directory)
    const file = path.join(directory, 'models.json')
    const store = new ModelPerformanceStore(file)
    const hardware = {
      platform: 'linux', cpuModel: 'CPU', cpuCores: 8, totalMemoryBytes: 32_000_000_000,
      gpus: [{ model: 'GPU', vramBytes: 12_000_000_000 }]
    } satisfies HardwareInfo
    const key = hardwarePerformanceKey(hardware)

    store.record(key, { model: 'qwen3.5:4b', firstResponseMs: 1_000, wallMs: 2_000, tokensPerSecond: 20 })
    store.record(key, { model: 'qwen3.5:4b', firstResponseMs: 3_000, wallMs: 4_000, tokensPerSecond: 10 })

    expect(store.list(key).get('qwen3.5:4b')).toEqual({ firstResponseMs: 2_000, tokensPerSecond: 15 })
    expect(new ModelPerformanceStore(file).list(key).get('qwen3.5:4b')).toEqual({ firstResponseMs: 2_000, tokensPerSecond: 15 })
    expect(() => JSON.parse(readFileSync(file, 'utf8'))).not.toThrow()
  })
})
