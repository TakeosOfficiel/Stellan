const fs = require('node:fs')
const { execFile } = require('node:child_process')
const crypto = require('node:crypto')
const os = require('node:os')
const path = require('node:path')
const { createRequire } = require('node:module')
const { Readable } = require('node:stream')
const { pipeline } = require('node:stream/promises')
const { promisify } = require('node:util')

const execFileAsync = promisify(execFile)

function getExecutablePath() {
  if (process.platform === 'win32') return 'electron.exe'
  if (process.platform === 'darwin') return 'Electron.app/Contents/MacOS/Electron'
  return 'electron'
}

function electronIsInstalled() {
  try {
    require('electron')
    return true
  } catch {
    return false
  }
}

async function checksum(file) {
  const hash = crypto.createHash('sha256')
  await pipeline(fs.createReadStream(file), hash)
  return hash.digest('hex')
}

async function findCachedArchive(filename, expectedChecksum) {
  const localCache = path.join(os.homedir(), '.cache', 'local-agent', filename)
  const candidates = [localCache]
  const electronCache = path.join(os.homedir(), '.cache', 'electron')

  try {
    for (const entry of await fs.promises.readdir(electronCache)) {
      candidates.push(path.join(electronCache, entry, filename))
    }
  } catch {
    // The standard Electron cache does not exist on a fresh machine.
  }

  for (const candidate of candidates) {
    try {
      if (await checksum(candidate) === expectedChecksum) return candidate
    } catch {
      // Missing or incomplete cache entries are ignored.
    }
  }

  return null
}

async function downloadArchive(version, filename, expectedChecksum) {
  const cached = await findCachedArchive(filename, expectedChecksum)
  if (cached) return cached

  const cacheDirectory = path.join(os.homedir(), '.cache', 'local-agent')
  const archive = path.join(cacheDirectory, filename)
  const temporaryArchive = `${archive}.partial`
  await fs.promises.mkdir(cacheDirectory, { recursive: true })

  const url = `https://github.com/electron/electron/releases/download/v${version}/${filename}`
  const response = await fetch(url, { redirect: 'follow' })
  if (!response.ok || !response.body) {
    throw new Error(`Electron download failed with status ${response.status}.`)
  }

  await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(temporaryArchive))
  if (await checksum(temporaryArchive) !== expectedChecksum) {
    await fs.promises.rm(temporaryArchive, { force: true })
    throw new Error('Electron download checksum verification failed.')
  }

  await fs.promises.rename(temporaryArchive, archive)
  return archive
}

async function repairElectron() {
  const packagePath = require.resolve('electron/package.json')
  const packageDirectory = path.dirname(packagePath)
  const packageRequire = createRequire(path.join(packageDirectory, 'install.js'))
  const { version } = packageRequire('./package.json')
  const checksums = packageRequire('./checksums.json')
  const distributionDirectory = path.join(packageDirectory, 'dist')
  const filename = `electron-v${version}-${process.platform}-${process.arch}.zip`
  const expectedChecksum = checksums[filename]
  if (!expectedChecksum) throw new Error(`No checksum is available for ${filename}.`)
  const archive = await downloadArchive(version, filename, expectedChecksum)

  await fs.promises.rm(distributionDirectory, { recursive: true, force: true })
  await fs.promises.mkdir(distributionDirectory, { recursive: true })
  await execFileAsync('unzip', ['-q', archive, '-d', distributionDirectory])

  const bundledTypes = path.join(distributionDirectory, 'electron.d.ts')
  if (fs.existsSync(bundledTypes)) {
    await fs.promises.rename(bundledTypes, path.join(packageDirectory, 'electron.d.ts'))
  }

  await fs.promises.writeFile(
    path.join(packageDirectory, 'path.txt'),
    getExecutablePath()
  )
}

if (!electronIsInstalled()) {
  const keepProcessAlive = setInterval(() => {}, 1_000)
  repairElectron()
    .then(() => {
      clearInterval(keepProcessAlive)
      if (!electronIsInstalled()) throw new Error('Electron repair did not produce a usable binary.')
    })
    .catch((error) => {
      clearInterval(keepProcessAlive)
      console.error(error)
      process.exitCode = 1
    })
}
