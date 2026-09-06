export type ClaudeCodeModelGroup = 'economical' | 'balanced' | 'advanced' | 'maximum' | 'automatic'

export type ClaudeCodeModel = {
  id: string
  cliModel: string
  name: string
  group: ClaudeCodeModelGroup
}

export type ClaudeCodeQuotaInfo = {
  impact: 'low' | 'moderate' | 'high' | 'maximum'
  label: string
  advice: string
}

export const CLAUDE_CODE_MODELS: readonly ClaudeCodeModel[] = [
  { id: 'claude-code:claude-haiku-4-5', cliModel: 'claude-haiku-4-5', name: 'Claude Haiku 4.5 · économique', group: 'economical' },
  { id: 'claude-code:claude-sonnet-5', cliModel: 'claude-sonnet-5', name: 'Claude Sonnet 5 · recommandé', group: 'balanced' },
  { id: 'claude-code:claude-sonnet-4-6', cliModel: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6 · modéré', group: 'balanced' },
  { id: 'claude-code:claude-sonnet-4-5', cliModel: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5 · modéré', group: 'balanced' },
  { id: 'claude-code:claude-opus-5', cliModel: 'claude-opus-5', name: 'Claude Opus 5 · élevé', group: 'advanced' },
  { id: 'claude-code:claude-opus-4-8', cliModel: 'claude-opus-4-8', name: 'Claude Opus 4.8 · élevé', group: 'advanced' },
  { id: 'claude-code:claude-opus-4-7', cliModel: 'claude-opus-4-7', name: 'Claude Opus 4.7 · élevé', group: 'advanced' },
  { id: 'claude-code:claude-opus-4-6', cliModel: 'claude-opus-4-6', name: 'Claude Opus 4.6 · élevé', group: 'advanced' },
  { id: 'claude-code:claude-opus-4-5', cliModel: 'claude-opus-4-5', name: 'Claude Opus 4.5 · élevé', group: 'advanced' },
  { id: 'claude-code:claude-fable-5-1', cliModel: 'claude-fable-5-1', name: 'Claude Fable 5.1 · maximale', group: 'maximum' },
  { id: 'claude-code:claude-fable-5', cliModel: 'claude-fable-5', name: 'Claude Fable 5 · maximale', group: 'maximum' },
  { id: 'claude-code:sonnet', cliModel: 'sonnet', name: 'Claude Sonnet · version automatique', group: 'automatic' },
  { id: 'claude-code:opus', cliModel: 'opus', name: 'Claude Opus · version automatique', group: 'automatic' },
  { id: 'claude-code:fable', cliModel: 'fable', name: 'Claude Fable · version automatique', group: 'automatic' }
]

export function claudeCodeModel(model: string): ClaudeCodeModel | undefined {
  return CLAUDE_CODE_MODELS.find((candidate) => candidate.id === model)
}

export function isClaudeCodeModel(model: string): boolean {
  return claudeCodeModel(model) !== undefined
}

export function claudeCodeQuotaInfo(model: string): ClaudeCodeQuotaInfo | null {
  const selected = claudeCodeModel(model)
  if (!selected) return null
  if (selected.cliModel.includes('haiku')) {
    return { impact: 'low', label: 'Faible', advice: 'Idéal pour les recherches et modifications simples.' }
  }
  if (selected.cliModel.includes('sonnet')) {
    return { impact: 'moderate', label: 'Modéré', advice: 'Le meilleur choix par défaut pour la majorité des tâches de code.' }
  }
  if (selected.cliModel.includes('opus')) {
    return { impact: 'high', label: 'Élevé', advice: 'À réserver au débogage difficile, à l’architecture et aux gros refactors.' }
  }
  return { impact: 'maximum', label: 'Très élevé', advice: 'Pour les tâches autonomes les plus longues et difficiles.' }
}
