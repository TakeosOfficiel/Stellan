import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { compactConversation, MAX_CONVERSATION_CHARACTERS, runCodingAgent } from './agent'
import { ProjectTools } from './project-tools'

const temporaryDirectories: string[] = []

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
})
