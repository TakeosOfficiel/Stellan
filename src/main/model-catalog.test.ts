import { describe, expect, it } from 'vitest'
import type { HardwareInfo } from '../shared/contracts'
import { getLlamaCppArtifact, getModelCatalog, isCatalogModel, selectAutomaticVisionModel, selectInstalledInteractiveModel, selectInstalledSpecialistModel } from './model-catalog'

function hardware(overrides: Partial<HardwareInfo> = {}): HardwareInfo {
  return {
    platform: 'windows',
    cpuModel: 'Test CPU',
    cpuCores: 8,
    totalMemoryBytes: 32_000_000_000,
    gpus: [],
    ...overrides
  }
}

describe('getModelCatalog', () => {
  it('recommends lighter models and flags demanding ones from available memory', () => {
    const models = getModelCatalog(hardware())

    expect(models.find((model) => model.id === 'qwen3.5:0.8b')?.compatibility)
      .toBe('recommended')
    expect(models.find((model) => model.id === 'qwen3.5:4b')?.compatibility)
      .toBe('recommended')
    expect(models.find((model) => model.id === 'qwen3.6:35b-a3b')?.compatibility)
      .toBe('demanding')
  })

  it('does not recommend a large dense model that cannot fit in detected VRAM', () => {
    const model = getModelCatalog(hardware({
      totalMemoryBytes: 64_000_000_000,
      gpus: [{ model: 'GPU 16 GB', vramBytes: 16_000_000_000 }]
    })).find((entry) => entry.id === 'devstral-small-2:24b')

    expect(model?.compatibility).toBe('demanding')
    expect(model?.compatibilityReason).toContain('trop lent')
  })

  it('marks experimental image generation unsupported on Windows', () => {
    const imageModel = getModelCatalog(hardware()).find(
      (model) => model.id === 'x/flux2-klein:4b'
    )

    expect(imageModel?.compatibility).toBe('unsupported')
  })

  it('only accepts curated model identifiers', () => {
    expect(isCatalogModel('qwen3.5:0.8b')).toBe(true)
    expect(isCatalogModel('qwen3.5:4b')).toBe(true)
    expect(isCatalogModel('devstral-small-2:24b')).toBe(true)
    expect(isCatalogModel('qwen3.6:35b-a3b')).toBe(true)
    expect(isCatalogModel('qwen2.5-coder:7b')).toBe(false)
    expect(isCatalogModel('qwen2.5-coder:14b')).toBe(false)
    expect(isCatalogModel('qwen3-coder:30b')).toBe(false)
    expect(isCatalogModel('unknown/model')).toBe(false)
  })

  it('offers several model families instead of a Qwen-only catalog', () => {
    const modelIds = getModelCatalog(hardware()).map((model) => model.id)

    expect(modelIds).toEqual(expect.arrayContaining([
      'devstral-small-2:24b',
      'gpt-oss:20b',
      'ministral-3:3b',
      'qwen3.6:35b-a3b'
    ]))
    expect(modelIds).not.toEqual(expect.arrayContaining([
      'granite4.2:3b', 'gemma4:e2b-it-qat', 'qwen2.5-coder:14b'
    ]))
  })

  it('only exposes curated, verified llama.cpp alternatives', () => {
    expect(getLlamaCppArtifact('qwen3.5:4b')).toBe('unsloth/Qwen3.5-4B-GGUF:UD-Q4_K_XL')
    expect(getLlamaCppArtifact('qwen3.5:9b')).toBe('unsloth/Qwen3.5-9B-GGUF:UD-Q4_K_XL')
    expect(getLlamaCppArtifact('qwen3.6:35b-a3b')).toBe('ggml-org/Qwen3.6-35B-A3B-GGUF:Q4_K_M')
    expect(getLlamaCppArtifact('gpt-oss:20b')).toBe('ggml-org/gpt-oss-20b-GGUF:MXFP4')
    expect(getLlamaCppArtifact('devstral-small-2:24b')).toBe('unsloth/Devstral-Small-2-24B-Instruct-2512-GGUF:Q4_K_M')
    expect(getLlamaCppArtifact('qwen3.5:2b')).toBeNull()
  })

  it('offers the newer MoE coding specialist for a 12 GB GPU with enough system RAM', () => {
    const catalog = getModelCatalog(hardware({
      totalMemoryBytes: 32_000_000_000,
      gpus: [{ model: 'GPU 12 GB', vramBytes: 12_000_000_000 }]
    }))

    expect(catalog.find((model) => model.id === 'qwen3.6:35b-a3b')?.compatibility)
      .toBe('compatible')
    expect(selectInstalledSpecialistModel(
      catalog,
      ['qwen3.5:9b', 'qwen3.6:35b-a3b'],
      'code',
      'qwen3.5:9b'
    )).toBe('qwen3.6:35b-a3b')
  })

  it('routes code work to an installed specialist and otherwise keeps the primary model', () => {
    const catalog = getModelCatalog(hardware())

    expect(selectInstalledSpecialistModel(
      catalog,
      ['ministral-3:8b', 'qwen3.5:9b'],
      'code',
      'ministral-3:8b'
    )).toBe('qwen3.5:9b')
    expect(selectInstalledSpecialistModel(catalog, ['ministral-3:8b'], 'code', 'ministral-3:8b'))
      .toBe('ministral-3:8b')
    expect(selectInstalledSpecialistModel(
      getModelCatalog(hardware({ totalMemoryBytes: 16_000_000_000 })),
      ['qwen3.5:4b', 'devstral-small-2:24b'],
      'code',
      'qwen3.5:4b'
    )).toBe('qwen3.5:4b')
    expect(selectInstalledSpecialistModel(
      getModelCatalog(hardware({ totalMemoryBytes: 16_000_000_000 })),
      ['qwen3.5:2b', 'qwen3.5:4b'],
      'code',
      'qwen3.5:2b'
    )).toBe('qwen3.5:4b')
  })

  it('selects an installed interactive model instead of an oversized CPU-offloaded model', () => {
    const catalog = getModelCatalog(hardware({
      totalMemoryBytes: 64_000_000_000
    }))

    expect(selectInstalledInteractiveModel(catalog, ['qwen3.6:35b-a3b', 'qwen3.5:9b'], 'code'))
      .toBe('qwen3.5:9b')
    expect(selectInstalledInteractiveModel(catalog, ['qwen3.6:35b-a3b'], 'code')).toBeNull()
  })

  it('avoids an installed model measured as too slow for interactive work', () => {
    const catalog = getModelCatalog(hardware({
      totalMemoryBytes: 32_000_000_000,
      gpus: [{ model: 'GPU 12 GB', vramBytes: 12_000_000_000 }]
    }))
    const performance = new Map([
      ['qwen3.5:9b', { firstResponseMs: 55_000, tokensPerSecond: 2 }]
    ])

    expect(selectInstalledInteractiveModel(catalog, ['qwen3.5:9b', 'qwen3.5:4b'], 'code', performance))
      .toBe('qwen3.5:4b')
  })

  it('exposes one polyvalent model in general, code, vision, and fast usages', () => {
    expect(getModelCatalog(hardware()).find((model) => model.id === 'qwen3.5:4b')?.categories)
      .toEqual(expect.arrayContaining(['fast', 'general', 'code', 'vision']))
  })

  it('chooses a bounded automatic vision download suited to available memory', () => {
    expect(selectAutomaticVisionModel(getModelCatalog(hardware({ totalMemoryBytes: 8_000_000_000 })))?.id)
      .toBe('qwen3.5:2b')
    expect(selectAutomaticVisionModel(getModelCatalog(hardware({ totalMemoryBytes: 16_000_000_000 })))?.id)
      .toBe('qwen3.5:4b')
    expect(selectAutomaticVisionModel(getModelCatalog(hardware({ totalMemoryBytes: 32_000_000_000 })))?.id)
      .toBe('qwen3.5:9b')
  })

  it('describes MoE storage and active parameters without implying it fits in active-parameter memory', () => {
    const model = getModelCatalog(hardware()).find((entry) => entry.id === 'qwen3.6:35b-a3b')

    expect(model).toMatchObject({
      architecture: 'moe',
      totalParametersBillions: 35,
      activeParametersBillions: 3,
      quantization: 'Q4_K_M',
      compatibility: 'demanding'
    })
  })
})
