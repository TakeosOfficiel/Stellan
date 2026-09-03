import { describe, expect, it } from 'vitest'
import {
  DOCKER_SERVICE_START_SCRIPT,
  MANAGED_RUNTIME_PACKAGES,
  MANAGED_WSL_DISTRO,
  WSL_ADDRESS_COMMAND,
  managedContainerPtyCommand,
  managedLinuxPathToWindows,
  managedProjectWindowsPath,
  translateWindowsDockerArgument
} from './wsl-runtime'

describe('managed WSL runtime arguments', () => {
  it('translates only Docker bind-mount sources to WSL paths', () => {
    expect(translateWindowsDockerArgument(
      'type=bind,source=C:\\Users\\Alice Smith\\project,target=/workspace'
    )).toBe('type=bind,source=/mnt/c/Users/Alice Smith/project,target=/workspace')
    expect(translateWindowsDockerArgument('local-agent-volume:/data')).toBe('local-agent-volume:/data')
    expect(translateWindowsDockerArgument(
      'type=bind,source=\\\\wsl.localhost\\LocalAgentRuntime\\var\\lib\\local-agent\\projects\\abc\\repository,target=/workspace'
    )).toBe('type=bind,source=/var/lib/local-agent/projects/abc/repository,target=/workspace')
  })

  it('publishes managed services on the WSL interface used by the Windows host', () => {
    expect(translateWindowsDockerArgument('127.0.0.1:11435:11434')).toBe('0.0.0.0:11435:11434')
  })

  it('builds stable private-project paths without exposing a host project folder', () => {
    const id = '12345678-1234-1234-1234-123456789abc'
    expect(managedProjectWindowsPath(id, 'repository')).toBe(
      '\\\\wsl.localhost\\LocalAgentRuntime\\var\\lib\\local-agent\\projects\\12345678-1234-1234-1234-123456789abc\\repository'
    )
    expect(managedLinuxPathToWindows('/var/lib/local-agent/project')).toBe(
      '\\\\wsl.localhost\\LocalAgentRuntime\\var\\lib\\local-agent\\project'
    )
  })

  it('uses the Alpine service supervisor instead of a detached shell process', () => {
    expect(DOCKER_SERVICE_START_SCRIPT).toContain('rc-service --nodeps docker restart')
    expect(DOCKER_SERVICE_START_SCRIPT).not.toContain('nohup')
  })

  it('installs the networking utility used to discover the WSL address', () => {
    expect(MANAGED_RUNTIME_PACKAGES).toContain('iproute2')
    expect(WSL_ADDRESS_COMMAND[0]).toBe('/sbin/ip')
  })

  it('keeps the regular Docker PTY command outside Windows', () => {
    const command = managedContainerPtyCommand(['exec', 'worker', '/bin/sh'])
    if (process.platform === 'win32') {
      expect(command).toEqual({
        executable: 'wsl.exe',
        args: ['--distribution', MANAGED_WSL_DISTRO, '--user', 'root', '--exec', 'docker', 'exec', 'worker', '/bin/sh']
      })
    } else {
      expect(command).toEqual({ executable: 'docker', args: ['exec', 'worker', '/bin/sh'] })
    }
  })
})
