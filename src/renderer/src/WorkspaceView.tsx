import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  ChatEvent,
  ChatMessage,
  OllamaStatus,
  ProjectSelection,
  ProjectReview,
  RuntimeInfo,
  StoredThread,
  WorkerProfile
} from '../../shared/contracts'
import { TerminalPanel } from './TerminalPanel'
import {
  applyMessageEvent,
  applyRunEvent,
  type ChatUiMessage as UiMessage,
  type ThreadRunState
} from './worker-state'

type WorkspaceViewProps = {
  status: OllamaStatus | null | 'loading'
  runtime: RuntimeInfo | null
  shortcut: { type: 'new-thread' | 'open-project' } | null
  onShortcutHandled: () => void
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

export function WorkspaceView({
  status,
  runtime,
  shortcut,
  onShortcutHandled,
  onOpenSetup
}: WorkspaceViewProps): React.JSX.Element {
  const models = status && status !== 'loading' && status.available ? status.models : []
  const [selectedModel, setSelectedModel] = useState(() => localStorage.getItem('local-agent:model') ?? '')
  const [project, setProject] = useState<ProjectSelection | null>(null)
  const [threads, setThreads] = useState<StoredThread[]>([])
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null)
  const [messagesByThread, setMessagesByThread] = useState<Record<string, UiMessage[]>>({})
  const [prompt, setPrompt] = useState('')
  const [runsByThread, setRunsByThread] = useState<ThreadRunState>({})
  const [toolsByThread, setToolsByThread] = useState<Record<string, ToolActivity[]>>({})
  const [projectReview, setProjectReview] = useState<ProjectReview | null>(null)
  const [reviewError, setReviewError] = useState<string | null>(null)
  const [workerProfile, setWorkerProfile] = useState<WorkerProfile | null>(null)
  const [workerDraft, setWorkerDraft] = useState<WorkerProfile | null>(null)
  const [workerPanelOpen, setWorkerPanelOpen] = useState(false)
  const [threadMenuOpen, setThreadMenuOpen] = useState(false)
  const [workerError, setWorkerError] = useState<string | null>(null)
  const [savingWorker, setSavingWorker] = useState(false)
  const [terminalThreadId, setTerminalThreadId] = useState<string | null>(null)
  const [terminalError, setTerminalError] = useState<string | null>(null)
  const composerRef = useRef<HTMLTextAreaElement>(null)
  const newThreadButtonRef = useRef<HTMLButtonElement>(null)
  const projectSwitcherRef = useRef<HTMLButtonElement>(null)
  const workerTriggerRef = useRef<HTMLButtonElement>(null)
  const workerCloseRef = useRef<HTMLButtonElement>(null)
  const workerPanelRef = useRef<HTMLElement>(null)
  const threadMenuButtonRef = useRef<HTMLButtonElement>(null)
  const handledShortcutRef = useRef<typeof shortcut>(null)
  const messageKey = activeThreadId ?? '__draft__'
  const messages = messagesByThread[messageKey] ?? []
  const activeRun = activeThreadId ? runsByThread[activeThreadId] : undefined
  const activeRequest = activeRun?.requestId ?? null
  const toolActivities = activeThreadId ? toolsByThread[activeThreadId] ?? [] : []

  const effectiveModel = useMemo(() => {
    if (models.some((model) => model.name === selectedModel)) return selectedModel
    return models[0]?.name ?? ''
  }, [models, selectedModel])

  useEffect(() => {
    void Promise.all([window.localAgent.listThreads(), window.localAgent.listActiveRuns()]).then(([storedThreads, runs]) => {
      setThreads(storedThreads)
      setRunsByThread(Object.fromEntries(runs.map((run) => [run.threadId, {
        requestId: run.requestId,
        status: run.status
      }])))
    })
  }, [])

  useEffect(() => {
    if (effectiveModel) localStorage.setItem('local-agent:model', effectiveModel)
  }, [effectiveModel])

  useEffect(() => () => {
    if (terminalThreadId) void window.localAgent.closeTerminal(terminalThreadId)
  }, [terminalThreadId])

  useEffect(() => {
    const handleEvent = (event: ChatEvent): void => {
      if (event.type === 'status') {
        setRunsByThread((current) => applyRunEvent(current, event))
        setMessagesByThread((current) => applyMessageEvent(current, event))
        return
      }
      if (event.type === 'tool') {
        setToolsByThread((all) => {
          const current = all[event.threadId] ?? []
          const running = [...current].reverse().find(
            (activity) => activity.tool === event.tool && activity.status === 'running'
          )
          if (running && event.status !== 'running') {
            return { ...all, [event.threadId]: current.map((activity) => activity.id === running.id
              ? { ...activity, status: event.status }
              : activity) }
          }
          return { ...all, [event.threadId]: [...current, { id: crypto.randomUUID(), tool: event.tool, status: event.status }] }
        })
        return
      }
      if (event.type === 'content') {
        setMessagesByThread((current) => applyMessageEvent(current, event))
        return
      }

      if (event.type === 'error') {
        setMessagesByThread((current) => applyMessageEvent(current, event))
      }
      setRunsByThread((current) => applyRunEvent(current, event))
    }

    return window.localAgent.onChatEvent(handleEvent)
  }, [])

  useEffect(() => {
    if (workerPanelOpen) workerCloseRef.current?.focus()
  }, [workerPanelOpen])

  useEffect(() => {
    const handleEscape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return

      if (workerPanelOpen) {
        event.preventDefault()
        closeWorkerPanel()
        return
      }

      if (threadMenuOpen) {
        event.preventDefault()
        setThreadMenuOpen(false)
        threadMenuButtonRef.current?.focus()
      }
    }

    window.addEventListener('keydown', handleEscape)
    return () => window.removeEventListener('keydown', handleEscape)
  }, [threadMenuOpen, workerPanelOpen])

  useEffect(() => {
    if (!shortcut || handledShortcutRef.current === shortcut) return
    handledShortcutRef.current = shortcut
    if (shortcut.type === 'new-thread') newThread()
    else void chooseProject()
    onShortcutHandled()
  }, [shortcut])

  function focusComposer(): void {
    requestAnimationFrame(() => {
      if (composerRef.current && !composerRef.current.disabled) composerRef.current.focus()
      else newThreadButtonRef.current?.focus()
    })
  }

  function closeThreadMenu(): void {
    setThreadMenuOpen(false)
  }

  function closeWorkerPanel(): void {
    setWorkerPanelOpen(false)
    requestAnimationFrame(() => workerTriggerRef.current?.focus())
  }

  async function chooseProject(): Promise<void> {
    closeThreadMenu()
    const selection = await window.localAgent.selectProject()
    if (selection) {
      if (activeThreadId) await newThread()
      setProject(selection)
      const profile = await window.localAgent.getWorkerProfile(selection.path)
      setWorkerProfile(profile)
      setWorkerDraft(profile)
      focusComposer()
    } else {
      projectSwitcherRef.current?.focus()
    }
  }

  async function openThread(thread: StoredThread): Promise<void> {
    await closeTerminal()
    await window.localAgent.setActiveThread(thread.id)
    let storedMessages = await window.localAgent.loadThreadMessages(thread.id)
    const activeRuns = await window.localAgent.listActiveRuns()
    const active = activeRuns.find((run) => run.threadId === thread.id)
    if (!active) storedMessages = await window.localAgent.loadThreadMessages(thread.id)
    setActiveThreadId(thread.id)
    const ephemeral = active ? { requestId: active.requestId, status: active.status } : undefined
    setRunsByThread((current) => {
      if (ephemeral) return { ...current, [thread.id]: ephemeral }
      if (!current[thread.id]) return current
      const next = { ...current }
      delete next[thread.id]
      return next
    })
    setMessagesByThread((current) => {
      const ephemeralMessage = ephemeral
        ? current[thread.id]?.find((message) => message.id === ephemeral.requestId)
        : undefined
      return { ...current, [thread.id]: [
        ...storedMessages.map((message) => ({
          id: message.id,
          role: message.role,
          content: message.content
        })),
        ...(ephemeral && !storedMessages.some((message) => message.id === ephemeral.requestId)
          ? [ephemeralMessage ?? { id: ephemeral.requestId, role: 'assistant' as const, content: '' }]
          : [])
      ] }
    })
    setProject(thread.projectPath
      ? { path: thread.projectPath, name: projectName(thread.projectPath) }
      : null)
    if (thread.model) setSelectedModel(thread.model)
    setToolsByThread((current) => ({ ...current, [thread.id]: current[thread.id] ?? [] }))
    setProjectReview(null)
    setReviewError(null)
    if (thread.projectPath) {
      const profile = await window.localAgent.getWorkerProfile(thread.projectPath)
      setWorkerProfile(profile)
      setWorkerDraft(profile)
    } else {
      setWorkerProfile(null)
      setWorkerDraft(null)
    }
  }

  async function closeTerminal(): Promise<void> {
    const threadId = terminalThreadId
    setTerminalThreadId(null)
    if (!threadId) return
    try {
      await window.localAgent.closeTerminal(threadId)
    } catch (error) {
      setTerminalError(error instanceof Error
        ? `Le nettoyage du terminal a échoué : ${error.message}`
        : 'Le nettoyage du terminal a échoué.')
    }
  }

  async function newThread(): Promise<void> {
    closeThreadMenu()
    await closeTerminal()
    await window.localAgent.setActiveThread(null)
    setActiveThreadId(null)
    setMessagesByThread((current) => ({ ...current, __draft__: [] }))
    setProjectReview(null)
    setReviewError(null)
    focusComposer()
  }

  async function saveWorkerProfile(): Promise<void> {
    if (!workerDraft) return
    setSavingWorker(true)
    setWorkerError(null)
    try {
      const saved = await window.localAgent.saveWorkerProfile({
        projectPath: workerDraft.projectPath,
        mode: workerDraft.mode,
        runtime: workerDraft.mode === 'container' ? workerDraft.runtime : null,
        cpuLimit: workerDraft.cpuLimit,
        memoryMb: workerDraft.memoryMb,
        image: workerDraft.image,
        network: workerDraft.network,
        maxConcurrentWorkers: workerDraft.maxConcurrentWorkers
      })
      setWorkerProfile(saved)
      setWorkerDraft(saved)
      closeWorkerPanel()
    } catch (error) {
      setWorkerError(error instanceof Error ? error.message : 'Le profil worker n’a pas pu être enregistré.')
    } finally {
      setSavingWorker(false)
    }
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
      if (terminalThreadId === threadId) await closeTerminal()
      if (!await window.localAgent.deleteThread(threadId)) return
      setThreads((current) => current.filter((thread) => thread.id !== threadId))
      if (activeThreadId === threadId) await newThread()
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
        await window.localAgent.setActiveThread(thread.id)
        setMessagesByThread((current) => ({ ...current, [thread.id]: current.__draft__ ?? [] }))
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
    setMessagesByThread((current) => ({
      ...current,
      [threadId]: [...(current[threadId] ?? messages), userMessage, assistantMessage]
    }))
    setRunsByThread((current) => ({ ...current, [threadId]: { requestId, status: 'queued' } }))
    setToolsByThread((current) => ({ ...current, [threadId]: [] }))
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
      setMessagesByThread((current) => ({ ...current, [threadId]: (current[threadId] ?? []).map((message) =>
        message.id === requestId
          ? { ...message, content: 'Impossible de démarrer la conversation.', failed: true }
          : message
      ) }))
      setRunsByThread((current) => {
        const next = { ...current }
        delete next[threadId]
        return next
      })
    }
  }

  const hasOllama = Boolean(status && status !== 'loading' && status.available)
  const activeThread = threads.find((thread) => thread.id === activeThreadId)

  return (
    <section className="workspace-view">
      <nav className="app-rail" aria-label="Sections de Local Agent">
        <div className="rail-main">
          <button className="active" type="button" aria-label="Threads" title="Threads">⌁</button>
          <button type="button" aria-label="Projets" aria-keyshortcuts="Control+O Meta+O" title="Projets" onClick={() => void chooseProject()}>◇</button>
          <button type="button" aria-label="Nouveau thread" aria-keyshortcuts="Control+N Meta+N" title="Nouveau thread" onClick={newThread}>＋</button>
        </div>
        <button type="button" aria-label="Modèles et réglages" aria-keyshortcuts="Control+, Meta+," title="Modèles et réglages" onClick={onOpenSetup}>⚙</button>
      </nav>

      <aside className="workspace-sidebar">
        <button
          ref={projectSwitcherRef}
          className="project-switcher"
          type="button"
          aria-label={`Ouvrir un projet, sélection actuelle : ${project?.name ?? 'Tous les projets'}`}
          aria-keyshortcuts="Control+O Meta+O"
          onClick={() => void chooseProject()}
        >
          <span className="project-icon" aria-hidden="true">◇</span>
          <span>
            <small>ESPACE LOCAL</small>
            <strong>{project?.name ?? 'Tous les projets'}</strong>
          </span>
          <span aria-hidden="true">⌄</span>
        </button>

        <button ref={newThreadButtonRef} className="new-thread-button" type="button" aria-label="Nouveau thread" aria-keyshortcuts="Control+N Meta+N" onClick={newThread}>
          <span aria-hidden="true">＋</span> Nouveau thread
          <kbd>Ctrl/Cmd N</kbd>
        </button>

        {project && workerProfile && (
          <button
            ref={workerTriggerRef}
            className="worker-profile-summary"
            type="button"
            aria-haspopup="dialog"
            aria-expanded={workerPanelOpen}
            aria-label={`Configurer le profil worker de ${project.name}`}
            onClick={() => setWorkerPanelOpen(true)}
          >
            <span aria-hidden="true">◇</span>
            <span><small>WORKER DU PROJET</small><strong>{workerProfile.mode === 'container' ? workerProfile.runtime : 'Direct'}</strong></span>
            <span>{workerProfile.maxConcurrentWorkers}× · {workerProfile.cpuLimit} CPU · {Math.round(workerProfile.memoryMb / 1024)} Go</span>
          </button>
        )}

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
                <span className={`thread-agent ${runsByThread[thread.id]?.status ?? ''}`} aria-label={runsByThread[thread.id]
                  ? runsByThread[thread.id]?.status === 'queued' ? 'Worker en attente' : 'Worker en cours'
                  : undefined}>●</span>
                <button type="button" title={thread.title} onClick={() => void openThread(thread)}>{thread.title}</button>
                <button
                  className="thread-delete"
                  type="button"
                  aria-label={`Supprimer ${thread.title}`}
                  disabled={Boolean(runsByThread[thread.id])}
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
              >
                {models.map((model) => <option value={model.name} key={model.name}>{model.name}</option>)}
              </select>
            ) : (
              <button type="button" onClick={onOpenSetup}>Configurer un modèle</button>
            )}
          </div>
        </div>
      </aside>

      <div className={`chat-panel ${terminalThreadId ? 'terminal-open' : ''}`}>
        <div className="chat-header">
          <div className="thread-identity">
            <span>{project?.name ?? 'Local'}</span>
            <span aria-hidden="true">/</span>
            <h3>{activeThread?.title ?? 'Nouveau thread'}</h3>
          </div>
          <div className="chat-header-actions">
            {activeThread?.projectPath && activeThread.environmentStatus === 'active' && (
              <button
                className="ghost-button"
                type="button"
                aria-pressed={terminalThreadId === activeThread.id}
                onClick={() => {
                  if (terminalThreadId === activeThread.id) void closeTerminal()
                  else {
                    setTerminalError(null)
                    setTerminalThreadId(activeThread.id)
                  }
                }}
              >
                <span aria-hidden="true">›_</span> Terminal
              </button>
            )}
            {activeThread?.projectPath && !activeRequest && (
              <button className="ghost-button" type="button" onClick={() => void reviewProject()}>
                <span aria-hidden="true">±</span> Changements
              </button>
            )}
            <div className="thread-menu">
              <button
                ref={threadMenuButtonRef}
                className="thread-menu-trigger"
                type="button"
                aria-label="Options du thread"
                aria-expanded={threadMenuOpen}
                aria-controls="thread-menu-popover"
                onClick={() => setThreadMenuOpen((open) => !open)}
              >•••</button>
              {threadMenuOpen && <div id="thread-menu-popover" className="thread-menu-popover">
                <div><span aria-hidden="true">⌁</span><span>Accès</span><small>Privé · local</small></div>
                <button type="button" onClick={newThread}><span aria-hidden="true">＋</span><span>Nouveau thread</span></button>
                <button type="button" onClick={onOpenSetup}><span aria-hidden="true">⚙</span><span>Réglages du modèle</span></button>
              </div>}
            </div>
          </div>
        </div>

        <div className="messages" aria-live="polite">
          <div className="conversation-column">
            {terminalError && (
              <div className="terminal-error" role="alert">
                <span>{terminalError}</span>
                <button type="button" aria-label="Fermer l’erreur du terminal" onClick={() => setTerminalError(null)}>×</button>
              </div>
            )}
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
                <p>{message.content || (activeRequest === message.id ? (activeRun?.status === 'queued' ? 'En attente…' : 'Réflexion…') : '')}</p>
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

        {terminalThreadId && activeThread?.id === terminalThreadId && activeThread.projectPath && (
          <TerminalPanel
            threadId={terminalThreadId}
            projectName={projectName(activeThread.projectPath)}
            onClose={() => void closeTerminal()}
          />
        )}

        <div className="composer-area">
          <form className="composer" onSubmit={(event) => { event.preventDefault(); void sendMessage() }}>
            <textarea
              ref={composerRef}
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

      {workerPanelOpen && workerDraft && (
        <div className="worker-panel-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) closeWorkerPanel()
        }}>
          <section
            ref={workerPanelRef}
            className="worker-panel"
            role="dialog"
            aria-modal="true"
            aria-labelledby="worker-panel-title"
            onKeyDown={(event) => {
              if (event.key !== 'Tab') return
              const focusable = Array.from(workerPanelRef.current?.querySelectorAll<HTMLElement>(
                'button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])'
              ) ?? [])
              const first = focusable[0]
              const last = focusable.at(-1)
              if (!first || !last) return
              if (event.shiftKey && document.activeElement === first) {
                event.preventDefault()
                last.focus()
              } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault()
                first.focus()
              }
            }}
          >
            <header>
              <div><p className="eyebrow">PROJET · {project?.name}</p><h2 id="worker-panel-title">Profil du worker</h2></div>
              <button ref={workerCloseRef} type="button" aria-label="Fermer le profil du worker" onClick={closeWorkerPanel}>×</button>
            </header>
            <p>Ces limites s’appliquent aux commandes lancées par l’agent. Les fichiers restent dans le worktree Git du thread.</p>

            <label>Mode d’exécution
              <select value={workerDraft.mode} onChange={(event) => {
                const mode = event.target.value as WorkerProfile['mode']
                setWorkerDraft({
                  ...workerDraft,
                  mode,
                  runtime: mode === 'container' ? runtime?.recommendedContainerRuntime ?? null : null
                })
              }}>
                <option value="direct">Direct — processus natifs</option>
                <option value="container" disabled={!runtime?.recommendedContainerRuntime}>Conteneur isolé</option>
              </select>
            </label>

            {workerDraft.mode === 'container' && (
              <>
                <label>Runtime
                  <select value={workerDraft.runtime ?? ''} onChange={(event) => setWorkerDraft({
                    ...workerDraft,
                    runtime: event.target.value as 'docker' | 'podman'
                  })}>
                    <option value="docker" disabled={!runtime?.docker.available}>Docker</option>
                    <option value="podman" disabled={!runtime?.podman.available}>Podman</option>
                  </select>
                </label>
                <label>Image du worker
                  <input value={workerDraft.image} onChange={(event) => setWorkerDraft({ ...workerDraft, image: event.target.value })} />
                </label>
              </>
            )}

            <div className="worker-resource-grid">
              <label>CPU
                <input type="number" min="0.5" max="128" step="0.5" value={workerDraft.cpuLimit} onChange={(event) => setWorkerDraft({ ...workerDraft, cpuLimit: Number(event.target.value) })} />
              </label>
              <label>RAM (Mo)
                <input type="number" min="512" step="256" value={workerDraft.memoryMb} onChange={(event) => setWorkerDraft({ ...workerDraft, memoryMb: Number(event.target.value) })} />
              </label>
              <label>Workers simultanés
                <input type="number" min="1" max="32" step="1" value={workerDraft.maxConcurrentWorkers} onChange={(event) => setWorkerDraft({ ...workerDraft, maxConcurrentWorkers: Number(event.target.value) })} />
              </label>
            </div>

            {activeThread?.workspaceMode === 'direct' && workerDraft.maxConcurrentWorkers > 1 && (
              <p className="worker-warning">Ce thread partage le dossier du projet : les workers qui utilisent ce même dossier resteront sérialisés. Préférez les worktrees Git ; un conteneur seul n’isole pas encore les outils de fichiers.</p>
            )}

            {workerDraft.mode === 'container' && (
              <label>Réseau
                <select value={workerDraft.network} onChange={(event) => setWorkerDraft({ ...workerDraft, network: event.target.value as 'none' | 'bridge' })}>
                  <option value="none">Désactivé</option>
                  <option value="bridge">Autorisé</option>
                </select>
              </label>
            )}

            <div className="storage-limit-note"><span>Stockage</span><strong>Worktree sur le disque hôte</strong><small>Une limite dure arrivera avec les volumes workers gérés ; elle n’est pas simulée ici.</small></div>
            {workerError && <p className="worker-error" role="alert">{workerError}</p>}
            <footer>
              <button className="secondary-button" type="button" onClick={closeWorkerPanel}>Annuler</button>
              <button type="button" disabled={savingWorker || (workerDraft.mode === 'container' && !workerDraft.runtime)} onClick={() => void saveWorkerProfile()}>
                {savingWorker ? 'Enregistrement…' : 'Enregistrer le profil'}
              </button>
            </footer>
          </section>
        </div>
      )}
    </section>
  )
}
