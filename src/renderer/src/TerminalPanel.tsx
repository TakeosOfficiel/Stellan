import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { useEffect, useRef, useState } from 'react'

export function TerminalPanel({ threadId, projectName, onClose }: {
  threadId: string
  projectName: string
  onClose: () => void
}): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const [mode, setMode] = useState<'direct' | 'container' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [exited, setExited] = useState(false)
  const [generation, setGeneration] = useState(0)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    setError(null)
    setExited(false)
    const terminal = new Terminal({
      cursorBlink: true,
      fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace',
      fontSize: 12,
      scrollback: 5_000,
      screenReaderMode: true,
      theme: {
        background: '#090c0a',
        foreground: '#c8d0ca',
        cursor: '#b5be6a',
        selectionBackground: '#3d4a41'
      }
    })
    const fit = new FitAddon()
    terminal.loadAddon(fit)
    terminal.open(host)

    let started = false
    let lastSize = ''
    const resize = (): void => {
      fit.fit()
      const size = `${terminal.cols}:${terminal.rows}`
      if (!started || size === lastSize) return
      lastSize = size
      void window.localAgent.resizeTerminal(threadId, terminal.cols, terminal.rows).catch(() => {})
    }
    const observer = new ResizeObserver(resize)
    observer.observe(host)
    const removeListener = window.localAgent.onTerminalEvent((event) => {
      if (event.threadId !== threadId) return
      if (event.type === 'data') terminal.write(event.data)
      else {
        terminal.write(`\r\n\x1b[90m[Terminal terminé avec le code ${event.exitCode}]\x1b[0m\r\n`)
        setExited(true)
      }
    })
    const input = terminal.onData((data) => {
      void window.localAgent.writeTerminal(threadId, data).catch(() => {})
    })

    requestAnimationFrame(() => {
      resize()
      void window.localAgent.startTerminal({
        threadId,
        cols: terminal.cols,
        rows: terminal.rows
      }).then((result) => {
        started = true
        setMode(result.mode)
        resize()
        terminal.focus()
      }).catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : 'Le terminal n’a pas pu démarrer.')
      })
    })

    return () => {
      observer.disconnect()
      input.dispose()
      removeListener()
      terminal.dispose()
    }
  }, [generation, threadId])

  return (
    <section className="terminal-panel" aria-label={`Terminal du projet ${projectName}`}>
      <header>
        <div>
          <span aria-hidden="true">›_</span>
          <strong>Terminal</strong>
          <small>{mode === 'container' ? 'Conteneur du worker' : 'Environnement du thread'}</small>
        </div>
        <div>
          {exited && (
            <button type="button" onClick={() => setGeneration((current) => current + 1)}>Redémarrer</button>
          )}
          <button type="button" aria-label="Fermer le terminal" onClick={onClose}>×</button>
        </div>
      </header>
      {error && <p role="alert">{error}</p>}
      <div ref={hostRef} className="terminal-host" />
    </section>
  )
}
