import { useCallback, useEffect, useMemo, useState } from 'react'
import type {
  CatalogModel,
  HardwareInfo,
  ModelCategory,
  ModelPullProgress,
  OllamaStatus,
  RuntimeProgress,
  SetupInfo
} from '../../shared/contracts'
import {
  getOllamaSetupState,
  installationEvidenceFromStart,
  type InstallationEvidence,
  type SetupStepState
} from './setup-state'
import { WorkspaceView } from './WorkspaceView'

type LoadState = OllamaStatus | null | 'loading'

const ONBOARDING_KEY = 'local-agent:onboarding-complete'
const CATEGORY_KEY = 'local-agent:model-category'

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

function stepIcon(state: SetupStepState): string {
  if (state === 'complete') return '✓'
  if (state === 'incomplete') return '!'
  return '·'
}

function TitleBar({ view, onViewChange }: {
  view: AppView
  onViewChange: (view: AppView) => void
}): React.JSX.Element {
  return (
    <header className="titlebar" onDoubleClick={() => void window.localAgent.toggleMaximizeWindow()}>
      <div className="titlebar-brand">
        <span aria-hidden="true">◒</span>
        <strong>Local Agent</strong>
      </div>
      <nav className="titlebar-nav" aria-label="Navigation principale" onDoubleClick={(event) => event.stopPropagation()}>
        <button className={view === 'agent' ? 'active' : ''} type="button" onClick={() => onViewChange('agent')}>Agent</button>
        <button
          className={view === 'setup' ? 'active' : ''}
          type="button"
          aria-keyshortcuts="Control+, Meta+,"
          onClick={() => onViewChange('setup')}
        >Modèles</button>
      </nav>
      <div className="window-controls" onDoubleClick={(event) => event.stopPropagation()}>
        <button type="button" aria-label="Réduire" onClick={() => void window.localAgent.minimizeWindow()}>—</button>
        <button type="button" aria-label="Agrandir" onClick={() => void window.localAgent.toggleMaximizeWindow()}>□</button>
        <button className="close" type="button" aria-label="Fermer" onClick={() => void window.localAgent.closeWindow()}>×</button>
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
  const [hardwarePreview, setHardwarePreview] = useState<HardwareInfo | null>(null)
  const [category, setCategory] = useState<ModelCategory>(initialCategory)
  const [pullProgress, setPullProgress] = useState<ModelPullProgress | null>(null)
  const [pullError, setPullError] = useState<string | null>(null)
  const [downloadingModel, setDownloadingModel] = useState<string | null>(null)
  const [checkingOllama, setCheckingOllama] = useState(false)
  const [startingOllama, setStartingOllama] = useState(false)
  const [activatingRuntime, setActivatingRuntime] = useState(false)
  const [analyzingComputer, setAnalyzingComputer] = useState(false)
  const [installationEvidence, setInstallationEvidence] = useState<InstallationEvidence>('unknown')
  const [actionError, setActionError] = useState<string | null>(null)
  const [runtimeProgress, setRuntimeProgress] = useState<RuntimeProgress | null>(null)
  const [runtimeElapsed, setRuntimeElapsed] = useState(0)

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
    setAnalyzingComputer(true)
    try {
      setHardwarePreview(await window.localAgent.getBasicHardwareInfo())
      setSetup(await window.localAgent.getSetupInfo())
    } finally {
      setAnalyzingComputer(false)
    }
  }

  useEffect(() => window.localAgent.onRuntimeProgress(setRuntimeProgress), [])

  const runtimeBusy = startingOllama || checkingOllama || activatingRuntime
  useEffect(() => {
    if (!runtimeBusy) {
      setRuntimeElapsed(0)
      return
    }
    const startedAt = Date.now()
    setRuntimeElapsed(0)
    const timer = setInterval(() => setRuntimeElapsed(Math.floor((Date.now() - startedAt) / 1_000)), 1_000)
    return () => clearInterval(timer)
  }, [runtimeBusy])

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
  const starterModel = setup?.models.find((model) => model.id === 'qwen3.5:4b')
  const detectedHardware = setup?.hardware ?? hardwarePreview

  useEffect(() => {
    if (!firstRun || !isModelReady) return
    localStorage.setItem(ONBOARDING_KEY, 'true')
    setFirstRun(false)
    setView('agent')
  }, [firstRun, isModelReady])

  const firstModelDownload = firstRun && Boolean(downloadingModel)
  const startupVisible = runtimeBusy || isLoading || !resolvedStatus?.available || firstModelDownload
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

  return (
    <main className="app-shell">
      <TitleBar view={view} onViewChange={setView} />

      {startupVisible && (
        <div className="startup-overlay">
          <section className="startup-card" aria-live="polite" aria-busy={runtimeBusy || firstModelDownload}>
            <div className="startup-card-heading">
              <span className="agent-mark" aria-hidden="true">◒</span>
              <div>
                <small>{firstRun ? 'PREMIÈRE MISE EN PLACE' : 'ENVIRONNEMENT LOCAL'}</small>
                <strong>{startupStep}</strong>
              </div>
              <span>{startupPercent}%</span>
            </div>
            <progress max="100" value={startupPercent} />
            <p>{startupDetail}</p>
            {!runtimeBusy && !firstModelDownload && !resolvedStatus?.available && (
              <div className="startup-card-actions">
                {ollamaSetup.canOpenDownload && <button type="button" disabled={activatingRuntime} onClick={() => void activateRuntime()}>Activer WSL 2</button>}
                <button type="button" disabled={checkingOllama || startingOllama} onClick={() => void refreshStatus()}>Réessayer</button>
              </div>
            )}
          </section>
        </div>
      )}

      {view === 'agent' ? (
        <WorkspaceView
          status={status}
          runtime={setup?.runtime ?? null}
          shortcut={workspaceShortcut}
          onShortcutHandled={() => setWorkspaceShortcut(null)}
          onOpenSetup={() => setView('setup')}
        />
      ) : (
      <div className="setup-view">
      <aside className="settings-sidebar">
        <div>
          <span className="agent-mark">◒</span>
          <strong>Réglages</strong>
        </div>
        <nav aria-label="Réglages">
          <button className="active" type="button"><span>◉</span> Modèles locaux</button>
          <button type="button" disabled><span>◇</span> Profils workers <small>Bientôt</small></button>
          <button type="button" disabled><span>⌁</span> Accès et portails <small>Bientôt</small></button>
        </nav>
        <button className="settings-back" type="button" onClick={firstRun ? finishOnboarding : () => setView('agent')}>
          {firstRun ? 'Configurer plus tard' : '← Retour aux threads'}
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

      <section className="runtime-panel">
        <div className="diagnostic-grid">
          <article className="diagnostic-card ollama-card" aria-labelledby="ollama-heading">
            <div className="card-title-row">
              <div><span className="label">Moteur local</span><strong id="ollama-heading">Ollama</strong></div>
              <span
                className={`status-dot ${isLoading || checkingOllama || startingOllama ? 'loading' : resolvedStatus?.available ? 'online' : 'offline'}`}
                aria-hidden="true"
              />
            </div>

            <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
              {checkingOllama ? 'Vérification d’Ollama en cours.' : startingOllama ? 'Démarrage d’Ollama en cours.' :
                resolvedStatus?.available ? `Ollama est joignable avec ${resolvedStatus.models.length} modèle installé.` :
                  resolvedStatus?.reason ?? 'Vérification d’Ollama en cours.'}
            </p>

            <ol className="setup-checklist" aria-label="État de la configuration Ollama">
              <li className={ollamaSetup.installed}>
                <span aria-hidden="true">{stepIcon(ollamaSetup.installed)}</span>
                <div><strong>Runtime privé disponible</strong><small>{ollamaSetup.installed === 'complete' ? 'Linux et conteneurs gérés par Local Agent' : ollamaSetup.installed === 'incomplete' ? 'WSL 2 doit être activé' : 'Préparation automatique du moteur isolé'}</small></div>
              </li>
              <li className={ollamaSetup.running}>
                <span aria-hidden="true">{stepIcon(ollamaSetup.running)}</span>
                <div><strong>Service démarré</strong><small>{ollamaSetup.running === 'complete' ? 'Le serveur local répond' : ollamaSetup.running === 'incomplete' ? 'Le démarrage a échoué' : 'État du processus inconnu'}</small></div>
              </li>
              <li className={ollamaSetup.reachable}>
                <span aria-hidden="true">{stepIcon(ollamaSetup.reachable)}</span>
                <div><strong>API locale joignable</strong><small>{ollamaSetup.reachable === 'complete' ? `Version ${resolvedStatus?.available && resolvedStatus.version ? resolvedStatus.version : 'détectée'} via le port privé 11435` : 'Aucune réponse du conteneur dans le runtime privé'}</small></div>
              </li>
              <li className={ollamaSetup.modelReady}>
                <span aria-hidden="true">{stepIcon(ollamaSetup.modelReady)}</span>
                <div><strong>Modèle prêt</strong><small>{resolvedStatus?.available && resolvedStatus.models.length > 0 ? `${resolvedStatus.models.length} modèle${resolvedStatus.models.length > 1 ? 's' : ''} installé${resolvedStatus.models.length > 1 ? 's' : ''}` : 'Installez un modèle après la connexion'}</small></div>
              </li>
            </ol>

            <div className="runtime-message">
              {runtimeBusy && runtimeProgress ? (
                <div className="runtime-operation" role="status" aria-live="polite">
                  <div><strong>{runtimeProgress.step}</strong><span>{runtimeProgress.percent}% · {runtimeElapsed} s</span></div>
                  <progress max="100" value={runtimeProgress.percent} />
                  <small>{runtimeProgress.detail}</small>
                </div>
              ) : isLoading ? <p className="muted">Initialisation automatique…</p> :
                resolvedStatus?.available ? <p className={isModelReady ? 'success' : 'muted'}>{isModelReady ? 'Votre moteur local est prêt.' : 'Ollama répond. Il reste à installer un modèle.'}</p> :
                  <p className="error">{resolvedStatus?.reason}</p>}
              {actionError && <p className="error" role="alert">{actionError}</p>}
            </div>

            <div className="runtime-actions">
              {isModelReady && <button type="button" onClick={finishOnboarding}>Utiliser Local Agent</button>}
              {!isModelReady && resolvedStatus?.available && starterModel && (
                <button type="button" disabled={Boolean(downloadingModel)} onClick={() => void downloadModel(starterModel)}>
                  {downloadingModel === starterModel.id ? 'Téléchargement…' : 'Installer le modèle de démarrage'}
                </button>
              )}
              {!resolvedStatus?.available && ollamaSetup.canStart && (
                <button type="button" disabled={startingOllama || checkingOllama} onClick={() => void startOllama()}>
                  {startingOllama ? 'Démarrage…' : 'Rechercher et démarrer'}
                </button>
              )}
              {!resolvedStatus?.available && ollamaSetup.canOpenDownload && (
                <button className="secondary-button" type="button" disabled={activatingRuntime} onClick={() => void activateRuntime()}>
                  {activatingRuntime ? 'Activation…' : 'Activer WSL 2'}
                </button>
              )}
              {!isLoading && (
                <button className="secondary-button" type="button" disabled={checkingOllama || startingOllama} onClick={() => void refreshStatus()}>
                  {checkingOllama ? 'Vérification…' : 'Réessayer la connexion'}
                </button>
              )}
            </div>

            {starterModel && downloadingModel === starterModel.id && pullProgress?.model === starterModel.id && (
              <div className="onboarding-download-progress" aria-live="polite">
                <div>
                  <strong>{pullProgress.status}</strong>
                  <span>{pullProgress.percent === null ? 'Préparation…' : `${pullProgress.percent}%`}</span>
                </div>
                <progress
                  aria-label={`Téléchargement de ${starterModel.name}`}
                  max="100"
                  value={pullProgress.percent ?? undefined}
                />
                <small>
                  {pullProgress.completed !== null && pullProgress.total !== null
                    ? `${formatSize(pullProgress.completed)} téléchargés sur ${formatSize(pullProgress.total)}`
                    : 'Ollama prépare les fichiers du modèle…'}
                </small>
              </div>
            )}

            {!resolvedStatus?.available && !isLoading && (
              <details className="troubleshooting">
                <summary>Dépannage rapide</summary>
                <p>Local Agent crée automatiquement le conteneur <code>local-agent-ollama</code> et conserve tous les modèles dans le volume Docker <code>local-agent-ollama-models</code>.</p>
                <p>Activez WSL 2 puis réessayez. Local Agent télécharge automatiquement son Linux minimal, le moteur de conteneurs et l’image Ollama.</p>
              </details>
            )}
          </article>

          <article className="diagnostic-card hardware-card">
            <div className="card-title-row">
              <div><span className="label">Profil détecté</span><strong>Cette machine</strong></div>
            </div>
            {!detectedHardware ? (
              <div className="hardware-analysis-prompt">
                <p className="muted">{analyzingComputer ? 'Détection automatique du processeur, de la mémoire et du GPU…' : 'La détection automatique n’a pas abouti.'}</p>
                {!analyzingComputer && <button type="button" onClick={() => void analyzeComputer()}>Relancer la détection</button>}
              </div>
            ) : (
              <>
                <dl>
                  <div><dt>Mémoire</dt><dd>{formatSize(detectedHardware.totalMemoryBytes)}</dd></div>
                  <div><dt>Processeur</dt><dd>{detectedHardware.cpuCores} cœurs</dd></div>
                  <div>
                    <dt>Graphique</dt>
                    <dd>{setup ? detectedHardware.gpus[0]?.model ?? 'Non détecté' : 'Détection en cours…'}</dd>
                  </div>
                </dl>
                {analyzingComputer && !setup && <p className="hardware-scan-status"><span /> Analyse du GPU et des runtimes en arrière-plan…</p>}
              </>
            )}
          </article>
        </div>
        {setup && (
          <div className="runtime-diagnostics" aria-label="Outils d’isolation détectés">
            {([
              ['Git', setup.runtime.git],
              ['Docker', setup.runtime.docker],
              ['Podman', setup.runtime.podman]
            ] as const).map(([name, tool]) => (
              <div key={name}>
                <span className={`status-dot ${tool.available ? 'online' : 'offline'}`} />
                <span><strong>{name}</strong><small>{tool.available ? tool.version ?? 'Disponible' : 'Indisponible'}</small></span>
              </div>
            ))}
            <p>
              {setup.runtime.recommendedContainerRuntime
                ? `Runtime worker recommandé : ${setup.runtime.recommendedContainerRuntime}`
                : 'Runtime privé indisponible : activez WSL 2 pour les workers isolés.'}
            </p>
          </div>
        )}
      </section>

      <section className="models-section">
        <div className="section-heading">
          <div><p className="eyebrow">CATALOGUE</p><h3>Installer un modèle</h3></div>
          <p>Les tailles sont approximatives. Le téléchargement nécessite Internet une seule fois.</p>
        </div>

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
      )}
    </main>
  )
}
