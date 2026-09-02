import { describe, expect, it } from 'vitest'
import {
  DOCKER_SERVICE_START_SCRIPT,
  MANAGED_RUNTIME_PACKAGES,
  MANAGED_WSL_DISTRO,
  WSL_ADDRESS_COMMAND,
  managedContainerPtyCommand,
  translateWindowsDockerArgument
} from './wsl-runtime'

describe('managed WSL runtime arguments', () => {
  it('translates only Docker bind-mount sources to WSL paths', () => {
    expect(translateWindowsDockerArgument(
      'type=bind,source=C:\\Users\\Alice Smith\\project,target=/workspace'
    )).toBe('type=bind,source=/mnt/c/Users/Alice Smith/project,target=/workspace')
    expect(translateWindowsDockerArgument('local-agent-volume:/data')).toBe('local-agent-volume:/data')
  })

  it('publishes managed services on the WSL interface used by the Windows host', () => {
    expect(translateWindowsDockerArgument('127.0.0.1:11435:11434')).toBe('0.0.0.0:11435:11434')
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
