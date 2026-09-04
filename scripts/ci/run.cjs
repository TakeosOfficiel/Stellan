const fs = require('node:fs')
const path = require('node:path')
const spawnSync = require('cross-spawn').sync

const target = process.argv[2]
const expectedTarget = process.platform === 'win32' ? 'windows' : 'linux'

if (!['linux', 'windows'].includes(target)) {
  console.error('Usage: node scripts/ci/run.cjs <linux|windows>')
  process.exit(2)
}

if (target !== expectedTarget) {
  console.error(`The ${target} package must be built on native ${target}; this runner is ${process.platform}.`)
  process.exit(1)
}

const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
const packageJson = require('../../package.json')
const expectedPnpm = packageJson.packageManager?.replace(/^pnpm@/, '')

function run(command, args, options = {}) {
  console.log(`\n> ${command} ${args.join(' ')}`)
  const result = spawnSync(command, args, { stdio: 'inherit', ...options })
  if (result.error) {
    console.error(result.error.message)
    process.exit(1)
  }
  if (result.status !== 0) process.exit(result.status ?? 1)
}

const versionResult = spawnSync(pnpm, ['--version'], { encoding: 'utf8' })
if (versionResult.error || versionResult.status !== 0) {
  console.error('pnpm is unavailable. Activate the packageManager version with Corepack first.')
  process.exit(1)
}

const actualPnpm = versionResult.stdout.trim()
if (actualPnpm !== expectedPnpm) {
  console.error(`Expected pnpm ${expectedPnpm} from package.json, received ${actualPnpm}.`)
  process.exit(1)
}

for (const script of ['typecheck', 'test', 'build']) run(pnpm, [script])

fs.rmSync(path.resolve('dist'), { recursive: true, force: true })
fs.rmSync(path.resolve('ci-artifacts', 'unsigned', target), { recursive: true, force: true })

console.warn('\nWARNING: CI distribution artifacts are intentionally UNSIGNED and are not published releases.')
const packagingEnvironment = {
  ...process.env,
  CSC_IDENTITY_AUTO_DISCOVERY: 'false',
}

if (target === 'windows') {
  run(process.execPath, ['scripts/package-windows.cjs', '--x64'], { env: packagingEnvironment })
} else {
  run(
    process.execPath,
    [require.resolve('electron-builder/cli.js'), '--linux', 'AppImage', '--x64', '--publish', 'never'],
    { env: packagingEnvironment },
  )
}

run(process.execPath, ['scripts/ci/smoke-packaged-native.cjs', target])
run(process.execPath, ['scripts/ci/verify-artifacts.cjs', target])
