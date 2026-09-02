import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { spawn, type IPty } from 'node-pty'
import type { TerminalEvent, TerminalStartResult, WorkerProfile } from '../shared/contracts'

export type TerminalLaunch = {
  threadId: string
  ownerId: number
  cwd: string
  cols: number
  rows: number
  profile: WorkerProfile | null
}

export type PtyFactory = (
  executable: string,
  args: string[],
  options: { name: string; cols: number; rows: number; cwd: string; env: NodeJS.ProcessEnv }
) => IPty

type Session = {
  ownerId: number
  pty: IPty
  mode: 'direct' | 'container'
  cleanupExecutable: 'docker' | 'podman' | null
  cleanupName: string | null
  cleanupPromise: Promise<void> | null
}

export type TerminalEventSink = (ownerId: number, event: TerminalEvent) => void
export type ProcessTreeKiller = (pid: number) => Promise<void>
export type ContainerRemover = (runtime: 'docker' | 'podman', name: string) => Promise<void>

const MAX_OUTPUT_CHUNK = 64 * 1024

function nativeShell(): { executable: string; args: string[] } {
  if (process.platform === 'win32') {
    const configured = process.env.ComSpec
    return {
      executable: configured && path.win32.basename(configured).toLowerCase() === 'cmd.exe'
        ? configured
        : 'cmd.exe',
      args: []
    }
  }
  return { executable: existsSync('/bin/bash') ? '/bin/bash' : '/bin/sh', args: [] }
}

function containerCommand(launch: TerminalLaunch, profile: WorkerProfile): {
  executable: 'docker' | 'podman'
  args: string[]
  name: string
} {
  if (!profile.runtime) throw new Error('Le profil conteneur n’a pas de runtime.')
  if (launch.cwd.includes(',')) {
    throw new Error('Le chemin du projet ne peut pas être monté dans le terminal conteneur.')
  }
  const name = `local-agent-terminal-${launch.threadId}`
  const identityArgs = process.platform === 'linux'
    ? profile.runtime === 'podman'
      ? ['--userns', 'keep-id']
      : typeof process.getuid === 'function' && typeof process.getgid === 'function'
        ? ['--user', `${process.getuid()}:${process.getgid()}`]
        : []
    : []
  return {
    executable: profile.runtime,
    name,
    args: [
      'run', '--rm', '--interactive', '--tty',
      '--name', name,
      '--pull', 'never',
      '--cpus', String(profile.cpuLimit),
      '--memory', `${profile.memoryMb}m`,
      '--network', profile.network,
      ...identityArgs,
      '--read-only',
      '--security-opt', 'no-new-privileges',
      '--cap-drop', 'ALL',
      '--pids-limit', '256',
      '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m',
      '--mount', `type=bind,source=${launch.cwd},target=/workspace`,
      '--workdir', '/workspace',
      '--', profile.image, '/bin/sh'
    ]
  }
}

async function linuxSessionProcesses(sessionId: number): Promise<number[]> {
  const entries = await readdir('/proc', { withFileTypes: true })
  const processes = await Promise.all(entries
    .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
    .map(async (entry) => {
      try {
        const stat = await readFile(`/proc/${entry.name}/stat`, 'utf8')
        const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
        return Number(fields[3]) === sessionId ? Number(entry.name) : null
      } catch {
        return null
      }
    }))
  return processes.filter((candidate): candidate is number => candidate !== null)
}

export const killProcessTree: ProcessTreeKiller = async (pid) => {
  if (process.platform === 'win32') {
    await new Promise<void>((resolve) => {
      const child = execFile('taskkill', ['/pid', String(pid), '/t', '/f'], {
        windowsHide: true,
        timeout: 5_000
      }, () => resolve())
      child.once('error', () => resolve())
    })
    return
  }
  if (process.platform === 'linux') {
    try { process.kill(pid, 'SIGSTOP') } catch { /* The PTY leader may already have exited. */ }
    const sessionProcesses = await linuxSessionProcesses(pid)
    for (const processId of sessionProcesses) {
      try { process.kill(processId, 'SIGKILL') } catch { /* It exited during the scan. */ }
    }
  }
  try { process.kill(-pid, 'SIGKILL') } catch { /* The PTY session may already have exited. */ }
}

function removeContainerOnce(runtime: 'docker' | 'podman', name: string): Promise<{
  removed: boolean
  detail: string
}> {
  return new Promise((resolve) => {
    execFile(runtime, ['rm', '--force', name], {
      windowsHide: true,
      timeout: 10_000
    }, (error, stdout, stderr) => {
      const detail = `${stderr}\n${stdout}`.trim()
      resolve({
        removed: !error || /no such container|no container with name|does not exist/i.test(detail),
        detail: detail || error?.message || 'erreur inconnue'
      })
    })
  })
}

const defaultRemoveContainer: ContainerRemover = async (runtime, name) => {
  let detail = 'erreur inconnue'
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = await removeContainerOnce(runtime, name)
    if (result.removed) return
    detail = result.detail
  }
  throw new Error(`Le conteneur du terminal n’a pas pu être supprimé : ${detail}`)
}

export class TerminalManager {
  private readonly sessions = new Map<string, Session>()

  constructor(
    private readonly send: TerminalEventSink,
    private readonly createPty: PtyFactory = spawn,
    private readonly killTree: ProcessTreeKiller = killProcessTree,
    private readonly removeContainer: ContainerRemover = defaultRemoveContainer
  ) {}

  start(launch: TerminalLaunch): TerminalStartResult {
    const existing = this.sessions.get(launch.threadId)
    if (existing) {
      this.requireOwner(existing, launch.ownerId)
      return { threadId: launch.threadId, mode: existing.mode, reused: true }
    }

    const command = launch.profile?.mode === 'container'
      ? containerCommand(launch, launch.profile)
      : { ...nativeShell(), name: null }
    const mode = launch.profile?.mode === 'container' ? 'container' as const : 'direct' as const
    const pty = this.createPty(command.executable, command.args, {
      name: 'xterm-256color',
      cols: launch.cols,
      rows: launch.rows,
      cwd: launch.cwd,
      env: { ...process.env, TERM: 'xterm-256color' }
    })
    const session: Session = {
      ownerId: launch.ownerId,
      pty,
      mode,
      cleanupExecutable: mode === 'container' ? command.executable as 'docker' | 'podman' : null,
      cleanupName: command.name,
      cleanupPromise: null
    }
    this.sessions.set(launch.threadId, session)

    pty.onData((data) => {
      for (let offset = 0; offset < data.length; offset += MAX_OUTPUT_CHUNK) {
        this.send(launch.ownerId, {
          threadId: launch.threadId,
          type: 'data',
          data: data.slice(offset, offset + MAX_OUTPUT_CHUNK)
        })
      }
    })
    pty.onExit(({ exitCode, signal }) => {
      if (this.sessions.get(launch.threadId) !== session) return
      this.sessions.delete(launch.threadId)
      void this.cleanup(session, false)
        .catch((error: unknown) => {
          this.send(launch.ownerId, {
            threadId: launch.threadId,
            type: 'data',
            data: `\r\n[Échec du nettoyage du terminal : ${error instanceof Error ? error.message : 'erreur inconnue'}]\r\n`
          })
        })
        .finally(() => {
          this.send(launch.ownerId, {
            threadId: launch.threadId,
            type: 'exit',
            exitCode,
            signal: signal ?? null
          })
        })
    })
    return { threadId: launch.threadId, mode, reused: false }
  }

  write(threadId: string, ownerId: number, data: string): void {
    const session = this.getOwned(threadId, ownerId)
    session.pty.write(data)
  }

  resize(threadId: string, ownerId: number, cols: number, rows: number): void {
    const session = this.getOwned(threadId, ownerId)
    session.pty.resize(cols, rows)
  }

  async close(threadId: string, ownerId: number): Promise<boolean> {
    const session = this.sessions.get(threadId)
    if (!session) return false
    this.requireOwner(session, ownerId)
    this.sessions.delete(threadId)
    await this.cleanup(session)
    return true
  }

  async closeOwner(ownerId: number): Promise<void> {
    await Promise.all([...this.sessions.entries()]
      .filter(([, session]) => session.ownerId === ownerId)
      .map(async ([threadId, session]) => {
        this.sessions.delete(threadId)
        await this.cleanup(session)
      }))
  }

  async closeAll(): Promise<void> {
    const sessions = [...this.sessions.values()]
    this.sessions.clear()
    await Promise.all(sessions.map((session) => this.cleanup(session)))
  }

  private getOwned(threadId: string, ownerId: number): Session {
    const session = this.sessions.get(threadId)
    if (!session) throw new Error('Aucun terminal actif pour ce thread.')
    this.requireOwner(session, ownerId)
    return session
  }

  private requireOwner(session: Session, ownerId: number): void {
    if (session.ownerId !== ownerId) throw new Error('Ce terminal appartient à une autre fenêtre.')
  }

  private cleanup(session: Session, terminate = true): Promise<void> {
    if (session.cleanupPromise) return session.cleanupPromise
    session.cleanupPromise = (async () => {
      let failure: unknown
      if (terminate) {
        try {
          await this.killTree(session.pty.pid)
        } catch (error) {
          failure = error
        }
        try { session.pty.kill() } catch { /* The PTY already exited. */ }
      }
      if (session.cleanupExecutable && session.cleanupName) {
        try {
          await this.removeContainer(session.cleanupExecutable, session.cleanupName)
        } catch (error) {
          failure ??= error
        }
      }
      if (failure) throw failure
    })()
    return session.cleanupPromise
  }
}
