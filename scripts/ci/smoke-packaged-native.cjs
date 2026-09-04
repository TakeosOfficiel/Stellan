const path = require('node:path')
const spawnSync = require('cross-spawn').sync

const target = process.argv[2]
if (!['linux', 'windows'].includes(target)) {
  console.error('Usage: node scripts/ci/smoke-packaged-native.cjs <linux|windows>')
  process.exit(2)
}

const unpacked = path.resolve('dist', target === 'windows' ? 'win-unpacked' : 'linux-unpacked')
const executable = target === 'windows'
  ? path.join(unpacked, 'Stellan.exe')
  : path.join(unpacked, 'stellan')
const app = path.join(unpacked, 'resources', 'app.asar', 'node_modules')
const script = [
  `const sharp=require(${JSON.stringify(path.join(app, 'sharp'))})`,
  `const pty=require(${JSON.stringify(path.join(app, 'node-pty'))})`,
  `const ort=require(${JSON.stringify(path.join(app, 'onnxruntime-node'))})`,
  "if(!sharp.versions?.sharp||typeof pty.spawn!=='function'||typeof ort.InferenceSession!=='function')process.exit(1)",
  "console.log(`native modules ready: sharp=${sharp.versions.sharp}`)"
].join(';')
const result = spawnSync(executable, ['-e', script], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  encoding: 'utf8',
  timeout: 30_000
})

if (result.error || result.status !== 0) {
  console.error(result.error?.message || result.stderr || result.stdout || 'Packaged native module smoke test failed.')
  process.exit(1)
}
process.stdout.write(result.stdout)
