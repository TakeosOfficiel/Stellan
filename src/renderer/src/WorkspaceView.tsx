import { useEffect, useMemo, useState } from 'react'
import type {
  ChatEvent,
  ChatMessage,
  OllamaStatus,
  ProjectSelection,
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
      if (event.type === 'tool') return
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
  }

  function newThread(): void {
    setActiveThreadId(null)
    setMessages([])
  }

  async function removeThread(threadId: string): Promise<void> {
    if (!await window.localAgent.deleteThread(threadId)) return
    setThreads((current) => current.filter((thread) => thread.id !== threadId))
    if (activeThreadId === threadId) newThread()
  }

  async function sendMessage(): Promise<void> {
    const content = prompt.trim()
    if (!content || !effectiveModel || activeRequest) return

    let threadId = activeThreadId
    if (!threadId) {
      const thread = await window.localAgent.createThread({
        title: content.length > 60 ? `${content.slice(0, 57)}…` : content,
        projectPath: project?.path ?? null,
        model: effectiveModel
      })
      threadId = thread.id
      setActiveThreadId(thread.id)
      setThreads((current) => [...current, thread])
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

  return (
    <section className="workspace-view">
      <aside className="workspace-sidebar">
        <div>
          <p className="eyebrow">ESPACE DE TRAVAIL</p>
          <h2>{project?.name ?? 'Aucun projet'}</h2>
          <p>{project?.path ?? 'Sélectionnez un dossier pour préparer les outils de code.'}</p>
          <button type="button" onClick={() => void chooseProject()}>
            {project ? 'Changer de projet' : 'Ouvrir un projet'}
          </button>
        </div>

        <div className="model-selector">
          <label htmlFor="active-model">Modèle actif</label>
          {models.length > 0 ? (
            <select
              id="active-model"
              value={effectiveModel}
              onChange={(event) => setSelectedModel(event.target.value)}
              disabled={Boolean(activeRequest)}
            >
              {models.map((model) => <option value={model.name} key={model.name}>{model.name}</option>)}
            </select>
          ) : (
            <button className="secondary-button" type="button" onClick={onOpenSetup}>
              Configurer un modèle
            </button>
          )}
        </div>

        <div className="thread-list">
          <div className="thread-list-heading">
            <span>Threads</span>
            <button type="button" onClick={newThread} aria-label="Nouveau thread">+</button>
          </div>
          {threads.map((thread) => (
            <div className={`thread-row ${activeThreadId === thread.id ? 'active' : ''}`} key={thread.id}>
              <button type="button" onClick={() => void openThread(thread)}>{thread.title}</button>
              <button type="button" aria-label={`Supprimer ${thread.title}`} onClick={() => void removeThread(thread.id)}>×</button>
            </div>
          ))}
        </div>

        <div className="runtime-summary">
          <span className={`status-dot ${hasOllama ? 'online' : 'offline'}`} />
          <span>{hasOllama ? 'Ollama connecté' : 'Ollama indisponible'}</span>
        </div>
      </aside>

      <div className="chat-panel">
        <div className="chat-header">
          <div><p className="eyebrow">THREAD LOCAL</p><h3>{threads.find((thread) => thread.id === activeThreadId)?.title ?? 'Nouvelle conversation'}</h3></div>
          {messages.length > 0 && !activeRequest && (
            <button className="ghost-button" type="button" onClick={newThread}>
              Nouveau
            </button>
          )}
        </div>

        <div className="messages" aria-live="polite">
          {messages.length === 0 ? (
            <div className="empty-chat">
              <span>⌁</span>
              <h3>Que voulez-vous construire ?</h3>
              <p>Choisissez un modèle local puis envoyez votre première demande.</p>
            </div>
          ) : messages.map((message) => (
            <article className={`message ${message.role} ${message.failed ? 'failed' : ''}`} key={message.id}>
              <span>{message.role === 'user' ? 'Vous' : 'Agent'}</span>
              <p>{message.content || (activeRequest === message.id ? 'Réflexion…' : '')}</p>
            </article>
          ))}
        </div>

        <form className="composer" onSubmit={(event) => { event.preventDefault(); void sendMessage() }}>
          <textarea
            aria-label="Votre demande"
            placeholder={effectiveModel ? 'Demandez une explication ou une modification…' : 'Installez d’abord un modèle local…'}
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
          {activeRequest ? (
            <button className="stop-button" type="button" onClick={() => void window.localAgent.cancelChat(activeRequest)}>
              Arrêter
            </button>
          ) : (
            <button type="submit" disabled={!prompt.trim() || !effectiveModel}>Envoyer</button>
          )}
        </form>
      </div>
    </section>
  )
}
