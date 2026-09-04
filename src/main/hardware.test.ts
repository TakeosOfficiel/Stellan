import { describe, expect, it } from 'vitest'
import { inferenceModelOptions, inferenceParallelism, selectGpus } from './hardware'

describe('selectGpus', () => {
  it('ignores virtual display adapters and prioritizes a discrete GPU', () => {
    expect(selectGpus([
      { model: 'Parsec Virtual Display Adapter', vram: 0 },
      { model: 'Intel(R) UHD Graphics', vram: 1024 },
      { model: 'NVIDIA GeForce GTX 1660 SUPER', vram: 6144 }
    ])).toEqual([
      { model: 'NVIDIA GeForce GTX 1660 SUPER', vramBytes: 6_144_000_000 },
      { model: 'Intel(R) UHD Graphics', vramBytes: 1_024_000_000 }
    ])
  })

  it('returns no GPU rather than presenting a virtual adapter as compute hardware', () => {
    expect(selectGpus([
      { model: 'Microsoft Basic Display Adapter' },
      { model: 'Parsec Virtual Display Adapter' }
    ])).toEqual([])
  })

  it('only parallelizes inference on a confirmed accelerated backend', () => {
    const base = {
      platform: 'windows' as const,
      cpuModel: 'Test CPU',
      cpuCores: 16,
      totalMemoryBytes: 32_000_000_000
    }

    expect(inferenceParallelism({ ...base, gpus: [] })).toBe(1)
    expect(inferenceParallelism({
      ...base,
      gpus: [{ model: 'AMD Radeon', vramBytes: 24_000_000_000 }]
    }, 'amd-rocm')).toBe(2)
    expect(inferenceParallelism({
      ...base,
      gpus: [{ model: 'NVIDIA GeForce RTX', vramBytes: 16_000_000_000 }]
    }, 'nvidia')).toBe(1)
    expect(inferenceParallelism({
      ...base,
      gpus: [{ model: 'Intel Arc', vramBytes: 16_000_000_000 }]
    }, 'vulkan')).toBe(1)
    expect(inferenceParallelism({
      ...base,
      gpus: [{ model: 'AMD Radeon', vramBytes: 24_000_000_000 }]
    }, 'cpu')).toBe(1)
  })

  it('scales context and response budgets without overloading small machines', () => {
    const base = {
      platform: 'windows' as const,
      cpuModel: 'Test CPU',
      cpuCores: 8,
      gpus: []
    }

    expect(inferenceModelOptions({ ...base, totalMemoryBytes: 16_000_000_000 }))
      .toEqual({ numCtx: 8_192, numPredict: 1_024 })
    expect(inferenceModelOptions({ ...base, totalMemoryBytes: 32_000_000_000 }))
      .toEqual({ numCtx: 16_384, numPredict: 1_536 })
    expect(inferenceModelOptions({ ...base, totalMemoryBytes: 64_000_000_000 }))
      .toEqual({ numCtx: 32_768, numPredict: 2_048 })
  })
})
