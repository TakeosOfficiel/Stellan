import { useEffect, useMemo, useState } from 'react'
import type {
  ChatEvent,
  ChatMessage,
  OllamaStatus,
  ProjectSelection,
  ProjectReview,
  StoredThread
} from '../../shared/contracts'

type UiMessage = ChatMessage & {
  id: string
  failed?: boolean
}

type WorkspaceViewProps = {
  status: OllamaStatus | null | 'loading'
  onOpenSetup: () => void
}

type ToolActivity = {
  id: string
  tool: string
  status: 'running' | 'done' | 'denied' | 'error'
}

const TOOL_LABELS: Record<string, string> = {
  list_files: 'Liste des fichiers',
  read_file: 'Lecture de fichier',
  search_files: 'Recherche dans le projet',
  write_file: 'Écriture de fichier',
  run_command: 'Commande locale',
  git_status: 'Statut Git',
  git_diff: 'Diff Git'
}

function projectName(projectPath: string): string {
  return projectPath.split(/[\\/]/).filter(Boolean).at(-1) ?? projectPath
}

export function WorkspaceView({ status, onOpenSetup }: WorkspaceViewProps): React.JSX.Element {
  const models = status && status !== 'loading' && status.available ? status.models : []
  const [selectedModel, setSelectedModel] = useState(() => localStorage.getItem('local-agent:model') ?? '')
  const [project, setProject] = useState<ProjectSelection | null>(null)
  const [threads, setThreads] = useState<StoredThread[]>([])
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null)
  const [messages, setMessages] = useState<UiMessage[]>([])
  const [prompt, setPrompt] = useState('')
  const [activeRequest, setActiveRequest] = useState<string | null>(null)
  const [toolActivities, setToolActivities] = useState<ToolActivity[]>([])
  const [projectReview, setProjectReview] = useState<ProjectReview | null>(null)
  const [reviewError, setReviewError] = useState<string | null>(null)

  const effectiveModel = useMemo(() => {
    if (models.some((model) => model.name === selectedModel)) return selectedModel
    return models[0]?.name ?? ''
  }, [models, selectedModel])

  useEffect(() => {
    void window.localAgent.listThreads().then(setThreads)
  }, [])

  useEffect(() => {
    if (effectiveModel) localStorage.setItem('local-agent:model', effectiveModel)
  }, [effectiveModel])

  useEffect(() => {
    const handleEvent = (event: ChatEvent): void => {
      if (event.type === 'tool') {
        setToolActivities((current) => {
          const running = [...current].reverse().find(
            (activity) => activity.tool === event.tool && activity.status === 'running'
          )
          if (running && event.status !== 'running') {
            return current.map((activity) => activity.id === running.id
              ? { ...activity, status: event.status }
              : activity)
          }
          return [...current, { id: crypto.randomUUID(), tool: event.tool, status: event.status }]
        })
        return
      }
      if (event.type === 'content') {
        setMessages((current) => current.map((message) =>
          message.id === event.requestId
            ? { ...message, content: message.content + event.content }
            : message
        ))
        return
      }

      if (event.type === 'error') {
        setMessages((current) => current.map((message) =>
          message.id === event.requestId
            ? { ...message, content: message.content || event.reason, failed: true }
            : message
        ))
      }
      setActiveRequest((current) => current === event.requestId ? null : current)
    }

    return window.localAgent.onChatEvent(handleEvent)
  }, [])

  async function chooseProject(): Promise<void> {
    const selection = await window.localAgent.selectProject()
    if (selection) {
      if (activeThreadId) newThread()
      setProject(selection)
    }
  }

  async function openThread(thread: StoredThread): Promise<void> {
    const storedMessages = await window.localAgent.loadThreadMessages(thread.id)
    setActiveThreadId(thread.id)
    setMessages(storedMessages.map((message) => ({
      id: message.id,
      role: message.role,
      content: message.content
    })))
    setProject(thread.projectPath
      ? { path: thread.projectPath, name: projectName(thread.projectPath) }
      : null)
    if (thread.model) setSelectedModel(thread.model)
    setToolActivities([])
    setProjectReview(null)
    setReviewError(null)
  }

  function newThread(): void {
    setActiveThreadId(null)
    setMessages([])
    setToolActivities([])
    setProjectReview(null)
    setReviewError(null)
  }

  async function reviewProject(): Promise<void> {
    if (!activeThreadId) return
    setReviewError(null)
    try {
      setProjectReview(await window.localAgent.reviewThreadProject(activeThreadId))
    } catch {
      setProjectReview(null)
      setReviewError('Impossible de lire les changements Git de ce projet.')
    }
  }

  async function removeThread(threadId: string): Promise<void> {
    try {
      if (!await window.localAgent.deleteThread(threadId)) return
      setThreads((current) => current.filter((thread) => thread.id !== threadId))
      if (activeThreadId === threadId) newThread()
    } catch {
      setReviewError('Impossible de supprimer ce thread pendant son utilisation.')
    }
  }

  async function sendMessage(): Promise<void> {
    const content = prompt.trim()
    if (!content || !effectiveModel || activeRequest) return

    let threadId = activeThreadId
    if (!threadId) {
      try {
        const thread = await window.localAgent.createThread({
          title: content.length > 60 ? `${content.slice(0, 57)}…` : content,
          projectPath: project?.path ?? null,
          model: effectiveModel
        })
        threadId = thread.id
        setActiveThreadId(thread.id)
        setThreads((current) => [...current, thread])
      } catch {
        return
      }
    }

    const requestId = crypto.randomUUID()
    const userMessage: UiMessage = { id: crypto.randomUUID(), role: 'user', content }
    const assistantMessage: UiMessage = { id: requestId, role: 'assistant', content: '' }
    const history: ChatMessage[] = messages
      .filter((message) => !message.failed && message.content)
      .map(({ role, content: messageContent }) => ({ role, content: messageContent }))

    setPrompt('')
    setMessages((current) => [...current, userMessage, assistantMessage])
    setActiveRequest(requestId)
    setToolActivities([])
    setProjectReview(null)

    try {
      await window.localAgent.startChat({
        requestId,
        threadId,
        model: effectiveModel,
        projectPath: project?.path ?? null,
        messages: [
          {
            role: 'system',
            content: project
              ? `Tu es un assistant de développement local. Le projet sélectionné est ${project.name}.`
              : 'Tu es un assistant local utile, précis et concis.'
          },
          ...history,
          { role: 'user', content }
        ]
      })
    } catch {
      setMessages((current) => current.map((message) =>
        message.id === requestId
          ? { ...message, content: 'Impossible de démarrer la conversation.', failed: true }
          : message
      ))
      setActiveRequest(null)
    }
  }

  const hasOllama = Boolean(status && status !== 'loading' && status.available)
  const activeThread = threads.find((thread) => thread.id === activeThreadId)

  return (
    <section className="workspace-view">
      <nav className="app-rail" aria-label="Sections de Local Agent">
        <div className="rail-main">
          <button className="active" type="button" aria-label="Threads" title="Threads">⌁</button>
          <button type="button" aria-label="Projets" title="Projets" onClick={() => void chooseProject()}>◇</button>
          <button type="button" aria-label="Nouveau thread" title="Nouveau thread" onClick={newThread}>＋</button>
        </div>
        <button type="button" aria-label="Modèles et réglages" title="Modèles et réglages" onClick={onOpenSetup}>⚙</button>
      </nav>

      <aside className="workspace-sidebar">
        <button className="project-switcher" type="button" onClick={() => void chooseProject()}>
          <span className="project-icon">◇</span>
          <span>
            <small>ESPACE LOCAL</small>
            <strong>{project?.name ?? 'Tous les projets'}</strong>
          </span>
          <span aria-hidden="true">⌄</span>
        </button>

        <button className="new-thread-button" type="button" onClick={newThread}>
          <span>＋</span> Nouveau thread
          <kbd>Ctrl N</kbd>
        </button>

        <div className="thread-list">
          <div className="thread-group-heading">
            <span className="agent-mark">◒</span>
            <strong>Agent de programmation</strong>
            <span>{threads.length}</span>
          </div>
          <div className="thread-tree">
            {threads.length === 0 && <p>Aucun thread pour le moment</p>}
            {threads.map((thread) => (
              <div className={`thread-row ${activeThreadId === thread.id ? 'active' : ''}`} key={thread.id}>
                <span className="branch" aria-hidden="true">├</span>
                <span className="thread-agent" aria-hidden="true">●</span>
                <button type="button" title={thread.title} onClick={() => void openThread(thread)}>{thread.title}</button>
                <button
                  className="thread-delete"
                  type="button"
                  aria-label={`Supprimer ${thread.title}`}
                  disabled={Boolean(activeRequest) && activeThreadId === thread.id}
                  onClick={() => void removeThread(thread.id)}
                >×</button>
              </div>
            ))}
          </div>
        </div>

        <div className="sidebar-footer">
          <div className="runtime-summary">
            <div>
              <span className={`status-dot ${hasOllama ? 'online' : 'offline'}`} />
              <span>{hasOllama ? 'Ollama connecté' : 'Ollama indisponible'}</span>
            </div>
            {activeThread?.projectPath && (
              <small>{activeThread.workspaceMode === 'worktree' ? 'Worktree Git isolé' : 'Dossier direct confirmé'}</small>
            )}
          </div>

          <div className="model-selector">
            {models.length > 0 ? (
              <select
                aria-label="Modèle actif"
                value={effectiveModel}
                onChange={(event) => setSelectedModel(event.target.value)}
                disabled={Boolean(activeRequest)}
              >
                {models.map((model) => <option value={model.name} key={model.name}>{model.name}</option>)}
              </select>
            ) : (
              <button type="button" onClick={onOpenSetup}>Configurer un modèle</button>
            )}
          </div>
        </div>
      </aside>

      <div className="chat-panel">
        <div className="chat-header">
          <div className="thread-identity">
            <span>{project?.name ?? 'Local'}</span>
            <span aria-hidden="true">/</span>
            <h3>{activeThread?.title ?? 'Nouveau thread'}</h3>
          </div>
          <div className="chat-header-actions">
            {activeThread?.projectPath && !activeRequest && (
              <button className="ghost-button" type="button" onClick={() => void reviewProject()}>
                <span aria-hidden="true">±</span> Changements
              </button>
            )}
            <details className="thread-menu">
              <summary aria-label="Options du thread">•••</summary>
              <div className="thread-menu-popover">
                <div><span>⌁</span><span>Accès</span><small>Privé · local</small></div>
                <button type="button" onClick={newThread}><span>＋</span><span>Nouveau thread</span></button>
                <button type="button" onClick={onOpenSetup}><span>⚙</span><span>Réglages du modèle</span></button>
              </div>
            </details>
          </div>
        </div>

        <div className="messages" aria-live="polite">
          <div className="conversation-column">
            {(projectReview || reviewError) && (
              <article className="project-review">
                <div>
                  <strong>Changements du projet</strong>
                  <button type="button" aria-label="Fermer les changements" onClick={() => { setProjectReview(null); setReviewError(null) }}>×</button>
                </div>
                {reviewError ? <p>{reviewError}</p> : projectReview && (
                  <>
                    <small>{projectReview.workspaceMode === 'worktree' ? 'Worktree Git isolé' : 'Dossier direct'}</small>
                    <pre>{projectReview.status || 'Aucun fichier modifié.'}</pre>
                    {projectReview.diff && <pre>{projectReview.diff}</pre>}
                  </>
                )}
              </article>
            )}
            {messages.length === 0 ? (
              <div className="empty-chat">
                <span className="agent-mark large">◒</span>
                <h2>Que voulez-vous construire ?</h2>
                <p>Local Agent travaille dans votre projet avec votre modèle Ollama.</p>
                <div className="prompt-suggestions">
                  <button type="button" onClick={() => setPrompt('Analyse ce projet et explique-moi sa structure.')}>Analyser le projet</button>
                  <button type="button" onClick={() => setPrompt('Trouve et corrige le problème principal de ce projet.')}>Corriger un problème</button>
                  <button type="button" onClick={() => setPrompt('Ajoute les tests manquants les plus importants.')}>Ajouter des tests</button>
                </div>
              </div>
            ) : messages.map((message) => (
              <article className={`message ${message.role} ${message.failed ? 'failed' : ''}`} key={message.id}>
                <span>{message.role === 'user' ? 'Vous' : 'Agent'}</span>
                <p>{message.content || (activeRequest === message.id ? 'Réflexion…' : '')}</p>
              </article>
            ))}
            {toolActivities.length > 0 && (
              <div className="tool-activities" aria-label="Activité des outils">
                {toolActivities.map((activity) => (
                  <div className={activity.status} key={activity.id}>
                    <span>{activity.status === 'running' ? '○' : activity.status === 'done' ? '✓' : '!'}</span>
                    <span>{TOOL_LABELS[activity.tool] ?? activity.tool}</span>
                    <small>{activity.status === 'running' ? 'en cours' : activity.status === 'done' ? 'terminé' : activity.status === 'denied' ? 'refusé' : 'erreur'}</small>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="composer-area">
          <form className="composer" onSubmit={(event) => { event.preventDefault(); void sendMessage() }}>
            <textarea
              aria-label="Votre demande"
              placeholder={effectiveModel ? 'Demandez à Local Agent…' : 'Installez d’abord un modèle local…'}
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault()
                  void sendMessage()
                }
              }}
              disabled={!effectiveModel || Boolean(activeRequest)}
            />
            <div className="composer-toolbar">
              <span>{project ? `◇ ${project.name}` : 'Aucun projet'}</span>
              {activeRequest ? (
                <button className="stop-button" type="button" onClick={() => void window.localAgent.cancelChat(activeRequest)}>Arrêter</button>
              ) : (
                <button type="submit" aria-label="Envoyer" disabled={!prompt.trim() || !effectiveModel}>↑</button>
              )}
            </div>
          </form>
          <small>Entrée pour envoyer · Maj + Entrée pour une nouvelle ligne</small>
        </div>
      </div>
    </section>
  )
}
