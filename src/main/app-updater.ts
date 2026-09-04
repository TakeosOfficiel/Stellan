import { app } from 'electron'
import electronUpdater from 'electron-updater'
import type { ProgressInfo, UpdateInfo } from 'electron-updater'
import type { UpdateState } from '../shared/contracts'

const { autoUpdater } = electronUpdater

export const UPDATE_BASE_URL = 'https://update.stellan.takeos.fr'
const CHECK_TIMEOUT_MS = 30_000

let state: UpdateState = { status: 'checking' }
let started: Promise<boolean> | null = null
let installing = false
let notify: ((state: UpdateState) => void) | null = null

function publish(next: UpdateState): void {
  state = next
  notify?.(next)
}

function failure(error: unknown): string {
  const detail = error instanceof Error ? error.message : 'erreur inconnue'
  return `La mise à jour obligatoire de Stellan a échoué (${detail}). Vérifiez votre connexion puis contactez le support Stellan si le problème persiste.`
}

export function getUpdateState(): UpdateState {
  return state
}

export function isInstallingUpdate(): boolean {
  return installing
}

export function configureMandatoryUpdater(listener: (state: UpdateState) => void): void {
  notify = listener
}

export function startMandatoryUpdate(): Promise<boolean> {
  if (started) return started
  if (!app.isPackaged) {
    publish({ status: 'current', version: app.getVersion() })
    started = Promise.resolve(true)
    return started
  }

  started = new Promise<boolean>((resolve) => {
    let settled = false
    let availableVersion = 'nouvelle version'
    const finish = (usable: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      resolve(usable)
    }
    const timeout = setTimeout(() => {
      publish({ status: 'error', message: failure(new Error('délai de vérification dépassé')) })
      finish(false)
    }, CHECK_TIMEOUT_MS)

    autoUpdater.autoDownload = true
    autoUpdater.autoInstallOnAppQuit = false
    autoUpdater.setFeedURL({
      provider: 'generic',
      url: `${UPDATE_BASE_URL}/${process.platform === 'win32' ? 'windows' : 'linux'}`,
      useMultipleRangeRequest: true
    })
    autoUpdater.on('checking-for-update', () => publish({ status: 'checking' }))
    autoUpdater.on('update-available', (info: UpdateInfo) => {
      clearTimeout(timeout)
      availableVersion = info.version
      publish({ status: 'downloading', version: info.version, percent: 0, bytesPerSecond: 0 })
    })
    autoUpdater.on('download-progress', (progress: ProgressInfo) => publish({
      status: 'downloading',
      version: availableVersion,
      percent: Math.max(0, Math.min(100, progress.percent)),
      bytesPerSecond: progress.bytesPerSecond
    }))
    autoUpdater.on('update-not-available', (info: UpdateInfo) => {
      publish({ status: 'current', version: info.version })
      finish(true)
    })
    autoUpdater.on('update-downloaded', (info: UpdateInfo) => {
      publish({ status: 'restarting', version: info.version })
      installing = true
      finish(false)
      setTimeout(() => autoUpdater.quitAndInstall(true, true), 250)
    })
    autoUpdater.on('error', (error: Error) => {
      publish({ status: 'error', message: failure(error) })
      finish(false)
    })

    void autoUpdater.checkForUpdates().catch((error: unknown) => {
      publish({ status: 'error', message: failure(error) })
      finish(false)
    })
  })
  return started
}
