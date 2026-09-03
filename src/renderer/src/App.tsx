import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Bot,
  Boxes,
  ChevronLeft,
  KeyRound,
  LoaderCircle,
  Minus,
  Settings2,
  Square,
  X
} from 'lucide-react'
import type {
  CatalogModel,
  ModelCategory,
  ModelPullProgress,
  OllamaStatus,
  RuntimeProgress,
  SetupInfo
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
  if (model.compatibility === 'demanding') return 'Exigeant'
  return 'Non disponible'
}

type AppView = 'agent' | 'setup'
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
        <strong>Local Agent</strong>
      </div>
      <h1 className="sr-only">Local Agent</h1>
      <nav className="titlebar-nav" aria-label="Navigation principale" onDoubleClick={(event) => event.stopPropagation()}>
        <button className={view === 'agent' ? 'active' : ''} type="button" aria-current={view === 'agent' ? 'page' : undefined} onClick={() => onViewChange('agent')}>Agent</button>
        <button
          className={view === 'setup' ? 'active' : ''}
          type="button"
          aria-current={view === 'setup' ? 'page' : undefined}
          aria-keyshortcuts="Control+, Meta+,"
          onClick={() => onViewChange('setup')}
        >Modèles</button>
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
  const [workspaceShortcut, setWorkspaceShortcut] = useState<WorkspaceShortcut | null>(null)
  const [status, setStatus] = useState<LoadState>(null)
  const [setup, setSetup] = useState<SetupInfo | null>(null)
  const [setupError, setSetupError] = useState<string | null>(null)
  const [category, setCategory] = useState<ModelCategory>(initialCategory)
  const [pullProgress, setPullProgress] = useState<ModelPullProgress | null>(null)
  const [pullError, setPullError] = useState<string | null>(null)
  const [downloadingModel, setDownloadingModel] = useState<string | null>(null)
  const [checkingOllama, setCheckingOllama] = useState(false)
  const [startingOllama, setStartingOllama] = useState(false)
  const [activatingRuntime, setActivatingRuntime] = useState(false)
  const [installationEvidence, setInstallationEvidence] = useState<InstallationEvidence>('unknown')
  const [actionError, setActionError] = useState<string | null>(null)
  const [runtimeProgress, setRuntimeProgress] = useState<RuntimeProgress | null>(null)
  const startupCardRef = useRef<HTMLElement>(null)

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
      setActionError('La vérification a échoué. Redémarrez Local Agent puis réessayez.')
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
      setActionError("Local Agent n'a pas pu lancer Ollama. Utilisez la commande adaptée ci-dessous.")
    } finally {
      setStartingOllama(false)
      setRuntimeProgress(null)
    }
  }

  async function activateRuntime(): Promise<void> {
    setActivatingRuntime(true)
    setRuntimeProgress({ step: 'Activation de WSL 2', detail: 'Préparation de la demande Windows…', percent: 1 })
    setActionError(null)
    try {
      await window.localAgent.openOllamaDownload()
      await startOllama()
    } catch {
      setActionError('WSL 2 n’a pas pu être activé. Acceptez la demande Windows puis redémarrez le PC si nécessaire.')
    } finally {
      setActivatingRuntime(false)
      setRuntimeProgress(null)
    }
  }

  useEffect(() => {
    void startOllama()
  }, [])

  useEffect(() => {
    void analyzeComputer()
  }, [])

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

  const runtimeBusy = startingOllama || checkingOllama || activatingRuntime
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
    () => setup?.models.filter((model) => model.category === category) ?? [],
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

  const firstModelDownload = firstRun && Boolean(downloadingModel)
  const startupVisible = runtimeProgress !== null || runtimeBusy || isLoading || !resolvedStatus?.available || firstModelDownload
  const startupPercent = firstModelDownload
    ? pullProgress?.percent ?? 0
    : runtimeProgress?.percent ?? (resolvedStatus?.available ? 100 : 2)
  const startupStep = firstModelDownload
    ? 'Installation du modèle'
    : runtimeProgress?.step ?? (firstRun ? 'Première mise en place' : 'Démarrage de Local Agent')
  const startupDetail = firstModelDownload
    ? pullProgress?.status ?? 'Préparation du téléchargement…'
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
        await refreshStatus()
        setPullProgress(null)
      }
    } catch {
      setPullError('Le téléchargement du modèle a échoué. Vérifiez Ollama et votre connexion, puis réessayez.')
    } finally {
      setDownloadingModel(null)
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
            aria-label="Préparation de Local Agent"
            aria-live="polite"
            aria-busy={runtimeBusy || firstModelDownload}
            tabIndex={-1}
          >
            <div className="startup-orbit" aria-hidden="true"><i /><i /><i /><span><LoaderCircle /></span></div>
            <div className="startup-card-heading">
              <div>
                <small>{firstRun ? 'PREMIÈRE MISE EN PLACE' : 'ENVIRONNEMENT LOCAL'}</small>
                <strong>{startupStep}</strong>
              </div>
              <span>{startupPercent}%</span>
            </div>
            <progress max="100" value={startupPercent} />
            <p>{STARTUP_PHRASES[Math.min(STARTUP_PHRASES.length - 1, Math.floor(startupPercent / 26))]}</p>
            <small className="startup-detail">{startupDetail}</small>
            {!runtimeBusy && !firstModelDownload && !resolvedStatus?.available && (
              <div className="startup-card-actions">
                {ollamaSetup.canOpenDownload && <button type="button" disabled={activatingRuntime} onClick={() => void activateRuntime()}>Activer WSL 2</button>}
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
        shortcut={workspaceShortcut}
        onShortcutHandled={() => setWorkspaceShortcut(null)}
        onOpenSetup={() => setView('setup')}
      />
      <div className={`setup-view${view === 'setup' ? '' : ' app-view-hidden'}`} aria-hidden={view !== 'setup'}>
      <aside className="settings-sidebar">
        <div>
          <span className="agent-mark"><Settings2 aria-hidden="true" /></span>
          <strong>Réglages</strong>
        </div>
        <nav aria-label="Réglages">
          <button className="active" type="button" aria-current="page"><span><Boxes aria-hidden="true" /></span> Modèles locaux</button>
          <button type="button" disabled><span><Bot aria-hidden="true" /></span> Profils workers <small>Bientôt</small></button>
          <button type="button" disabled><span><KeyRound aria-hidden="true" /></span> Accès et portails <small>Bientôt</small></button>
        </nav>
        <button className="settings-back" type="button" onClick={firstRun ? finishOnboarding : () => setView('agent')}>
          {!firstRun && <ChevronLeft aria-hidden="true" />}{firstRun ? 'Configurer plus tard' : 'Retour aux threads'}
        </button>
      </aside>

      <div className="settings-content">
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
          <p>Les tailles sont approximatives. Le téléchargement nécessite Internet une seule fois.</p>
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
            const disabled =
              installed || Boolean(downloadingModel) || model.compatibility === 'unsupported' ||
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
                  <span>≈ {formatSize(model.downloadSizeBytes)}</span>
                  <span>RAM conseillée : {formatSize(model.minimumMemoryBytes)}</span>
                </div>
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
                  {installed ? 'Installé' : downloading ? 'Téléchargement…' : 'Télécharger ce modèle'}
                </button>
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
      </div>
      </div>
    </main>
  )
}
