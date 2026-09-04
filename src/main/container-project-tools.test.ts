import { describe, expect, it, vi } from 'vitest'
import type { WorkerProfile } from '../shared/contracts'
import type { AgentProjectTools } from './agent'
import { ContainerProjectTools, createAgentProjectTools } from './container-project-tools'
import type { CommandResult, executeInWorkerContainer } from './runtime'

const profile: WorkerProfile = {
  projectPath: 'C:\\project', mode: 'container', runtime: 'docker', cpuLimit: 2,
  memoryMb: 4096, storageGb: 20, automaticCpuMemory: true,
  image: 'node:22-bookworm', network: 'none', maxConcurrentWorkers: 2,
  updatedAt: '2026-01-01'
}

function result(stdout = ''): CommandResult {
  return { exitCode: 0, signal: null, stdout, stderr: '', timedOut: false, outputTruncated: false }
}

describe('ContainerProjectTools', () => {
  it('fails closed instead of returning host project tools for a direct profile', () => {
    const direct = {} as AgentProjectTools

    expect(() => createAgentProjectTools(
      { ...profile, mode: 'direct', runtime: null },
      'thread-123',
      '/project',
      direct
    )).toThrow('accès direct')
  })

  it('routes reads, writes, searches, Git, and commands through the persistent container', async () => {
    const executor = vi.fn<typeof executeInWorkerContainer>()
      .mockResolvedValueOnce(result('avant\n'))
      .mockResolvedValueOnce(result())
      .mockResolvedValueOnce(result('[{"path":"src/a.ts","line":1,"column":1,"text":"avant"}]'))
      .mockResolvedValueOnce(result(' M src/a.ts\n'))
      .mockResolvedValueOnce(result('diff'))
      .mockResolvedValueOnce(result('tests ok'))
    const tools = new ContainerProjectTools(profile, 'thread-123', 'C:\\project', null, executor)

    await expect(tools.writeFile('src/a.ts', 'après\n')).resolves.toMatchObject({ path: 'src/a.ts' })
    await expect(tools.search('avant', 'src')).resolves.toHaveLength(1)
    await expect(tools.gitStatus()).resolves.toContain('src/a.ts')
    await expect(tools.gitDiff()).resolves.toBe('diff')
    await expect(tools.runCommand('pnpm', ['test'])).resolves.toMatchObject({ stdout: 'tests ok' })

    expect(executor).toHaveBeenCalledTimes(6)
    expect(executor.mock.calls[1]?.[0]).toMatchObject({
      runtime: 'docker',
      input: 'après\n',
      network: 'none',
      cpuLimit: 2,
      memoryLimit: '4096m'
    })
    expect(executor.mock.calls[3]?.[0].command).toEqual([
      'git', '-c', 'core.fsmonitor=false', '-c', 'safe.directory=/workspace', 'status', '--short', '--untracked-files=all'
    ])
    expect(executor.mock.calls[4]?.[0].command).toEqual([
      'git', '-c', 'core.fsmonitor=false', '-c', 'safe.directory=/workspace',
      'diff', '--no-ext-diff', '--no-textconv'
    ])
    expect(executor.mock.calls[5]?.[0].command).toEqual(['pnpm', 'test'])
  })

  it('deletes files through the persistent container', async () => {
    const executor = vi.fn<typeof executeInWorkerContainer>()
      .mockResolvedValueOnce(result('line one\nline two\n'))
      .mockResolvedValueOnce(result())
    const tools = new ContainerProjectTools(profile, 'thread-123', 'C:\\project', null, executor)

    await expect(tools.deleteFile('src/a.ts')).resolves.toEqual({
      path: 'src/a.ts',
      added: 0,
      removed: 2
    })
    expect(executor).toHaveBeenCalledTimes(2)
    expect(executor.mock.calls[1]?.[0].command).toContain('src/a.ts')
    expect(executor.mock.calls[1]?.[0].command.join('\n')).toContain('fs.rmdirSync(directory)')
    expect(executor.mock.calls[1]?.[0].command.join('\n')).toContain('directory !== root')
  })

  it('applies Git metadata protection to every container file operation', async () => {
    const executor = vi.fn<typeof executeInWorkerContainer>().mockResolvedValue(result())
    const tools = new ContainerProjectTools(profile, 'thread-123', 'C:\\project', null, executor)

    await tools.readFile('.git/config')

    const script = executor.mock.calls[0]?.[0].command.join('\n') ?? ''
    expect(script).toContain("part.toLowerCase() === '.git'")
    expect(script).toContain('Métadonnées Git protégées')
  })

  it('rejects directories before trying to read them as files in the container', async () => {
    const executor = vi.fn<typeof executeInWorkerContainer>().mockResolvedValue(result())
    const tools = new ContainerProjectTools(profile, 'thread-123', 'C:\\project', null, executor)

    await tools.readFile('assets')

    expect(executor.mock.calls[0]?.[0].command.join('\n')).toContain("lstatSync(target).isFile()")
  })

  it('returns reviewable changes and line counts for untracked files', async () => {
    const executor = vi.fn<typeof executeInWorkerContainer>()
      .mockResolvedValueOnce(result('?? index.html\0'))
      .mockResolvedValueOnce(result('diff --git a/index.html b/index.html\n--- /dev/null\n+++ b/index.html\n@@ -0,0 +1,2 @@\n+<h1>Minecraft</h1>\n+<p>Bienvenue</p>\n'))
    const tools = new ContainerProjectTools(profile, 'thread-123', 'C:\\project', null, executor)

    await expect(tools.gitChanges()).resolves.toEqual([{
      path: 'index.html',
      kind: 'added',
      added: 2,
      removed: 0,
      diff: expect.stringContaining('+<h1>Minecraft</h1>')
    }])
    expect(executor.mock.calls[0]?.[0].command).toContain('--porcelain=v1')
    expect(executor.mock.calls[1]?.[0].command).toEqual([
      'git', 'diff', '--no-index', '--no-ext-diff', '--no-textconv', '--', '/dev/null', 'index.html'
    ])
  })
})
