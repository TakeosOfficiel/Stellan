import os from 'node:os'
import systeminformation from 'systeminformation'
import type { HardwareInfo } from '../shared/contracts'
import type { OllamaGpuBackend } from './ollama-process'

type GraphicsController = {
  model?: string | null
  vendor?: string | null
  vram?: number | null
}

const VIRTUAL_ADAPTER_PATTERN = /parsec|virtual|remote display|indirect display|microsoft basic|vmware|virtualbox|citrix|hyper-v/i
const DISCRETE_GPU_PATTERN = /nvidia|geforce|quadro|rtx|gtx|amd|radeon|arc\b/i
let hardwarePromise: Promise<HardwareInfo> | null = null

function getPlatform(): HardwareInfo['platform'] {
  if (process.platform === 'win32') return 'windows'
  if (process.platform === 'linux') return 'linux'
  if (process.platform === 'darwin') return 'macos'
  return 'other'
}

export function selectGpus(controllers: GraphicsController[]): HardwareInfo['gpus'] {
  return controllers
    .map((controller) => {
      const model = controller.model || controller.vendor || 'GPU inconnu'
      const vramBytes = typeof controller.vram === 'number' && controller.vram > 0
        ? controller.vram * 1_000_000
        : null
      return { model, vramBytes }
    })
    .filter((gpu) => !VIRTUAL_ADAPTER_PATTERN.test(gpu.model))
    .sort((left, right) => {
      const leftDiscrete = DISCRETE_GPU_PATTERN.test(left.model) ? 1 : 0
      const rightDiscrete = DISCRETE_GPU_PATTERN.test(right.model) ? 1 : 0
      if (leftDiscrete !== rightDiscrete) return rightDiscrete - leftDiscrete
      return (right.vramBytes ?? 0) - (left.vramBytes ?? 0)
    })
}

export function inferenceParallelism(
  hardware: HardwareInfo,
  gpuBackend: OllamaGpuBackend = 'cpu'
): 1 | 2 {
  const largestVram = hardware.gpus.reduce(
    (largest, gpu) => Math.max(largest, gpu.vramBytes ?? 0),
    0
  )
  return gpuBackend !== 'cpu'
    && largestVram >= 24_000_000_000
    && hardware.totalMemoryBytes >= 24_000_000_000
    ? 2
    : 1
}

export function inferenceModelOptions(hardware: HardwareInfo): { numCtx: number; numPredict: number } {
  const largestVram = hardware.gpus.reduce(
    (largest, gpu) => Math.max(largest, gpu.vramBytes ?? 0),
    0
  )
  if (largestVram >= 24_000_000_000 || hardware.totalMemoryBytes >= 64_000_000_000) {
    return { numCtx: 32_768, numPredict: 2_048 }
  }
  if (largestVram >= 12_000_000_000 || hardware.totalMemoryBytes >= 24_000_000_000) {
    return { numCtx: 16_384, numPredict: 1_536 }
  }
  return { numCtx: 8_192, numPredict: 1_024 }
}

export function getBasicHardwareInfo(): HardwareInfo {
  const cpus = os.cpus()
  return {
    platform: getPlatform(),
    cpuModel: cpus[0]?.model.trim() || 'Processeur inconnu',
    cpuCores: cpus.length,
    totalMemoryBytes: os.totalmem(),
    gpus: []
  }
}

export function getHardwareInfo(): Promise<HardwareInfo> {
  if (hardwarePromise) return hardwarePromise
  hardwarePromise = (async () => {
    let gpus: HardwareInfo['gpus'] = []
    try {
      const graphics = await Promise.race([
        systeminformation.graphics(),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 8_000))
      ])
      if (graphics) gpus = selectGpus(graphics.controllers)
    } catch {
      // GPU detection is best-effort; RAM recommendations remain available.
    }
    return { ...getBasicHardwareInfo(), gpus }
  })()
  return hardwarePromise
}
