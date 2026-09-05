import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import type { HardwareInfo } from '../shared/contracts'
import type { InferencePerformanceMetrics } from './inference'

const profileSchema = z.record(z.string(), z.object({
  samples: z.number().int().positive(),
  firstResponseMs: z.number().nonnegative(),
  tokensPerSecond: z.number().positive().nullable(),
  updatedAt: z.string()
}))

export type ModelPerformance = {
  firstResponseMs: number
  tokensPerSecond: number | null
}

type StoredProfile = ModelPerformance & { samples: number; updatedAt: string }

export function hardwarePerformanceKey(hardware: HardwareInfo): string {
  return createHash('sha256').update(JSON.stringify({
    cpu: hardware.cpuModel,
    cores: hardware.cpuCores,
    memory: hardware.totalMemoryBytes,
    gpus: hardware.gpus.map((gpu) => [gpu.model, gpu.vramBytes ?? null])
  })).digest('hex').slice(0, 16)
}

export class ModelPerformanceStore {
  private readonly profiles: Record<string, StoredProfile>

  constructor(private readonly filePath: string) {
    try {
      this.profiles = profileSchema.parse(JSON.parse(readFileSync(filePath, 'utf8')))
    } catch {
      this.profiles = {}
    }
  }

  list(hardwareKey: string): ReadonlyMap<string, ModelPerformance> {
    return new Map(Object.entries(this.profiles)
      .filter(([key]) => key.startsWith(`${hardwareKey}:`))
      .map(([key, profile]) => [key.slice(hardwareKey.length + 1), {
        firstResponseMs: profile.firstResponseMs,
        tokensPerSecond: profile.tokensPerSecond
      }]))
  }

  record(hardwareKey: string, metrics: InferencePerformanceMetrics): void {
    if (!Number.isFinite(metrics.firstResponseMs) || metrics.firstResponseMs < 0) return
    const key = `${hardwareKey}:${metrics.model.replace(/:latest$/, '')}`
    const previous = this.profiles[key]
    const samples = Math.min(20, (previous?.samples ?? 0) + 1)
    const weight = 1 / samples
    this.profiles[key] = {
      samples,
      firstResponseMs: previous
        ? previous.firstResponseMs * (1 - weight) + metrics.firstResponseMs * weight
        : metrics.firstResponseMs,
      tokensPerSecond: metrics.tokensPerSecond === null
        ? previous?.tokensPerSecond ?? null
        : previous?.tokensPerSecond
          ? previous.tokensPerSecond * (1 - weight) + metrics.tokensPerSecond * weight
          : metrics.tokensPerSecond,
      updatedAt: new Date().toISOString()
    }
    try {
      mkdirSync(path.dirname(this.filePath), { recursive: true })
      const temporaryPath = `${this.filePath}.tmp`
      writeFileSync(temporaryPath, JSON.stringify(this.profiles), { mode: 0o600 })
      renameSync(temporaryPath, this.filePath)
    } catch {
      // Performance learning must never interrupt a completed model response.
    }
  }
}
