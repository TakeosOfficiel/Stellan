import type {
  CatalogModel,
  HardwareInfo,
  ModelCompatibility,
  ModelCategory
} from '../shared/contracts'
import type { ModelPerformance } from './model-performance'

const GB = 1_000_000_000

type ModelDefinition = {
  id: string
  name: string
  category: ModelCategory
  additionalCategories?: ModelCategory[]
  description: string
  architecture?: 'dense' | 'moe'
  totalParametersBillions?: number
  activeParametersBillions?: number
  quantization?: string
  hybridEfficient?: boolean
  downloadSizeBytes: number
  minimumMemoryBytes: number
  supportedPlatforms?: HardwareInfo['platform'][]
  experimental?: boolean
  llamaCppArtifact?: string
}

const MODEL_CATALOG: ModelDefinition[] = [
  {
    id: 'qwen3.5:0.8b',
    name: 'Qwen 3.5 0.8B',
    category: 'fast',
    additionalCategories: ['general'],
    description: 'Assistant minimal pour les machines sans accélération GPU ; moins précis mais nettement plus rapide en CPU.',
    architecture: 'dense',
    totalParametersBillions: 0.8,
    downloadSizeBytes: 1 * GB,
    minimumMemoryBytes: 4 * GB
  },
  {
    id: 'qwen3.5:2b',
    name: 'Qwen 3.5 2B',
    category: 'fast',
    additionalCategories: ['general', 'code', 'vision'],
    description: 'Assistant récent ultraléger avec outils, programmation et vision.',
    architecture: 'dense',
    totalParametersBillions: 2,
    downloadSizeBytes: 2.7 * GB,
    minimumMemoryBytes: 8 * GB
  },
  {
    id: 'qwen3.5:4b',
    name: 'Qwen 3.5 4B',
    category: 'code',
    additionalCategories: ['fast', 'general', 'vision'],
    description: 'Modèle polyvalent léger pour programmer, utiliser les outils et analyser des images.',
    architecture: 'dense',
    totalParametersBillions: 4,
    quantization: 'Q4',
    downloadSizeBytes: 3.4 * GB,
    minimumMemoryBytes: 10 * GB,
    llamaCppArtifact: 'unsloth/Qwen3.5-4B-GGUF:UD-Q4_K_XL'
  },
  {
    id: 'qwen3.5:9b',
    name: 'Qwen 3.5 9B',
    category: 'general',
    additionalCategories: ['code', 'vision'],
    description: 'Assistant polyvalent équilibré pour raisonner, programmer et comprendre des images.',
    architecture: 'dense',
    totalParametersBillions: 9,
    quantization: 'Q4',
    downloadSizeBytes: 6.6 * GB,
    minimumMemoryBytes: 16 * GB,
    llamaCppArtifact: 'unsloth/Qwen3.5-9B-GGUF:UD-Q4_K_XL'
  },
  {
    id: 'gpt-oss:20b',
    name: 'GPT-OSS 20B',
    category: 'general',
    additionalCategories: ['code'],
    description: 'Raisonnement et outils avancés pour les machines avec beaucoup de mémoire.',
    architecture: 'moe',
    totalParametersBillions: 21,
    activeParametersBillions: 3.6,
    quantization: 'MXFP4',
    hybridEfficient: true,
    downloadSizeBytes: 14 * GB,
    minimumMemoryBytes: 24 * GB,
    llamaCppArtifact: 'ggml-org/gpt-oss-20b-GGUF:MXFP4'
  },
  {
    id: 'qwen3.6:35b-a3b',
    name: 'Qwen 3.6 35B-A3B',
    category: 'code',
    additionalCategories: ['general', 'vision'],
    description: 'MoE récent conçu pour le code agentique, les outils et les interfaces : 35B stockés, mais seulement 3B calculés par token.',
    architecture: 'moe',
    totalParametersBillions: 35,
    activeParametersBillions: 3,
    quantization: 'Q4_K_M',
    hybridEfficient: true,
    downloadSizeBytes: 23 * GB,
    minimumMemoryBytes: 32 * GB,
    llamaCppArtifact: 'ggml-org/Qwen3.6-35B-A3B-GGUF:Q4_K_M'
  },
  {
    id: 'devstral-small-2:24b',
    name: 'Devstral Small 2 24B',
    category: 'code',
    description: 'Modèle Mistral récent spécialisé dans les agents de programmation et les outils.',
    architecture: 'dense',
    totalParametersBillions: 24,
    quantization: 'Q4_K_M',
    downloadSizeBytes: 15 * GB,
    minimumMemoryBytes: 32 * GB,
    llamaCppArtifact: 'unsloth/Devstral-Small-2-24B-Instruct-2512-GGUF:Q4_K_M'
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
  const fitsGpu = knownVram >= model.downloadSizeBytes * 1.15
  const lightweight = model.downloadSizeBytes <= 8 * GB

  let compatibility: ModelCompatibility
  let compatibilityReason: string

  if (knownVram === 0 && !lightweight) {
    compatibility = 'demanding'
    compatibilityReason = availableMemory >= model.minimumMemoryBytes
      ? 'Exécutable en CPU, mais probablement trop lent pour un agent interactif.'
      : 'Peut être lent ou manquer de mémoire sur cette machine.'
  } else if (!fitsGpu && !lightweight && !model.hybridEfficient) {
    compatibility = 'demanding'
    compatibilityReason = availableMemory >= model.minimumMemoryBytes
      ? 'Le modèle utilisera fortement le processeur et risque d’être trop lent pour un usage interactif.'
      : 'Peut être lent ou manquer de mémoire sur cette machine.'
  } else if (model.hybridEfficient && knownVram > 0 && hardware.totalMemoryBytes >= model.minimumMemoryBytes) {
    compatibility = 'compatible'
    compatibilityReason = fitsGpu
      ? 'Le modèle MoE devrait tenir dans le GPU.'
      : 'Exécution hybride GPU + RAM possible ; la vitesse dépendra du matériel.'
  } else if (availableMemory >= model.minimumMemoryBytes * 1.25) {
    compatibility = 'recommended'
    compatibilityReason = 'Recommandé pour la mémoire détectée.'
  } else if (availableMemory >= model.minimumMemoryBytes) {
    compatibility = 'compatible'
    compatibilityReason = 'Compatible, avec une vitesse variable selon le matériel.'
  } else {
    compatibility = 'demanding'
    compatibilityReason = 'Peut être lent ou manquer de mémoire sur cette machine.'
  }

  return { compatibility, compatibilityReason }
}

export function getModelCatalog(hardware: HardwareInfo): CatalogModel[] {
  return MODEL_CATALOG.map((model) => {
    const { additionalCategories = [], llamaCppArtifact, hybridEfficient: _hybridEfficient, ...definition } = model
    return {
      ...definition,
      categories: [model.category, ...additionalCategories],
      ...getCompatibility(model, hardware)
    }
  })
}

export function getLlamaCppArtifact(modelId: string): string | null {
  return MODEL_CATALOG.find((model) => model.id === modelId)?.llamaCppArtifact ?? null
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

export function selectInstalledInteractiveModel(
  catalog: readonly CatalogModel[],
  installedModels: readonly string[],
  category: ModelCategory,
  performance: ReadonlyMap<string, ModelPerformance> = new Map()
): string | null {
  const installedById = new Map(installedModels.map((model) => [normalizedModelId(model), model]))
  const candidate = [...catalog]
    .filter((model) => model.categories.includes(category))
    .filter((model) => model.compatibility === 'recommended' || model.compatibility === 'compatible')
    .filter((model) => installedById.has(normalizedModelId(model.id)))
    .filter((model) => {
      const measured = performance.get(normalizedModelId(model.id))
      return !measured || (measured.firstResponseMs <= 45_000
        && (measured.tokensPerSecond === null || measured.tokensPerSecond >= 3))
    })
    .sort((left, right) => right.downloadSizeBytes - left.downloadSizeBytes)[0]
  return candidate ? installedById.get(normalizedModelId(candidate.id)) ?? candidate.id : null
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
