import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { compactConversation, MAX_CONVERSATION_CHARACTERS, normalizeWorkerPath, runCodingAgent } from './agent'
import { ProjectTools } from './project-tools'

const temporaryDirectories: string[] = []

describe('normalizeWorkerPath', () => {
  it('collapses Windows case and trailing-dot aliases without changing Linux case', () => {
    expect(normalizeWorkerPath('./Src/Index.ts. ', 'win32')).toBe('src/index.ts')
    expect(normalizeWorkerPath('src\\INDEX.ts', 'win32')).toBe('src/index.ts')
    expect(normalizeWorkerPath('Src/Index.ts', 'linux')).toBe('Src/Index.ts')
  })
})

function streamResponse(lines: unknown[]): Response {
  const body = lines.map((line) => JSON.stringify(line)).join('\n') + '\n'
  return new Response(body, { status: 200 })
}

afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(temporaryDirectories.splice(0).map(
    (directory) => rm(directory, { recursive: true, force: true })
  ))
})

describe('runCodingAgent', () => {
  it('executes a read-only tool and continues to a final answer', async () => {
    const projectPath = await mkdtemp(join(tmpdir(), 'local-agent-agent-'))
    temporaryDirectories.push(projectPath)
    await writeFile(join(projectPath, 'hello.txt'), 'contenu local')
    const project = await ProjectTools.create(projectPath)
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(streamResponse([{
        message: {
          content: '',
          tool_calls: [{ function: { name: 'read_file', arguments: { path: 'hello.txt' } } }]
        },
        done: true
      }]))
      .mockResolvedValueOnce(streamResponse([
        { message: { content: 'Le fichier contient du contenu local.' }, done: true }
      ]))
    vi.stubGlobal('fetch', fetcher)
    const onContent = vi.fn()
    const onTool = vi.fn()

    await runCodingAgent({
      model: 'test-model',
      messages: [{ role: 'user', content: 'Lis le fichier.' }],
      project,
      signal: new AbortController().signal,
      onContent,
      onTool,
      authorize: vi.fn().mockResolvedValue(false)
    })

    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(onTool).toHaveBeenNthCalledWith(1, 'read_file', 'running')
    expect(onTool).toHaveBeenNthCalledWith(2, 'read_file', 'done')
    expect(onContent).toHaveBeenCalledWith('Le fichier contient du contenu local.')
  })

  it('keeps tool-turn commentary hidden until tools finish and publishes only the final answer', async () => {
    const projectPath = await mkdtemp(join(tmpdir(), 'local-agent-agent-'))
    temporaryDirectories.push(projectPath)
    await writeFile(join(projectPath, 'hello.txt'), 'contenu local')
    const project = await ProjectTools.create(projectPath)
    vi.stubGlobal('fetch', vi.fn<typeof fetch>()
      .mockResolvedValueOnce(streamResponse([{
        message: {
          content: 'Je vais lire le fichier.',
          tool_calls: [{ function: { name: 'read_file', arguments: { path: 'hello.txt' } } }]
        },
        done: true
      }]))
      .mockResolvedValueOnce(streamResponse([{ message: { content: 'Voici le résultat final.' }, done: true }])))
    const onContent = vi.fn()

    await runCodingAgent({
      model: 'test-model',
      messages: [{ role: 'user', content: 'Lis le fichier.' }],
      project,
      signal: new AbortController().signal,
      onContent,
      onTool: vi.fn(),
      authorize: vi.fn().mockResolvedValue(false)
    })

    expect(onContent).toHaveBeenCalledTimes(1)
    expect(onContent).toHaveBeenCalledWith('Voici le résultat final.')
  })

  it('deletes files with the dedicated tool instead of a shell command', async () => {
    const projectPath = await mkdtemp(join(tmpdir(), 'local-agent-agent-'))
    temporaryDirectories.push(projectPath)
    await writeFile(join(projectPath, 'obsolete.css'), 'one\ntwo\n')
    const project = await ProjectTools.create(projectPath)
    vi.stubGlobal('fetch', vi.fn<typeof fetch>()
      .mockResolvedValueOnce(streamResponse([{
        message: { tool_calls: [{ function: { name: 'delete_file', arguments: { path: 'obsolete.css' } } }] },
        done: true
      }]))
      .mockResolvedValueOnce(streamResponse([{ message: { content: 'Le fichier a été supprimé.' }, done: true }])))
    const authorize = vi.fn().mockResolvedValue(true)

    await runCodingAgent({
      model: 'test-model',
      messages: [{ role: 'user', content: 'Supprime obsolete.css.' }],
      project,
      signal: new AbortController().signal,
      onContent: vi.fn(),
      onTool: vi.fn(),
      authorize
    })

    expect(authorize).toHaveBeenCalledWith('delete_file', 'Supprimer obsolete.css')
    await expect(readFile(join(projectPath, 'obsolete.css'), 'utf8')).rejects.toThrow()
  })

  it('does not expose Git tools for an ordinary folder', async () => {
    const projectPath = await mkdtemp(join(tmpdir(), 'local-agent-agent-'))
    temporaryDirectories.push(projectPath)
    const project = await ProjectTools.create(projectPath)
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(streamResponse([
      { message: { content: 'Projet analysé.' }, done: true }
    ]))
    vi.stubGlobal('fetch', fetcher)

    await runCodingAgent({
      model: 'test-model',
      messages: [{ role: 'user', content: 'Analyse ce projet.' }],
      project,
      signal: new AbortController().signal,
      onContent: vi.fn(),
      onTool: vi.fn(),
      authorize: vi.fn().mockResolvedValue(false),
      isGitRepository: false
    })

    const body = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body)) as {
      tools: Array<{ function: { name: string } }>
    }
    expect(body.tools.map((tool) => tool.function.name)).not.toContain('git_status')
    expect(body.tools.map((tool) => tool.function.name)).not.toContain('git_diff')
  })

  it('awaits durable tool lifecycle callbacks before publishing live statuses', async () => {
    const projectPath = await mkdtemp(join(tmpdir(), 'local-agent-agent-'))
    temporaryDirectories.push(projectPath)
    await writeFile(join(projectPath, 'hello.txt'), 'contenu local')
    const project = await ProjectTools.create(projectPath)
    vi.stubGlobal('fetch', vi.fn<typeof fetch>()
      .mockResolvedValueOnce(streamResponse([{
        message: {
          tool_calls: [{ function: { name: 'read_file', arguments: { path: 'hello.txt' } } }]
        },
        done: true
      }]))
      .mockResolvedValueOnce(streamResponse([{ message: { content: 'Terminé.' }, done: true }])))
    const order: string[] = []

    await runCodingAgent({
      model: 'test-model',
      messages: [{ role: 'user', content: 'Lis le fichier.' }],
      project,
      signal: new AbortController().signal,
      onContent: vi.fn(),
      onTool: (_tool, status) => order.push(`ipc:${status}`),
      onToolEvent: async (event) => {
        await Promise.resolve()
        order.push(`stored:${event.type === 'started' ? 'running' : event.status}`)
      },
      authorize: vi.fn().mockResolvedValue(false)
    })

    expect(order).toEqual([
      'stored:running',
      'ipc:running',
      'stored:done',
      'ipc:done'
    ])
  })

  it('does not write when the user refuses authorization', async () => {
    const projectPath = await mkdtemp(join(tmpdir(), 'local-agent-agent-'))
    temporaryDirectories.push(projectPath)
    await writeFile(join(projectPath, 'hello.txt'), 'original')
    const project = await ProjectTools.create(projectPath)
    vi.stubGlobal('fetch', vi.fn<typeof fetch>()
      .mockResolvedValueOnce(streamResponse([{
        message: {
          tool_calls: [{
            function: {
              name: 'write_file',
              arguments: { path: 'hello.txt', content: 'modifié' }
            }
          }]
        },
        done: true
      }]))
      .mockResolvedValueOnce(streamResponse([
        { message: { content: 'La modification a été refusée.' }, done: true }
      ])))

    await runCodingAgent({
      model: 'test-model',
      messages: [{ role: 'user', content: 'Modifie le fichier.' }],
      project,
      signal: new AbortController().signal,
      onContent: vi.fn(),
      onTool: vi.fn(),
      authorize: vi.fn().mockResolvedValue(false)
    })

    await expect(readFile(join(projectPath, 'hello.txt'), 'utf8')).resolves.toBe('original')
  })

  it('always reports completion when a model ends silently after writing', async () => {
    const projectPath = await mkdtemp(join(tmpdir(), 'local-agent-agent-'))
    temporaryDirectories.push(projectPath)
    const project = await ProjectTools.create(projectPath)
    vi.stubGlobal('fetch', vi.fn<typeof fetch>()
      .mockResolvedValueOnce(streamResponse([{
        message: {
          tool_calls: [{
            function: {
              name: 'write_file',
              arguments: { path: 'style.css', content: 'body { color: red; }\n' }
            }
          }]
        },
        done: true
      }]))
      .mockResolvedValueOnce(streamResponse([{ message: { content: '' }, done: true }])))
    const onContent = vi.fn()

    await runCodingAgent({
      model: 'test-model',
      messages: [{ role: 'user', content: 'Anime le texte.' }],
      project,
      signal: new AbortController().signal,
      onContent,
      onTool: vi.fn(),
      authorize: vi.fn().mockResolvedValue(true)
    })

    expect(onContent).toHaveBeenCalledWith('Terminé. J’ai modifié ou supprimé 1 fichier : `style.css`.')
    await expect(readFile(join(projectPath, 'style.css'), 'utf8')).resolves.toBe('body { color: red; }\n')
  })

  it('asks the model to resume instead of claiming success after read-only tools', async () => {
    const projectPath = await mkdtemp(join(tmpdir(), 'local-agent-agent-'))
    temporaryDirectories.push(projectPath)
    await writeFile(join(projectPath, 'style.css'), '.title { opacity: 0; }\n')
    const project = await ProjectTools.create(projectPath)
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(streamResponse([{
        message: { tool_calls: [{ function: { name: 'read_file', arguments: { path: 'style.css' } } }] },
        done: true
      }]))
      .mockResolvedValueOnce(streamResponse([{ message: { content: '' }, done: true }]))
      .mockResolvedValueOnce(streamResponse([{
        message: { tool_calls: [{
          function: {
            name: 'write_file',
            arguments: { path: 'style.css', content: '.title { opacity: 1; }\n' }
          }
        }] },
        done: true
      }]))
      .mockResolvedValueOnce(streamResponse([{ message: { content: 'Animation retirée et texte restauré.' }, done: true }]))
    vi.stubGlobal('fetch', fetcher)
    const onContent = vi.fn()

    await runCodingAgent({
      model: 'test-model',
      messages: [{ role: 'user', content: 'Retire l’animation qui masque le texte.' }],
      project,
      signal: new AbortController().signal,
      onContent,
      onTool: vi.fn(),
      authorize: vi.fn().mockResolvedValue(true)
    })

    expect(fetcher).toHaveBeenCalledTimes(4)
    expect(String(fetcher.mock.calls[2]?.[1]?.body)).toContain('sans modification de fichier confirmée')
    expect(onContent).toHaveBeenCalledWith('Animation retirée et texte restauré.')
    expect(onContent).not.toHaveBeenCalledWith('Terminé. Les actions demandées ont été exécutées.')
    await expect(readFile(join(projectPath, 'style.css'), 'utf8')).resolves.toBe('.title { opacity: 1; }\n')
  })

  it('keeps recent context within a bounded request size', async () => {
    const projectPath = await mkdtemp(join(tmpdir(), 'local-agent-agent-'))
    temporaryDirectories.push(projectPath)
    const project = await ProjectTools.create(projectPath)
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(streamResponse([
      { message: { content: 'Terminé.' }, done: true }
    ]))
    vi.stubGlobal('fetch', fetcher)

    await runCodingAgent({
      model: 'test-model',
      messages: [
        ...Array.from({ length: 10 }, (_, index) => ({
          role: index % 2 === 0 ? 'user' as const : 'assistant' as const,
          content: `${index}: ${'x'.repeat(15_000)}`
        })),
        { role: 'user', content: 'message récent à conserver' }
      ],
      project,
      signal: new AbortController().signal,
      onContent: vi.fn(),
      onTool: vi.fn(),
      authorize: vi.fn().mockResolvedValue(false)
    })

    const request = fetcher.mock.calls[0]?.[1]
    const body = String(request?.body)
    expect(body.length).toBeLessThan(70_000)
    expect(body).toContain('message récent à conserver')
    expect(body).not.toContain('0: xxxxx')
  })

  it('deterministically bounds an oversized newest message without semantic summarization', () => {
    const newestSuffix = 'suffixe récent à conserver'
    const compacted = compactConversation([
      { role: 'system', content: 'instruction système' },
      { role: 'user', content: `ancien ${'a'.repeat(70_000)}` },
      { role: 'assistant', content: 'ancienne réponse' },
      { role: 'user', content: `${'x'.repeat(90_000)}${newestSuffix}` }
    ])

    expect(JSON.stringify(compacted).length).toBeLessThanOrEqual(MAX_CONVERSATION_CHARACTERS)
    expect(compacted).toHaveLength(2)
    expect(compacted[1]?.content).toContain('[début tronqué]')
    expect(compacted[1]?.content).toContain(newestSuffix)
    expect(compacted[1]?.content).not.toContain('ancien')
  })

  it('routes authorized commands through the configured worker executor', async () => {
    const projectPath = await mkdtemp(join(tmpdir(), 'local-agent-agent-'))
    temporaryDirectories.push(projectPath)
    const project = await ProjectTools.create(projectPath)
    const workerCommand = vi.fn().mockResolvedValue({ exitCode: 0, stdout: 'worker output' })
    vi.stubGlobal('fetch', vi.fn<typeof fetch>()
      .mockResolvedValueOnce(streamResponse([{
        message: { tool_calls: [{ function: { name: 'run_command', arguments: { command: 'npm', args: ['test'] } } }] },
        done: true
      }]))
      .mockResolvedValueOnce(streamResponse([{ message: { content: 'Tests terminés.' }, done: true }])))

    await runCodingAgent({
      model: 'test-model',
      messages: [{ role: 'user', content: 'Lance les tests.' }],
      project,
      signal: new AbortController().signal,
      onContent: vi.fn(),
      onTool: vi.fn(),
      authorize: vi.fn().mockResolvedValue(true),
      runCommand: workerCommand
    })

    expect(workerCommand).toHaveBeenCalledWith(
      'npm',
      ['test'],
      expect.objectContaining({ timeoutMs: 120_000 })
    )
  })

  it('delegates disjoint files to automatic workers and returns their results', async () => {
    const projectPath = await mkdtemp(join(tmpdir(), 'local-agent-agent-'))
    temporaryDirectories.push(projectPath)
    const project = await ProjectTools.create(projectPath)
    const tasks = [
      { title: 'HTML', instructions: 'Crée la structure.', files: ['index.html'] },
      { title: 'CSS', instructions: 'Crée le style.', files: ['styles.css'] }
    ]
    const spawnWorkers = vi.fn().mockResolvedValue(tasks.map((task) => ({
      title: task.title,
      summary: 'Terminé',
      files: task.files
    })))
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(streamResponse([{
        message: { tool_calls: [{ function: { name: 'create_workers', arguments: { tasks } } }] },
        done: true
      }]))
      .mockResolvedValueOnce(streamResponse([{ message: { content: 'Les deux workers ont terminé.' }, done: true }]))
    vi.stubGlobal('fetch', fetcher)
    const authorize = vi.fn().mockResolvedValue(false)

    await runCodingAgent({
      model: 'test-model',
      messages: [{ role: 'user', content: 'Crée le HTML et le CSS.' }],
      project,
      signal: new AbortController().signal,
      onContent: vi.fn(),
      onTool: vi.fn(),
      authorize,
      spawnWorkers
    })

    expect(spawnWorkers).toHaveBeenCalledWith(tasks)
    expect(authorize).not.toHaveBeenCalled()
    expect(String(fetcher.mock.calls[0]?.[1]?.body)).toContain('create_workers')
  })

  it('rejects worker plans that assign the same file twice', async () => {
    const projectPath = await mkdtemp(join(tmpdir(), 'local-agent-agent-'))
    temporaryDirectories.push(projectPath)
    const project = await ProjectTools.create(projectPath)
    const spawnWorkers = vi.fn()
    vi.stubGlobal('fetch', vi.fn<typeof fetch>()
      .mockResolvedValueOnce(streamResponse([{
        message: { tool_calls: [{ function: { name: 'create_workers', arguments: { tasks: [
          { title: 'A', instructions: 'A', files: ['index.html'] },
          { title: 'B', instructions: 'B', files: ['./index.html'] }
        ] } } }] },
        done: true
      }]))
      .mockResolvedValueOnce(streamResponse([{ message: { content: 'Plan refusé.' }, done: true }])))

    await runCodingAgent({
      model: 'test-model',
      messages: [{ role: 'user', content: 'Travaille en parallèle.' }],
      project,
      signal: new AbortController().signal,
      onContent: vi.fn(),
      onTool: vi.fn(),
      authorize: vi.fn().mockResolvedValue(true),
      spawnWorkers
    })

    expect(spawnWorkers).not.toHaveBeenCalled()
  })
})
