import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Bot,
  Boxes,
  ChevronLeft,
  FileText,
  KeyRound,
  LoaderCircle,
  Minus,
  Settings2,
  Square,
  X
} from 'lucide-react'
import type {
  CatalogModel,
  ClaudeCodeStatus,
  InferenceSettings,
  ModelCategory,
  ModelPullProgress,
  OllamaStatus,
  ReasoningMode,
  RuntimeProgress,
  SetupInfo,
  UpdateState
} from '../../shared/contracts'
import {
  getOllamaSetupState,
  installationEvidenceFromStart,
  type InstallationEvidence
} from './setup-state'
import { WorkspaceView } from './WorkspaceView'

type LoadState = OllamaStatus | null | 'loading'

const ONBOARDING_KEY = 'local-agent:onboarding-complete'
const CATEGORY_KEY = 'local-agent:model-category'
const IS_WINDOWS = navigator.userAgent.includes('Windows')
const CLAUDE_INSTALL_COMMAND = IS_WINDOWS
  ? 'irm https://claude.ai/install.ps1 | iex'
  : 'curl -fsSL https://claude.ai/install.sh | bash'
const STARTUP_PHRASES = [
  'Préparation de votre espace privé…',
  'Mise en route des outils locaux…',
  'Tout reste sur votre ordinateur.',
  'Encore quelques instants…'
]

const CATEGORIES: Array<{ id: ModelCategory; label: string; description: string }> = [
  { id: 'fast', label: 'Simple et rapide', description: 'Résumés et petites demandes' },
  { id: 'general', label: 'Usage général', description: 'Discussion et raisonnement' },
  { id: 'code', label: 'Programmation', description: 'Écriture et correction de code' },
  { id: 'vision', label: 'Analyser des images', description: 'Captures, documents et photos' },
  { id: 'image', label: 'Créer des images', description: 'Génération expérimentale' }
]

function formatSize(bytes: number): string {
  return new Intl.NumberFormat('fr-FR', {
    style: 'unit',
    unit: 'gigabyte',
    maximumFractionDigits: 1
  }).format(bytes / 1_000_000_000)
}

function normalizeModelName(model: string): string {
  return model.endsWith(':latest') ? model.slice(0, -7) : model
}

function compatibilityLabel(model: CatalogModel): string {
  if (model.compatibility === 'recommended') return 'Recommandé'
  if (model.compatibility === 'compatible') return 'Compatible'
  if (model.compatibility === 'demanding') return 'Non recommandé'
  return 'Non disponible'
}

function executionEstimate(model: CatalogModel, hardware: SetupInfo['hardware'] | undefined): string {
  const vram = hardware?.gpus.reduce((largest, gpu) => Math.max(largest, gpu.vramBytes ?? 0), 0) ?? 0
  if (vram === 0) return 'Calcul prévu : processeur, sauf si une mémoire GPU compatible est détectée.'
  if (vram >= model.downloadSizeBytes * 1.15) {
    return `GPU : devrait tenir dans vos ${formatSize(vram)} de VRAM.`
  }
  return `GPU + processeur probable : modèle trop grand pour vos ${formatSize(vram)} de VRAM.`
}

type AppView = 'agent' | 'setup'
type SettingsSection = 'models' | 'connections'
type WorkspaceShortcut = { type: 'new-thread' | 'open-project' }

function initialCategory(): ModelCategory {
  const saved = localStorage.getItem(CATEGORY_KEY)
  return CATEGORIES.some((category) => category.id === saved) ? saved as ModelCategory : 'code'
}

function TitleBar({ view, onViewChange }: {
  view: AppView
  onViewChange: (view: AppView) => void
}): React.JSX.Element {
  return (
    <header className="titlebar" onDoubleClick={() => void window.localAgent.toggleMaximizeWindow()}>
      <div className="titlebar-brand">
        <span aria-hidden="true"><Bot /></span>
        <strong>Stellan</strong>
      </div>
      <h1 className="sr-only">Stellan</h1>
      <nav className="titlebar-nav" aria-label="Navigation principale" onDoubleClick={(event) => event.stopPropagation()}>
        <button className={view === 'agent' ? 'active' : ''} type="button" aria-current={view === 'agent' ? 'page' : undefined} onClick={() => onViewChange('agent')}>Agent</button>
        <button
          className={view === 'setup' ? 'active' : ''}
          type="button"
          aria-current={view === 'setup' ? 'page' : undefined}
          aria-keyshortcuts="Control+, Meta+,"
          onClick={() => onViewChange('setup')}
        >Paramètres</button>
      </nav>
      <div className="window-controls" onDoubleClick={(event) => event.stopPropagation()}>
        <button type="button" aria-label="Réduire" onClick={() => void window.localAgent.minimizeWindow()}><Minus /></button>
        <button type="button" aria-label="Agrandir" onClick={() => void window.localAgent.toggleMaximizeWindow()}><Square /></button>
        <button className="close" type="button" aria-label="Fermer" onClick={() => void window.localAgent.closeWindow()}><X /></button>
      </div>
    </header>
  )
}

export function App(): React.JSX.Element {
  const [firstRun, setFirstRun] = useState(() => localStorage.getItem(ONBOARDING_KEY) !== 'true')
  const [view, setView] = useState<AppView>(() => firstRun ? 'setup' : 'agent')
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('models')
  const [preferredModel, setPreferredModel] = useState(() => localStorage.getItem('local-agent:model') ?? '')
  const [workspaceShortcut, setWorkspaceShortcut] = useState<WorkspaceShortcut | null>(null)
  const [status, setStatus] = useState<LoadState>(null)
  const [setup, setSetup] = useState<SetupInfo | null>(null)
  const [setupError, setSetupError] = useState<string | null>(null)
  const [category, setCategory] = useState<ModelCategory>(initialCategory)
  const [pullProgress, setPullProgress] = useState<ModelPullProgress | null>(null)
  const [pullError, setPullError] = useState<string | null>(null)
  const [downloadingModel, setDownloadingModel] = useState<string | null>(null)
  const [deletingModel, setDeletingModel] = useState<string | null>(null)
  const [inferenceSettings, setInferenceSettings] = useState<InferenceSettings | null>(null)
  const [savingInferenceSettings, setSavingInferenceSettings] = useState(false)
  const [inferenceSettingsError, setInferenceSettingsError] = useState<string | null>(null)
  const [checkingOllama, setCheckingOllama] = useState(false)
  const [startingOllama, setStartingOllama] = useState(false)
  const [activatingRuntime, setActivatingRuntime] = useState(false)
  const [installationEvidence, setInstallationEvidence] = useState<InstallationEvidence>('unknown')
  const [actionError, setActionError] = useState<string | null>(null)
  const [runtimeProgress, setRuntimeProgress] = useState<RuntimeProgress | null>(null)
  const [updateState, setUpdateState] = useState<UpdateState>({ status: 'checking' })
  const [claudeStatus, setClaudeStatus] = useState<ClaudeCodeStatus | null>(null)
  const [checkingClaude, setCheckingClaude] = useState(false)
  const [claudeAction, setClaudeAction] = useState<'install' | 'login' | null>(null)
  const [claudeActionError, setClaudeActionError] = useState<string | null>(null)
  const startupCardRef = useRef<HTMLElement>(null)
  const localStartupStarted = useRef(false)

  const refreshStatus = useCallback(async () => {
    setCheckingOllama(true)
    setRuntimeProgress({ step: 'Vérification de la connexion', detail: 'Interrogation de l’API Ollama dans le runtime privé…', percent: 50 })
    setActionError(null)
    setStatus((current) => current === null ? 'loading' : current)
    try {
      const nextStatus = await window.localAgent.getOllamaStatus()
      setStatus(nextStatus)
      if (nextStatus.available) setInstallationEvidence('detected')
    } catch {
      setActionError('La vérification a échoué. Redémarrez Stellan puis réessayez.')
    } finally {
      setCheckingOllama(false)
      setRuntimeProgress(null)
    }
  }, [])

  async function startOllama(): Promise<void> {
    setStartingOllama(true)
    setRuntimeProgress({ step: 'Démarrage du runtime privé', detail: 'Initialisation de la vérification automatique…', percent: 1 })
    setActionError(null)
    try {
      const nextStatus = await window.localAgent.startOllama()
      setStatus(nextStatus)
      setInstallationEvidence(installationEvidenceFromStart(nextStatus))
      if (nextStatus.available) {
        try { setSetup(await window.localAgent.getSetupInfo()) } catch { /* Ollama is usable even if diagnostics refresh fails. */ }
      }
    } catch {
      setActionError("Stellan n'a pas pu lancer Ollama. Utilisez la commande adaptée ci-dessous.")
    } finally {
      setStartingOllama(false)
      setRuntimeProgress(null)
    }
  }

  async function activateRuntime(): Promise<void> {
    setActivatingRuntime(true)
    setRuntimeProgress(IS_WINDOWS
      ? { step: 'Activation de WSL 2', detail: 'Préparation de la demande Windows…', percent: 1 }
      : { step: 'Préparation du moteur privé', detail: 'Vérification des prérequis Linux…', percent: 1 })
    setActionError(null)
    try {
      await window.localAgent.openOllamaDownload()
      await startOllama()
    } catch (error) {
      setActionError(IS_WINDOWS
        ? 'WSL 2 n’a pas pu être activé. Acceptez la demande Windows puis redémarrez le PC si nécessaire.'
        : error instanceof Error ? error.message : 'Le moteur Linux privé n’a pas pu être préparé.')
    } finally {
      setActivatingRuntime(false)
      setRuntimeProgress(null)
    }
  }

  useEffect(() => {
    const unsubscribe = window.localAgent.onUpdateState(setUpdateState)
    void window.localAgent.getUpdateState().then(setUpdateState)
    return unsubscribe
  }, [])

  useEffect(() => {
    void window.localAgent.getInferenceSettings()
      .then(setInferenceSettings)
      .catch(() => setInferenceSettingsError('Les préférences de raisonnement n’ont pas pu être chargées.'))
  }, [])

  const refreshClaudeStatus = useCallback(async () => {
    setCheckingClaude(true)
    try {
      setClaudeStatus(await window.localAgent.getClaudeCodeStatus())
    } catch {
      setClaudeStatus({
        available: false,
        version: null,
        subscription: null,
        reason: 'Stellan n’a pas pu vérifier Claude Code. Redémarrez l’application puis réessayez.'
      })
    } finally {
      setCheckingClaude(false)
    }
  }, [])

  useEffect(() => {
    void refreshClaudeStatus()
  }, [refreshClaudeStatus])

  async function installClaude(): Promise<void> {
    setClaudeAction('install')
    setClaudeActionError(null)
    try {
      setClaudeStatus(await window.localAgent.installClaudeCode())
    } catch (error) {
      setClaudeActionError(error instanceof Error ? error.message : 'L’installation automatique a échoué.')
    } finally {
      setClaudeAction(null)
    }
  }

  async function loginClaude(): Promise<void> {
    setClaudeAction('login')
    setClaudeActionError(null)
    try {
      setClaudeStatus(await window.localAgent.loginClaudeCode())
    } catch (error) {
      setClaudeActionError(error instanceof Error ? error.message : 'La connexion automatique a échoué.')
    } finally {
      setClaudeAction(null)
    }
  }

  useEffect(() => {
    if ((updateState.status !== 'current' && updateState.status !== 'error') || localStartupStarted.current) return
    localStartupStarted.current = true
    void startOllama()
    void analyzeComputer()
  }, [updateState.status])

  async function analyzeComputer(): Promise<void> {
    setSetupError(null)
    try {
      setSetup(await window.localAgent.getSetupInfo())
    } catch {
      setSetupError('La détection du catalogue et de la machine a échoué.')
    }
  }

  useEffect(() => window.localAgent.onRuntimeProgress((progress) => {
    setRuntimeProgress(progress)
    if (progress.percent >= 100) {
      setTimeout(() => setRuntimeProgress((current) => current === progress ? null : current), 600)
    }
  }), [])

  const updating = updateState.status !== 'current' && updateState.status !== 'error'
  const runtimeBusy = updating || startingOllama || checkingOllama || activatingRuntime
  useEffect(() => {
    return window.localAgent.onModelPullProgress(setPullProgress)
  }, [])

  useEffect(() => {
    localStorage.setItem(CATEGORY_KEY, category)
  }, [category])

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent): void => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey || event.repeat) return

      const key = event.key.toLowerCase()
      if (key === ',') {
        event.preventDefault()
        setView('setup')
      } else if (key === 'n' || key === 'o') {
        event.preventDefault()
        setWorkspaceShortcut({ type: key === 'n' ? 'new-thread' : 'open-project' })
        setView('agent')
      }
    }

    window.addEventListener('keydown', handleShortcut)
    return () => window.removeEventListener('keydown', handleShortcut)
  }, [])

  const visibleModels = useMemo(
    () => setup?.models.filter((model) => model.categories.includes(category)) ?? [],
    [category, setup]
  )

  const installedModels = useMemo(() => {
    if (!status || status === 'loading' || !status.available) return new Set<string>()
    return new Set(status.models.map((model) => normalizeModelName(model.name)))
  }, [status])

  const isLoading = status === null || status === 'loading'
  const canDownload = status !== null && status !== 'loading' && status.available
  const resolvedStatus = status === 'loading' ? null : status
  const ollamaSetup = getOllamaSetupState(resolvedStatus, installationEvidence)
  const isModelReady = ollamaSetup.modelReady === 'complete'

  useEffect(() => {
    if (!firstRun || !isModelReady) return
    localStorage.setItem(ONBOARDING_KEY, 'true')
    setFirstRun(false)
    setView('agent')
  }, [firstRun, isModelReady])

  const updatePending = updateState.status !== 'current' && updateState.status !== 'error'
  const startupVisible = updatePending || runtimeProgress !== null || runtimeBusy || isLoading || !resolvedStatus?.available
  const startupPercent = updateState.status === 'downloading'
    ? Math.round(updateState.percent)
    : updatePending ? (updateState.status === 'restarting' ? null : 2)
      : runtimeProgress?.percent ?? (resolvedStatus?.available ? 100 : 2)
  const startupPhrase = updateState.status === 'restarting'
    ? 'Préparation du redémarrage sécurisé…'
    : STARTUP_PHRASES[Math.min(STARTUP_PHRASES.length - 1, Math.floor((startupPercent ?? 100) / 26))]
  const startupStep = updateState.status === 'checking' ? 'Recherche des mises à jour'
    : updateState.status === 'downloading' ? `Mise à jour ${updateState.version}`
      : updateState.status === 'restarting' ? 'Installation de la mise à jour'
        : updateState.status === 'current' && updateState.updatedFrom ? `Finalisation de Stellan ${updateState.version}`
          : runtimeProgress?.step ?? (firstRun ? 'Première mise en place' : 'Démarrage de Stellan')
  const startupDetail = updateState.status === 'checking' ? 'Vérification sécurisée de la version disponible…'
    : updateState.status === 'downloading' ? `Téléchargement optimisé en cours — ${Math.round(updateState.bytesPerSecond / 1_000_000 * 10) / 10} Mo/s`
      : updateState.status === 'restarting' ? 'Téléchargement terminé. Stellan va se fermer quelques secondes, installer la mise à jour, puis se rouvrir automatiquement.'
        : updateState.status === 'current' && updateState.updatedFrom
            ? `Mise à jour depuis la version ${updateState.updatedFrom} réussie.${runtimeProgress ? ` ${runtimeProgress.detail}` : ' Finalisation du démarrage…'}`
          : runtimeProgress?.detail ?? actionError ?? (resolvedStatus?.available
            ? 'Environnement local prêt.'
            : resolvedStatus?.reason ?? 'Préparation de l’environnement privé…')

  useEffect(() => {
    if (startupVisible) startupCardRef.current?.focus()
    void window.localAgent.setStartupWindow(startupVisible)
  }, [startupVisible])

  function finishOnboarding(): void {
    localStorage.setItem(ONBOARDING_KEY, 'true')
    setFirstRun(false)
    setView('agent')
  }

  async function downloadModel(model: CatalogModel): Promise<void> {
    setPullError(null)
    setPullProgress({
      model: model.id,
      status: 'Préparation du téléchargement',
      completed: null,
      total: null,
      percent: null
    })
    setDownloadingModel(model.id)
    try {
      const result = await window.localAgent.pullModel(model.id)
      if (!result.success) setPullError(result.reason)
      else {
        const nextStatus = await window.localAgent.getOllamaStatus()
        setStatus(nextStatus)
        if (nextStatus.available) setInstallationEvidence('detected')
        localStorage.setItem('local-agent:model', model.id)
        setPreferredModel(model.id)
        setPullProgress(null)
      }
    } catch {
      setPullError('Le téléchargement du modèle a échoué. Vérifiez Ollama et votre connexion, puis réessayez.')
    } finally {
      setDownloadingModel(null)
    }
  }

  async function removeModel(model: CatalogModel): Promise<void> {
    const confirmed = window.confirm(
      `Supprimer ${model.name} de cet ordinateur ?\n\nLe modèle Ollama et son éventuel cache GGUF llama.cpp seront supprimés pour libérer de l’espace.`
    )
    if (!confirmed) return
    setDeletingModel(model.id)
    setPullError(null)
    try {
      const result = await window.localAgent.deleteModel(model.id)
      if (!result.success) {
        setPullError(result.reason)
        return
      }
      const nextStatus = await window.localAgent.getOllamaStatus()
      setStatus(nextStatus)
      if (normalizeModelName(preferredModel) === normalizeModelName(model.id)) {
        const nextModel = nextStatus.available ? nextStatus.models[0]?.name ?? '' : ''
        localStorage.setItem('local-agent:model', nextModel)
        setPreferredModel(nextModel)
      }
    } catch (error) {
      setPullError(error instanceof Error ? error.message : 'Le modèle n’a pas pu être supprimé.')
    } finally {
      setDeletingModel(null)
    }
  }

  async function updateReasoningMode(reasoningMode: ReasoningMode): Promise<void> {
    if (reasoningMode === inferenceSettings?.reasoningMode) return
    setSavingInferenceSettings(true)
    setInferenceSettingsError(null)
    try {
      setInferenceSettings(await window.localAgent.setInferenceSettings({ reasoningMode }))
    } catch {
      setInferenceSettingsError('Le mode de raisonnement n’a pas pu être enregistré.')
    } finally {
      setSavingInferenceSettings(false)
    }
  }

  if (startupVisible) {
    return (
      <main className="startup-shell">
        <div className="startup-window-drag" />
        <div className="startup-overlay">
          <section
            ref={startupCardRef}
            className="startup-card"
            role="dialog"
            aria-modal="true"
            aria-label="Préparation de Stellan"
            aria-live="polite"
            aria-busy={runtimeBusy}
            tabIndex={-1}
          >
            <div className="startup-orbit" aria-hidden="true"><i /><i /><i /><span><LoaderCircle /></span></div>
            <div className="startup-card-heading">
              <div>
                <small>STELLAN</small>
                <strong>{startupStep}</strong>
              </div>
              <span>{startupPercent === null ? 'En cours' : `${startupPercent}%`}</span>
            </div>
            <progress max="100" value={startupPercent ?? undefined} />
            <p>{startupPhrase}</p>
            <small className="startup-detail" title={startupDetail}>{startupDetail}</small>
            {(updateState.status === 'current' || updateState.status === 'error') && !runtimeBusy && !resolvedStatus?.available && (
              <div className="startup-card-actions">
                {ollamaSetup.canOpenDownload && <button type="button" disabled={activatingRuntime} onClick={() => void activateRuntime()}>{IS_WINDOWS ? 'Activer WSL 2' : 'Préparer le moteur privé'}</button>}
                <button type="button" disabled={checkingOllama || startingOllama} onClick={() => void refreshStatus()}>Réessayer</button>
              </div>
            )}
          </section>
        </div>
      </main>
    )
  }

  return (
    <main className="app-shell">
      <TitleBar view={view} onViewChange={setView} />

      <WorkspaceView
        visible={view === 'agent'}
        status={status}
        catalogModels={setup?.models ?? []}
        preferredModel={preferredModel}
        inferenceSettings={inferenceSettings}
        inferenceSettingsBusy={savingInferenceSettings}
        claudeStatus={claudeStatus}
        onRefreshClaudeStatus={refreshClaudeStatus}
        onReasoningModeChange={updateReasoningMode}
        shortcut={workspaceShortcut}
        onShortcutHandled={() => setWorkspaceShortcut(null)}
        onOpenSetup={() => { setSettingsSection('models'); setView('setup') }}
        onOpenClaudeSettings={() => { setSettingsSection('connections'); setView('setup') }}
      />
      <div className={`setup-view${view === 'setup' ? '' : ' app-view-hidden'}`} aria-hidden={view !== 'setup'}>
      <aside className="settings-sidebar">
        <div>
          <span className="agent-mark"><Settings2 aria-hidden="true" /></span>
          <strong>Réglages</strong>
        </div>
        <nav aria-label="Réglages">
          <button className={settingsSection === 'models' ? 'active' : ''} type="button" aria-current={settingsSection === 'models' ? 'page' : undefined} onClick={() => setSettingsSection('models')}><span><Boxes aria-hidden="true" /></span> Modèles locaux</button>
          <button className={settingsSection === 'connections' ? 'active' : ''} type="button" aria-current={settingsSection === 'connections' ? 'page' : undefined} onClick={() => setSettingsSection('connections')}><span><KeyRound aria-hidden="true" /></span> Connexions</button>
          <button type="button" disabled><span><Bot aria-hidden="true" /></span> Profils workers <small>Bientôt</small></button>
        </nav>
        <button className="settings-diagnostic" type="button" onClick={() => void window.localAgent.openInferenceLog()}>
          <FileText aria-hidden="true" /> Journal diagnostic
        </button>
        <button className="settings-back" type="button" onClick={firstRun ? finishOnboarding : () => setView('agent')}>
          {!firstRun && <ChevronLeft aria-hidden="true" />}{firstRun ? 'Configurer plus tard' : 'Retour aux threads'}
        </button>
      </aside>

      <div className="settings-content">
      {settingsSection === 'models' ? <>
      <header className="settings-page-header">
        <div>
          <p className="eyebrow">MODÈLES LOCAUX</p>
          <h2>{firstRun ? 'Choisissez votre premier modèle' : 'Modèles locaux'}</h2>
        </div>
        <p>Installez et gérez les modèles qui correspondent à votre machine et à vos usages.</p>
      </header>

      <section className="models-section">
        <div className="section-heading">
          <div><p className="eyebrow">CATALOGUE</p><h3>Installer un modèle</h3></div>
          <p>Le téléchargement occupe le disque. La RAM charge le modèle ; la VRAM détermine la part accélérée par le GPU.</p>
        </div>

        {setupError && (
          <div className="setup-inline-error" role="alert">
            <span>{setupError}</span>
            <button type="button" onClick={() => void analyzeComputer()}>Réessayer</button>
          </div>
        )}

        <div className="model-browser">
        <div className="category-tabs" aria-label="Filtrer les modèles par usage">
          {CATEGORIES.map((item) => (
            <button
              className={category === item.id ? 'active' : ''}
              key={item.id}
              type="button"
              aria-pressed={category === item.id}
              onClick={() => setCategory(item.id)}
            >
              <strong>{item.label}</strong>
              <span>{item.description}</span>
            </button>
          ))}
        </div>

        <div className="model-results">
        <div className="catalog-grid">
          {visibleModels.map((model) => {
            const installed = installedModels.has(normalizeModelName(model.id))
            const downloading = downloadingModel === model.id
            const deleting = deletingModel === model.id
            const disabled =
              installed || Boolean(downloadingModel) || Boolean(deletingModel) || ['demanding', 'unsupported'].includes(model.compatibility) ||
              !canDownload

            return (
              <article className="model-card" key={model.id}>
                <div className="model-card-top">
                  <span className={`compatibility ${model.compatibility}`}>
                    {compatibilityLabel(model)}
                  </span>
                  {model.experimental && <span className="experimental">Expérimental</span>}
                </div>
                <h4>{model.name}</h4>
                <code>{model.id}</code>
                <p>{model.description}</p>
                <div className="model-meta">
                  {model.totalParametersBillions !== undefined && (
                    <span>
                      <strong>{model.architecture === 'moe' ? 'Architecture MoE' : 'Architecture dense'}</strong>
                      {' '}{model.totalParametersBillions}B paramètres au total
                      {model.activeParametersBillions !== undefined ? ` · ${model.activeParametersBillions}B actifs par token` : ''}
                      {model.quantization ? ` · ${model.quantization}` : ''}
                    </span>
                  )}
                  <span><strong>Téléchargement</strong> ≈ {formatSize(model.downloadSizeBytes)} sur le disque</span>
                  <span><strong>Mémoire minimale</strong> {formatSize(model.minimumMemoryBytes)} de RAM</span>
                  {model.measuredTokensPerSecond !== undefined && (
                    <span><strong>Vitesse mesurée</strong> {model.measuredTokensPerSecond} tokens/s · première réponse ≈ {Math.max(0.1, (model.measuredFirstResponseMs ?? 0) / 1_000).toFixed(1)} s</span>
                  )}
                </div>
                {model.architecture === 'moe' && (
                  <p className="model-memory-note">Les poids complets doivent rester en VRAM ou en RAM ; les paramètres actifs réduisent surtout le calcul.</p>
                )}
                <p className="model-execution">{executionEstimate(model, setup?.hardware)}</p>
                <small>{model.compatibilityReason}</small>

                {downloading && pullProgress?.model === model.id && (
                  <div className="progress-block" aria-live="polite">
                    <div><span>{pullProgress.status}</span><span>{pullProgress.percent === null ? '…' : `${pullProgress.percent}%`}</span></div>
                    <progress max="100" value={pullProgress.percent ?? undefined} />
                  </div>
                )}

                <button
                  type="button"
                  disabled={disabled}
                  title={!canDownload ? 'Ollama doit être joignable avant de télécharger un modèle.' : undefined}
                  onClick={() => void downloadModel(model)}
                >
                  {installed
                    ? 'Installé'
                    : downloading
                      ? 'Téléchargement…'
                      : model.compatibility === 'demanding'
                        ? 'Configuration insuffisante'
                        : 'Télécharger ce modèle'}
                </button>

                {installed && (
                  <button
                    className="delete-model-button"
                    type="button"
                    disabled={Boolean(downloadingModel) || Boolean(deletingModel)}
                    onClick={() => void removeModel(model)}
                  >{deleting ? 'Suppression…' : 'Supprimer et libérer l’espace'}</button>
                )}
              </article>
            )
          })}
        </div>

        {pullError && <p className="download-error" role="alert">{pullError}</p>}
        {category === 'image' && (
          <p className="category-note">
            La création d’images est différente de leur analyse. Ollama la propose encore
            expérimentalement et sa disponibilité dépend du système.
          </p>
        )}
        </div>
        </div>
      </section>
      </> : <>
      <header className="settings-page-header">
        <div>
          <p className="eyebrow">CONNEXIONS</p>
          <h2>Services externes</h2>
        </div>
        <p>Ajoutez un service seulement si vous souhaitez l’utiliser. Les modèles locaux continuent de fonctionner sans compte externe.</p>
      </header>

      <section className="connections-section">
        <article className="connection-card">
          <div className="connection-card-heading">
            <span className="connection-logo"><Bot aria-hidden="true" /></span>
            <div><h3>Claude Code</h3><p>Utilisez votre abonnement Claude depuis Stellan.</p></div>
            <span className={`connection-status ${claudeStatus?.available ? 'connected' : ''}`}>
              <i aria-hidden="true" />{checkingClaude && claudeStatus === null ? 'Vérification' : claudeStatus?.available ? 'Connecté' : 'Non connecté'}
            </span>
          </div>

          <div className="connection-summary">
            <div><span>Application</span><strong>{checkingClaude && claudeStatus === null ? 'Détection…' : claudeStatus?.version ? `Claude Code ${claudeStatus.version}` : 'Non détectée'}</strong></div>
            <div><span>Compte</span><strong>{claudeStatus?.available ? `Abonnement ${claudeStatus.subscription ?? 'Claude'}` : 'À configurer'}</strong></div>
          </div>

          {claudeStatus?.available ? (
            <p className="connection-success">Claude Code est prêt. Choisissez maintenant un modèle Claude dans un thread.</p>
          ) : (
            <div className="connection-setup">
              <h4>Configuration en 3 étapes</h4>
              <ol>
                <li><span>1</span><div><strong>Installer Claude Code</strong><p>C’est l’outil officiel d’Anthropic, distinct de l’application Claude Desktop.</p><code>{CLAUDE_INSTALL_COMMAND}</code><button type="button" disabled={claudeAction !== null} onClick={() => void installClaude()}>{claudeAction === 'install' ? 'Installation en arrière-plan…' : claudeStatus?.version ? 'Mettre à jour automatiquement' : 'Installer automatiquement'}</button></div></li>
                <li><span>2</span><div><strong>Connecter votre abonnement</strong><p>Claude ouvrira sa page officielle dans votre navigateur. Il suffira de valider votre compte.</p><code>claude auth login</code><button type="button" disabled={!claudeStatus?.version || claudeAction !== null} onClick={() => void loginClaude()}>{claudeAction === 'login' ? 'Connexion en cours…' : 'Connecter mon abonnement'}</button></div></li>
                <li><span>3</span><div><strong>Revenir dans Stellan</strong><p>Une fois connecté, cliquez sur « Vérifier la connexion ».</p></div></li>
              </ol>
              {claudeActionError && <p className="connection-action-error" role="alert">{claudeActionError}</p>}
              {claudeStatus?.reason && <p className="connection-reason" role="status">{claudeStatus.reason}</p>}
            </div>
          )}

          <div className="connection-actions">
            <a href="https://code.claude.com/docs/en/quickstart" target="_blank" rel="noreferrer">Guide officiel d’installation</a>
            <button type="button" disabled={checkingClaude} onClick={() => void refreshClaudeStatus()}>{checkingClaude ? 'Vérification…' : 'Vérifier la connexion'}</button>
          </div>
          <small>Stellan refuse les clés API et n’utilise que la connexion à un abonnement Claude.ai existant.</small>
        </article>
      </section>
      </>}
      </div>
      </div>
    </main>
  )
}
