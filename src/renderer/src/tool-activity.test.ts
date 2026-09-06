import { describe, expect, it } from 'vitest'
import { assistantActivityTimeline, fileEditActivity, toolActivityDetailSections } from './WorkspaceView'

describe('assistant activity timeline', () => {
  it('keeps tool actions between the text emitted before and after them', () => {
    const activity = {
      id: 'request-1:tool-1',
      requestId: 'request-1',
      tool: 'write_file',
      status: 'done' as const,
      input: JSON.stringify({ path: 'index.html', content: '<main />' }),
      output: 'ok',
      assistantContent: 'Je commence par le HTML.',
      expanded: false
    }

    expect(assistantActivityTimeline(
      'Je commence par le HTML.\n\nLe contrat est posé.',
      [activity]
    )).toEqual([
      { content: 'Je commence par le HTML.', activities: [activity] },
      { content: '\n\nLe contrat est posé.', activities: [] }
    ])
  })

  it('groups parallel actions at the same point in the conversation', () => {
    const first = {
      id: 'request-1:agent-1', requestId: 'request-1', tool: 'worker:Assets', status: 'running' as const,
      input: null, output: null, assistantContent: 'Je lance deux workers.', expanded: false
    }
    const second = {
      id: 'request-1:agent-2', requestId: 'request-1', tool: 'worker:CSS', status: 'running' as const,
      input: null, output: null, assistantContent: '', expanded: false
    }

    expect(assistantActivityTimeline('Je lance deux workers.', [first, second]))
      .toEqual([{ content: 'Je lance deux workers.', activities: [first, second] }])
  })

  it('preserves alternating text and action groups', () => {
    const first = {
      id: 'request-1:tool-1', requestId: 'request-1', tool: 'write_file', status: 'done' as const,
      input: null, output: null, assistantContent: 'Je prépare le HTML.', expanded: false
    }
    const second = {
      id: 'request-1:tool-2', requestId: 'request-1', tool: 'worker:Assets', status: 'done' as const,
      input: null, output: null, assistantContent: 'Je lance ensuite les assets.', expanded: false
    }

    expect(assistantActivityTimeline(
      'Je prépare le HTML.\nJe lance ensuite les assets.\nLe jeu est prêt.',
      [first, second]
    )).toEqual([
      { content: 'Je prépare le HTML.', activities: [first] },
      { content: '\nJe lance ensuite les assets.', activities: [second] },
      { content: '\nLe jeu est prêt.', activities: [] }
    ])
  })
})

describe('file edit activity', () => {
  it('hides completed writes that changed zero lines', () => {
    expect(fileEditActivity({
      id: 'activity-1',
      requestId: 'request-1',
      tool: 'write_file',
      status: 'done',
      input: JSON.stringify({ path: 'index.html', content: '<h1>Boutique</h1>' }),
      output: JSON.stringify({ path: 'index.html', added: 0, removed: 0, unchanged: true }),
      expanded: false
    })).toBeNull()
  })

  it('keeps a write that has an actual diff', () => {
    expect(fileEditActivity({
      id: 'activity-2',
      requestId: 'request-1',
      tool: 'write_file',
      status: 'done',
      input: JSON.stringify({ path: 'styles.css', content: 'body {}' }),
      output: JSON.stringify({ path: 'styles.css', added: 1, removed: 0 }),
      expanded: false
    })).toMatchObject({ path: 'styles.css', added: 1, removed: 0 })
  })

  it('shows an executed command and its useful output without a JSON envelope', () => {
    expect(toolActivityDetailSections({
      id: 'activity-3',
      requestId: 'request-1',
      tool: 'run_command',
      status: 'done',
      input: JSON.stringify({ command: 'ls', args: ['-la'] }),
      output: JSON.stringify({
        exitCode: 0,
        stdout: 'index.html\nassets',
        stderr: '',
        timedOut: false,
        outputTruncated: false
      }),
      expanded: true
    })).toEqual([
      { label: 'Commande', content: 'ls -la' },
      { label: 'Sortie', content: 'index.html\nassets\nCode de sortie : 0' }
    ])
  })
})
