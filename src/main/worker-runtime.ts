import type { WorkerProfile } from '../shared/contracts'
import { executeInContainer, type ContainerExecutionOptions, type CommandResult } from './runtime'

type ContainerExecutor = (options: ContainerExecutionOptions) => Promise<CommandResult>

export function createWorkerCommandExecutor(
  profile: WorkerProfile | null,
  threadId: string,
  projectPath: string,
  executor: ContainerExecutor = executeInContainer
) {
  if (!profile || profile.mode === 'direct') return undefined
  if (!profile.runtime) throw new Error('Le profil conteneur est invalide : aucun runtime n’est défini.')

  return (command: string, args: readonly string[], options: {
    timeoutMs: number
    signal: AbortSignal
  }): Promise<CommandResult> => executor({
    runtime: profile.runtime as 'docker' | 'podman',
    threadId,
    projectPath,
    image: profile.image,
    command: [command, ...args],
    cpuLimit: profile.cpuLimit,
    memoryLimit: `${profile.memoryMb}m`,
    network: profile.network,
    timeoutMs: options.timeoutMs,
    signal: options.signal
  })
}
