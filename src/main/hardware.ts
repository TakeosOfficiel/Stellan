import os from 'node:os'
import systeminformation from 'systeminformation'
import type { HardwareInfo } from '../shared/contracts'

function getPlatform(): HardwareInfo['platform'] {
  if (process.platform === 'win32') return 'windows'
  if (process.platform === 'linux') return 'linux'
  if (process.platform === 'darwin') return 'macos'
  return 'other'
}

export async function getHardwareInfo(): Promise<HardwareInfo> {
  let gpus: HardwareInfo['gpus'] = []

  try {
    const graphics = await systeminformation.graphics()
    gpus = graphics.controllers.map((controller) => ({
      model: controller.model || controller.vendor || 'GPU inconnu',
      vramBytes:
        typeof controller.vram === 'number' && controller.vram > 0
          ? controller.vram * 1_000_000
          : null
    }))
  } catch {
    // GPU detection is best-effort; RAM recommendations remain available.
  }

  const cpus = os.cpus()

  return {
    platform: getPlatform(),
    cpuModel: cpus[0]?.model.trim() || 'Processeur inconnu',
    cpuCores: cpus.length,
    totalMemoryBytes: os.totalmem(),
    gpus
  }
}
