import type { WorkerProfile } from '../shared/contracts'
import { executeInWorkerContainer, type ContainerExecutionOptions, type CommandResult } from './runtime'

type ContainerExecutor = (options: ContainerExecutionOptions) => Promise<CommandResult>

export function createWorkerCommandExecutor(
  profile: WorkerProfile | null,
  threadId: string,
  projectPath: string,
  git: { directory: string; commonDirectory: string } | null = null,
  executor: ContainerExecutor = executeInWorkerContainer
) {
  if (!profile || profile.mode === 'direct') {
    throw new Error('Le moteur de commandes sécurisé est indisponible. L’exécution directe sur la machine est bloquée.')
  }
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
    ...(git ? { gitDirectory: git.directory, gitCommonDirectory: git.commonDirectory } : {}),
    timeoutMs: options.timeoutMs,
    signal: options.signal
  })
}
