import { useCallback, useEffect, useMemo, useState } from 'react'
import type {
  CatalogModel,
  ModelCategory,
  ModelPullProgress,
  OllamaStatus,
  SetupInfo
} from '../../shared/contracts'
import { WorkspaceView } from './WorkspaceView'

type LoadState = OllamaStatus | null | 'loading'

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

export function App(): React.JSX.Element {
  const [view, setView] = useState<'agent' | 'setup'>('agent')
  const [status, setStatus] = useState<LoadState>(null)
  const [setup, setSetup] = useState<SetupInfo | null>(null)
  const [category, setCategory] = useState<ModelCategory>('code')
  const [pullProgress, setPullProgress] = useState<ModelPullProgress | null>(null)
  const [pullError, setPullError] = useState<string | null>(null)
  const [downloadingModel, setDownloadingModel] = useState<string | null>(null)

  const refreshStatus = useCallback(async () => {
    setStatus('loading')
    setStatus(await window.localAgent.getOllamaStatus())
  }, [])

  useEffect(() => {
    void refreshStatus()
    void window.localAgent.getSetupInfo().then(setSetup)
  }, [refreshStatus])

  useEffect(() => {
    return window.localAgent.onModelPullProgress(setPullProgress)
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

    const result = await window.localAgent.pullModel(model.id)
    if (!result.success) setPullError(result.reason)
    else await refreshStatus()
    setDownloadingModel(null)
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand-mark" aria-hidden="true">L</div>
        <div>
          <p className="eyebrow">LOCAL DEVELOPMENT AGENT</p>
          <h1>Local Agent</h1>
        </div>
        <nav className="topnav" aria-label="Navigation principale">
          <button className={view === 'agent' ? 'active' : ''} type="button" onClick={() => setView('agent')}>Agent</button>
          <button className={view === 'setup' ? 'active' : ''} type="button" onClick={() => setView('setup')}>Modèles</button>
        </nav>
        <span className="platform-pill">Windows + Linux</span>
      </header>

      {view === 'agent' ? (
        <WorkspaceView status={status} onOpenSetup={() => setView('setup')} />
      ) : (
      <>
      <section className="intro">
        <div>
          <p className="eyebrow">CONFIGURATION LOCALE</p>
          <h2>Choisissez l’IA qui vous correspond.</h2>
          <p className="lede">
            Local Agent analyse votre machine et conseille des modèles, mais vous gardez
            toujours le choix selon votre usage.
          </p>
        </div>

        <div className="diagnostic-grid">
          <article className="diagnostic-card" aria-live="polite">
            <div className="card-title-row">
              <div><span className="label">Moteur local</span><strong>Ollama</strong></div>
              <span className={`status-dot ${isLoading ? 'loading' : status.available ? 'online' : 'offline'}`} />
            </div>
            {isLoading ? (
              <p className="muted">Vérification en cours…</p>
            ) : status.available ? (
              <>
                <p className="success">Ollama {status.version ? `v${status.version}` : ''} est prêt.</p>
                <p className="muted">{status.models.length} modèle{status.models.length > 1 ? 's' : ''} installé{status.models.length > 1 ? 's' : ''}</p>
                <button className="secondary-button" type="button" onClick={() => void refreshStatus()}>
                  Actualiser
                </button>
              </>
            ) : (
              <>
                <p className="error">{status.reason}</p>
                <p className="muted">L’installation s’ouvre sur le site officiel et reste sous votre contrôle.</p>
                <button type="button" onClick={() => void window.localAgent.openOllamaDownload()}>
                  Installer Ollama
                </button>
                <button className="secondary-button" type="button" onClick={() => void refreshStatus()}>
                  J’ai terminé, vérifier
                </button>
              </>
            )}
          </article>

          <article className="diagnostic-card hardware-card">
            <div className="card-title-row">
              <div><span className="label">Profil détecté</span><strong>Cette machine</strong></div>
            </div>
            {!setup ? (
              <p className="muted">Analyse du matériel…</p>
            ) : (
              <dl>
                <div><dt>Mémoire</dt><dd>{formatSize(setup.hardware.totalMemoryBytes)}</dd></div>
                <div><dt>Processeur</dt><dd>{setup.hardware.cpuCores} cœurs</dd></div>
                <div>
                  <dt>Graphique</dt>
                  <dd>{setup.hardware.gpus[0]?.model ?? 'Non détecté'}</dd>
                </div>
              </dl>
            )}
          </article>
        </div>
      </section>

      <section className="models-section">
        <div className="section-heading">
          <div><p className="eyebrow">CATALOGUE LOCAL</p><h3>Quel type de modèle voulez-vous ?</h3></div>
          <p>Les tailles sont approximatives. Le téléchargement nécessite Internet une seule fois.</p>
        </div>

        <div className="category-tabs" role="tablist" aria-label="Types de modèles">
          {CATEGORIES.map((item) => (
            <button
              className={category === item.id ? 'active' : ''}
              key={item.id}
              type="button"
              role="tab"
              aria-selected={category === item.id}
              onClick={() => setCategory(item.id)}
            >
              <strong>{item.label}</strong>
              <span>{item.description}</span>
            </button>
          ))}
        </div>

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
      </section>
      </>
      )}
    </main>
  )
}
