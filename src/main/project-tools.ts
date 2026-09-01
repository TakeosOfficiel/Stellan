import { lstat, mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'

export interface SearchResult {
  path: string
  line: number
  column: number
  text: string
}

export interface CommandOptions {
  timeoutMs?: number
  maxOutputBytes?: number
}

export interface CommandResult {
  exitCode: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  outputTruncated: boolean
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

    const result = await this.run('rg', ['--files', '--hidden', '--glob', '!.git', '--', directory])
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

  async search(query: string, relativePath = '.'): Promise<SearchResult[]> {
    if (!query) throw new Error('Search query must not be empty')
    const target = await this.safePath(relativePath)
    const result = await this.run('rg', [
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
    return readFile(await this.safePath(relativePath), 'utf8')
  }

  async writeFile(relativePath: string, content: string): Promise<void> {
    const target = await this.safePath(relativePath, true)
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, content, 'utf8')
  }

  async gitStatus(): Promise<string> {
    const result = await this.run('git', ['status', '--short'])
    if (result.outputTruncated) throw new Error('Git status exceeded the output limit')
    if (result.exitCode !== 0) throw new Error(result.stderr.trim() || 'Unable to read Git status')
    return result.stdout
  }

  async gitDiff(staged = false): Promise<string> {
    const result = await this.run('git', ['diff', ...(staged ? ['--cached'] : [])])
    if (result.outputTruncated) throw new Error('Git diff exceeded the output limit')
    if (result.exitCode !== 0) throw new Error(result.stderr.trim() || 'Unable to read Git diff')
    return result.stdout
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
    if (relativePath.split(/[\\/]/).includes('..')) {
      throw new Error('Path traversal is not allowed')
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
  ): Promise<CommandResult> {
    const timeoutMs = options.timeoutMs ?? 30_000
    const maxOutputBytes = options.maxOutputBytes ?? 1_048_576
    if (timeoutMs <= 0 || maxOutputBytes <= 0) {
      throw new Error('Timeout and output limit must be positive')
    }

    return new Promise((resolve, reject) => {
      const child = spawn(command, args, { cwd: this.root, shell: false, windowsHide: true })
      const stdout: Buffer[] = []
      const stderr: Buffer[] = []
      let outputBytes = 0
      let timedOut = false
      let outputTruncated = false

      const capture = (chunks: Buffer[], chunk: Buffer): void => {
        const remaining = maxOutputBytes - outputBytes
        if (remaining > 0) chunks.push(chunk.subarray(0, remaining))
        outputBytes += Math.min(chunk.length, Math.max(remaining, 0))
        if (chunk.length > remaining) {
          outputTruncated = true
          child.kill('SIGKILL')
        }
      }
      child.stdout.on('data', (chunk: Buffer) => capture(stdout, chunk))
      child.stderr.on('data', (chunk: Buffer) => capture(stderr, chunk))
      child.once('error', reject)

      const timer = setTimeout(() => {
        timedOut = true
        child.kill('SIGKILL')
      }, timeoutMs)
      child.once('close', (exitCode) => {
        clearTimeout(timer)
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
