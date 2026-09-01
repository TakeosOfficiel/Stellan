import { useCallback, useEffect, useState } from 'react'
import type { OllamaStatus } from '../../shared/contracts'

type LoadState = OllamaStatus | null | 'loading'

function formatSize(bytes: number): string {
  return new Intl.NumberFormat('fr-FR', {
    style: 'unit',
    unit: 'gigabyte',
    maximumFractionDigits: 1
  }).format(bytes / 1_000_000_000)
}

export function App(): React.JSX.Element {
  const [status, setStatus] = useState<LoadState>(null)

  const refreshStatus = useCallback(async () => {
    setStatus('loading')
    setStatus(await window.localAgent.getOllamaStatus())
  }, [])

  useEffect(() => {
    void refreshStatus()
  }, [refreshStatus])

  const isLoading = status === null || status === 'loading'

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand-mark" aria-hidden="true">L</div>
        <div>
          <p className="eyebrow">LOCAL DEVELOPMENT AGENT</p>
          <h1>Local Agent</h1>
        </div>
        <span className="platform-pill">Windows + Linux</span>
      </header>

      <section className="hero">
        <div>
          <p className="eyebrow">PREMIER DIAGNOSTIC</p>
          <h2>Votre environnement d’IA locale.</h2>
          <p className="lede">
            Cette première version vérifie la connexion à Ollama et découvre les
            modèles déjà installés sur votre machine.
          </p>
        </div>

        <div className="status-card" aria-live="polite">
          <div className="status-heading">
            <div>
              <span className="label">Moteur d’inférence</span>
              <strong>Ollama</strong>
            </div>
            <span
              className={`status-dot ${
                isLoading ? 'loading' : status.available ? 'online' : 'offline'
              }`}
              aria-label={
                isLoading ? 'Vérification' : status.available ? 'Disponible' : 'Indisponible'
              }
            />
          </div>

          {isLoading ? (
            <p className="status-copy">Vérification en cours…</p>
          ) : status.available ? (
            <>
              <p className="status-copy success">
                Ollama {status.version ? `v${status.version}` : ''} est prêt.
              </p>
              <div className="model-list">
                {status.models.length === 0 ? (
                  <p>Aucun modèle installé pour le moment.</p>
                ) : (
                  status.models.map((model) => (
                    <div className="model-row" key={model.name}>
                      <span>{model.name}</span>
                      <span>{formatSize(model.size)}</span>
                    </div>
                  ))
                )}
              </div>
            </>
          ) : (
            <>
              <p className="status-copy error">{status.reason}</p>
              <p className="hint">
                Installez puis démarrez Ollama. Local Agent le détectera automatiquement.
              </p>
            </>
          )}

          <button type="button" onClick={() => void refreshStatus()} disabled={isLoading}>
            {isLoading ? 'Vérification…' : 'Vérifier à nouveau'}
          </button>
        </div>
      </section>

      <section className="roadmap" aria-label="Étapes de configuration">
        <article className="step active">
          <span>01</span>
          <div><strong>Détecter Ollama</strong><p>Connexion locale et modèles.</p></div>
        </article>
        <article className="step">
          <span>02</span>
          <div><strong>Choisir un projet</strong><p>Ouverture sécurisée d’un dépôt.</p></div>
        </article>
        <article className="step">
          <span>03</span>
          <div><strong>Démarrer un thread</strong><p>Conversation et outils de code.</p></div>
        </article>
      </section>
    </main>
  )
}
