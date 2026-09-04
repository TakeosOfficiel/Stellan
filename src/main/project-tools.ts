import { constants } from 'node:fs'
import { lstat, mkdir, open, readdir, realpath, rmdir, stat, unlink } from 'node:fs/promises'
import path from 'node:path'
import { spawn as nodeSpawn } from 'node:child_process'
import spawn from 'cross-spawn'
import { rgPath } from '@vscode/ripgrep'
import { diffLines } from 'diff'
import type { ProjectChange } from '../shared/contracts'

const RIPGREP_PATH = process.resourcesPath
  ? path.join(process.resourcesPath, 'bin', process.platform === 'win32' ? 'rg.exe' : 'rg')
  : rgPath

export interface SearchResult {
  path: string
  line: number
  column: number
  text: string
}

export type FileWriteResult = {
  path: string
  added: number
  removed: number
}

function gitStatusTokens(status: string): string[] {
  return status
    .split(/\0|\uFFFD|\r?\n|(?=[ MADRCUT?!]{2} )/)
    .filter((token) => token.length >= 4)
}

export function parseGitStatus(status: string): Array<Pick<ProjectChange, 'path' | 'kind'>> {
  const entries: Array<Pick<ProjectChange, 'path' | 'kind'>> = []
  // Docker output normally preserves NUL separators. Some Windows runtime
  // transports replace them with U+FFFD or remove them, so also recognize
  // the next porcelain status marker instead of merging changed paths.
  const tokens = gitStatusTokens(status)
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (!token || token.length < 4) continue
    const code = token.slice(0, 2)
    entries.push({
      path: token.slice(3),
      kind: code === '??' || code.includes('A')
        ? 'added'
        : code.includes('R')
            ? 'renamed'
            : code.includes('D')
              ? 'deleted'
              : 'modified'
    })
    if (code.includes('R') || code.includes('C')) index += 1
  }
  return entries
}

export function countDiffLines(diff: string): Pick<ProjectChange, 'added' | 'removed'> {
  let added = 0
  let removed = 0
  for (const line of diff.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) added += 1
    if (line.startsWith('-') && !line.startsWith('---')) removed += 1
  }
  return { added, removed }
}

export interface CommandOptions {
  timeoutMs?: number
  maxOutputBytes?: number
  signal?: AbortSignal
}

export interface CommandResult {
  exitCode: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  outputTruncated: boolean
}

export interface FilePreview {
  content: string
  truncated: boolean
}

export class ProjectTools {
  private constructor(private readonly root: string) {}

  static async create(projectPath: string): Promise<ProjectTools> {
    const root = await realpath(projectPath)
    if (!(await stat(root)).isDirectory()) {
      throw new Error('Project path must be a directory')
    }
    return new ProjectTools(root)
  }

  async listFiles(relativePath = '.'): Promise<string[]> {
    const directory = await this.safePath(relativePath)
    if (!(await stat(directory)).isDirectory()) {
      throw new Error('List path must be a directory')
    }

    const result = await this.run(RIPGREP_PATH, ['--files', '--hidden', '--glob', '!.git', '--', directory])
    if (result.outputTruncated) throw new Error('File listing exceeded the output limit')
    if (result.exitCode !== 0 && result.exitCode !== 1) {
      throw new Error(result.stderr.trim() || 'Unable to list project files')
    }
    return result.stdout
      .split('\n')
      .filter(Boolean)
      .map((file) => path.relative(this.root, file).split(path.sep).join('/'))
      .sort()
  }

  async listDirectories(relativePath = '.'): Promise<string[]> {
    const directory = await this.safePath(relativePath)
    if (!(await stat(directory)).isDirectory()) throw new Error('List path must be a directory')
    const entries = await readdir(directory, { withFileTypes: true })
    return entries
      .filter((entry) => entry.isDirectory() && entry.name !== '.git')
      .map((entry) => path.relative(this.root, path.join(directory, entry.name)).split(path.sep).join('/'))
      .sort((left, right) => left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' }))
  }

  async search(query: string, relativePath = '.'): Promise<SearchResult[]> {
    if (!query) throw new Error('Search query must not be empty')
    const target = await this.safePath(relativePath)
    const result = await this.run(RIPGREP_PATH, [
      '--json',
      '--color',
      'never',
      '--hidden',
      '--glob',
      '!.git',
      '--',
      query,
      target,
    ])
    if (result.outputTruncated) throw new Error('Search exceeded the output limit')
    if (result.exitCode !== 0 && result.exitCode !== 1) {
      throw new Error(result.stderr.trim() || 'Unable to search project files')
    }

    const matches: SearchResult[] = []
    for (const line of result.stdout.split('\n')) {
      if (!line) continue
      const event = JSON.parse(line) as {
        type: string
        data: {
          path: { text: string }
          line_number: number
          lines: { text: string }
          submatches: Array<{ start: number }>
        }
      }
      if (event.type !== 'match') continue
      matches.push({
        path: path.relative(this.root, event.data.path.text).split(path.sep).join('/'),
        line: event.data.line_number,
        column: (event.data.submatches[0]?.start ?? 0) + 1,
        text: event.data.lines.text.replace(/\r?\n$/, ''),
      })
    }
    return matches
  }

  async readFile(relativePath: string): Promise<string> {
    const target = await this.safePath(relativePath)
    if (!(await stat(target)).isFile()) throw new Error('Path must reference a project file')
    const handle = await open(
      target,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)
    )
    try {
      return await handle.readFile('utf8')
    } finally {
      await handle.close()
    }
  }

  async readFilePreview(relativePath: string, maxBytes = 200_000): Promise<FilePreview> {
    if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 1_000_000) {
      throw new Error('File preview limit is invalid')
    }
    const target = await this.safePath(relativePath)
    if (!(await stat(target)).isFile()) throw new Error('Path must reference a project file')
    const handle = await open(
      target,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)
    )
    try {
      const buffer = Buffer.alloc(maxBytes + 1)
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
      const content = buffer.subarray(0, Math.min(bytesRead, maxBytes))
      if (content.includes(0)) throw new Error('Binary files cannot be previewed')
      return {
        content: new TextDecoder().decode(content),
        truncated: bytesRead > maxBytes
      }
    } finally {
      await handle.close()
    }
  }

  async resolveFilePath(relativePath: string): Promise<string> {
    const target = await this.safePath(relativePath)
    if (!(await stat(target)).isFile()) throw new Error('Path must reference a project file')
    return target
  }

  async writeFile(relativePath: string, content: string): Promise<FileWriteResult> {
    const target = await this.safePath(relativePath, true)
    let previous = ''
    try {
      previous = await this.readFile(relativePath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    let added = 0
    let removed = 0
    for (const change of diffLines(previous, content)) {
      if (change.added) added += change.count ?? 0
      if (change.removed) removed += change.count ?? 0
    }
    await mkdir(path.dirname(target), { recursive: true })
    await this.safePath(path.dirname(relativePath) || '.')
    const handle = await open(
      target,
      constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | (constants.O_NOFOLLOW ?? 0),
      0o666
    )
    try {
      await handle.writeFile(content, 'utf8')
    } finally {
      await handle.close()
    }
    return { path: relativePath, added, removed }
  }

  async editFile(relativePath: string, oldText: string, newText: string, replaceAll = false): Promise<FileWriteResult> {
    const content = await this.readFile(relativePath)
    const occurrences = content.split(oldText).length - 1
    if (occurrences === 0) throw new Error('Le texte à remplacer est introuvable dans le fichier.')
    if (!replaceAll && occurrences !== 1) {
      throw new Error(`Le texte à remplacer apparaît ${occurrences} fois. Fournissez plus de contexte ou activez replaceAll.`)
    }
    return this.writeFile(
      relativePath,
      replaceAll ? content.split(oldText).join(newText) : content.replace(oldText, newText)
    )
  }

  async deleteFile(relativePath: string): Promise<FileWriteResult> {
    const previous = await this.readFile(relativePath)
    const target = await this.safePath(relativePath)
    const info = await stat(target)
    if (!info.isFile()) throw new Error('Path must reference a project file')
    let removed = 0
    for (const change of diffLines(previous, '')) {
      if (change.removed) removed += change.count ?? 0
    }
    await unlink(target)
    let directory = path.dirname(target)
    while (directory !== this.root) {
      try {
        await rmdir(directory)
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code === 'ENOTEMPTY' || code === 'EEXIST') break
        if (code !== 'ENOENT') throw error
      }
      directory = path.dirname(directory)
    }
    return { path: relativePath, added: 0, removed }
  }

  async gitStatus(): Promise<string> {
    const result = await this.run('git', [
      '-c', 'core.fsmonitor=false',
      '-c', `safe.directory=${this.root}`,
      'status', '--short', '--untracked-files=all'
    ], {}, sanitizedGitEnvironment())
    if (result.outputTruncated) throw new Error('Git status exceeded the output limit')
    if (result.exitCode !== 0) throw new Error(result.stderr.trim() || 'Unable to read Git status')
    return result.stdout
  }

  async isGitRepository(): Promise<boolean> {
    const result = await this.run('git', [
      '-c', 'core.fsmonitor=false',
      '-c', `safe.directory=${this.root}`,
      'rev-parse', '--is-inside-work-tree'
    ], {}, sanitizedGitEnvironment())
    return result.exitCode === 0 && result.stdout.trim() === 'true'
  }

  async gitDiff(staged = false): Promise<string> {
    const result = await this.run('git', [
      '-c', 'core.fsmonitor=false',
      '-c', `safe.directory=${this.root}`,
      'diff', '--no-ext-diff', '--no-textconv', ...(staged ? ['--cached'] : [])
    ], {}, sanitizedGitEnvironment())
    if (result.outputTruncated) throw new Error('Git diff exceeded the output limit')
    if (result.exitCode !== 0) throw new Error(result.stderr.trim() || 'Unable to read Git diff')
    return result.stdout
  }

  async gitChanges(): Promise<ProjectChange[]> {
    const status = await this.run('git', [
      '-c', 'core.fsmonitor=false',
      '-c', `safe.directory=${this.root}`,
      'status', '--porcelain=v1', '-z', '--untracked-files=all'
    ], {}, sanitizedGitEnvironment())
    if (status.outputTruncated) throw new Error('Git status exceeded the output limit')
    if (status.exitCode !== 0) throw new Error(status.stderr.trim() || 'Unable to read Git status')

    const statusTokens = gitStatusTokens(status.stdout)
    return Promise.all(parseGitStatus(status.stdout).map(async (change) => {
      const untracked = statusTokens.some((token) => token === `?? ${change.path}`)
      const result = await this.run('git', untracked
        ? ['diff', '--no-index', '--no-ext-diff', '--no-textconv', '--', '/dev/null', change.path]
        : ['-c', 'core.fsmonitor=false', '-c', `safe.directory=${this.root}`, 'diff', 'HEAD', '--no-ext-diff', '--no-textconv', '--', change.path],
      {}, sanitizedGitEnvironment())
      if (result.outputTruncated) throw new Error(`Git diff for ${change.path} exceeded the output limit`)
      if (result.exitCode !== 0 && !(untracked && result.exitCode === 1)) {
        throw new Error(result.stderr.trim() || `Unable to read Git diff for ${change.path}`)
      }
      return { ...change, ...countDiffLines(result.stdout), diff: result.stdout }
    }))
  }

  runCommand(
    command: string,
    args: readonly string[] = [],
    options: CommandOptions = {},
  ): Promise<CommandResult> {
    return this.run(command, args, options)
  }

  private async safePath(relativePath: string, allowMissing = false): Promise<string> {
    if (!relativePath || path.isAbsolute(relativePath) || relativePath.includes('\0')) {
      throw new Error('Path must be relative to the project')
    }
    const parts = relativePath.split(/[\\/]/)
    if (parts.includes('..')) {
      throw new Error('Path traversal is not allowed')
    }
    if (parts.some((part) => part.toLowerCase() === '.git')) {
      throw new Error('Git metadata is protected')
    }

    const target = path.resolve(this.root, relativePath)
    const relation = path.relative(this.root, target)
    if (relation.startsWith(`..${path.sep}`) || relation === '..' || path.isAbsolute(relation)) {
      throw new Error('Path escapes the project')
    }

    let current = this.root
    for (const part of relation.split(path.sep).filter(Boolean)) {
      current = path.join(current, part)
      try {
        if ((await lstat(current)).isSymbolicLink()) {
          throw new Error('Symbolic links are not allowed')
        }
      } catch (error) {
        if (allowMissing && (error as NodeJS.ErrnoException).code === 'ENOENT') break
        throw error
      }
    }
    return target
  }

  private run(
    command: string,
    args: readonly string[],
    options: CommandOptions = {},
    environment?: NodeJS.ProcessEnv,
  ): Promise<CommandResult> {
    const timeoutMs = options.timeoutMs ?? 30_000
    const maxOutputBytes = options.maxOutputBytes ?? 1_048_576
    if (timeoutMs <= 0 || maxOutputBytes <= 0) {
      throw new Error('Timeout and output limit must be positive')
    }

    return new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        cwd: this.root,
        shell: false,
        windowsHide: true,
        detached: process.platform !== 'win32',
        env: environment
      })
      const stdout: Buffer[] = []
      const stderr: Buffer[] = []
      let outputBytes = 0
      let timedOut = false
      let outputTruncated = false

      const stop = (): void => {
        if (!child.pid) return
        if (process.platform === 'win32') {
          nodeSpawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
            windowsHide: true,
            stdio: 'ignore'
          })
        } else {
          try { process.kill(-child.pid, 'SIGKILL') } catch { child.kill('SIGKILL') }
        }
      }

      const capture = (chunks: Buffer[], chunk: Buffer): void => {
        const remaining = maxOutputBytes - outputBytes
        if (remaining > 0) chunks.push(chunk.subarray(0, remaining))
        outputBytes += Math.min(chunk.length, Math.max(remaining, 0))
        if (chunk.length > remaining) {
          outputTruncated = true
          stop()
        }
      }
      child.stdout?.on('data', (chunk: Buffer) => capture(stdout, chunk))
      child.stderr?.on('data', (chunk: Buffer) => capture(stderr, chunk))
      child.once('error', reject)

      const timer = setTimeout(() => {
        timedOut = true
        stop()
      }, timeoutMs)
      if (options.signal?.aborted) stop()
      else options.signal?.addEventListener('abort', stop, { once: true })
      child.once('close', (exitCode) => {
        clearTimeout(timer)
        options.signal?.removeEventListener('abort', stop)
        resolve({
          exitCode,
          stdout: Buffer.concat(stdout).toString('utf8'),
          stderr: Buffer.concat(stderr).toString('utf8'),
          timedOut,
          outputTruncated,
        })
      })
    })
  }
}

function sanitizedGitEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env }
  for (const key of Object.keys(environment)) {
    if (key.toUpperCase().startsWith('GIT_')) delete environment[key]
  }
  return environment
}
