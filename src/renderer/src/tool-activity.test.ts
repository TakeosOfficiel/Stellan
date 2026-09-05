import { describe, expect, it } from 'vitest'
import { fileEditActivity } from './WorkspaceView'

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
})
