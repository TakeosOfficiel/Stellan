export type FileStatus = 'M' | 'A' | 'D'

export type FileTreeNode = {
  name: string
  path: string
  type: 'directory' | 'file'
  status: FileStatus | null
  children: FileTreeNode[]
}

function statusPriority(status: FileStatus | null): number {
  if (status === 'M') return 3
  if (status === 'A') return 2
  if (status === 'D') return 1
  return 0
}

function strongestStatus(left: FileStatus | null, right: FileStatus | null): FileStatus | null {
  return statusPriority(left) >= statusPriority(right) ? left : right
}

export function parseFileStatuses(status: string): Map<string, FileStatus> {
  const statuses = new Map<string, FileStatus>()
  for (const line of status.split('\n')) {
    if (line.length < 4) continue
    const code = line.slice(0, 2)
    const path = line.slice(3).trim().split(' -> ').at(-1)
    if (!path) continue
    const fileStatus: FileStatus = code.includes('A') || code.includes('?')
      ? 'A'
      : code.includes('D')
        ? 'D'
        : 'M'
    statuses.set(path.replaceAll('\\', '/'), fileStatus)
  }
  return statuses
}

export function buildFileTree(files: readonly string[], status: string, directories: readonly string[] = []): FileTreeNode[] {
  const statuses = parseFileStatuses(status)
  const roots: FileTreeNode[] = []

  for (const originalPath of directories) {
    const directoryPath = originalPath.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/$/, '')
    const parts = directoryPath.split('/').filter(Boolean)
    let children = roots
    let currentPath = ''
    for (const name of parts) {
      currentPath = currentPath ? `${currentPath}/${name}` : name
      let node = children.find((entry) => entry.name === name && entry.type === 'directory')
      if (!node) {
        node = { name, path: currentPath, type: 'directory', status: null, children: [] }
        children.push(node)
      }
      children = node.children
    }
  }

  for (const originalPath of new Set([...files, ...statuses.keys()])) {
    const filePath = originalPath.replaceAll('\\', '/').replace(/^\.\//, '')
    const parts = filePath.split('/').filter(Boolean)
    let children = roots
    let currentPath = ''
    for (let index = 0; index < parts.length; index += 1) {
      const name = parts[index] as string
      currentPath = currentPath ? `${currentPath}/${name}` : name
      const type = index === parts.length - 1 ? 'file' : 'directory'
      let node = children.find((entry) => entry.name === name && entry.type === type)
      if (!node) {
        node = { name, path: currentPath, type, status: null, children: [] }
        children.push(node)
      }
      if (type === 'file') node.status = statuses.get(filePath) ?? null
      children = node.children
    }
  }

  const finalize = (nodes: FileTreeNode[]): FileStatus | null => {
    nodes.sort((left, right) => (
      left.type === right.type
        ? left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: 'base' })
        : left.type === 'directory' ? -1 : 1
    ))
    let aggregate: FileStatus | null = null
    for (const node of nodes) {
      if (node.type === 'directory') node.status = finalize(node.children)
      aggregate = strongestStatus(aggregate, node.status)
    }
    return aggregate
  }
  finalize(roots)
  return roots
}
