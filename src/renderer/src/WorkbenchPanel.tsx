import { useEffect, useMemo, useState } from 'react'
import type { PortalInfo, ProjectFilePreview, ProjectReview, StoredThread } from '../../shared/contracts'
import { buildFileTree, type FileTreeNode } from './file-tree'
import { TerminalPanel } from './TerminalPanel'

type WorkbenchTab = 'changes' | 'portals' | 'files' | 'terminal' | 'space'
type PortalDuration = 15 | 60 | 240 | null
type PortalDevice = 'desktop' | 'tablet' | 'mobile'
type BrowserIconName = 'back' | 'forward' | 'reload' | 'globe' | 'device' | 'external' | 'more'

const TABS: Array<{ id: WorkbenchTab; label: string; disabled?: boolean }> = [
  { id: 'changes', label: 'Changes' },
  { id: 'portals', label: 'Portals' },
  { id: 'files', label: 'Files' },
  { id: 'terminal', label: 'Terminal' },
  { id: 'space', label: 'Space', disabled: true }
]

function TabIcon({ tab }: { tab: WorkbenchTab }): React.JSX.Element {
  if (tab === 'changes') return <svg viewBox="0 0 24 24"><path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2zm3-12h6m-3 3V7M9 17h6" /></svg>
  if (tab === 'portals') return <svg viewBox="0 0 24 24"><path d="M12 2 21.5 16.9 12 22Z" /><path d="M12 2 2.5 16.9 12 22" /></svg>
  if (tab === 'files') return <svg viewBox="0 0 24 24"><path d="M20 10a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1h-2.5a1 1 0 0 1-.8-.4l-.9-1.2A1 1 0 0 0 15 3h-2a1 1 0 0 0-1 1v5a1 1 0 0 0 1 1Zm0 11a1 1 0 0 0 1-1v-3a1 1 0 0 0-1-1h-2.9a1 1 0 0 1-.88-.55l-.42-.85a1 1 0 0 0-.92-.6H13a1 1 0 0 0-1 1v5a1 1 0 0 0 1 1ZM3 5a2 2 0 0 0 2 2h3" /><path d="M3 3v13a2 2 0 0 0 2 2h3" /></svg>
  if (tab === 'terminal') return <svg viewBox="0 0 24 24"><path d="m7 11 2-2-2-2m4 6h4" /><rect width="18" height="18" x="3" y="3" rx="2" /></svg>
  return <svg viewBox="0 0 24 24"><path d="M20.341 6.484A10 10 0 0 1 10.266 21.85m-6.607-4.334A10 10 0 0 1 13.74 2.152" /><circle cx="12" cy="12" r="3" /><circle cx="19" cy="5" r="2" /><circle cx="5" cy="19" r="2" /></svg>
}

function ReviewIcon(): React.JSX.Element {
  return <svg viewBox="0 0 24 24"><path d="M13 5h8m-8 7h8m-8 7h8M3 17l2 2 4-4M3 7l2 2 4-4" /></svg>
}

function RefreshIcon(): React.JSX.Element {
  return <svg viewBox="0 0 24 24"><path d="M20 11a8.1 8.1 0 0 0-15.5-2M4 4v5h5m-5 4a8.1 8.1 0 0 0 15.5 2m.5 5v-5h-5" /></svg>
}

function FocusIcon(): React.JSX.Element {
  return <svg viewBox="0 0 24 24"><path d="M15 3h6v6m0-6-7 7M3 21l7-7m-1 7H3v-6" /></svg>
}

function BrowserIcon({ name }: { name: BrowserIconName }): React.JSX.Element {
  if (name === 'back') return <svg viewBox="0 0 24 24"><path d="m12 19-7-7 7-7m7 7H5" /></svg>
  if (name === 'forward') return <svg viewBox="0 0 24 24"><path d="m12 5 7 7-7 7M5 12h14" /></svg>
  if (name === 'reload') return <svg viewBox="0 0 24 24"><path d="M20 11a8 8 0 0 0-15.5-2M4 4v5h5m-5 4a8 8 0 0 0 15.5 2m.5 5v-5h-5" /></svg>
  if (name === 'globe') return <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" /><path d="M2 12h20M12 2a15 15 0 0 1 0 20M12 2a15 15 0 0 0 0 20" /></svg>
  if (name === 'device') return <svg viewBox="0 0 24 24"><rect width="10" height="14" x="3" y="8" rx="2" /><path d="M5 4a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2h-2.4M8 18h.01" /></svg>
  if (name === 'external') return <svg viewBox="0 0 24 24"><path d="M15 3h6v6m-11 5L21 3m-3 10v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /></svg>
  return <svg viewBox="0 0 24 24"><circle cx="5" cy="12" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /></svg>
}

function FileTreeIcon({ type, expanded }: { type: FileTreeNode['type']; expanded?: boolean }): React.JSX.Element {
  if (type === 'directory') {
    return <svg className="file-kind-icon" viewBox="0 0 24 24"><path d={expanded ? 'M3 7h6l2 2h10l-2 10H3zM3 7v12' : 'M3 6h6l2 2h10v11H3z'} /></svg>
  }
  return <svg className="file-kind-icon" viewBox="0 0 24 24"><path d="M6 3h8l4 4v14H6zM14 3v5h4" /><path className="file-code-mark" d="m10 12-2 2 2 2m4-4 2 2-2 2" /></svg>
}

export function WorkbenchPanel({
  thread,
  projectName,
  refreshKey,
  revealFile,
  onChooseProject
}: {
  thread: StoredThread | undefined
  projectName: string
  refreshKey: string
  revealFile: { threadId: string; path: string; nonce: number } | null
  onChooseProject: () => void
}): React.JSX.Element {
  const [tab, setTab] = useState<WorkbenchTab>('changes')
  const [reviewOpen, setReviewOpen] = useState(false)
  const [focused, setFocused] = useState(false)
  const [review, setReview] = useState<ProjectReview | null>(null)
  const [reviewError, setReviewError] = useState<string | null>(null)
  const [files, setFiles] = useState<string[]>([])
  const [directories, setDirectories] = useState<string[]>([])
  const [filesTruncated, setFilesTruncated] = useState(false)
  const [filePreview, setFilePreview] = useState<ProjectFilePreview | null>(null)
  const [filesError, setFilesError] = useState<string | null>(null)
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set())
  const [portal, setPortal] = useState<PortalInfo | null>(null)
  const [portalDuration, setPortalDuration] = useState<PortalDuration>(null)
  const [portalMenuOpen, setPortalMenuOpen] = useState(false)
  const [portalDevice, setPortalDevice] = useState<PortalDevice>('desktop')
  const [portalReloadKey, setPortalReloadKey] = useState(0)
  const [portalBusy, setPortalBusy] = useState<'starting' | 'stopping' | null>(null)
  const [portalError, setPortalError] = useState<string | null>(null)
  const [terminalStartedForThreadId, setTerminalStartedForThreadId] = useState<string | null>(null)
  const ready = Boolean(thread?.projectPath && thread.environmentStatus === 'active')

  async function refreshChanges(): Promise<void> {
    if (!thread || !ready) return
    setReviewError(null)
    try {
      setReview(await window.localAgent.reviewThreadProject(thread.id))
    } catch (error) {
      setReviewError(error instanceof Error ? error.message : 'Impossible de lire les changements.')
    }
  }

  async function refreshFiles(): Promise<void> {
    if (!thread || !ready) return
    setFilesError(null)
    try {
      const result = await window.localAgent.listProjectFiles(thread.id)
      setFiles(result.files)
      setDirectories(result.directories)
      setFilesTruncated(result.truncated)
    } catch (error) {
      setFilesError(error instanceof Error ? error.message : 'Impossible de lire les fichiers du projet.')
    }
  }

  useEffect(() => {
    setReview(null)
    setReviewError(null)
    setFiles([])
    setDirectories([])
    setFilesTruncated(false)
    setFilePreview(null)
    setFilesError(null)
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
      if (filesResult.status === 'fulfilled') {
        setFiles(filesResult.value.files)
        setDirectories(filesResult.value.directories)
        setFilesTruncated(filesResult.value.truncated)
      } else setFilesError('Impossible de lire les fichiers du projet.')
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
      setFilesError(error instanceof Error ? error.message : 'Ce fichier ne peut pas être prévisualisé.')
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
    if (next === 'portals' && !portal && portalBusy !== 'starting') void startPortal()
    if (next === 'files') void refreshFiles()
    if (next === 'terminal' && ready && thread) setTerminalStartedForThreadId(thread.id)
  }

  const statusLines = review?.status.split('\n').filter(Boolean) ?? []
  const fileTree = useMemo(() => buildFileTree(files, review?.status ?? '', directories), [directories, files, review?.status])

  function toggleFolder(path: string): void {
    setExpandedFolders((current) => {
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
          role="treeitem"
          aria-expanded={node.type === 'directory' ? expanded : undefined}
          key={`${node.type}:${node.path}`}
        >
          <button
            className={`file-tree-row${filePreview?.path === node.path ? ' active' : ''}${node.status ? ` status-${node.status.toLowerCase()}` : ''}`}
            style={{ paddingLeft: `${8 + depth * 15}px` }}
            type="button"
            title={node.path}
            onClick={() => node.type === 'directory' ? toggleFolder(node.path) : void openFile(node.path)}
          >
            {node.type === 'directory'
              ? <svg className={`file-chevron${expanded ? ' expanded' : ''}`} viewBox="0 0 24 24" aria-hidden="true"><path d="m9 18 6-6-6-6" /></svg>
              : <span className="file-chevron-spacer" />}
            <FileTreeIcon type={node.type} expanded={expanded} />
            <span className="file-tree-name">{node.name}</span>
            {node.status && <span className="file-status" aria-label={`Statut Git ${node.status}`}>{node.status}</span>}
          </button>
          {expanded && <div role="group">{renderFileNodes(node.children, depth + 1)}</div>}
        </div>
      )
    })
  }

  return (
    <aside className={focused ? 'workbench focused' : 'workbench'} aria-label="Espace de travail du projet">
      <div className="workbench-titlebar">
        <nav className="workbench-tabs" aria-label="Outils du projet">
          {TABS.map((item) => (
            <button
              className={tab === item.id ? 'active' : ''}
              type="button"
              aria-pressed={tab === item.id}
              disabled={item.disabled}
              title={item.disabled ? 'Bientôt disponible' : undefined}
              onClick={() => selectTab(item.id)}
              key={item.id}
            ><TabIcon tab={item.id} />{item.label}</button>
          ))}
        </nav>
        <button className="workbench-focus" type="button" aria-label={focused ? 'Quitter le mode focus' : 'Focus Pane'} aria-pressed={focused} onClick={() => setFocused((value) => !value)}><FocusIcon /></button>
      </div>

      {!ready ? (
        <div className="workbench-empty">
          <span aria-hidden="true">＋</span>
          <strong>Aucun projet actif</strong>
          <p>Ouvrez un projet pour que l’agent modifie de vrais fichiers et affiche ses changements ici.</p>
          <button type="button" onClick={onChooseProject}>Ouvrir un projet</button>
        </div>
      ) : (
        <div className="workbench-content">
          <section className={tab === 'changes' ? 'workbench-pane active' : 'workbench-pane'} aria-label="Changements">
            <header className="changes-toolbar">
              <div>
                <button className={reviewOpen ? 'active' : ''} type="button" aria-pressed={reviewOpen} onClick={() => setReviewOpen((value) => !value)}><ReviewIcon />Review</button>
              </div>
              <button className="icon-button" type="button" aria-label="Actualiser les changements" onClick={() => void refreshChanges()}><RefreshIcon /></button>
            </header>
            {reviewError && <p className="workbench-error" role="alert">{reviewError}</p>}
            <small>{review?.workspaceMode === 'worktree' ? 'Worktree Git isolé' : 'Dossier direct confirmé'}</small>
            {reviewOpen ? (
              review?.diff ? <pre className="workbench-diff">{review.diff}</pre> : <div className="workbench-zero"><span aria-hidden="true">✓</span><p>Rien à relire pour le moment</p></div>
            ) : statusLines.length > 0 ? (
              <div className="change-list">{statusLines.map((line) => <code key={line}>{line}</code>)}</div>
            ) : <div className="workbench-zero"><span aria-hidden="true">＋</span><p>Aucun changement</p></div>}
          </section>

          <section className={tab === 'portals' ? 'workbench-pane active portals-pane' : 'workbench-pane portals-pane'} aria-label="Portails">
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
                  <button type="button" aria-label="Options du portail" aria-expanded={portalMenuOpen} onClick={() => setPortalMenuOpen((open) => !open)}><BrowserIcon name="more" /></button>
                {portalMenuOpen && (
                  <div className="portal-options-menu">
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
                  ) : (
                    <button type="button" onClick={() => void startPortal()}>Ouvrir l’aperçu</button>
                  )}
                </div>
              )}
            </div>
          </section>

          <section className={tab === 'files' ? 'workbench-pane active files-pane' : 'workbench-pane files-pane'} aria-label="Fichiers">
            {filesError && <p className="workbench-error" role="alert">{filesError}</p>}
            {filePreview ? (
              <div className="file-preview">
                <header><button type="button" aria-label="Retour aux fichiers" onClick={() => setFilePreview(null)}>‹</button><code>{filePreview.path}</code>{filePreview.truncated && <small>Aperçu tronqué</small>}</header>
                <pre>{filePreview.content}</pre>
              </div>
            ) : (
              <div className="file-tree" role="tree" aria-label={`Fichiers de ${projectName}`}>
                {fileTree.length > 0 ? renderFileNodes(fileTree) : <div className="workbench-zero"><span aria-hidden="true">▧</span><p>Aucun fichier</p></div>}
                {filesTruncated && <small>Liste limitée aux 5 000 premiers fichiers.</small>}
              </div>
            )}
          </section>

          <section className={tab === 'terminal' ? 'workbench-pane active terminal-pane' : 'workbench-pane terminal-pane'} aria-label="Terminal">
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
