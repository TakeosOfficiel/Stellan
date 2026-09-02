const { spawnSync } = require('node:child_process')

const args = ['--win', '--publish', 'never', ...process.argv.slice(2)]
const env = { ...process.env }

if (process.platform !== 'win32') {
  const wine = spawnSync('wine', ['--version'], { encoding: 'utf8' })
  const wineOutput = `${wine.stdout ?? ''}\n${wine.stderr ?? ''}`
  const wineMajorVersion = Number(/wine-(\d+)/i.exec(wineOutput)?.[1])
  if (
    wine.error ||
    wine.status !== 0 ||
    !Number.isFinite(wineMajorVersion) ||
    wineMajorVersion < 2 ||
    /wine32 is missing/i.test(wineOutput)
  ) {
    console.error(
      'Wine 2.0 or newer with 32-bit support is required to build the Windows NSIS installer outside Windows. ' +
        'Install Wine (including wine32 on Debian) or use the electronuserland/builder:wine container.',
    )
    process.exit(1)
  }

  if (!env.CSC_LINK && !env.WIN_CSC_LINK) {
    console.warn(
      'Building an unsigned Windows installer. Windows will report an unknown publisher and may show SmartScreen warnings.',
    )
    env.CSC_IDENTITY_AUTO_DISCOVERY = 'false'
  }
}

const result = spawnSync(process.execPath, [require.resolve('electron-builder/cli.js'), ...args], {
  env,
  stdio: 'inherit',
})

if (result.error) {
  console.error(result.error.message)
  process.exit(1)
}

process.exit(result.status ?? 1)
