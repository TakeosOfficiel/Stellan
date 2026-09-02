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
    ? [`Local-Agent-${version}-win-x64.exe`]
    : [
        `Local-Agent-${version}-linux-x86_64.AppImage`,
        `Local-Agent-${version}-linux-amd64.deb`,
      ]
const artifactDirectory = path.resolve('ci-artifacts', 'unsigned', target)

fs.mkdirSync(artifactDirectory, { recursive: true })

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
