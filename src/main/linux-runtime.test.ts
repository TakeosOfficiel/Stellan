import { describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  configureManagedLinuxRuntime,
  ensureManagedLinuxRuntime,
  LINUX_DOCKER_ARCHIVES,
  LINUX_DOCKER_VERSION,
  LINUX_SLIRP4NETNS,
  stopManagedLinuxRuntime,
  subIdConfigured
} from './linux-runtime'
import { runCommand } from './runtime'

describe('private Linux runtime', () => {
  it('pins official x86_64 Docker archives and their SHA-256 digests', () => {
    expect(LINUX_DOCKER_VERSION).toMatch(/^\d+\.\d+\.\d+$/)
    expect(LINUX_DOCKER_ARCHIVES).toHaveLength(2)
    for (const archive of LINUX_DOCKER_ARCHIVES) {
      expect(new URL(archive.url).origin).toBe('https://download.docker.com')
      expect(archive.url).toContain('/linux/static/stable/x86_64/')
      expect(archive.sha256).toMatch(/^[a-f0-9]{64}$/)
    }
    expect(LINUX_DOCKER_ARCHIVES.map(({ name }) => name)).toEqual([
      `docker-${LINUX_DOCKER_VERSION}.tgz`,
      `docker-rootless-extras-${LINUX_DOCKER_VERSION}.tgz`
    ])
    expect(new URL(LINUX_SLIRP4NETNS.url).hostname).toBe('github.com')
    expect(LINUX_SLIRP4NETNS.sha256).toMatch(/^[a-f0-9]{64}$/)
  })

  it('requires a complete subordinate UID/GID range for the signed-in user', () => {
    const entries = 'daemon:100000:65536\nalice:165536:65536\nbob:231072:1000\n'
    expect(subIdConfigured(entries, 'alice')).toBe(true)
    expect(subIdConfigured(entries, 'bob')).toBe(false)
    expect(subIdConfigured(entries, 'missing')).toBe(false)
    expect(subIdConfigured('alice:not-a-number:65536', 'alice')).toBe(false)
  })

  it.runIf(process.env.STELLAN_TEST_PRIVATE_RUNTIME === '1')(
    'downloads and starts the official private daemon without a system Docker socket',
    async () => {
      const root = await mkdtemp(path.join(tmpdir(), 'stellan-linux-runtime-'))
      try {
        configureManagedLinuxRuntime(root)
        await ensureManagedLinuxRuntime()
        const info = await runCommand('docker', ['info', '--format', '{{.ServerVersion}}|{{.DockerRootDir}}'])
        expect(info.exitCode).toBe(0)
        expect(info.stdout).toContain(LINUX_DOCKER_VERSION)
        expect(info.stdout).toContain(path.join(root, 'linux-rootless', 'data'))
        const container = await runCommand('docker', [
          'run', '--rm', '--pull', 'always', '--cpus', '0.5', '--memory', '128m', 'hello-world:latest'
        ], { timeoutMs: 120_000 })
        expect(container.exitCode, container.stderr).toBe(0)
        expect(container.stdout).toContain('Hello from Docker!')
      } finally {
        await stopManagedLinuxRuntime()
        await rm(root, { recursive: true, force: true })
      }
    },
    180_000
  )
})
