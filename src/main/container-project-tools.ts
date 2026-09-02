import path from 'node:path'
import { diffLines } from 'diff'
import type { WorkerProfile } from '../shared/contracts'
import type { AgentProjectTools } from './agent'
import type { FileWriteResult, SearchResult } from './project-tools'
import { executeInWorkerContainer, type CommandResult } from './runtime'

type ContainerExecutor = typeof executeInWorkerContainer

const SAFE_PATH_SCRIPT = `
const fs = require('node:fs'); const path = require('node:path');
const rel = process.argv[1] || '.'; if (path.isAbsolute(rel) || rel.includes('\\0') || rel.split(/[\\\\/]/).includes('..')) throw new Error('Chemin de projet invalide');
const root = '/workspace'; const target = path.resolve(root, rel); if (target !== root && !target.startsWith(root + path.sep)) throw new Error('Sortie du projet refusée');
for (let current = root, parts = path.relative(root, target).split(path.sep).filter(Boolean), i = 0; i < parts.length; i++) { current = path.join(current, parts[i]); if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error('Lien symbolique refusé'); }
`

export class ContainerProjectTools implements AgentProjectTools {
  constructor(
    private readonly profile: WorkerProfile,
    private readonly threadId: string,
    private readonly projectPath: string,
    private readonly git: { directory: string; commonDirectory: string } | null,
    private readonly executor: ContainerExecutor = executeInWorkerContainer
  ) {
    if (profile.mode !== 'container' || !profile.runtime) throw new Error('Profil Docker invalide.')
  }

  private execute(command: readonly string[], input?: string, timeoutMs = 30_000): Promise<CommandResult> {
    return this.executor({
      runtime: this.profile.runtime as 'docker' | 'podman',
      threadId: this.threadId,
      projectPath: this.projectPath,
      image: this.profile.image,
      command,
      cpuLimit: this.profile.cpuLimit,
      memoryLimit: `${this.profile.memoryMb}m`,
      network: this.profile.network,
      timeoutMs,
      input,
      ...(this.git ? {
        gitDirectory: this.git.directory,
        gitCommonDirectory: this.git.commonDirectory
      } : {})
    })
  }

  private async node(script: string, args: string[], input?: string): Promise<string> {
    const result = await this.execute(['node', '-e', `${SAFE_PATH_SCRIPT}\n${script}`, ...args], input)
    if (result.exitCode !== 0) throw new Error(result.stderr.trim() || 'Outil Docker en échec.')
    if (result.outputTruncated) throw new Error('Sortie de l’outil Docker trop volumineuse.')
    return result.stdout
  }

  async listFiles(relativePath = '.'): Promise<string[]> {
    const output = await this.node(`
const files = []; function walk(dir) { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) { if (entry.name === '.git') continue; const file = path.join(dir, entry.name); if (entry.isSymbolicLink()) continue; if (entry.isDirectory()) walk(file); else if (entry.isFile()) files.push(path.relative(root, file).split(path.sep).join('/')); if (files.length >= 5000) return; } } walk(target); process.stdout.write(JSON.stringify(files.sort()));
`, [relativePath])
    return JSON.parse(output) as string[]
  }

  async readFile(relativePath: string): Promise<string> {
    return this.node(`process.stdout.write(fs.readFileSync(target, 'utf8'));`, [relativePath])
  }

  async search(query: string, relativePath = '.'): Promise<SearchResult[]> {
    const output = await this.node(`
const query = process.argv[2]; const matches = []; function walk(file) { const info = fs.lstatSync(file); if (info.isSymbolicLink()) return; if (info.isDirectory()) { for (const entry of fs.readdirSync(file)) if (entry !== '.git') walk(path.join(file, entry)); return; } if (!info.isFile() || info.size > 2000000) return; let text; try { text = fs.readFileSync(file, 'utf8'); } catch { return; } if (text.includes('\\0')) return; text.split(/\\r?\\n/).forEach((line, index) => { let column = line.indexOf(query); if (column >= 0 && matches.length < 1000) matches.push({ path: path.relative(root, file).split(path.sep).join('/'), line: index + 1, column: column + 1, text: line }); }); } walk(target); process.stdout.write(JSON.stringify(matches));
`, [relativePath, query])
    return JSON.parse(output) as SearchResult[]
  }

  async writeFile(relativePath: string, content: string): Promise<FileWriteResult> {
    let previous = ''
    try { previous = await this.readFile(relativePath) } catch { /* A new file has no previous content. */ }
    const output = await this.node(`
fs.mkdirSync(path.dirname(target), { recursive: true }); const chunks = []; process.stdin.on('data', chunk => chunks.push(chunk)); process.stdin.on('end', () => fs.writeFileSync(target, Buffer.concat(chunks)));
`, [relativePath], content)
    if (output) throw new Error('Écriture Docker inattendue.')
    let added = 0
    let removed = 0
    for (const change of diffLines(previous, content)) {
      if (change.added) added += change.count ?? 0
      if (change.removed) removed += change.count ?? 0
    }
    return { path: relativePath, added, removed }
  }

  async deleteFile(relativePath: string): Promise<FileWriteResult> {
    const previous = await this.readFile(relativePath)
    const output = await this.node('if (!fs.lstatSync(target).isFile()) throw new Error("Le chemin doit désigner un fichier"); fs.unlinkSync(target);', [relativePath])
    if (output) throw new Error('Suppression Docker inattendue.')
    let removed = 0
    for (const change of diffLines(previous, '')) {
      if (change.removed) removed += change.count ?? 0
    }
    return { path: relativePath, added: 0, removed }
  }

  async gitStatus(): Promise<string> {
    return this.success(await this.execute(['git', '-c', 'core.fsmonitor=false', 'status', '--short']))
  }

  async gitDiff(staged = false): Promise<string> {
    return this.success(await this.execute(['git', '-c', 'core.fsmonitor=false', 'diff', '--no-ext-diff', '--no-textconv', ...(staged ? ['--cached'] : [])]))
  }

  runCommand(command: string, args: readonly string[] = [], options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<CommandResult> {
    return this.executor({
      runtime: this.profile.runtime as 'docker' | 'podman', threadId: this.threadId,
      projectPath: this.projectPath, image: this.profile.image, command: [command, ...args],
      cpuLimit: this.profile.cpuLimit, memoryLimit: `${this.profile.memoryMb}m`, network: this.profile.network,
      timeoutMs: options.timeoutMs, signal: options.signal,
      ...(this.git ? { gitDirectory: this.git.directory, gitCommonDirectory: this.git.commonDirectory } : {})
    })
  }

  private success(result: CommandResult): string {
    if (result.exitCode !== 0) throw new Error(result.stderr.trim() || 'Commande Docker en échec.')
    return result.stdout
  }
}

export function createAgentProjectTools(
  profile: WorkerProfile | null,
  threadId: string,
  projectPath: string,
  direct: AgentProjectTools,
  git: { directory: string; commonDirectory: string } | null = null
): AgentProjectTools {
  return profile?.mode === 'container'
    ? new ContainerProjectTools(profile, threadId, projectPath, git)
    : direct
}
