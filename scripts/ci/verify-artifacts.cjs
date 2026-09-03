const fs = require('node:fs')
const path = require('node:path')

const target = process.argv[2]
if (!['linux', 'windows'].includes(target)) {
  console.error('Usage: node scripts/ci/verify-artifacts.cjs <linux|windows>')
  process.exit(2)
}

const { version } = require('../../package.json')
const expectedNames =
  target === 'windows'
    ? [`Stellan-${version}-win-x64.exe`]
    : [
        `Stellan-${version}-linux-x86_64.AppImage`,
        `Stellan-${version}-linux-amd64.deb`,
      ]
const artifactDirectory = path.resolve('ci-artifacts', 'unsigned', target)

fs.mkdirSync(artifactDirectory, { recursive: true })

if (target === 'windows') {
  const nodePty = path.resolve(
    'dist',
    'win-unpacked',
    'resources',
    'app.asar.unpacked',
    'node_modules',
    'node-pty',
  )
  if (fs.existsSync(path.join(nodePty, 'build'))) {
    console.error('The Windows package contains a host node-pty build that can shadow its Windows prebuilds.')
    process.exit(1)
  }
  for (const unexpected of [
    'deps',
    'scripts',
    'src',
    'third_party',
    'typings',
    'binding.gyp',
    path.join('prebuilds', 'win32-arm64'),
    path.join('prebuilds', 'darwin-arm64'),
    path.join('prebuilds', 'darwin-x64'),
  ]) {
    if (fs.existsSync(path.join(nodePty, unexpected))) {
      console.error(`The Windows x64 package contains unused node-pty payload: ${unexpected}`)
      process.exit(1)
    }
  }
  for (const name of ['conpty.node', 'pty.node']) {
    const nativeModule = path.join(nodePty, 'prebuilds', 'win32-x64', name)
    const signature = fs.readFileSync(nativeModule).subarray(0, 2).toString('ascii')
    if (signature !== 'MZ') {
      console.error(`The Windows node-pty module is not a PE binary: ${nativeModule}`)
      process.exit(1)
    }
  }
}

for (const name of expectedNames) {
  const source = path.resolve('dist', name)
  let stats
  try {
    stats = fs.statSync(source)
  } catch {
    console.error(`Expected artifact is missing: ${path.relative(process.cwd(), source)}`)
    process.exit(1)
  }

  if (!stats.isFile() || stats.size === 0) {
    console.error(`Expected artifact is not a non-empty file: ${path.relative(process.cwd(), source)}`)
    process.exit(1)
  }

  const destination = path.join(artifactDirectory, name)
  fs.copyFileSync(source, destination)
  console.log(`Verified unsigned artifact: ${path.relative(process.cwd(), destination)} (${stats.size} bytes)`)
}
