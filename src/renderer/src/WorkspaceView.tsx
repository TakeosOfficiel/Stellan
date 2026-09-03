import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowDown,
  ArrowUp,
  Bot,
  Box,
  Check,
  ChevronDown,
  ChevronRight,
  Circle,
  CircleAlert,
  ExternalLink,
  FolderOpen,
  Import,
  ListTree,
  LockKeyhole,
  MessageSquare,
  MessageSquarePlus,
  Mic,
  MoreHorizontal,
  PanelLeft,
  PanelRight,
  Pencil,
  Plus,
  Settings2,
  SlidersHorizontal,
  Square,
  Trash2,
  X
} from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type {
  AgentRunSummary,
  ChatEvent,
  ChatMessage,
  DictationProgress,
  OllamaStatus,
  ProjectSelection,
  ProjectResourceSettings,
  StoredThread
} from '../../shared/contracts'
import { prepareWhisperAudio } from './dictation-audio'
import { WorkbenchPanel } from './WorkbenchPanel'
import {
  applyMessageEvent,
  applyRunEvent,
  type ChatUiMessage as UiMessage,
  type ThreadRunState
} from './worker-state'

type WorkspaceViewProps = {
  visible: boolean
  status: OllamaStatus | null | 'loading'
  shortcut: { type: 'new-thread' | 'open-project' } | null
  onShortcutHandled: () => void
  onOpenSetup: () => void
}

type ToolActivity = {
  id: string
  requestId: string
  tool: string
  status: 'running' | 'done' | 'denied' | 'error'
  input: string | null
  output: string | null
  expanded: boolean
}

type FileEditActivity = {
  path: string
  added: number
  removed: number
  active: boolean
  deleted: boolean
}

type ContentEvent = Extract<ChatEvent, { type: 'content' }>

const TOOL_LABELS: Record<string, string> = {
  list_files: 'Liste des fichiers',
  read_file: 'Lecture de fichier',
  search_files: 'Recherche dans le projet',
  write_file: 'Écriture de fichier',
  delete_file: 'Suppression de fichier',
  run_command: 'Commande locale',
  git_status: 'Statut Git',
  git_diff: 'Diff Git'
}

function parsedToolValue(value: string | null): unknown {
  if (!value) return null
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

function toolActivityLabel(activity: ToolActivity): React.JSX.Element {
  const input = parsedToolValue(activity.input) as Record<string, unknown> | null
  const output = parsedToolValue(activity.output)
  const path = typeof input?.path === 'string' ? input.path : ''
  const running = activity.status === 'running'
  if (activity.tool === 'list_files') {
    const count = Array.isArray(output) ? output.length : null
    return <>{running ? 'Exploration des fichiers…' : count === null ? 'Exploré les fichiers' : `Exploré ${count} fichier${count > 1 ? 's' : ''}`}</>
  }
  if (activity.tool === 'read_file') return <>{running ? 'Lecture de ' : 'Lu '}<code>{path}</code>{running ? '…' : ''}</>
  if (activity.tool === 'search_files') {
    const query = typeof input?.query === 'string' ? input.query : ''
    return <>{running ? 'Recherche dans le code' : 'Recherché dans le code'}{query && <> · <code>{query}</code></>}{running ? '…' : ''}</>
  }
  if (activity.tool === 'write_file') return <>{running ? 'Modification de ' : 'Modifié '}<code>{path}</code>{running ? '…' : ''}</>
  if (activity.tool === 'delete_file') return <>{running ? 'Suppression de ' : 'Supprimé '}<code>{path}</code>{running ? '…' : ''}</>
  if (activity.tool === 'run_command') {
    const command = [input?.command, ...(Array.isArray(input?.args) ? input.args : [])].filter((part) => typeof part === 'string').join(' ')
    return <>{running ? 'Exécution de ' : 'Exécuté '}<code>{command}</code>{running ? '…' : ''}</>
  }
  if (activity.tool === 'git_status') return <>{running ? 'Vérification de Git…' : 'Vérifié l’état Git'}</>
  if (activity.tool === 'git_diff') return <>{running ? 'Lecture des changements…' : 'Consulté les changements Git'}</>
  if (activity.tool === 'create_workers') {
    const tasks = Array.isArray(input?.tasks) ? input.tasks.length : null
    return <>{running ? 'Organisation des workers…' : `Coordonné${tasks ? ` ${tasks}` : ''} workers`}</>
  }
  if (activity.tool.startsWith('worker:')) return <>{running ? 'Worker en cours · ' : 'Worker terminé · '}{activity.tool.slice(7)}</>
  return <>{TOOL_LABELS[activity.tool] ?? activity.tool}{running ? '…' : ''}</>
}

function fileEditActivity(activity: ToolActivity): FileEditActivity | null {
  if (!['write_file', 'delete_file'].includes(activity.tool) || (activity.status !== 'done' && activity.status !== 'running')) return null
  const input = parsedToolValue(activity.input) as Record<string, unknown> | null
  const output = parsedToolValue(activity.output) as Record<string, unknown> | null
  if (
    typeof input?.path !== 'string' ||
    (activity.tool === 'write_file' && typeof input.content !== 'string')
  ) return null
  return {
    path: input.path,
    added: typeof output?.added === 'number' ? output.added : 0,
    removed: typeof output?.removed === 'number' ? output.removed : 0,
    active: activity.status === 'running',
    deleted: activity.tool === 'delete_file' && activity.status === 'done'
  }
}

function projectName(projectPath: string): string {
  return projectPath.split(/[\\/]/).filter(Boolean).at(-1) ?? projectPath
}

function MarkdownMessage({ content }: { content: string }): React.JSX.Element {
  return (
    <div className="message-markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer" />
        }}
      >{content}</ReactMarkdown>
    </div>
  )
}

type DictationCapture = {
  stream: MediaStream
  context: AudioContext
  source: MediaStreamAudioSourceNode
  processor: ScriptProcessorNode
  silentGain: GainNode
  chunks: Float32Array[]
  timeout: ReturnType<typeof setTimeout>
}

export function WorkspaceView({
  visible,
  status,
  shortcut,
  onShortcutHandled,
  onOpenSetup
}: WorkspaceViewProps): React.JSX.Element {
  const models = status && status !== 'loading' && status.available ? status.models : []
  const hasOllama = Boolean(status && status !== 'loading' && status.available)
  const [selectedModel, setSelectedModel] = useState(() => localStorage.getItem('local-agent:model') ?? '')
  const [project, setProject] = useState<ProjectSelection | null>(null)
  const [threads, setThreads] = useState<StoredThread[]>([])
  const [exportingProject, setExportingProject] = useState(false)
  const [exportProjectError, setExportProjectError] = useState<string | null>(null)
  const [resourceSettings, setResourceSettings] = useState<ProjectResourceSettings | null>(null)
  const [resourceError, setResourceError] = useState<string | null>(null)
  const [savingResources, setSavingResources] = useState(false)
  const [newProjectName, setNewProjectName] = useState<string | null>(null)
  const [creatingProject, setCreatingProject] = useState(false)
  const [createProjectError, setCreateProjectError] = useState<string | null>(null)
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
  const [fileReveal, setFileReveal] = useState<{ threadId: string; path: string; nonce: number } | null>(null)
  const [threadMenuOpen, setThreadMenuOpen] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [mobileWorkbenchOpen, setMobileWorkbenchOpen] = useState(false)
  const [thinkingElapsed, setThinkingElapsed] = useState(0)
  const [dictationState, setDictationState] = useState<'idle' | 'recording' | 'transcribing'>('idle')
  const [dictationProgress, setDictationProgress] = useState<DictationProgress | null>(null)
  const [dictationError, setDictationError] = useState<string | null>(null)
  const composerRef = useRef<HTMLTextAreaElement>(null)
  const dictationCaptureRef = useRef<DictationCapture | null>(null)
  const newThreadButtonRef = useRef<HTMLButtonElement>(null)
  const projectSwitcherRef = useRef<HTMLButtonElement>(null)
  const threadMenuButtonRef = useRef<HTMLButtonElement>(null)
  const runHistoryTriggerRef = useRef<HTMLButtonElement>(null)
  const dialogRef = useRef<HTMLElement>(null)
  const dialogTriggerRef = useRef<HTMLElement | null>(null)
  const messagesScrollRef = useRef<HTMLDivElement>(null)
  const stickToBottomRef = useRef(true)
  const bufferedContentRef = useRef(new Map<string, ContentEvent>())
  const contentFrameRef = useRef<number | null>(null)
  const warmedModelRef = useRef('')
  const handledShortcutRef = useRef<typeof shortcut>(null)
  const openThreadRequestRef = useRef(0)
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

  useEffect(() => {
    if (activeRun?.status !== 'running') {
      setThinkingElapsed(0)
      return
    }
    const startedAt = Date.now()
    setThinkingElapsed(0)
    const timer = setInterval(() => setThinkingElapsed(Math.floor((Date.now() - startedAt) / 1_000)), 1_000)
    return () => clearInterval(timer)
  }, [activeRequest, activeRun?.status])

  function contentEventKey(threadId: string, requestId: string): string {
    return `${threadId}:${requestId}`
  }

  function renderBufferedContent(): void {
    const chunks: ContentEvent[] = []
    for (const [key, event] of bufferedContentRef.current) {
      chunks.push(event)
      bufferedContentRef.current.delete(key)
    }
    if (chunks.length > 0) {
      setMessagesByThread((current) => chunks.reduce(applyMessageEvent, current))
    }
    contentFrameRef.current = null
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

  useEffect(() => {
    if (!effectiveModel || !hasOllama || warmedModelRef.current === effectiveModel) return
    warmedModelRef.current = effectiveModel
    void window.localAgent.warmModel(effectiveModel)
  }, [effectiveModel, hasOllama])

  useEffect(() => () => {
    if (contentFrameRef.current !== null) cancelAnimationFrame(contentFrameRef.current)
  }, [])

  useEffect(() => window.localAgent.onDictationProgress(setDictationProgress), [])

  useEffect(() => () => {
    const capture = dictationCaptureRef.current
    if (!capture) return
    clearTimeout(capture.timeout)
    capture.processor.disconnect()
    capture.source.disconnect()
    capture.silentGain.disconnect()
    capture.stream.getTracks().forEach((track) => track.stop())
    void capture.context.close()
  }, [])

  useEffect(() => {
    if (stickToBottomRef.current) {
      messagesScrollRef.current?.scrollTo({ top: messagesScrollRef.current.scrollHeight })
    }
  }, [messages, toolActivities])

  useEffect(() => {
    const handleEvent = (event: ChatEvent): void => {
      if (event.type === 'thread-created') {
        setThreads((current) => current.some((thread) => thread.id === event.child.id)
          ? current
          : [...current, event.child])
        setRunHistoryByThread((current) => ({ ...current, [event.child.id]: current[event.child.id] ?? [] }))
        return
      }
      if (event.type === 'status') {
        setRunsByThread((current) => applyRunEvent(current, event))
        setMessagesByThread((current) => applyMessageEvent(current, event))
        void refreshRunHistory(event.threadId)
        return
      }
      if (event.type === 'tool') {
        setToolsByThread((all) => {
          const current = all[event.threadId] ?? []
          const id = `${event.requestId}:${event.callId}`
          if (current.some((activity) => activity.id === id)) {
            return { ...all, [event.threadId]: current.map((activity) => activity.id === id
              ? {
                  ...activity,
                  status: event.status,
                  input: event.input ?? activity.input,
                  output: event.output ?? activity.output
                }
              : activity) }
          }
          return { ...all, [event.threadId]: [...current, {
            id,
            requestId: event.requestId,
            tool: event.tool,
            status: event.status,
            input: event.input,
            output: event.output,
            expanded: false
          }] }
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
    const handleEscape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return

      if (newProjectName !== null && !creatingProject) {
        event.preventDefault()
        setNewProjectName(null)
        return
      }

      if (resourceSettings && !savingResources) {
        event.preventDefault()
        setResourceSettings(null)
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
  }, [creatingProject, newProjectName, resourceSettings, runHistoryOpen, savingResources, threadMenuOpen])

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    const focusable = (): HTMLElement[] => Array.from(dialog.querySelectorAll<HTMLElement>(
      'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'
    ))
    const initialFocus = dialog.querySelector<HTMLElement>('[data-dialog-initial]') ?? focusable()[0]
    initialFocus?.focus()
    const trapFocus = (event: KeyboardEvent): void => {
      if (event.key !== 'Tab') return
      const elements = focusable()
      if (elements.length === 0) return
      const first = elements[0]!
      const last = elements[elements.length - 1]!
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    dialog.addEventListener('keydown', trapFocus)
    return () => {
      dialog.removeEventListener('keydown', trapFocus)
      dialogTriggerRef.current?.focus()
      dialogTriggerRef.current = null
    }
  }, [newProjectName !== null, resourceSettings !== null])

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

  async function createProjectThread(selection: ProjectSelection): Promise<void> {
    const thread = await window.localAgent.createThread({
      title: 'Nouveau thread',
      projectName: selection.name,
      projectPath: selection.path,
      model: effectiveModel || null
    })
    await window.localAgent.setActiveThread(thread.id)
    setThreads((current) => [...current, thread])
    setActiveThreadId(thread.id)
    setMessagesByThread((current) => ({ ...current, [thread.id]: [] }))
    setRunHistoryByThread((current) => ({ ...current, [thread.id]: [] }))
  }

  async function chooseProject(): Promise<void> {
    closeThreadMenu()
    const selection = await window.localAgent.selectProject()
    if (selection) {
      await createProjectThread(selection)
      setProject(selection)
      focusComposer()
    } else {
      projectSwitcherRef.current?.focus()
    }
  }

  async function createProject(): Promise<void> {
    const name = newProjectName?.trim()
    if (!name) return
    setCreatingProject(true)
    setCreateProjectError(null)
    try {
      const selection = await window.localAgent.createProject(name)
      await createProjectThread(selection)
      setProject(selection)
      setNewProjectName(null)
      focusComposer()
    } catch (error) {
      setCreateProjectError(error instanceof Error ? error.message : 'La création du projet a échoué.')
    } finally {
      setCreatingProject(false)
    }
  }

  async function openThread(thread: StoredThread): Promise<void> {
    const request = ++openThreadRequestRef.current
    const [storedMessages, runHistory] = await Promise.all([
      window.localAgent.loadThreadMessages(thread.id),
      window.localAgent.listThreadRuns(thread.id)
    ])
    if (request !== openThreadRequestRef.current) return
    await window.localAgent.setActiveThread(thread.id)
    if (request !== openThreadRequestRef.current) return
    const active = runHistory.find((run) => run.status === 'running')
      ?? runHistory.find((run) => run.status === 'queued')
    stickToBottomRef.current = true
    setShowScrollToBottom(false)
    setSidebarOpen(false)
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
      ? { path: thread.projectPath, name: thread.projectName ?? projectName(thread.projectPath) }
      : null)
    if (thread.model) setSelectedModel(thread.model)
    setToolsByThread((current) => ({ ...current, [thread.id]: current[thread.id] ?? [] }))
  }

  async function newThread(): Promise<void> {
    closeThreadMenu()
    if (!project) {
      dialogTriggerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
      setCreateProjectError(null)
      setNewProjectName('')
      return
    }
    await window.localAgent.setActiveThread(null)
    stickToBottomRef.current = true
    setShowScrollToBottom(false)
    setActiveThreadId(null)
    setRunHistoryOpen(false)
    setEditingRequestId(null)
    setMessagesByThread((current) => ({ ...current, __draft__: [] }))
    if (project) await createProjectThread(project)
    focusComposer()
  }

  async function removeThread(threadId: string): Promise<void> {
    try {
      if (!await window.localAgent.deleteThread(threadId)) return
      setThreads((current) => current.filter((thread) => thread.id !== threadId && thread.parentThreadId !== threadId))
      if (activeThreadId === threadId || threads.find((thread) => thread.id === activeThreadId)?.parentThreadId === threadId) await newThread()
    } catch { /* Le thread actif reste affiché. */ }
  }

  async function exportProject(): Promise<void> {
    if (!activeThread) return
    setExportProjectError(null)
    setExportingProject(true)
    try {
      await window.localAgent.exportThreadProject(activeThread.id)
    } catch (error) {
      setExportProjectError(error instanceof Error ? error.message : 'L’export du projet a échoué.')
    } finally {
      setExportingProject(false)
    }
  }

  async function openResources(): Promise<void> {
    if (!activeThread) return
    dialogTriggerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    setResourceError(null)
    try {
      setResourceSettings(await window.localAgent.getProjectResources(activeThread.id))
    } catch (error) {
      setResourceError(error instanceof Error ? error.message : 'Les ressources sont indisponibles.')
    }
  }

  async function saveResources(): Promise<void> {
    if (!activeThread || !resourceSettings) return
    setSavingResources(true)
    setResourceError(null)
    try {
      setResourceSettings(await window.localAgent.saveProjectResources({
        threadId: activeThread.id,
        cpuLimit: resourceSettings.cpuLimit,
        memoryMb: resourceSettings.memoryMb,
        storageGb: resourceSettings.storageGb,
        automaticCpuMemory: resourceSettings.automaticCpuMemory
      }))
      setResourceSettings(null)
    } catch (error) {
      setResourceError(error instanceof Error ? error.message : 'Les ressources n’ont pas été enregistrées.')
    } finally {
      setSavingResources(false)
    }
  }

  async function sendMessage(): Promise<void> {
    const content = prompt.trim()
    if (!project || !activeThreadId) {
      await chooseProject()
      return
    }
    if (!content || !effectiveModel) return

    let threadId = activeThreadId
    if (!threadId) {
      try {
        const thread = await window.localAgent.createThread({
          title: content.length > 60 ? `${content.slice(0, 57)}…` : content,
          projectName: project.name,
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
              ? `Tu es Stellan, un agent de développement local. Le projet sélectionné est ${project.name}.`
              : 'Tu es Stellan, un assistant local utile, précis et concis. Aucun projet n’est ouvert. Si une demande nécessite de créer ou modifier des fichiers, demande d’abord à l’utilisateur d’ouvrir un projet et ne présente jamais du code collé dans le chat comme une modification réellement effectuée.'
          },
          ...history,
          { role: 'user', content }
        ]
      })
      setThreads((current) => current.map((thread) =>
        thread.id === threadId && thread.title === 'Nouveau thread'
          ? { ...thread, title: content.length > 60 ? `${content.slice(0, 57)}…` : content }
          : thread
      ))
      await refreshRunHistory(threadId)
    } catch {
      await refreshRunHistory(threadId)
    }
  }

  async function startDictation(): Promise<void> {
    if (!project || !activeThreadId || !effectiveModel || dictationState !== 'idle') return
    setDictationError(null)
    setDictationProgress(null)
    let stream: MediaStream | null = null
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
        video: false
      })
      const context = new AudioContext()
      const source = context.createMediaStreamSource(stream)
      const processor = context.createScriptProcessor(4096, 1, 1)
      const silentGain = context.createGain()
      const capture: DictationCapture = {
        stream,
        context,
        source,
        processor,
        silentGain,
        chunks: [],
        timeout: setTimeout(() => void stopDictation(), 60_000)
      }
      processor.onaudioprocess = (event) => {
        const chunk = new Float32Array(event.inputBuffer.getChannelData(0))
        capture.chunks.push(chunk)
      }
      silentGain.gain.value = 0
      source.connect(processor)
      processor.connect(silentGain)
      silentGain.connect(context.destination)
      dictationCaptureRef.current = capture
      await context.resume()
      setDictationState('recording')
    } catch (error) {
      stream?.getTracks().forEach((track) => track.stop())
      setDictationError(error instanceof Error ? error.message : 'Le microphone est indisponible.')
      setDictationState('idle')
    }
  }

  async function stopDictation(): Promise<void> {
    const capture = dictationCaptureRef.current
    if (!capture) return
    dictationCaptureRef.current = null
    clearTimeout(capture.timeout)
    capture.processor.onaudioprocess = null
    capture.processor.disconnect()
    capture.source.disconnect()
    capture.silentGain.disconnect()
    capture.stream.getTracks().forEach((track) => track.stop())
    await capture.context.close()
    setDictationState('transcribing')
    try {
      const transcript = await window.localAgent.transcribeDictation(
        prepareWhisperAudio(capture.chunks, capture.context.sampleRate)
      )
      if (transcript) setPrompt((current) => `${current}${current && !/\s$/.test(current) ? ' ' : ''}${transcript}`)
      focusComposer()
    } catch (error) {
      setDictationError(error instanceof Error ? error.message : 'La transcription locale a échoué.')
    } finally {
      setDictationProgress(null)
      setDictationState('idle')
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

  function renderToolActivities(activities: ToolActivity[]): React.JSX.Element | null {
    if (activities.length === 0) return null
    const fileEdits = activities
      .map(fileEditActivity)
      .filter((edit): edit is FileEditActivity => edit !== null)
      .reduce<FileEditActivity[]>((files, edit) => {
        const existing = files.find((file) => file.path === edit.path)
        if (!existing) return [...files, edit]
        existing.added += edit.added
        existing.removed += edit.removed
        existing.active ||= edit.active
        existing.deleted ||= edit.deleted
        return files
      }, [])
    const fileEditsExpanded = activities.some((activity) => fileEditActivity(activity)?.path && activity.expanded)
    const activeFileEdits = fileEdits.filter((edit) => edit.active).length
    const linesAdded = fileEdits.reduce((total, edit) => total + edit.added, 0)
    const linesRemoved = fileEdits.reduce((total, edit) => total + edit.removed, 0)
    const activityIds = new Set(activities.map((activity) => activity.id))

    return (
      <div className="tool-activities" aria-label="Activité des outils">
        {activities.filter((activity) => !fileEditActivity(activity)).map((activity) => (
          <article className={`tool-activity ${activity.status} ${activity.expanded ? 'expanded' : ''}`} key={activity.id}>
            <button
              type="button"
              aria-expanded={activity.expanded}
              onClick={() => setToolsByThread((all) => ({
                ...all,
                [messageKey]: (all[messageKey] ?? []).map((item) => item.id === activity.id
                  ? { ...item, expanded: !item.expanded }
                  : item)
              }))}
            >
              <span>{toolActivityLabel(activity)}</span>
              {activity.status === 'denied' && <small>refusé</small>}
              {activity.status === 'error' && <small>erreur</small>}
              <ChevronRight className="tool-activity-arrow" aria-hidden="true" />
            </button>
            {activity.expanded && (
              <div className="tool-activity-details">
                {activity.input && <section><strong>Action</strong><pre>{activity.input}</pre></section>}
                {activity.output && <section><strong>Résultat</strong><pre>{activity.output}</pre></section>}
                {!activity.output && activity.status === 'running' && <span>Action en cours…</span>}
              </div>
            )}
          </article>
        ))}
        {fileEdits.length > 0 && (
          <article className={`tool-activity tool-edit-summary ${activeFileEdits ? 'running' : 'done'} ${fileEditsExpanded ? 'expanded' : ''}`}>
            <button
              type="button"
              aria-expanded={fileEditsExpanded}
              onClick={() => setToolsByThread((all) => ({
                ...all,
                [messageKey]: (all[messageKey] ?? []).map((item) => activityIds.has(item.id) && fileEditActivity(item)
                  ? { ...item, expanded: !fileEditsExpanded }
                  : item)
              }))}
            >
              <span>{activeFileEdits ? 'Modification de' : 'Mis à jour'} {fileEdits.length} fichier{fileEdits.length > 1 ? 's' : ''} <strong className="added">+{linesAdded}</strong> <strong className="removed">-{linesRemoved}</strong>{activeFileEdits > 0 && <small>, {activeFileEdits} actif{activeFileEdits > 1 ? 's' : ''}</small>}</span>
              <span />
              <ChevronRight className="tool-activity-arrow" aria-hidden="true" />
            </button>
            {fileEditsExpanded && (
              <div className="tool-activity-details edit-details">
                {fileEdits.map((edit) => (
                  <div className="edit-file-row" key={edit.path}>
                    <button type="button" disabled={edit.deleted} title={edit.deleted ? undefined : 'Afficher dans Files'} onClick={() => !edit.deleted && activeThreadId && setFileReveal((current) => ({ threadId: activeThreadId, path: edit.path, nonce: (current?.nonce ?? 0) + 1 }))}>
                      <span>{edit.active ? 'Modification de ' : edit.deleted ? 'Supprimé ' : 'Mis à jour '}<code>{edit.path}</code></span>
                      {!edit.active && <span><strong className="added">+{edit.added}</strong> <strong className="removed">-{edit.removed}</strong></span>}
                    </button>
                    {!edit.deleted && <button type="button" className="edit-file-open" aria-label={`Ouvrir ${edit.path}`} title="Ouvrir avec l’application associée" onClick={() => activeThreadId && void window.localAgent.openProjectFile({ threadId: activeThreadId, path: edit.path })}><ExternalLink aria-hidden="true" /></button>}
                  </div>
                ))}
              </div>
            )}
          </article>
        )}
      </div>
    )
  }

  const activeThread = threads.find((thread) => thread.id === activeThreadId)
  const rootThreads = threads.filter((thread) => !thread.parentThreadId || !threads.some((candidate) => candidate.id === thread.parentThreadId))
  const workbenchRefreshKey = activeRunHistory.map((run) => `${run.requestId}:${run.status}:${run.finishedAt ?? ''}`).join('|')

  return (
    <section
      className={`workspace-view${mobileWorkbenchOpen ? ' show-mobile-workbench' : ''}${visible ? '' : ' app-view-hidden'}`}
      aria-hidden={!visible}
    >
      <nav className="app-rail" aria-label="Sections de Stellan">
        <div className="rail-main">
          <button
            className="active"
            type="button"
            aria-label="Threads"
            aria-expanded={sidebarOpen}
            title="Threads"
            onClick={() => setSidebarOpen((open) => !open)}
          ><PanelLeft aria-hidden="true" /></button>
          <button type="button" aria-label="Importer un projet" aria-keyshortcuts="Control+O Meta+O" title="Importer un projet" onClick={() => void chooseProject()}><Import aria-hidden="true" /></button>
          <button type="button" aria-label="Nouveau thread" aria-keyshortcuts="Control+N Meta+N" title="Nouveau thread" onClick={newThread}><MessageSquarePlus aria-hidden="true" /></button>
          <button
            className="mobile-workbench-toggle"
            type="button"
            aria-label={mobileWorkbenchOpen ? 'Afficher la conversation' : 'Afficher les outils du projet'}
            aria-pressed={mobileWorkbenchOpen}
            title={mobileWorkbenchOpen ? 'Conversation' : 'Outils du projet'}
            onClick={() => setMobileWorkbenchOpen((open) => !open)}
          >{mobileWorkbenchOpen ? <MessageSquare aria-hidden="true" /> : <PanelRight aria-hidden="true" />}</button>
        </div>
        <button type="button" aria-label="Modèles et réglages" aria-keyshortcuts="Control+, Meta+," title="Modèles et réglages" onClick={onOpenSetup}><Settings2 aria-hidden="true" /></button>
      </nav>

      <aside className={`workspace-sidebar${sidebarOpen ? ' open' : ''}`}>
        <button
          ref={projectSwitcherRef}
          className="project-switcher"
          type="button"
          aria-label={`Ouvrir un projet, sélection actuelle : ${project?.name ?? 'Tous les projets'}`}
          aria-keyshortcuts="Control+O Meta+O"
          onClick={() => void chooseProject()}
        >
          <span className="project-icon" aria-hidden="true"><Box /></span>
          <span>
            <small>ESPACE LOCAL</small>
            <strong>{project?.name ?? 'Tous les projets'}</strong>
          </span>
          <ChevronDown aria-hidden="true" />
        </button>

        <button ref={newThreadButtonRef} className="new-thread-button" type="button" aria-label="Nouveau thread" aria-keyshortcuts="Control+N Meta+N" onClick={newThread}>
          <Plus aria-hidden="true" /> Nouveau thread
          <kbd>Ctrl/Cmd N</kbd>
        </button>

        <div className="thread-list">
          <div className="thread-group-heading">
            <span className="agent-mark"><Bot aria-hidden="true" /></span>
            <strong>Agent de programmation</strong>
            <span>{threads.length}</span>
          </div>
          <div className="thread-tree">
            {threads.length === 0 && <p>Aucun thread pour le moment</p>}
            {rootThreads.map((thread) => (
              <div className="thread-family" key={thread.id}>
                <div className={`thread-row ${activeThreadId === thread.id ? 'active' : ''}`}>
                  <span className="branch" aria-hidden="true" />
                  <span className={`thread-agent ${runsByThread[thread.id]?.status ?? ''}`} aria-label={runsByThread[thread.id]
                    ? runsByThread[thread.id]?.status === 'queued' ? 'Worker en attente' : 'Worker en cours'
                    : 'Worker inactif'}><Circle aria-hidden="true" /></span>
                  <button type="button" title={thread.title} onClick={() => { setMobileWorkbenchOpen(false); void openThread(thread) }}>{thread.title}</button>
                  <button
                    className="thread-delete"
                    type="button"
                    aria-label={`Supprimer ${thread.title}`}
                    disabled={Boolean(runsByThread[thread.id])}
                    onClick={() => void removeThread(thread.id)}
                  ><X aria-hidden="true" /></button>
                </div>
                {threads.filter((child) => child.parentThreadId === thread.id).map((child, childIndex, children) => (
                  <div className={`thread-row child ${activeThreadId === child.id ? 'active' : ''}`} key={child.id}>
                    <span className={`branch${childIndex === children.length - 1 ? ' last' : ''}`} aria-hidden="true" />
                    <span className={`thread-agent ${runsByThread[child.id]?.status ?? ''}`} aria-label={runsByThread[child.id]
                      ? runsByThread[child.id]?.status === 'queued' ? 'Worker en attente' : 'Worker en cours'
                      : 'Worker terminé'}><Circle aria-hidden="true" /></span>
                    <button type="button" title={child.title} onClick={() => { setMobileWorkbenchOpen(false); void openThread(child) }}>{child.title}</button>
                    <button className="thread-delete" type="button" aria-label={`Supprimer ${child.title}`} disabled={Boolean(runsByThread[child.id])} onClick={() => void removeThread(child.id)}><X aria-hidden="true" /></button>
                  </div>
                ))}
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
              <small>{activeThread.workspaceMode === 'worktree' ? 'Projet privé · ressources isolées' : 'Dossier direct confirmé'}</small>
            )}
          </div>

          {activeThread?.workspaceMode === 'worktree' && (
            <>
              <button className="resource-project-button" type="button" onClick={() => void openResources()}>
                <SlidersHorizontal aria-hidden="true" /> Ressources du projet
              </button>
              <button className="export-project-button" type="button" disabled={exportingProject} onClick={() => void exportProject()}>
                <ExternalLink aria-hidden="true" /> {exportingProject ? 'Export en cours…' : 'Exporter ce projet'}
              </button>
              {exportProjectError && <small className="export-project-error" role="alert">{exportProjectError}</small>}
            </>
          )}

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

      {newProjectName !== null && (
        <div className="dialog-backdrop project-create-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget && !creatingProject) setNewProjectName(null)
        }}>
          <section ref={dialogRef} className="dialog-surface project-create-dialog" role="dialog" aria-modal="true" aria-labelledby="project-create-title">
            <form className="project-create-form" onSubmit={(event) => { event.preventDefault(); void createProject() }}>
            <header>
              <div><small>NOUVEL ESPACE PRIVÉ</small><h2 id="project-create-title">Créer un projet</h2></div>
              <button className="icon-button" type="button" aria-label="Fermer" disabled={creatingProject} onClick={() => setNewProjectName(null)}><X aria-hidden="true" /></button>
            </header>
            <p>Le projet sera créé directement dans l’environnement isolé. Aucun dossier Windows ne doit être choisi.</p>
            <label>Nom du projet<input data-dialog-initial maxLength={100} value={newProjectName} onChange={(event) => setNewProjectName(event.target.value)} placeholder="Mon projet" /></label>
            {createProjectError && <p className="resource-error" role="alert">{createProjectError}</p>}
            <footer><button type="button" disabled={creatingProject} onClick={() => setNewProjectName(null)}>Annuler</button><button type="submit" disabled={creatingProject || !newProjectName.trim()}>{creatingProject ? 'Création…' : 'Créer'}</button></footer>
            </form>
          </section>
        </div>
      )}

      {resourceSettings && (
        <div className="dialog-backdrop resource-dialog-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget && !savingResources) setResourceSettings(null)
        }}>
          <section ref={dialogRef} className="dialog-surface resource-dialog" role="dialog" aria-modal="true" aria-labelledby="resource-title">
            <header>
              <div><small>PROJET PRIVÉ</small><h2 id="resource-title">Ressources</h2></div>
              <button className="icon-button" type="button" aria-label="Fermer" disabled={savingResources} onClick={() => setResourceSettings(null)}><X aria-hidden="true" /></button>
            </header>
            <label className="resource-auto">
              <input type="checkbox" checked={resourceSettings.automaticCpuMemory} onChange={(event) => setResourceSettings({
                ...resourceSettings, automaticCpuMemory: event.target.checked
              })} />
              CPU et RAM automatiques
            </label>
            <div className="resource-grid">
              <label>CPU <input type="number" min="1" max={resourceSettings.maxCpu} disabled={resourceSettings.automaticCpuMemory} value={resourceSettings.cpuLimit} onChange={(event) => setResourceSettings({ ...resourceSettings, cpuLimit: Number(event.target.value) })} /><small>Maximum : {resourceSettings.maxCpu}</small></label>
              <label>RAM (Go) <input type="number" min="1" max={Math.floor(resourceSettings.maxMemoryMb / 1024)} disabled={resourceSettings.automaticCpuMemory} value={Math.round(resourceSettings.memoryMb / 1024)} onChange={(event) => setResourceSettings({ ...resourceSettings, memoryMb: Number(event.target.value) * 1024 })} /><small>Maximum sûr : {Math.floor(resourceSettings.maxMemoryMb / 1024)} Go</small></label>
              <label>Stockage (Go) <input type="number" min={resourceSettings.storageGb} max={resourceSettings.maxStorageGb} value={resourceSettings.storageGb} onChange={(event) => setResourceSettings({ ...resourceSettings, storageGb: Number(event.target.value) })} /><small>Extensible jusqu’à {resourceSettings.maxStorageGb} Go sur ce volume</small></label>
            </div>
            <p>Le stockage peut être agrandi, mais pas réduit afin d’éviter toute corruption.</p>
            {resourceError && <p className="resource-error" role="alert">{resourceError}</p>}
            <footer><button type="button" disabled={savingResources} onClick={() => setResourceSettings(null)}>Annuler</button><button type="button" disabled={savingResources} onClick={() => void saveResources()}>{savingResources ? 'Application…' : 'Appliquer'}</button></footer>
          </section>
        </div>
      )}

      <div className="chat-panel">
        <div className="chat-header">
          <div className="thread-identity">
            <span>{project?.name ?? 'Local'}</span>
            <span aria-hidden="true">/</span>
            <h2>{activeThread?.title ?? 'Nouveau thread'}</h2>
          </div>
          <div className="chat-header-actions">
            <div className="thread-menu">
              <button
                ref={threadMenuButtonRef}
                className="thread-menu-trigger"
                type="button"
                aria-label="Options du thread"
                aria-expanded={threadMenuOpen}
                aria-haspopup="menu"
                aria-controls="thread-menu-popover"
                onClick={() => setThreadMenuOpen((open) => !open)}
              ><MoreHorizontal aria-hidden="true" /></button>
              {threadMenuOpen && <div id="thread-menu-popover" className="thread-menu-popover" role="menu">
                <div role="status"><LockKeyhole aria-hidden="true" /><span>Accès</span><small>Privé · local</small></div>
                <button type="button" role="menuitem" onClick={newThread}><Plus aria-hidden="true" /><span>Nouveau thread</span></button>
                <button type="button" role="menuitem" onClick={onOpenSetup}><Settings2 aria-hidden="true" /><span>Réglages du modèle</span></button>
              </div>}
            </div>
          </div>
        </div>

        <div
          ref={messagesScrollRef}
          className="messages"
          aria-label="Conversation"
          onScroll={(event) => {
            const element = event.currentTarget
            const awayFromBottom = element.scrollHeight - element.scrollTop - element.clientHeight > 72
            stickToBottomRef.current = !awayFromBottom
            setShowScrollToBottom(awayFromBottom)
          }}
        >
          <div className="conversation-column">
            {messages.length === 0 ? (
              <div className="empty-chat">
                <span className="agent-mark large"><Bot aria-hidden="true" /></span>
                <h2>{project ? 'Que voulez-vous construire ?' : 'Ouvrez d’abord un projet'}</h2>
                <p>{project ? 'Stellan travaille dans votre projet avec votre modèle Ollama.' : 'Créez un espace privé ou importez un dossier existant.'}</p>
                {project ? (
                  <div className="prompt-suggestions">
                    <button type="button" onClick={() => setPrompt('Analyse ce projet et explique-moi sa structure.')}>Analyser le projet</button>
                    <button type="button" onClick={() => setPrompt('Trouve et corrige le problème principal de ce projet.')}>Corriger un problème</button>
                    <button type="button" onClick={() => setPrompt('Ajoute les tests manquants les plus importants.')}>Ajouter des tests</button>
                  </div>
                ) : <div className="empty-project-actions"><button className="empty-project-button" type="button" onClick={(event) => { dialogTriggerRef.current = event.currentTarget; setNewProjectName('') }}><Plus aria-hidden="true" /> Créer un projet</button><button className="empty-project-button secondary" type="button" onClick={() => void chooseProject()}><FolderOpen aria-hidden="true" /> Importer un dossier</button></div>}
              </div>
            ) : messages.map((message) => {
              const requestActivities = message.role === 'assistant'
                ? toolActivities.filter((activity) => activity.requestId === message.id)
                : []
              return (
                <article className={`message ${message.role} ${message.failed ? 'failed' : ''}`} key={message.id}>
                  <span>{message.role === 'user' ? 'Vous' : 'Agent'}</span>
                  {message.role === 'assistant' && renderToolActivities(requestActivities)}
                  {message.role === 'assistant'
                    ? message.content
                      ? <MarkdownMessage content={message.content} />
                      : activeRequest === message.id && requestActivities.length === 0
                        ? <p>{activeRun?.status === 'queued'
                            ? 'En attente dans ce chat…'
                            : thinkingElapsed < 10
                              ? 'Préparation de la réponse…'
                              : `Analyse en cours… ${thinkingElapsed} s`}</p>
                        : null
                    : <p>{message.content}</p>}
                </article>
              )
            })}
          </div>
          <span className="sr-only" role="status" aria-live="polite">
            {activeRun?.status === 'queued' ? 'Message ajouté à la file d’attente.' : activeRun?.status === 'running' ? 'L’agent travaille.' : ''}
          </span>
        </div>

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
                          <button type="button" aria-label="Supprimer le message en attente" title="Supprimer" onClick={() => void deleteQueuedMessage(run.requestId)}><Trash2 aria-hidden="true" /></button>
                          <button type="button" aria-label="Modifier le message en attente" title="Modifier" onClick={() => { setEditingRequestId(run.requestId); setEditingContent(run.userContent) }}><Pencil aria-hidden="true" /></button>
                          <button className="send-now" type="button" aria-label="Envoyer ce message maintenant" title="Envoyer maintenant" onClick={() => void sendQueuedMessageNow(run.requestId)}><ArrowUp aria-hidden="true" /></button>
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
              <ListTree aria-hidden="true" />
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
              ><ArrowDown aria-hidden="true" /></button>
            )}
            {runHistoryOpen && (
              <section id="run-history-panel" className="run-history-panel" aria-label="Historique des messages">
                {historyRuns.length === 0 && <p className="empty-run-history">Aucun message traité pour le moment.</p>}
                {historyRuns.map((run) => (
                  <article className={`run-history-item ${run.status}`} key={run.requestId}>
                    <div className="run-history-status">
                      <span aria-hidden="true">{run.status === 'running' ? <Circle /> : run.status === 'completed' ? <Check /> : <CircleAlert />}</span>
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
              placeholder={!project ? 'Ouvrez un projet pour commencer…' : effectiveModel ? 'Demandez à Stellan…' : 'Installez d’abord un modèle local…'}
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault()
                  void sendMessage()
                }
              }}
              disabled={!effectiveModel || !project || !activeThreadId}
            />
            <div className="composer-toolbar">
              <span>{dictationState === 'recording'
                ? <><Circle className="recording-indicator" aria-hidden="true" /> Écoute… cliquez pour terminer</>
                : dictationState === 'transcribing'
                  ? dictationProgress?.status === 'downloading'
                    ? `Whisper se télécharge${dictationProgress.percent === undefined ? '…' : ` · ${dictationProgress.percent}%`}`
                    : 'Transcription locale…'
                  : project ? <><Box aria-hidden="true" /> {project.name}</> : 'Aucun projet'}</span>
              <div className="composer-actions">
                <button
                  className={dictationState === 'recording' ? 'dictation-button recording' : 'dictation-button'}
                  type="button"
                  aria-label={dictationState === 'recording' ? 'Arrêter la dictée' : 'Dicter le message'}
                  title={dictationState === 'recording' ? 'Arrêter la dictée' : 'Dictée locale avec Whisper'}
                  disabled={!effectiveModel || !project || !activeThreadId || dictationState === 'transcribing'}
                  onClick={() => void (dictationState === 'recording' ? stopDictation() : startDictation())}
                >{dictationState === 'recording' ? <Square aria-hidden="true" /> : <Mic aria-hidden="true" />}</button>
                {activeRequest && !prompt.trim() ? (
                  <button className="stop-button" type="button" aria-label="Arrêter l’agent" title="Arrêter" onClick={() => void window.localAgent.cancelChat(activeRequest)}><Square aria-hidden="true" /></button>
                ) : (
                  <button type="submit" aria-label={activeRequest ? 'Ajouter à la file d’attente' : 'Envoyer'} disabled={!prompt.trim() || !effectiveModel}><ArrowUp aria-hidden="true" /></button>
                )}
              </div>
            </div>
          </form>
          {dictationError && <small className="dictation-error" role="alert">{dictationError}</small>}
          <small>Entrée pour envoyer · Maj + Entrée pour une nouvelle ligne</small>
        </div>
      </div>

      <WorkbenchPanel
        thread={activeThread}
        projectName={activeThread?.projectName ?? (activeThread?.projectPath ? projectName(activeThread.projectPath) : 'Projet')}
        refreshKey={workbenchRefreshKey}
        revealFile={fileReveal}
        onChooseProject={() => void chooseProject()}
      />
    </section>
  )
}
