import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronRight,
  ExternalLink,
  FileCode2,
  FileDiff,
  FileX2,
  Folder,
  FolderOpen,
  FolderTree,
  Globe2,
  ListChecks,
  Maximize2,
  Minimize2,
  MonitorSmartphone,
  MoreHorizontal,
  Orbit,
  PanelsTopLeft,
  Plus,
  RefreshCw,
  SquareTerminal
} from 'lucide-react'
import type { PortalInfo, ProjectFilePreview, ProjectReview, StoredThread } from '../../shared/contracts'
import { buildFileTree, type FileTreeNode } from './file-tree'
import { TerminalPanel } from './TerminalPanel'

type WorkbenchTab = 'changes' | 'portals' | 'files' | 'terminal' | 'space'
type PortalDuration = 15 | 60 | 240 | null
type PortalDevice = 'desktop' | 'tablet' | 'mobile'
type BrowserIconName = 'back' | 'forward' | 'reload' | 'globe' | 'device' | 'external' | 'more'

const TABS: Array<{ id: WorkbenchTab; label: string; disabled?: boolean }> = [
  { id: 'changes', label: 'Modifications' },
  { id: 'portals', label: 'Portails' },
  { id: 'files', label: 'Fichiers' },
  { id: 'terminal', label: 'Terminal' },
  { id: 'space', label: 'Espace', disabled: true }
]

function TabIcon({ tab }: { tab: WorkbenchTab }): React.JSX.Element {
  if (tab === 'changes') return <FileDiff aria-hidden="true" />
  if (tab === 'portals') return <PanelsTopLeft aria-hidden="true" />
  if (tab === 'files') return <FolderTree aria-hidden="true" />
  if (tab === 'terminal') return <SquareTerminal aria-hidden="true" />
  return <Orbit aria-hidden="true" />
}

function BrowserIcon({ name }: { name: BrowserIconName }): React.JSX.Element {
  if (name === 'back') return <ArrowLeft aria-hidden="true" />
  if (name === 'forward') return <ArrowRight aria-hidden="true" />
  if (name === 'reload') return <RefreshCw aria-hidden="true" />
  if (name === 'globe') return <Globe2 aria-hidden="true" />
  if (name === 'device') return <MonitorSmartphone aria-hidden="true" />
  if (name === 'external') return <ExternalLink aria-hidden="true" />
  return <MoreHorizontal aria-hidden="true" />
}

function FileTreeIcon({ type, expanded }: { type: FileTreeNode['type']; expanded?: boolean }): React.JSX.Element {
  if (type === 'directory') {
    return expanded ? <FolderOpen className="file-kind-icon" aria-hidden="true" /> : <Folder className="file-kind-icon" aria-hidden="true" />
  }
  return <FileCode2 className="file-kind-icon" aria-hidden="true" />
}

function DiffContent({ diff, className }: { diff: string; className?: string }): React.JSX.Element {
  return (
    <pre className={className}>{diff.split('\n').map((line, index) => {
      const kind = line.startsWith('+') && !line.startsWith('+++')
        ? 'added'
        : line.startsWith('-') && !line.startsWith('---')
          ? 'removed'
          : line.startsWith('@@')
            ? 'hunk'
            : 'context'
      return <span className={`diff-line ${kind}`} key={`${index}:${line}`}>{line || ' '}{'\n'}</span>
    })}</pre>
  )
}

export function WorkbenchPanel({
  thread,
  projectName,
  refreshKey,
  revealFile,
  onChooseProject,
  active = true
}: {
  thread: StoredThread | undefined
  projectName: string
  refreshKey: string
  revealFile: { threadId: string; path: string; nonce: number } | null
  onChooseProject: () => void
  active?: boolean
}): React.JSX.Element {
  const [tab, setTab] = useState<WorkbenchTab>('changes')
  const [reviewOpen, setReviewOpen] = useState(false)
  const [focused, setFocused] = useState(false)
  const [review, setReview] = useState<ProjectReview | null>(null)
  const [expandedChanges, setExpandedChanges] = useState<Set<string>>(new Set())
  const [reviewError, setReviewError] = useState<string | null>(null)
  const [reviewLoading, setReviewLoading] = useState(false)
  const [files, setFiles] = useState<string[]>([])
  const [directories, setDirectories] = useState<string[]>([])
  const [filesTruncated, setFilesTruncated] = useState(false)
  const [filePreview, setFilePreview] = useState<ProjectFilePreview | null>(null)
  const [filesError, setFilesError] = useState<string | null>(null)
  const [filesLoading, setFilesLoading] = useState(false)
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set())
  const [portal, setPortal] = useState<PortalInfo | null>(null)
  const [portalDuration, setPortalDuration] = useState<PortalDuration>(null)
  const [portalMenuOpen, setPortalMenuOpen] = useState(false)
  const portalMenuButtonRef = useRef<HTMLButtonElement>(null)
  const [portalDevice, setPortalDevice] = useState<PortalDevice>('desktop')
  const [portalReloadKey, setPortalReloadKey] = useState(0)
  const [portalBusy, setPortalBusy] = useState<'starting' | 'stopping' | null>(null)
  const [portalError, setPortalError] = useState<string | null>(null)
  const [terminalStartedForThreadId, setTerminalStartedForThreadId] = useState<string | null>(null)
  const ready = Boolean(thread?.projectPath && thread.environmentStatus === 'active')
  const panelId = thread?.id ?? 'empty'

  useEffect(() => {
    if (!portalMenuOpen) return
    const closeMenu = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      setPortalMenuOpen(false)
      portalMenuButtonRef.current?.focus()
    }
    window.addEventListener('keydown', closeMenu)
    return () => window.removeEventListener('keydown', closeMenu)
  }, [portalMenuOpen])

  async function refreshChanges(): Promise<void> {
    if (!thread || !ready) return
    setReviewError(null)
    setReviewLoading(true)
    try {
      setReview(await window.localAgent.reviewThreadProject(thread.id))
    } catch (error) {
      setReviewError(error instanceof Error ? error.message : 'Impossible de lire les changements.')
    } finally {
      setReviewLoading(false)
    }
  }

  async function refreshFiles(): Promise<void> {
    if (!thread || !ready) return
    setFilesError(null)
    setFilesLoading(true)
    try {
      const result = await window.localAgent.listProjectFiles(thread.id)
      setFiles(result.files)
      setDirectories(result.directories)
      setFilesTruncated(result.truncated)
    } catch (error) {
      setFilesError(error instanceof Error ? error.message : 'Impossible de lire les fichiers du projet.')
    } finally {
      setFilesLoading(false)
    }
  }

  useEffect(() => {
    setReview(null)
    setExpandedChanges(new Set())
    setReviewError(null)
    setReviewLoading(Boolean(thread && ready))
    setFiles([])
    setDirectories([])
    setFilesTruncated(false)
    setFilePreview(null)
    setFilesError(null)
    setFilesLoading(Boolean(thread && ready))
    setExpandedFolders(new Set())
    setPortal(null)
    setPortalError(null)
    setTerminalStartedForThreadId(null)
    if (!thread || !ready) return
    let canceled = false
    void Promise.allSettled([
      window.localAgent.reviewThreadProject(thread.id),
      window.localAgent.listProjectFiles(thread.id),
      window.localAgent.getPortal(thread.id)
    ]).then(([reviewResult, filesResult, portalResult]) => {
      if (canceled) return
      if (reviewResult.status === 'fulfilled') setReview(reviewResult.value)
      else setReviewError('Impossible de lire les changements.')
      setReviewLoading(false)
      if (filesResult.status === 'fulfilled') {
        setFiles(filesResult.value.files)
        setDirectories(filesResult.value.directories)
        setFilesTruncated(filesResult.value.truncated)
      } else setFilesError('Impossible de lire les fichiers du projet.')
      setFilesLoading(false)
      if (portalResult.status === 'fulfilled') setPortal(portalResult.value)
      else setPortalError('Impossible de lire l’état du portail local.')
    })
    return () => { canceled = true }
  }, [ready, thread?.id])

  useEffect(() => {
    if (!portal?.expiresAt) return
    const remaining = new Date(portal.expiresAt).getTime() - Date.now()
    if (remaining <= 0) {
      setPortal(null)
      return
    }
    const timeout = setTimeout(() => setPortal(null), remaining)
    return () => clearTimeout(timeout)
  }, [portal?.expiresAt])

  useEffect(() => {
    if (!thread || !ready || !refreshKey) return
    void Promise.all([refreshChanges(), refreshFiles()])
  }, [refreshKey])

  const terminalThreadId = thread?.id
  useEffect(() => () => {
    if (terminalThreadId) void window.localAgent.closeTerminal(terminalThreadId)
  }, [terminalThreadId])

  async function openFile(path: string): Promise<void> {
    if (!thread) return
    setFilesError(null)
    try {
      setFilePreview(await window.localAgent.readProjectFile({ threadId: thread.id, path }))
    } catch (error) {
      setFilePreview(null)
      const message = error instanceof Error ? error.message : ''
      if (/\bENOENT\b|no such file/i.test(message)) {
        await refreshFiles()
        return
      }
      setFilesError(message || 'Ce fichier ne peut pas être prévisualisé.')
    }
  }

  useEffect(() => {
    if (!thread || !ready || revealFile?.threadId !== thread.id) return
    setTab('files')
    const parts = revealFile.path.replaceAll('\\', '/').split('/')
    setExpandedFolders((current) => {
      const next = new Set(current)
      for (let index = 1; index < parts.length; index += 1) next.add(parts.slice(0, index).join('/'))
      return next
    })
    void Promise.all([refreshFiles(), openFile(revealFile.path)])
  }, [ready, revealFile?.nonce, thread?.id])

  async function startPortal(): Promise<void> {
    if (!thread) return
    setPortalBusy('starting')
    setPortalError(null)
    try {
      const result = await window.localAgent.startPortal({
        threadId: thread.id,
        source: 'project',
        durationMinutes: portalDuration
      })
      setPortal(result)
      setPortalReloadKey((key) => key + 1)
    } catch (error) {
      setPortalError(error instanceof Error ? error.message : 'Le portail local n’a pas pu démarrer.')
    } finally {
      setPortalBusy(null)
    }
  }

  async function stopPortal(): Promise<void> {
    if (!thread) return
    setPortalBusy('stopping')
    try {
      await window.localAgent.stopPortal(thread.id)
      setPortal(null)
    } catch (error) {
      setPortalError(error instanceof Error ? error.message : 'Le portail local n’a pas pu être arrêté.')
    } finally {
      setPortalBusy(null)
    }
  }

  async function usePortal(action: 'copy' | 'open'): Promise<void> {
    if (!thread) return
    try {
      if (action === 'copy') await window.localAgent.copyPortalUrl(thread.id)
      else await window.localAgent.openPortal(thread.id)
    } catch (error) {
      setPortalError(error instanceof Error ? error.message : 'L’action sur le portail a échoué.')
    }
  }

  function selectTab(next: WorkbenchTab): void {
    if (next === 'space') return
    setTab(next)
    if (next === 'changes') void refreshChanges()
    if (next === 'files') void refreshFiles()
    if (next === 'terminal' && ready && thread) setTerminalStartedForThreadId(thread.id)
  }

  const fileTree = useMemo(() => buildFileTree(files, review?.status ?? '', directories), [directories, files, review?.status])
  const hasProjectIndex = files.includes('index.html')

  function toggleFolder(path: string): void {
    setExpandedFolders((current) => {
      const next = new Set(current)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  function toggleChange(path: string): void {
    setExpandedChanges((current) => {
      const next = new Set(current)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  function renderFileNodes(nodes: FileTreeNode[], depth = 0): React.JSX.Element[] {
    return nodes.map((node) => {
      const expanded = node.type === 'directory' && expandedFolders.has(node.path)
      return (
        <div
          className="file-tree-node"
          key={`${node.type}:${node.path}`}
        >
          <button
            className={`file-tree-row${filePreview?.path === node.path ? ' active' : ''}${node.status ? ` status-${node.status.toLowerCase()}` : ''}`}
            style={{ paddingLeft: `${8 + depth * 15}px` }}
            type="button"
            title={node.path}
            aria-expanded={node.type === 'directory' ? expanded : undefined}
            onClick={() => node.type === 'directory' ? toggleFolder(node.path) : void openFile(node.path)}
          >
            {node.type === 'directory'
              ? <ChevronRight className={`file-chevron${expanded ? ' expanded' : ''}`} aria-hidden="true" />
              : <span className="file-chevron-spacer" />}
            <FileTreeIcon type={node.type} expanded={expanded} />
            <span className="file-tree-name">{node.name}</span>
            {node.status && <span className="file-status" aria-label={`Statut Git ${node.status}`}>{node.status}</span>}
          </button>
          {expanded && <div>{renderFileNodes(node.children, depth + 1)}</div>}
        </div>
      )
    })
  }

  return (
    <aside className={`${focused ? 'workbench focused' : 'workbench'}${active ? '' : ' inactive'}`} aria-hidden={!active} aria-label="Espace de travail du projet">
      <div className="workbench-titlebar">
        <nav className="workbench-tabs" aria-label="Outils du projet" role="tablist">
          {TABS.map((item) => (
            <button
              className={tab === item.id ? 'active' : ''}
              type="button"
              role="tab"
              aria-selected={tab === item.id}
              aria-controls={ready && !item.disabled ? `workbench-${panelId}-${item.id}` : undefined}
              disabled={item.disabled || !ready}
              title={item.disabled ? 'Bientôt disponible' : !ready ? 'Ouvrez d’abord un projet' : undefined}
              onClick={() => selectTab(item.id)}
              key={item.id}
            ><TabIcon tab={item.id} />{item.label}</button>
          ))}
        </nav>
        <button className="workbench-focus" type="button" aria-label={focused ? 'Quitter le mode plein écran' : 'Agrandir les outils du projet'} aria-pressed={focused} onClick={() => setFocused((value) => !value)}>{focused ? <Minimize2 aria-hidden="true" /> : <Maximize2 aria-hidden="true" />}</button>
      </div>

      {!ready ? (
        <div className="workbench-empty">
          <span aria-hidden="true"><Plus /></span>
          <strong>Aucun projet actif</strong>
          <p>Ouvrez un projet pour que l’agent modifie de vrais fichiers et affiche ses changements ici.</p>
          <button type="button" onClick={onChooseProject}>Ouvrir un projet</button>
        </div>
      ) : (
        <div className="workbench-content">
          <section id={`workbench-${panelId}-changes`} role="tabpanel" className={tab === 'changes' ? 'workbench-pane active' : 'workbench-pane'} aria-label="Modifications">
            <header className="changes-toolbar">
              <div>
                <button className={reviewOpen ? 'active' : ''} type="button" aria-pressed={reviewOpen} onClick={() => setReviewOpen((value) => !value)}><ListChecks aria-hidden="true" />Relire</button>
              </div>
              <button className="icon-button" type="button" aria-label="Actualiser les modifications" onClick={() => void refreshChanges()}><RefreshCw aria-hidden="true" /></button>
            </header>
            {reviewError && <p className="workbench-error" role="alert">{reviewError}</p>}
            <small>{review?.workspaceMode === 'worktree' ? 'Worktree Git isolé' : 'Dossier direct confirmé'}</small>
            {reviewLoading ? <div className="workbench-zero"><p>Lecture des changements…</p></div> : reviewOpen ? (
              review?.diff ? <DiffContent className="workbench-diff" diff={review.diff} /> : <div className="workbench-zero"><span aria-hidden="true"><Check /></span><p>Rien à relire pour le moment</p></div>
            ) : review && review.changes.length > 0 ? (
              <div className="change-list">{review.changes.map((change) => {
                const expanded = expandedChanges.has(change.path)
                const label = change.kind === 'added' ? 'Nouveau' : change.kind === 'deleted' ? 'Supprimé' : change.kind === 'renamed' ? 'Renommé' : 'Modifié'
                return <article key={change.path}>
                  <button type="button" aria-expanded={expanded} onClick={() => toggleChange(change.path)}>
                    <ChevronRight className={expanded ? 'expanded' : ''} aria-hidden="true" />
                    <code>{change.path}</code>
                    <small>{label}</small>
                    <span className="change-added">+{change.added}</span>
                    <span className="change-removed">−{change.removed}</span>
                  </button>
                  {expanded && (change.diff
                    ? <DiffContent diff={change.diff} />
                    : <p>Aucun diff textuel disponible pour ce fichier.</p>)}
                </article>
              })}</div>
            ) : <div className="workbench-zero"><span aria-hidden="true"><Plus /></span><p>Aucune modification</p></div>}
          </section>

          <section id={`workbench-${panelId}-portals`} role="tabpanel" className={tab === 'portals' ? 'workbench-pane active portals-pane' : 'workbench-pane portals-pane'} aria-label="Portails">
            <div className="portal-browser">
              <div className="portal-browser-toolbar">
                <div className="portal-history-controls">
                  <button type="button" disabled title="Retour" aria-label="Retour"><BrowserIcon name="back" /></button>
                  <button type="button" disabled title="Suivant" aria-label="Suivant"><BrowserIcon name="forward" /></button>
                </div>
                <button type="button" disabled={!portal} title="Actualiser" aria-label="Actualiser l’aperçu" onClick={() => setPortalReloadKey((key) => key + 1)}><BrowserIcon name="reload" /></button>
                <div className="portal-address">
                  <button type="button" disabled={!portal} title="Copier l’adresse" aria-label="Copier l’adresse" onClick={() => void usePortal('copy')}><BrowserIcon name="globe" /></button>
                  <input aria-label="Adresse du portail" readOnly value={portal?.url ?? (portalBusy === 'starting' ? 'Ouverture du portail…' : '')} onFocus={(event) => event.currentTarget.select()} />
                </div>
                <button
                  className={portalDevice === 'desktop' ? '' : 'active'}
                  type="button"
                  disabled={!portal}
                  title={`Mode appareil : ${portalDevice === 'desktop' ? 'ordinateur' : portalDevice === 'tablet' ? 'tablette' : 'téléphone'}`}
                  aria-label="Changer le mode d’appareil"
                  onClick={() => setPortalDevice((device) => device === 'desktop' ? 'tablet' : device === 'tablet' ? 'mobile' : 'desktop')}
                ><BrowserIcon name="device" /></button>
                <button type="button" disabled={!portal} title="Ouvrir dans le navigateur" aria-label="Ouvrir dans le navigateur" onClick={() => void usePortal('open')}><BrowserIcon name="external" /></button>
                <div className="portal-options">
                  <button ref={portalMenuButtonRef} type="button" aria-label="Options du portail" aria-expanded={portalMenuOpen} aria-haspopup="dialog" aria-controls="portal-options-dialog" onClick={() => setPortalMenuOpen((open) => !open)}><BrowserIcon name="more" /></button>
                {portalMenuOpen && (
                  <div id="portal-options-dialog" className="portal-options-menu" role="dialog" aria-label="Options du portail">
                    <label><span>Accès</span><select value="private" disabled><option value="private">Privé · cet ordinateur</option><option value="public">Public</option></select></label>
                    <small>Le partage public nécessite un service de tunnel et n’est pas disponible hors ligne.</small>
                    <label><span>Durée</span><select value={portalDuration ?? 'session'} onChange={(event) => setPortalDuration(event.target.value === 'session' ? null : Number(event.target.value) as PortalDuration)} disabled={Boolean(portal)}><option value="session">Jusqu’à l’arrêt</option><option value="15">15 minutes</option><option value="60">1 heure</option><option value="240">4 heures</option></select></label>
                    {portal && <button className="portal-stop" type="button" disabled={portalBusy === 'stopping'} onClick={() => void stopPortal()}>Arrêter le portail</button>}
                  </div>
                )}
                </div>
              </div>
              {portal ? (
                <div className={`portal-preview ${portalDevice}`}>
                  <iframe
                    key={portalReloadKey}
                    src={portal.url}
                    title="Prévisualisation Chromium du projet"
                    sandbox="allow-forms allow-modals allow-scripts allow-same-origin"
                  />
                </div>
              ) : (
                <div className="portal-preview portal-preview-empty">
                  {portalBusy === 'starting' ? (
                    <p>Ouverture de Chromium…</p>
                  ) : portalError ? (
                    <div><p>{portalError}</p><button type="button" onClick={() => void startPortal()}>Réessayer</button></div>
                  ) : !hasProjectIndex ? (
                    <div><p>L’aperçu sera disponible dès qu’un fichier <code>index.html</code> sera créé.</p></div>
                  ) : (
                    <button type="button" onClick={() => void startPortal()}>Ouvrir l’aperçu</button>
                  )}
                </div>
              )}
            </div>
          </section>

          <section id={`workbench-${panelId}-files`} role="tabpanel" className={tab === 'files' ? 'workbench-pane active files-pane' : 'workbench-pane files-pane'} aria-label="Fichiers">
            {filesError && <p className="workbench-error" role="alert">{filesError}</p>}
            {filePreview ? (
              <div className="file-preview">
                <header><button type="button" aria-label="Retour aux fichiers" onClick={() => setFilePreview(null)}><ArrowLeft aria-hidden="true" /></button><code>{filePreview.path}</code>{filePreview.truncated && <small>Aperçu tronqué</small>}</header>
                <pre>{filePreview.content}</pre>
              </div>
            ) : (
              <div className="file-tree" aria-label={`Fichiers de ${projectName}`}>
                {filesLoading
                  ? <div className="workbench-zero"><p>Lecture des fichiers…</p></div>
                  : fileTree.length > 0
                    ? renderFileNodes(fileTree)
                    : <div className="workbench-zero"><span aria-hidden="true"><FileX2 /></span><p>Aucun fichier</p></div>}
                {filesTruncated && <small>Liste limitée aux 5 000 premiers fichiers.</small>}
              </div>
            )}
          </section>

          <section id={`workbench-${panelId}-terminal`} role="tabpanel" className={tab === 'terminal' ? 'workbench-pane active terminal-pane' : 'workbench-pane terminal-pane'} aria-label="Terminal">
            {thread && terminalStartedForThreadId === thread.id && <TerminalPanel threadId={thread.id} projectName={projectName} onClose={() => {
              void window.localAgent.closeTerminal(thread.id)
              setTerminalStartedForThreadId(null)
            }} />}
          </section>
        </div>
      )}
    </aside>
  )
}
