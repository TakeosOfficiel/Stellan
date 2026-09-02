import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  AgentRunSummary,
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
import { applyPortalEvent, type PortalUiState } from './portal-state'
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

type ContentEvent = Extract<ChatEvent, { type: 'content' }>

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

function TrashIcon(): React.JSX.Element {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /></svg>
}

function PencilIcon(): React.JSX.Element {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21.17 6.81a2.82 2.82 0 0 0-3.98-3.98L3.84 16.17a2 2 0 0 0-.5.83l-1.32 4.35a.5.5 0 0 0 .62.63L7 20.66a2 2 0 0 0 .83-.5zM15 5l4 4" /></svg>
}

function ArrowUpIcon(): React.JSX.Element {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 7-7 7 7M12 19V5" /></svg>
}

function OutlineIcon(): React.JSX.Element {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 5h.01M3 12h.01M3 19h.01M8 5h13M8 12h13M8 19h13" /></svg>
}

function ArrowDownIcon(): React.JSX.Element {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14m7-7-7 7-7-7" /></svg>
}

function StopIcon(): React.JSX.Element {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="5" width="14" height="14" rx="2" /></svg>
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
  const [runHistoryByThread, setRunHistoryByThread] = useState<Record<string, AgentRunSummary[]>>({})
  const [runHistoryOpen, setRunHistoryOpen] = useState(false)
  const [showScrollToBottom, setShowScrollToBottom] = useState(false)
  const [editingRequestId, setEditingRequestId] = useState<string | null>(null)
  const [editingContent, setEditingContent] = useState('')
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
  const [portalPanelOpen, setPortalPanelOpen] = useState(false)
  const [portalPort, setPortalPort] = useState('3000')
  const [portalsByThread, setPortalsByThread] = useState<PortalUiState>({})
  const composerRef = useRef<HTMLTextAreaElement>(null)
  const newThreadButtonRef = useRef<HTMLButtonElement>(null)
  const projectSwitcherRef = useRef<HTMLButtonElement>(null)
  const workerTriggerRef = useRef<HTMLButtonElement>(null)
  const workerCloseRef = useRef<HTMLButtonElement>(null)
  const workerPanelRef = useRef<HTMLElement>(null)
  const portalTriggerRef = useRef<HTMLButtonElement>(null)
  const portalCloseRef = useRef<HTMLButtonElement>(null)
  const portalPanelRef = useRef<HTMLElement>(null)
  const threadMenuButtonRef = useRef<HTMLButtonElement>(null)
  const runHistoryTriggerRef = useRef<HTMLButtonElement>(null)
  const messagesScrollRef = useRef<HTMLDivElement>(null)
  const stickToBottomRef = useRef(true)
  const bufferedContentRef = useRef(new Map<string, ContentEvent>())
  const contentFrameRef = useRef<number | null>(null)
  const handledShortcutRef = useRef<typeof shortcut>(null)
  const messageKey = activeThreadId ?? '__draft__'
  const messages = messagesByThread[messageKey] ?? []
  const activeRun = activeThreadId ? runsByThread[activeThreadId] : undefined
  const activeRequest = activeRun?.requestId ?? null
  const activeRunHistory = activeThreadId ? runHistoryByThread[activeThreadId] ?? [] : []
  const queuedRuns = activeRunHistory.filter((run) => run.status === 'queued')
  const historyRuns = activeRunHistory.filter((run) => run.status !== 'queued')
  const toolActivities = activeThreadId ? toolsByThread[activeThreadId] ?? [] : []

  const effectiveModel = useMemo(() => {
    if (models.some((model) => model.name === selectedModel)) return selectedModel
    return models[0]?.name ?? ''
  }, [models, selectedModel])

  function contentEventKey(threadId: string, requestId: string): string {
    return `${threadId}:${requestId}`
  }

  function renderBufferedContent(): void {
    const chunks: ContentEvent[] = []
    for (const [key, event] of bufferedContentRef.current) {
      const characters = Array.from(event.content)
      const content = characters.slice(0, 2).join('')
      chunks.push({ ...event, content })
      if (characters.length <= 2) bufferedContentRef.current.delete(key)
      else bufferedContentRef.current.set(key, { ...event, content: characters.slice(2).join('') })
    }
    if (chunks.length > 0) {
      setMessagesByThread((current) => chunks.reduce(applyMessageEvent, current))
    }
    contentFrameRef.current = bufferedContentRef.current.size > 0
      ? requestAnimationFrame(renderBufferedContent)
      : null
  }

  function bufferContent(event: ContentEvent): void {
    const key = contentEventKey(event.threadId, event.requestId)
    const pending = bufferedContentRef.current.get(key)
    bufferedContentRef.current.set(key, {
      ...event,
      content: `${pending?.content ?? ''}${event.content}`
    })
    if (contentFrameRef.current === null) {
      contentFrameRef.current = requestAnimationFrame(renderBufferedContent)
    }
  }

  function flushBufferedContent(threadId: string, requestId: string): void {
    const key = contentEventKey(threadId, requestId)
    const pending = bufferedContentRef.current.get(key)
    if (!pending) return
    bufferedContentRef.current.delete(key)
    setMessagesByThread((current) => applyMessageEvent(current, pending))
  }

  useEffect(() => {
    void Promise.all([window.localAgent.listThreads(), window.localAgent.listActiveRuns()]).then(([storedThreads, runs]) => {
      setThreads(storedThreads)
      const representatives = new Map<string, (typeof runs)[number]>()
      for (const run of runs) {
        const current = representatives.get(run.threadId)
        if (!current || run.status === 'running') representatives.set(run.threadId, run)
      }
      setRunsByThread(Object.fromEntries([...representatives.values()].map((run) => [run.threadId, {
        requestId: run.requestId, status: run.status
      }])))
      void Promise.all(storedThreads.map(async (thread) => [
        thread.id,
        await window.localAgent.listThreadRuns(thread.id)
      ] as const)).then((entries) => setRunHistoryByThread(Object.fromEntries(entries)))
    })
  }, [])

  useEffect(() => {
    if (effectiveModel) localStorage.setItem('local-agent:model', effectiveModel)
  }, [effectiveModel])

  useEffect(() => () => {
    if (terminalThreadId) void window.localAgent.closeTerminal(terminalThreadId)
  }, [terminalThreadId])

  useEffect(() => () => {
    if (contentFrameRef.current !== null) cancelAnimationFrame(contentFrameRef.current)
  }, [])

  useEffect(() => {
    if (stickToBottomRef.current) {
      messagesScrollRef.current?.scrollTo({ top: messagesScrollRef.current.scrollHeight })
    }
  }, [messages, toolActivities])

  useEffect(() => {
    const handleEvent = (event: ChatEvent): void => {
      if (event.type === 'status') {
        setRunsByThread((current) => applyRunEvent(current, event))
        setMessagesByThread((current) => applyMessageEvent(current, event))
        void refreshRunHistory(event.threadId)
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
      if (event.type === 'started') {
        setMessagesByThread((current) => applyMessageEvent(current, event))
        return
      }
      if (event.type === 'content') {
        bufferContent(event)
        return
      }

      if (event.type === 'error') {
        flushBufferedContent(event.threadId, event.requestId)
        setMessagesByThread((current) => applyMessageEvent(current, event))
      }
      setRunsByThread((current) => applyRunEvent(current, event))
      void refreshRunHistory(event.threadId)
    }

    return window.localAgent.onChatEvent(handleEvent)
  }, [])

  useEffect(() => {
    if (workerPanelOpen) workerCloseRef.current?.focus()
  }, [workerPanelOpen])

  useEffect(() => {
    if (portalPanelOpen) portalCloseRef.current?.focus()
  }, [portalPanelOpen])

  useEffect(() => {
    const handleEscape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return

      if (workerPanelOpen) {
        event.preventDefault()
        closeWorkerPanel()
        return
      }

      if (portalPanelOpen) {
        event.preventDefault()
        closePortalPanel()
        return
      }

      if (threadMenuOpen) {
        event.preventDefault()
        setThreadMenuOpen(false)
        threadMenuButtonRef.current?.focus()
        return
      }

      if (runHistoryOpen) {
        event.preventDefault()
        setRunHistoryOpen(false)
        runHistoryTriggerRef.current?.focus()
      }
    }

    window.addEventListener('keydown', handleEscape)
    return () => window.removeEventListener('keydown', handleEscape)
  }, [portalPanelOpen, runHistoryOpen, threadMenuOpen, workerPanelOpen])

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

  function closePortalPanel(): void {
    setPortalPanelOpen(false)
    requestAnimationFrame(() => portalTriggerRef.current?.focus())
  }

  function storeRunHistory(threadId: string, runs: AgentRunSummary[]): void {
    setRunHistoryByThread((current) => ({ ...current, [threadId]: runs }))
    const representative = runs.find((run) => run.status === 'running')
      ?? runs.find((run) => run.status === 'queued')
    setRunsByThread((current) => {
      if (representative) {
        return { ...current, [threadId]: {
          requestId: representative.requestId,
          status: representative.status as 'queued' | 'running'
        } }
      }
      if (!current[threadId]) return current
      const next = { ...current }
      delete next[threadId]
      return next
    })
  }

  async function refreshRunHistory(threadId: string): Promise<void> {
    storeRunHistory(threadId, await window.localAgent.listThreadRuns(threadId))
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
    const [storedMessages, runHistory] = await Promise.all([
      window.localAgent.loadThreadMessages(thread.id),
      window.localAgent.listThreadRuns(thread.id)
    ])
    const active = runHistory.find((run) => run.status === 'running')
      ?? runHistory.find((run) => run.status === 'queued')
    stickToBottomRef.current = true
    setShowScrollToBottom(false)
    setActiveThreadId(thread.id)
    setRunHistoryOpen(false)
    setEditingRequestId(null)
    storeRunHistory(thread.id, runHistory)
    const ephemeral = active ? {
      requestId: active.requestId,
      status: active.status as 'queued' | 'running'
    } : undefined
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
        ...(ephemeral?.status === 'running' && !storedMessages.some((message) => message.id === ephemeral.requestId)
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
      if (thread.environmentStatus === 'active') {
        try {
          const portal = await window.localAgent.getPortal(thread.id)
          setPortalsByThread((current) => applyPortalEvent(current, portal
            ? { threadId: thread.id, type: 'ready', portal }
            : { threadId: thread.id, type: 'closed' }))
        } catch {
          setPortalsByThread((current) => applyPortalEvent(
            applyPortalEvent(current, { threadId: thread.id, type: 'closed' }),
            { threadId: thread.id, type: 'error', error: 'Impossible de lire l’état du portail local.' }
          ))
        }
      }
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
    stickToBottomRef.current = true
    setShowScrollToBottom(false)
    setActiveThreadId(null)
    setRunHistoryOpen(false)
    setEditingRequestId(null)
    setMessagesByThread((current) => ({ ...current, __draft__: [] }))
    setProjectReview(null)
    setReviewError(null)
    setPortalPanelOpen(false)
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
      setPortalsByThread((current) => {
        const next = { ...current }
        delete next[threadId]
        return next
      })
      if (activeThreadId === threadId) await newThread()
    } catch {
      setReviewError('Impossible de supprimer ce thread pendant son utilisation.')
    }
  }

  async function startPortal(): Promise<void> {
    if (!activeThreadId) return
    const port = Number(portalPort)
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      setPortalsByThread((current) => applyPortalEvent(current, {
        threadId: activeThreadId,
        type: 'error',
        error: 'Saisissez un port numérique entre 1 et 65535.'
      }))
      return
    }
    setPortalsByThread((current) => applyPortalEvent(current, { threadId: activeThreadId, type: 'starting' }))
    try {
      const portal = await window.localAgent.startPortal({ threadId: activeThreadId, port })
      setPortalsByThread((current) => applyPortalEvent(current, { threadId: activeThreadId, type: 'ready', portal }))
    } catch (error) {
      setPortalsByThread((current) => applyPortalEvent(current, {
        threadId: activeThreadId,
        type: 'error',
        error: error instanceof Error ? error.message : 'Le portail local n’a pas pu démarrer.'
      }))
    }
  }

  async function stopPortal(): Promise<void> {
    if (!activeThreadId) return
    setPortalsByThread((current) => applyPortalEvent(current, { threadId: activeThreadId, type: 'stopping' }))
    try {
      await window.localAgent.stopPortal(activeThreadId)
      setPortalsByThread((current) => applyPortalEvent(current, { threadId: activeThreadId, type: 'closed' }))
    } catch (error) {
      setPortalsByThread((current) => applyPortalEvent(current, {
        threadId: activeThreadId,
        type: 'error',
        error: error instanceof Error ? error.message : 'Le portail local n’a pas pu être arrêté.'
      }))
    }
  }

  async function usePortal(action: 'copy' | 'open'): Promise<void> {
    if (!activeThreadId) return
    try {
      if (action === 'copy') await window.localAgent.copyPortalUrl(activeThreadId)
      else await window.localAgent.openPortal(activeThreadId)
    } catch (error) {
      setPortalsByThread((current) => applyPortalEvent(current, {
        threadId: activeThreadId,
        type: 'error',
        error: error instanceof Error ? error.message : `Impossible ${action === 'copy' ? 'de copier' : 'd’ouvrir'} l’URL locale.`
      }))
    }
  }

  async function sendMessage(): Promise<void> {
    const content = prompt.trim()
    if (!content || !effectiveModel) return

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
    const history: ChatMessage[] = messages
      .filter((message) => !message.failed && message.content)
      .map(({ role, content: messageContent }) => ({ role, content: messageContent }))

    setPrompt('')
    setRunsByThread((current) => current[threadId]
      ? current
      : { ...current, [threadId]: { requestId, status: 'queued' } })
    if (!activeRequest) setToolsByThread((current) => ({ ...current, [threadId]: [] }))
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
      await refreshRunHistory(threadId)
    } catch {
      await refreshRunHistory(threadId)
    }
  }

  async function saveQueuedMessage(requestId: string): Promise<void> {
    await window.localAgent.updateQueuedMessage({ requestId, content: editingContent })
    setEditingRequestId(null)
    if (activeThreadId) await refreshRunHistory(activeThreadId)
  }

  async function deleteQueuedMessage(requestId: string): Promise<void> {
    await window.localAgent.deleteQueuedMessage(requestId)
    if (activeThreadId) await refreshRunHistory(activeThreadId)
  }

  async function sendQueuedMessageNow(requestId: string): Promise<void> {
    await window.localAgent.sendQueuedMessageNow(requestId)
    if (activeThreadId) await refreshRunHistory(activeThreadId)
  }

  const hasOllama = Boolean(status && status !== 'loading' && status.available)
  const activeThread = threads.find((thread) => thread.id === activeThreadId)
  const activePortal = activeThreadId ? portalsByThread[activeThreadId] : undefined

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
                ref={portalTriggerRef}
                className={`ghost-button portal-trigger ${activePortal?.status === 'ready' ? 'active' : ''}`}
                type="button"
                aria-haspopup="dialog"
                aria-expanded={portalPanelOpen}
                onClick={() => setPortalPanelOpen(true)}
              >
                <span aria-hidden="true">⌁</span> {activePortal?.status === 'ready' ? 'Portail LOCAL actif' : 'Portail local'}
              </button>
            )}
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

        <div
          ref={messagesScrollRef}
          className="messages"
          aria-live="polite"
          onScroll={(event) => {
            const element = event.currentTarget
            const awayFromBottom = element.scrollHeight - element.scrollTop - element.clientHeight > 72
            stickToBottomRef.current = !awayFromBottom
            setShowScrollToBottom(awayFromBottom)
          }}
        >
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
                <p>{message.content
                  ? message.role === 'assistant'
                    ? message.content.split(/\n{2,}/).map((paragraph, index) => (
                        <span className="message-paragraph" key={index}>{paragraph}</span>
                      ))
                    : message.content
                  : activeRequest === message.id
                    ? activeRun?.status === 'queued' ? 'En attente…' : 'Réflexion…'
                    : ''}</p>
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

        {activeThreadId && activeRunHistory.length > 0 && (
          <div className="run-history-area">
            {queuedRuns.length > 0 && (
              <section className="message-queue" aria-label="File d’attente des messages">
                {queuedRuns.map((run) => (
                  <article className="queued-message" key={run.requestId}>
                    {editingRequestId === run.requestId ? (
                      <div className="run-history-editor">
                        <textarea aria-label="Modifier le message en attente" value={editingContent} onChange={(event) => setEditingContent(event.target.value)} />
                        <button type="button" disabled={!editingContent.trim()} onClick={() => void saveQueuedMessage(run.requestId)}>Enregistrer</button>
                        <button type="button" onClick={() => setEditingRequestId(null)}>Annuler</button>
                      </div>
                    ) : (
                      <>
                        <p title={run.userContent}>{run.userContent}</p>
                        <div className="queued-message-actions">
                          <button type="button" aria-label="Supprimer le message en attente" title="Supprimer" onClick={() => void deleteQueuedMessage(run.requestId)}><TrashIcon /></button>
                          <button type="button" aria-label="Modifier le message en attente" title="Modifier" onClick={() => { setEditingRequestId(run.requestId); setEditingContent(run.userContent) }}><PencilIcon /></button>
                          <button className="send-now" type="button" aria-label="Envoyer ce message maintenant" title="Envoyer maintenant" onClick={() => void sendQueuedMessageNow(run.requestId)}><ArrowUpIcon /></button>
                        </div>
                      </>
                    )}
                  </article>
                ))}
              </section>
            )}
            <button
              ref={runHistoryTriggerRef}
              className="run-history-trigger"
              type="button"
              aria-expanded={runHistoryOpen}
              aria-controls="run-history-panel"
              aria-label="Afficher l’historique des messages"
              title="Historique"
              onClick={() => setRunHistoryOpen((open) => !open)}
            >
              <OutlineIcon />
              {queuedRuns.length > 0 && <strong>{queuedRuns.length}</strong>}
            </button>
            {showScrollToBottom && (
              <button
                className="scroll-to-bottom"
                type="button"
                aria-label="Aller aux nouveaux messages"
                title="Nouveaux messages"
                onClick={() => {
                  stickToBottomRef.current = true
                  setShowScrollToBottom(false)
                  messagesScrollRef.current?.scrollTo({ top: messagesScrollRef.current.scrollHeight, behavior: 'smooth' })
                }}
              ><ArrowDownIcon /></button>
            )}
            {runHistoryOpen && (
              <section id="run-history-panel" className="run-history-panel" aria-label="Historique des messages">
                {historyRuns.length === 0 && <p className="empty-run-history">Aucun message traité pour le moment.</p>}
                {historyRuns.map((run) => (
                  <article className={`run-history-item ${run.status}`} key={run.requestId}>
                    <div className="run-history-status">
                      <span aria-hidden="true">{run.status === 'running' ? '●' : run.status === 'completed' ? '✓' : '!'}</span>
                      <strong>{run.status === 'running' ? 'En cours' : run.status === 'completed' ? 'Terminé' : run.status === 'interrupted' ? 'Interrompu' : 'Erreur'}</strong>
                    </div>
                    <p>{run.userContent}</p>
                    {run.error && <small>{run.error}</small>}
                  </article>
                ))}
              </section>
            )}
          </div>
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
              disabled={!effectiveModel}
            />
            <div className="composer-toolbar">
              <span>{project ? `◇ ${project.name}` : 'Aucun projet'}</span>
              <div className="composer-actions">
                {activeRequest && !prompt.trim() ? (
                  <button className="stop-button" type="button" aria-label="Arrêter l’agent" title="Arrêter" onClick={() => void window.localAgent.cancelChat(activeRequest)}><StopIcon /></button>
                ) : (
                  <button type="submit" aria-label={activeRequest ? 'Ajouter à la file d’attente' : 'Envoyer'} disabled={!prompt.trim() || !effectiveModel}><ArrowUpIcon /></button>
                )}
              </div>
            </div>
          </form>
          <small>Entrée pour envoyer · Maj + Entrée pour une nouvelle ligne</small>
        </div>
      </div>

      {portalPanelOpen && activeThread?.projectPath && activeThread.environmentStatus === 'active' && (
        <div className="worker-panel-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) closePortalPanel()
        }}>
          <section
            ref={portalPanelRef}
            className="worker-panel portal-panel"
            role="dialog"
            aria-modal="true"
            aria-labelledby="portal-panel-title"
            onKeyDown={(event) => {
              if (event.key !== 'Tab') return
              const focusable = Array.from(portalPanelRef.current?.querySelectorAll<HTMLElement>(
                'button:not(:disabled), input:not(:disabled), [tabindex]:not([tabindex="-1"])'
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
              <div><p className="eyebrow">LOCAL UNIQUEMENT</p><h2 id="portal-panel-title">Portail de prévisualisation</h2></div>
              <button ref={portalCloseRef} type="button" aria-label="Fermer le portail" onClick={closePortalPanel}>×</button>
            </header>
            <p>Crée une URL temporaire accessible uniquement depuis cet ordinateur. Ce portail n’est ni public ni accessible depuis le réseau local.</p>

            {activePortal?.portal ? (
              <div className="portal-ready" role="status">
                <span>PRÊT · CIBLE 127.0.0.1/::1:{activePortal.portal.targetPort}</span>
                <code>{activePortal.portal.url}</code>
                <div>
                  <button type="button" onClick={() => void usePortal('copy')}>Copier l’URL</button>
                  <button type="button" onClick={() => void usePortal('open')}>Ouvrir</button>
                  <button className="portal-stop" type="button" disabled={activePortal.status === 'stopping'} onClick={() => void stopPortal()}>
                    {activePortal.status === 'stopping' ? 'Arrêt…' : 'Arrêter'}
                  </button>
                </div>
              </div>
            ) : (
              <form onSubmit={(event) => { event.preventDefault(); void startPortal() }}>
                <label>Port HTTP du projet
                  <input
                    type="number"
                    inputMode="numeric"
                    min="1"
                    max="65535"
                    step="1"
                    value={portalPort}
                    onChange={(event) => setPortalPort(event.target.value)}
                  />
                </label>
                <button type="submit" disabled={activePortal?.status === 'starting'}>
                  {activePortal?.status === 'starting' ? 'Vérification via le proxy…' : 'Démarrer le portail LOCAL'}
                </button>
              </form>
            )}

            {activePortal?.error && <p className="worker-error" role="alert">{activePortal.error}</p>}
            <div className="portal-public-disabled" aria-disabled="true">
              <span>Accès LAN et public</span>
              <strong>Indisponible</strong>
              <small>Ces modes resteront désactivés tant que l’application ne peut pas attribuer un processus au projet et appliquer des contrôles d’accès.</small>
            </div>
          </section>
        </div>
      )}

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
