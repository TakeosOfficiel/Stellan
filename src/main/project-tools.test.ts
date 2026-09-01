import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ProjectTools } from './project-tools'

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
    await tools.writeFile('src/new.txt', 'find this needle\n')

    expect(await tools.listFiles()).toEqual(['src/hello.txt', 'src/new.txt'])
    expect(await tools.readFile('src/new.txt')).toBe('find this needle\n')
    expect(await tools.search('needle')).toEqual([
      { path: 'src/new.txt', line: 1, column: 11, text: 'find this needle' },
    ])
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
  })

  it('returns Git status and unstaged and staged diffs', async () => {
    execFileSync('git', ['add', '.'], { cwd: project })
    execFileSync('git', ['commit', '-m', 'initial'], { cwd: project })
    await writeFile(path.join(project, 'src', 'hello.txt'), 'changed\n')
    await writeFile(path.join(project, 'new.txt'), 'untracked\n')

    expect(await tools.gitStatus()).toContain(' M src/hello.txt')
    expect(await tools.gitStatus()).toContain('?? new.txt')
    expect(await tools.gitDiff()).toContain('-hello world')

    execFileSync('git', ['add', 'src/hello.txt'], { cwd: project })
    expect(await tools.gitDiff(true)).toContain('+changed')
  })
})
