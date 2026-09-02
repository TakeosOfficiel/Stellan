const fs = require('node:fs/promises')
const path = require('node:path')

const ARCH_NAMES = ['ia32', 'x64', 'armv7l', 'arm64', 'universal']

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return

  const arch = typeof context.arch === 'string' ? context.arch : ARCH_NAMES[context.arch]
  if (!arch) throw new Error(`Unsupported Windows package architecture: ${context.arch}`)

  const nodePty = path.join(
    context.appOutDir,
    'resources',
    'app.asar.unpacked',
    'node_modules',
    'node-pty',
  )
  const prebuildDirectory = path.join(nodePty, 'prebuilds', `win32-${arch}`)
  await Promise.all([
    fs.access(path.join(prebuildDirectory, 'conpty.node')),
    fs.access(path.join(prebuildDirectory, 'pty.node')),
  ])

  // A cross-build can leave the host's native addon here. node-pty checks this
  // directory before its target-specific prebuilds, so never ship it on Windows.
  await fs.rm(path.join(nodePty, 'build'), { recursive: true, force: true })

  // node-pty ships binaries and source trees for every supported platform. They
  // are unpacked by Electron but cannot be used by this architecture-specific
  // installer, so retaining them only inflates the downloadable artifact.
  const prebuilds = path.join(nodePty, 'prebuilds')
  for (const entry of await fs.readdir(prebuilds, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name !== `win32-${arch}`) {
      await fs.rm(path.join(prebuilds, entry.name), { recursive: true, force: true })
    }
  }
  await Promise.all(['deps', 'scripts', 'src', 'third_party', 'typings'].map((directory) => fs.rm(
    path.join(nodePty, directory),
    { recursive: true, force: true },
  )))
  await fs.rm(path.join(nodePty, 'binding.gyp'), { force: true })
}
