import { describe, expect, it, vi } from 'vitest'
import { runAdvisor, type AdvisorProjectTools } from './advisor'

function streamResponse(lines: unknown[]): Response {
  return new Response(`${lines.map((line) => JSON.stringify(line)).join('\n')}\n`, { status: 200 })
}

function projectTools(): AdvisorProjectTools & Record<string, ReturnType<typeof vi.fn>> {
  return {
    listFiles: vi.fn().mockResolvedValue(['src/index.ts', 'src/service.ts']),
    readFile: vi.fn().mockResolvedValue('one\ntwo\nthree\nfour'),
    search: vi.fn().mockResolvedValue([{ path: 'src/index.ts', line: 2, column: 1, text: 'two' }]),
    gitStatus: vi.fn().mockResolvedValue(' M src/index.ts\n'),
    gitDiff: vi.fn().mockResolvedValue('diff --git a/src/index.ts b/src/index.ts\n+change\n')
  }
}

describe('runAdvisor', () => {
  it('investigates with only read-only project tools and returns an auditable trace', async () => {
    const project = projectTools()
    const progress = vi.fn()
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(streamResponse([{
        message: {
          tool_calls: [
            { function: { name: 'list_files', arguments: {} } },
            { function: { name: 'read_file', arguments: { path: 'src/index.ts', startLine: 2, endLine: 3 } } },
            { function: { name: 'search_files', arguments: { query: 'two', path: 'src' } } },
            { function: { name: 'git_diff', arguments: { staged: true } } },
            { function: { name: 'write_file', arguments: { path: 'src/index.ts', content: 'unsafe' } } }
          ]
        },
        done: true
      }]))
      .mockResolvedValueOnce(streamResponse([{
        message: { content: 'Conclusion : conserver la frontière actuelle.\n\nPreuve : `src/index.ts:2`.' },
        done: true
      }]))

    const result = await runAdvisor({
      model: 'advisor-model',
      question: 'Quelle architecture choisir ?',
      project,
      signal: new AbortController().signal,
      isGitRepository: true,
      fetcher,
      onProgress: progress
    })

    const firstRequest = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body)) as {
      tools: Array<{ function: { name: string } }>
    }
    const secondRequest = String(fetcher.mock.calls[1]?.[1]?.body)
    expect(firstRequest.tools.map((tool) => tool.function.name)).toEqual([
      'list_files', 'read_file', 'search_files', 'git_status', 'git_diff'
    ])
    expect(firstRequest.tools.map((tool) => tool.function.name)).not.toContain('write_file')
    expect(project.listFiles).toHaveBeenCalledWith(undefined)
    expect(project.readFile).toHaveBeenCalledWith('src/index.ts')
    expect(project.search).toHaveBeenCalledWith('two', 'src')
    expect(project.gitDiff).toHaveBeenCalledWith(true)
    expect(secondRequest).toContain('two\\nthree')
    expect(secondRequest).toContain('write_file n’est pas autorisé en lecture seule')
    expect(result).toMatchObject({
      model: 'advisor-model',
      advice: expect.stringContaining('conserver la frontière'),
      trace: [
        { tool: 'list_files', status: 'done' },
        { tool: 'read_file', status: 'done' },
        { tool: 'search_files', status: 'done' },
        { tool: 'git_diff', status: 'done', label: 'Changements Git indexés' },
        { tool: 'write_file', status: 'error', summary: expect.stringContaining('lecture seule') }
      ]
    })
    expect(progress).toHaveBeenCalledWith('Conseiller · lecture de src/index.ts')
  })

  it('stops investigating after the bounded number of rounds and forces a final synthesis', async () => {
    const project = projectTools()
    const toolTurn = streamResponse([{
      message: { tool_calls: [{ function: { name: 'git_status', arguments: {} } }] },
      done: true
    }])
    const fetcher = vi.fn<typeof fetch>()
    for (let index = 0; index < 6; index += 1) fetcher.mockResolvedValueOnce(toolTurn.clone())
    fetcher.mockResolvedValueOnce(streamResponse([{ message: { content: 'Avis final borné.' }, done: true }]))

    const result = await runAdvisor({
      model: 'advisor-model',
      question: 'Vérifie ce changement.',
      project,
      signal: new AbortController().signal,
      isGitRepository: true,
      fetcher
    })

    expect(fetcher).toHaveBeenCalledTimes(7)
    expect(project.gitStatus).toHaveBeenCalledTimes(6)
    expect(result.advice).toBe('Avis final borné.')
    const finalRequest = JSON.parse(String(fetcher.mock.calls[6]?.[1]?.body)) as { tools?: unknown }
    expect(finalRequest.tools).toBeUndefined()
  })
})
