import { constants } from 'node:fs'
import { access } from 'node:fs/promises'
import path from 'node:path'
import spawn from 'cross-spawn'

export type OllamaStartResult =
  | { success: true }
  | { success: false; reason: string }

export function ollamaExecutableCandidates(
  platform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env
): string[] {
  const executable = platform === 'win32' ? 'ollama.exe' : 'ollama'
  const platformPath = platform === 'win32' ? path.win32 : path.posix
  const delimiter = platform === 'win32' ? ';' : ':'
  const candidates = (environment.PATH ?? '')
    .split(delimiter)
    .filter(Boolean)
    .map((directory) => platformPath.join(directory, executable))

  if (platform === 'win32' && environment.LOCALAPPDATA) {
    candidates.unshift(
      path.win32.join(environment.LOCALAPPDATA, 'Programs', 'Ollama', 'ollama.exe'),
      path.win32.join(environment.LOCALAPPDATA, 'Ollama', 'ollama.exe')
    )
  }
  if (platform === 'darwin') candidates.unshift('/Applications/Ollama.app/Contents/Resources/ollama')
  if (platform === 'linux') candidates.unshift('/usr/local/bin/ollama', '/usr/bin/ollama')

  return [...new Set(candidates)]
}

export async function findOllamaExecutable(): Promise<string | null> {
  for (const candidate of ollamaExecutableCandidates()) {
    try {
      await access(candidate, constants.F_OK)
      return candidate
    } catch {
      // Continue through the known installation locations and PATH.
    }
  }
  return null
}

export async function startOllamaServer(): Promise<OllamaStartResult> {
  const executable = await findOllamaExecutable()
  if (!executable) {
    return {
      success: false,
      reason: "L'exécutable Ollama est introuvable. Réinstallez Ollama ou ajoutez-le au PATH."
    }
  }

  return await new Promise((resolve) => {
    const child = spawn(executable, ['serve'], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    })
    child.once('error', () => {
      resolve({ success: false, reason: "Ollama n'a pas pu démarrer." })
    })
    child.once('spawn', () => {
      child.unref()
      resolve({ success: true })
    })
  })
}
