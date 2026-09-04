import { chmod, mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseGitStatus, ProjectTools } from './project-tools'

describe('parseGitStatus', () => {
  it('separates paths when a Windows runtime replaces NUL bytes', () => {
    expect(parseGitStatus('?? app.js\uFFFD?? index.html\uFFFD?? styles.css\uFFFD')).toEqual([
      { path: 'app.js', kind: 'added' },
      { path: 'index.html', kind: 'added' },
      { path: 'styles.css', kind: 'added' }
    ])
  })

  it('separates paths when a container transport removes NUL bytes', () => {
    expect(parseGitStatus('?? app.js?? index.html?? assets/css/style.css?? assets/js/app.js')).toEqual([
      { path: 'app.js', kind: 'added' },
      { path: 'index.html', kind: 'added' },
      { path: 'assets/css/style.css', kind: 'added' },
      { path: 'assets/js/app.js', kind: 'added' }
    ])
  })
})

describe('ProjectTools', () => {
  let project: string
  let tools: ProjectTools

  beforeEach(async () => {
    project = await mkdtemp(path.join(tmpdir(), 'project-tools-'))
    execFileSync('git', ['init', '--quiet'], { cwd: project })
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: project })
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: project })
    await mkdir(path.join(project, 'src'))
    await writeFile(path.join(project, 'src', 'hello.txt'), 'hello world\nsecond line\n')
    tools = await ProjectTools.create(project)
  })

  afterEach(async () => {
    await rm(project, { recursive: true, force: true })
  })

  it('lists, reads, writes, and searches project files', async () => {
    await expect(tools.writeFile('src/new.txt', 'find this needle\n')).resolves.toEqual({
      path: 'src/new.txt',
      added: 1,
      removed: 0
    })

    expect(await tools.listFiles()).toEqual(['src/hello.txt', 'src/new.txt'])
    expect(await tools.listDirectories()).toEqual(['src'])
    expect(await tools.readFile('src/new.txt')).toBe('find this needle\n')
    expect(await tools.search('needle')).toEqual([
      { path: 'src/new.txt', line: 1, column: 11, text: 'find this needle' },
    ])
  })

  it('counts added and removed lines for an existing file', async () => {
    await expect(tools.writeFile(
      'src/hello.txt',
      'hello changed\nsecond line\nthird line\n'
    )).resolves.toEqual({
      path: 'src/hello.txt',
      added: 2,
      removed: 1
    })
  })

  it('edits one exact occurrence and rejects ambiguous replacements', async () => {
    await expect(tools.editFile('src/hello.txt', 'hello world', 'bonjour')).resolves.toEqual({
      path: 'src/hello.txt',
      added: 1,
      removed: 1
    })
    await writeFile(path.join(project, 'repeated.txt'), 'same\nsame\n')
    await expect(tools.editFile('repeated.txt', 'same', 'other')).rejects.toThrow('apparaît 2 fois')
    await expect(tools.editFile('repeated.txt', 'same', 'other', true)).resolves.toMatchObject({ path: 'repeated.txt' })
    await expect(readFile(path.join(project, 'repeated.txt'), 'utf8')).resolves.toBe('other\nother\n')
  })

  it('deletes a project file and reports its removed lines', async () => {
    await mkdir(path.join(project, 'css', 'nested'), { recursive: true })
    await writeFile(path.join(project, 'css', 'nested', 'styles.css'), 'body {}\n')
    await writeFile(path.join(project, 'keep.txt'), 'keep\n')

    await tools.deleteFile('css/nested/styles.css')
    await expect(stat(path.join(project, 'css'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(path.join(project, 'keep.txt'), 'utf8')).resolves.toBe('keep\n')

    await expect(tools.deleteFile('src/hello.txt')).resolves.toEqual({
      path: 'src/hello.txt',
      added: 0,
      removed: 2
    })
    await expect(readFile(path.join(project, 'src', 'hello.txt'), 'utf8')).rejects.toThrow()
    await expect(stat(project)).resolves.toMatchObject({})
  })

  it('returns bounded text previews and rejects binary files', async () => {
    await writeFile(path.join(project, 'large.txt'), 'abcdef')
    await writeFile(path.join(project, 'binary.bin'), Buffer.from([1, 0, 2]))

    await expect(tools.readFilePreview('large.txt', 4)).resolves.toEqual({
      content: 'abcd',
      truncated: true
    })
    await expect(tools.readFilePreview('src/hello.txt')).resolves.toMatchObject({
      content: 'hello world\nsecond line\n',
      truncated: false
    })
    await expect(tools.readFilePreview('binary.bin')).rejects.toThrow('Binary files')
  })

  it('resolves only existing project files for external opening', async () => {
    await expect(tools.resolveFilePath('src/hello.txt')).resolves.toBe(path.join(project, 'src', 'hello.txt'))
    await expect(tools.resolveFilePath('src')).rejects.toThrow('project file')
    await expect(tools.resolveFilePath('../outside.txt')).rejects.toThrow(/traversal/)
  })

  it('reports a clear file error instead of reading a directory', async () => {
    await expect(tools.readFile('src')).rejects.toThrow('project file')
    await expect(tools.readFilePreview('src')).rejects.toThrow('project file')
  })

  it('rejects traversal and paths through symlinks', async () => {
    const outside = await mkdtemp(path.join(tmpdir(), 'project-tools-outside-'))
    await writeFile(path.join(outside, 'secret.txt'), 'secret')
    await symlink(outside, path.join(project, 'linked'))

    await expect(tools.readFile('../secret.txt')).rejects.toThrow(/traversal/)
    await expect(tools.writeFile('linked/stolen.txt', 'bad')).rejects.toThrow(/symbolic/i)
    await expect(tools.readFile('linked/secret.txt')).rejects.toThrow(/symbolic/i)
    await expect(readFile(path.join(outside, 'secret.txt'), 'utf8')).resolves.toBe('secret')

    await rm(outside, { recursive: true, force: true })
  })

  it('never exposes, reads, changes, or deletes Git metadata', async () => {
    await expect(tools.listDirectories()).resolves.not.toContain('.git')
    await expect(tools.readFile('.git/config')).rejects.toThrow(/Git metadata/i)
    await expect(tools.writeFile('.git/config', 'bad')).rejects.toThrow(/Git metadata/i)
    await expect(tools.deleteFile('.git/HEAD')).rejects.toThrow(/Git metadata/i)
    await expect(tools.deleteFile('.GIT')).rejects.toThrow(/Git metadata/i)
    await expect(stat(path.join(project, '.git'))).resolves.toMatchObject({})
  })

  it('fixes command cwd, captures output, enforces limits, and times out', async () => {
    const cwd = await tools.runCommand(process.execPath, ['-e', 'console.log(process.cwd()); console.error("err")'])
    expect(cwd.stdout.trim()).toBe(project)
    expect(cwd.stderr.trim()).toBe('err')
    expect(cwd.exitCode).toBe(0)

    const limited = await tools.runCommand(process.execPath, ['-e', 'process.stdout.write("x".repeat(1000))'], {
      maxOutputBytes: 20,
    })
    expect(Buffer.byteLength(limited.stdout)).toBe(20)
    expect(limited.outputTruncated).toBe(true)

    const timeout = await tools.runCommand(process.execPath, ['-e', 'setTimeout(() => {}, 1000)'], {
      timeoutMs: 20,
    })
    expect(timeout.timedOut).toBe(true)

    const controller = new AbortController()
    const canceled = tools.runCommand(process.execPath, ['-e', 'setTimeout(() => {}, 1000)'], {
      signal: controller.signal
    })
    controller.abort()
    await expect(canceled).resolves.toMatchObject({ timedOut: false })
  })

  it.skipIf(process.platform === 'win32')('cancels the complete command process group', async () => {
    const controller = new AbortController()
    const command = tools.runCommand(process.execPath, ['-e', `
      const { spawn } = require('node:child_process')
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 10000)'], { stdio: 'ignore' })
      console.log(child.pid)
      setInterval(() => {}, 10000)
    `], { signal: controller.signal })
    await new Promise((resolve) => setTimeout(resolve, 100))
    controller.abort()
    const result = await command
    const childPid = Number(result.stdout.trim())

    expect(childPid).toBeGreaterThan(0)
    let running = true
    for (let attempt = 0; attempt < 20 && running; attempt += 1) {
      try {
        process.kill(childPid, 0)
        await new Promise((resolve) => setTimeout(resolve, 25))
      } catch {
        running = false
      }
    }
    expect(running).toBe(false)
  })

  it('returns Git status and unstaged and staged diffs', async () => {
    execFileSync('git', ['add', '.'], { cwd: project })
    execFileSync('git', ['commit', '-m', 'initial'], { cwd: project })
    await writeFile(path.join(project, 'src', 'hello.txt'), 'changed\n')
    await writeFile(path.join(project, 'new.txt'), 'untracked\n')

    expect(await tools.gitStatus()).toContain(' M src/hello.txt')
    expect(await tools.gitStatus()).toContain('?? new.txt')
    expect(await tools.gitDiff()).toContain('-hello world')
    await expect(tools.gitChanges()).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'src/hello.txt', kind: 'modified', added: 1, removed: 2 }),
      expect.objectContaining({ path: 'new.txt', kind: 'added', added: 1, removed: 0, diff: expect.stringContaining('+untracked') })
    ]))

    execFileSync('git', ['add', 'src/hello.txt'], { cwd: project })
    expect(await tools.gitDiff(true)).toContain('+changed')
  })

  it('distinguishes Git repositories from ordinary folders', async () => {
    const ordinaryFolder = await mkdtemp(path.join(tmpdir(), 'project-tools-folder-'))
    try {
      expect(await tools.isGitRepository()).toBe(true)
      expect(await (await ProjectTools.create(ordinaryFolder)).isGitRepository()).toBe(false)
    } finally {
      await rm(ordinaryFolder, { recursive: true, force: true })
    }
  })

  it.skipIf(process.platform === 'win32')('disables configured Git helpers for status and diff', async () => {
    execFileSync('git', ['add', '.'], { cwd: project })
    execFileSync('git', ['commit', '-m', 'initial'], { cwd: project })
    const marker = path.join(project, 'git-helper-ran')
    const helper = path.join(project, 'git-helper.sh')
    await writeFile(helper, `#!/bin/sh\ntouch "${marker}"\n`)
    await chmod(helper, 0o755)
    await writeFile(path.join(project, '.gitattributes'), '*.txt diff=evil\n')
    execFileSync('git', ['config', 'core.fsmonitor', helper], { cwd: project })
    execFileSync('git', ['config', 'diff.evil.command', helper], { cwd: project })
    await writeFile(path.join(project, 'src', 'hello.txt'), 'changed\n')

    await tools.gitStatus()
    await tools.gitDiff()

    await expect(stat(marker)).rejects.toThrow()
  })
})
