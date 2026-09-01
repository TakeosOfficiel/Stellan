import type {
  CatalogModel,
  HardwareInfo,
  ModelCompatibility,
  ModelCategory
} from '../shared/contracts'

const GB = 1_000_000_000

type ModelDefinition = {
  id: string
  name: string
  category: ModelCategory
  description: string
  downloadSizeBytes: number
  minimumMemoryBytes: number
  supportedPlatforms?: HardwareInfo['platform'][]
  experimental?: boolean
}

const MODEL_CATALOG: ModelDefinition[] = [
  {
    id: 'qwen3.5:4b',
    name: 'Qwen 3.5 4B',
    category: 'fast',
    description: 'Réponses courtes, résumés et petites tâches avec peu de mémoire.',
    downloadSizeBytes: 3 * GB,
    minimumMemoryBytes: 8 * GB
  },
  {
    id: 'qwen3.5:9b',
    name: 'Qwen 3.5 9B',
    category: 'general',
    description: 'Assistant polyvalent pour écrire, raisonner et discuter.',
    downloadSizeBytes: 6.6 * GB,
    minimumMemoryBytes: 16 * GB
  },
  {
    id: 'qwen2.5-coder:7b',
    name: 'Qwen 2.5 Coder 7B',
    category: 'code',
    description: 'Modèle de programmation léger pour les PC modestes.',
    downloadSizeBytes: 4.7 * GB,
    minimumMemoryBytes: 12 * GB
  },
  {
    id: 'qwen2.5-coder:14b',
    name: 'Qwen 2.5 Coder 14B',
    category: 'code',
    description: 'Bon équilibre pour écrire, corriger et expliquer du code.',
    downloadSizeBytes: 9 * GB,
    minimumMemoryBytes: 20 * GB
  },
  {
    id: 'qwen3-coder:30b',
    name: 'Qwen 3 Coder 30B',
    category: 'code',
    description: 'Modèle agentique puissant pour les dépôts et tâches complexes.',
    downloadSizeBytes: 19 * GB,
    minimumMemoryBytes: 32 * GB
  },
  {
    id: 'qwen3-vl:4b',
    name: 'Qwen 3 VL 4B',
    category: 'vision',
    description: 'Analyse des captures, documents et images sur une petite machine.',
    downloadSizeBytes: 3.3 * GB,
    minimumMemoryBytes: 12 * GB
  },
  {
    id: 'qwen3-vl:8b',
    name: 'Qwen 3 VL 8B',
    category: 'vision',
    description: 'Compréhension visuelle plus précise et meilleur raisonnement.',
    downloadSizeBytes: 6.1 * GB,
    minimumMemoryBytes: 20 * GB
  },
  {
    id: 'x/flux2-klein:4b',
    name: 'FLUX.2 Klein 4B',
    category: 'image',
    description: "Création locale d'images, fonctionnalité encore expérimentale dans Ollama.",
    downloadSizeBytes: 5.7 * GB,
    minimumMemoryBytes: 16 * GB,
    supportedPlatforms: ['macos'],
    experimental: true
  }
]

function getCompatibility(
  model: ModelDefinition,
  hardware: HardwareInfo
): Pick<CatalogModel, 'compatibility' | 'compatibilityReason'> {
  if (model.supportedPlatforms && !model.supportedPlatforms.includes(hardware.platform)) {
    return {
      compatibility: 'unsupported',
      compatibilityReason: "Cette fonction expérimentale d'Ollama n'est pas encore disponible sur ce système."
    }
  }

  const knownVram = hardware.gpus
    .map((gpu) => gpu.vramBytes ?? 0)
    .reduce((largest, current) => Math.max(largest, current), 0)
  const availableMemory = Math.max(knownVram, hardware.totalMemoryBytes * 0.65)

  let compatibility: ModelCompatibility
  let compatibilityReason: string

  if (availableMemory >= model.minimumMemoryBytes * 1.25) {
    compatibility = 'recommended'
    compatibilityReason = 'Recommandé pour la mémoire détectée.'
  } else if (availableMemory >= model.minimumMemoryBytes) {
    compatibility = 'compatible'
    compatibilityReason = 'Compatible, avec une vitesse variable selon le GPU.'
  } else {
    compatibility = 'demanding'
    compatibilityReason = 'Peut être lent ou manquer de mémoire sur cette machine.'
  }

  return { compatibility, compatibilityReason }
}

export function getModelCatalog(hardware: HardwareInfo): CatalogModel[] {
  return MODEL_CATALOG.map((model) => ({
    ...model,
    ...getCompatibility(model, hardware)
  }))
}

export function isCatalogModel(model: string): boolean {
  return MODEL_CATALOG.some((entry) => entry.id === model)
}
