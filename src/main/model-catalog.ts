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
  additionalCategories?: ModelCategory[]
  description: string
  downloadSizeBytes: number
  minimumMemoryBytes: number
  supportedPlatforms?: HardwareInfo['platform'][]
  experimental?: boolean
}

const MODEL_CATALOG: ModelDefinition[] = [
  {
    id: 'qwen3.5:0.8b',
    name: 'Qwen 3.5 0.8B',
    category: 'fast',
    additionalCategories: ['general'],
    description: 'Assistant minimal pour les machines sans accélération GPU ; moins précis mais nettement plus rapide en CPU.',
    downloadSizeBytes: 1 * GB,
    minimumMemoryBytes: 4 * GB
  },
  {
    id: 'qwen3.5:2b',
    name: 'Qwen 3.5 2B',
    category: 'fast',
    additionalCategories: ['general', 'code', 'vision'],
    description: 'Assistant récent ultraléger avec outils, programmation et vision.',
    downloadSizeBytes: 2.7 * GB,
    minimumMemoryBytes: 8 * GB
  },
  {
    id: 'granite4.2:3b',
    name: 'Granite 4.2 3B',
    category: 'fast',
    description: 'Petit modèle IBM multilingue, adapté aux outils et aux réponses structurées.',
    downloadSizeBytes: 2.2 * GB,
    minimumMemoryBytes: 8 * GB
  },
  {
    id: 'qwen3.5:4b',
    name: 'Qwen 3.5 4B',
    category: 'code',
    additionalCategories: ['fast', 'general', 'vision'],
    description: 'Modèle polyvalent léger pour programmer, utiliser les outils et analyser des images.',
    downloadSizeBytes: 3.4 * GB,
    minimumMemoryBytes: 10 * GB
  },
  {
    id: 'qwen3.5:9b',
    name: 'Qwen 3.5 9B',
    category: 'general',
    additionalCategories: ['code', 'vision'],
    description: 'Assistant polyvalent équilibré pour raisonner, programmer et comprendre des images.',
    downloadSizeBytes: 6.6 * GB,
    minimumMemoryBytes: 16 * GB
  },
  {
    id: 'granite4.2:8b',
    name: 'Granite 4.2 8B',
    category: 'general',
    description: 'Modèle IBM multilingue pour raisonner, rechercher et produire du JSON.',
    downloadSizeBytes: 5.3 * GB,
    minimumMemoryBytes: 16 * GB
  },
  {
    id: 'gpt-oss:20b',
    name: 'GPT-OSS 20B',
    category: 'general',
    description: 'Raisonnement et outils avancés pour les machines avec beaucoup de mémoire.',
    downloadSizeBytes: 14 * GB,
    minimumMemoryBytes: 28 * GB
  },
  {
    id: 'qwen3.8:27b',
    name: 'Qwen 3.8 27B',
    category: 'general',
    additionalCategories: ['code', 'vision'],
    description: 'Assistant multimodal puissant pour les tâches complexes, le code et la vision.',
    downloadSizeBytes: 18 * GB,
    minimumMemoryBytes: 32 * GB
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
    id: 'devstral-small-2:24b',
    name: 'Devstral Small 2 24B',
    category: 'code',
    description: 'Modèle Mistral récent spécialisé dans les agents de programmation et les outils.',
    downloadSizeBytes: 15 * GB,
    minimumMemoryBytes: 32 * GB
  },
  {
    id: 'devstral-2:123b',
    name: 'Devstral 2 123B',
    category: 'code',
    description: 'Modèle agentique très haut de gamme (72,2 % SWE-bench Verified) pour stations de travail.',
    downloadSizeBytes: 75 * GB,
    minimumMemoryBytes: 80 * GB
  },
  {
    id: 'ministral-3:3b',
    name: 'Ministral 3 3B',
    category: 'vision',
    description: 'Vision et outils Mistral dans un modèle compact pour petite configuration.',
    downloadSizeBytes: 3 * GB,
    minimumMemoryBytes: 10 * GB
  },
  {
    id: 'ministral-3:8b',
    name: 'Ministral 3 8B',
    category: 'vision',
    description: 'Analyse visuelle polyvalente avec appels d’outils.',
    downloadSizeBytes: 6 * GB,
    minimumMemoryBytes: 18 * GB
  },
  {
    id: 'gemma4:e2b-it-qat',
    name: 'Gemma 4 E2B',
    category: 'vision',
    description: 'Modèle visuel Google compact, multilingue et compatible avec les outils.',
    downloadSizeBytes: 4.3 * GB,
    minimumMemoryBytes: 14 * GB
  },
  {
    id: 'gemma4:12b',
    name: 'Gemma 4 12B',
    category: 'vision',
    description: 'Analyse visuelle Google plus précise pour les configurations puissantes.',
    downloadSizeBytes: 7.6 * GB,
    minimumMemoryBytes: 22 * GB
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
  },
  {
    id: 'x/z-image-turbo',
    name: 'Z-Image Turbo',
    category: 'image',
    description: 'Création locale rapide d’images photoréalistes, expérimentale dans Ollama.',
    downloadSizeBytes: 13 * GB,
    minimumMemoryBytes: 24 * GB,
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
  return MODEL_CATALOG.map((model) => {
    const { additionalCategories = [], ...definition } = model
    return {
      ...definition,
      categories: [model.category, ...additionalCategories],
      ...getCompatibility(model, hardware)
    }
  })
}

export function isCatalogModel(model: string): boolean {
  return MODEL_CATALOG.some((entry) => entry.id === model)
}

function normalizedModelId(model: string): string {
  return model.endsWith(':latest') ? model.slice(0, -7) : model
}

export function selectInstalledSpecialistModel(
  catalog: readonly CatalogModel[],
  installedModels: readonly string[],
  category: ModelCategory,
  primaryModel: string
): string {
  const installedById = new Map(installedModels.map((model) => [normalizedModelId(model), model]))
  const compatibilityRank: Record<ModelCompatibility, number> = {
    recommended: 0,
    compatible: 0,
    demanding: 1,
    unsupported: 2
  }
  const candidates = catalog
    .filter((model) => model.categories.includes(category) && model.compatibility !== 'unsupported')
    .filter((model) => installedById.has(normalizedModelId(model.id)))
    .sort((left, right) => {
      const compatibilityDifference = compatibilityRank[left.compatibility] - compatibilityRank[right.compatibility]
      if (compatibilityDifference !== 0) return compatibilityDifference
      return left.compatibility === 'demanding'
        ? left.downloadSizeBytes - right.downloadSizeBytes
        : right.downloadSizeBytes - left.downloadSizeBytes
    })
  const specialist = candidates[0]
  return specialist ? installedById.get(normalizedModelId(specialist.id)) ?? specialist.id : primaryModel
}

export function selectAutomaticVisionModel(catalog: readonly CatalogModel[]): CatalogModel | null {
  return [...catalog]
    .filter((model) => model.categories.includes('vision') && model.compatibility !== 'unsupported')
    .filter((model) => model.downloadSizeBytes <= 8 * GB)
    .sort((left, right) => {
      const leftFits = left.compatibility === 'recommended' || left.compatibility === 'compatible'
      const rightFits = right.compatibility === 'recommended' || right.compatibility === 'compatible'
      if (leftFits !== rightFits) return leftFits ? -1 : 1
      return leftFits
        ? right.downloadSizeBytes - left.downloadSizeBytes
        : left.downloadSizeBytes - right.downloadSizeBytes
    })[0] ?? null
}
