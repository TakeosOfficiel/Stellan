import type { ChatMessage } from '../shared/contracts'
import { streamOllamaChat } from './ollama'

export type IntentKind = 'activity' | 'code' | 'discussion' | 'unknown'

export type IntentClassification = {
  intent: IntentKind
  clear: boolean
  source: 'rule' | 'model' | 'fallback'
  reason: string
  activityEngine?: 'hangman'
}

type ClassifyIntentOptions = {
  model: string
  messages: readonly ChatMessage[]
  signal: AbortSignal
  activityContext?: string | null
  onInferenceLog?: (message: string) => void
}

function normalizedLatestRequest(messages: readonly ChatMessage[]): string {
  return ([...messages].reverse().find((message) => message.role === 'user')?.content ?? '')
    .trim()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
}

export function requestsProjectChange(messages: readonly ChatMessage[]): boolean {
  const request = normalizedLatestRequest(messages)
  if (/\b(?:pas (?:de |du )?code|sans code|dans (?:le )?chat|juste (?:jouer|discuter|parler))\b/.test(request)) return false
  if (/^\s*(?:comment|how (?:do|can|would|should))\b/.test(request)) return false
  return /\b(?:cree(?:r|z)?|ajoute(?:r|z)?|modifie(?:r|z)?|corrige(?:r|z)?|supprime(?:r|z)?|retire(?:r|z)?|remplace(?:r|z)?|implemente(?:r|z)?|genere(?:r|z)?|ecri(?:s|re|vez)|mets? a jour|faites?|create|add|update|modify|fix|remove|delete|replace|implement|generate|write)\b/.test(request)
    || /\bil manque\b[^.!?\n]{0,80}\b(?:fichier|css|html|javascript|js|code)\b/.test(request)
}

function requestsSoftwareArtifact(messages: readonly ChatMessage[]): boolean {
  const request = normalizedLatestRequest(messages)
  if (!requestsProjectChange(messages)) return false
  return /\b(?:site|page(?:\s+web)?|application|appli|logiciel|programme|code|projet|interface|fichiers?|dossiers?|animation|composant|bouton|menu|formulaire|html|css|javascript|typescript|react|vue|svelte)\b/.test(request)
    || /(?:^|\s)[\w./\\-]+\.[a-z0-9]{1,12}(?:\s|$)/.test(request)
    || /\bjeu\b[^.!?\n]{0,50}\b(?:web|video|javascript|html|a coder|a programmer)\b/.test(request)
}

function explicitActivityRequest(request: string): boolean {
  return /\b(?:joue|jouer|jouons|partie|play)\b[^.!?\n]{0,50}\b(?:pendu|hangman)\b/.test(request)
    || /\b(?:pendu|hangman)\b[^.!?\n]{0,50}\b(?:joue|jouer|jouons|partie|play)\b/.test(request)
    || /\bpend\s+u\s*ca te dit\b/.test(request)
}

function explanatoryHangmanRequest(request: string): boolean {
  return /\b(?:explique|expliquer|regles?|fonctionne|principe|definition|c['’]est quoi|what is|how does)\b[^.!?\n]{0,80}\b(?:pendu|hangman)\b/.test(request)
    || /\b(?:regles?|principe|definition)\b[^.!?\n]{0,50}\b(?:du |de |of )?(?:pendu|hangman)\b/.test(request)
}

function activeActivityAction(request: string): boolean {
  return /^[a-z]$/i.test(request)
    || /\b(?:indice|hint|abandonne|abandonner|laisse tomber|solution)\b/.test(request)
    || /\b(?:arrete|arreter|stoppe|stopper|quitte|quitter)\s+(?:la\s+)?(?:partie|jeu)\b/.test(request)
    || /^(?:stop|arrete|on arrete|fin (?:du jeu|de la partie))[\s:;!.,?]*$/.test(request)
}

export function classifyIntentByRule(
  messages: readonly ChatMessage[],
  activityContext?: string | null
): IntentClassification | null {
  const request = normalizedLatestRequest(messages)
  if (!request) return { intent: 'discussion', clear: true, source: 'rule', reason: 'empty-request' }
  if (requestsSoftwareArtifact(messages)) {
    return { intent: 'code', clear: true, source: 'rule', reason: 'explicit-software-artifact' }
  }
  if (explanatoryHangmanRequest(request)) {
    return { intent: 'discussion', clear: true, source: 'rule', reason: 'activity-explanation' }
  }
  if (explicitActivityRequest(request)) {
    return { intent: 'activity', clear: true, source: 'rule', reason: 'explicit-activity', activityEngine: 'hangman' }
  }
  if (activityContext?.includes('"engineId":"hangman"') && activeActivityAction(request)) {
    return { intent: 'activity', clear: true, source: 'rule', reason: 'active-activity-action', activityEngine: 'hangman' }
  }
  const previousAssistant = [...messages].reverse().find((message) => message.role === 'assistant')?.content
    .normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase() ?? ''
  if (/^(?:oui|yes|confirme|je confirme|vas[- ]?y|go)[\s.!]*$/.test(request)
    && /\b(?:supprime|supprimer|delete|suppression)\b/.test(previousAssistant)) {
    return { intent: 'code', clear: true, source: 'rule', reason: 'confirmed-destructive-action' }
  }
  if (/\b(?:pas (?:de |du )?code|sans code|dans (?:le )?chat|juste (?:discuter|parler))\b/.test(request)
    || /^(?:bonjour|salut|bonsoir|merci|hello|hi)\b/.test(request)) {
    return { intent: 'discussion', clear: true, source: 'rule', reason: 'explicit-conversation' }
  }
  return null
}

function classificationTranscript(messages: readonly ChatMessage[]): string {
  return messages
    .filter((message) => message.role === 'user' || message.role === 'assistant')
    .slice(-3)
    .map((message) => `${message.role === 'user' ? 'Utilisateur' : 'Assistant'}: ${message.content.slice(0, 1_000)}`)
    .join('\n')
}

function parseModelIntent(content: string): IntentKind {
  const matches = content.toUpperCase().match(/\b(?:CODE|DISCUSSION|ACTIVITE)\b/g) ?? []
  const unique = [...new Set(matches)]
  if (unique.length !== 1) return 'unknown'
  if (unique[0] === 'CODE') return 'code'
  if (unique[0] === 'ACTIVITE') return 'activity'
  return 'discussion'
}

export async function classifyIntent(options: ClassifyIntentOptions): Promise<IntentClassification> {
  const ruled = classifyIntentByRule(options.messages, options.activityContext)
  if (ruled) return ruled

  try {
    const result = await streamOllamaChat(
      options.model,
      [
        {
          role: 'system',
          content: 'Classe uniquement la dernière demande. CODE = travailler sur un logiciel ou ses fichiers. ACTIVITE = jouer ou poursuivre une activité à état. DISCUSSION = répondre ou expliquer sans agir sur le projet. Réponds par exactement un mot : CODE, ACTIVITE ou DISCUSSION.'
        },
        { role: 'user', content: classificationTranscript(options.messages) }
      ],
      () => undefined,
      options.signal,
      fetch,
      undefined,
      30_000,
      8,
      undefined,
      options.onInferenceLog
    )
    const intent = parseModelIntent(result.content)
    return {
      intent,
      clear: false,
      source: intent === 'unknown' ? 'fallback' : 'model',
      reason: intent === 'unknown' ? 'invalid-classifier-output' : 'model-classification'
    }
  } catch (error) {
    if (options.signal.aborted) throw error
    options.onInferenceLog?.(`intentClassifier=fallback reason=${error instanceof Error ? error.name : 'unknown'}`)
    return { intent: 'unknown', clear: false, source: 'fallback', reason: 'classifier-unavailable' }
  }
}
