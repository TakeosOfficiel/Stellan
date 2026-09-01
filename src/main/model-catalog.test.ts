import { describe, expect, it } from 'vitest'
import type { HardwareInfo } from '../shared/contracts'
import { getModelCatalog, isCatalogModel } from './model-catalog'

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

    expect(models.find((model) => model.id === 'qwen2.5-coder:7b')?.compatibility)
      .toBe('recommended')
    expect(models.find((model) => model.id === 'qwen3-coder:30b')?.compatibility)
      .toBe('demanding')
  })

  it('marks experimental image generation unsupported on Windows', () => {
    const imageModel = getModelCatalog(hardware()).find(
      (model) => model.id === 'x/flux2-klein:4b'
    )

    expect(imageModel?.compatibility).toBe('unsupported')
  })

  it('only accepts curated model identifiers', () => {
    expect(isCatalogModel('qwen3.5:4b')).toBe(true)
    expect(isCatalogModel('unknown/model')).toBe(false)
  })
})
