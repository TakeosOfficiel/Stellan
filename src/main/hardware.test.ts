import { describe, expect, it } from 'vitest'
import { selectGpus } from './hardware'

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
})
