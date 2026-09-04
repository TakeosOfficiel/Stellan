import { describe, expect, it } from 'vitest'
import { buildFileTree, parseFileStatuses } from './file-tree'

describe('file tree', () => {
  it('builds sorted directories and aggregates Git state', () => {
    const tree = buildFileTree([
      'README.md',
      'src/view.tsx',
      'src/components/Button.tsx',
      'package.json'
    ], ' M src/view.tsx\n?? src/components/Button.tsx\n D removed.ts\n')

    expect(tree.map((node) => node.name)).toEqual(['src', 'package.json', 'README.md', 'removed.ts'])
    expect(tree.at(-1)).toMatchObject({ status: 'D' })
    expect(tree[0]).toMatchObject({ type: 'directory', status: 'M' })
    expect(tree[0]?.children.map((node) => [node.name, node.status])).toEqual([
      ['components', 'A'],
      ['view.tsx', 'M']
    ])
  })

  it('reads additions, deletions and the destination of renames', () => {
    expect(Object.fromEntries(parseFileStatuses(
      'A  added.ts\n D deleted.ts\nR  before.ts -> after.ts\n'
    ))).toEqual({ 'added.ts': 'A', 'deleted.ts': 'D', 'after.ts': 'M' })
  })

  it('keeps top-level ignored or empty directories visible', () => {
    const tree = buildFileTree(['src/index.ts'], '', ['node_modules', 'out', 'src'])

    expect(tree.map((node) => [node.name, node.type])).toEqual([
      ['node_modules', 'directory'],
      ['out', 'directory'],
      ['src', 'directory']
    ])
    expect(tree[2]?.children[0]).toMatchObject({ name: 'index.ts', type: 'file' })
  })

  it('hides the root Git placeholder from the project explorer', () => {
    const tree = buildFileTree(['.gitkeep', 'src/.gitkeep', 'README.md'], '?? .gitkeep\n')

    expect(tree.map((node) => node.name)).toEqual(['src', 'README.md'])
    expect(tree[0]?.children[0]).toMatchObject({ name: '.gitkeep' })
  })

  it('does not duplicate an untracked directory as a clickable file', () => {
    const tree = buildFileTree(['assets/index.html', 'assets/script.js'], '?? assets/\n', ['assets'])

    expect(tree).toHaveLength(1)
    expect(tree[0]).toMatchObject({ name: 'assets', type: 'directory' })
    expect(tree[0]?.children.map((node) => node.name)).toEqual(['index.html', 'script.js'])
  })
})
