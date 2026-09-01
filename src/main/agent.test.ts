import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runCodingAgent } from './agent'
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
})
