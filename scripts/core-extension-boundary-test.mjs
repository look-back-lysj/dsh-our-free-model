import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { stageDesktopService } from './prepare-desktop.mjs'
import { coreStandaloneSourceFiles } from './pack-standalone.mjs'
const root = fileURLToPath(new URL('../', import.meta.url)), scratchRoot = path.join(root, '.extension-test-tmp')
fs.mkdirSync(scratchRoot, { recursive: true })
const scratch = fs.mkdtempSync(path.join(scratchRoot, 'package-boundary-'))
const forbidden = name => name.startsWith('vendor/channel-pack/') || name.startsWith('packages/standalone/channels/') || /(?:qoder-auth-wasm\.wasm|channels-[^/]+\.js)$/.test(name)
const walk = (directory, prefix = '') => fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? walk(path.join(directory, entry.name), prefix + entry.name + '/') : [prefix + entry.name])
let checks = 0
const check = (name, action) => { action(); console.log('ok ' + (++checks) + ' ' + name) }
try {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  check('core has no direct account vendor import or runtime dependency; companion is a separately validated installation payload', () => {
    assert.equal(pkg.files.some(forbidden), false)
    assert.equal(Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies }).some(name => /account-connectors|channel-pack/.test(name)), false)
    for (const file of ['vendor/channel-pack', 'packages/standalone/channels', 'src/chan-relay.js']) assert.equal(fs.existsSync(path.join(root, file)), false, file)
    assert.ok(fs.existsSync(path.join(root, 'src/channel.js')), 'generic SSE channel bridge remains')
  })
  check('standalone source list includes all core modules and manifest assets, with no account runtime', () => {
    const files = coreStandaloneSourceFiles()
    assert.equal(files.some(forbidden), false)
    for (const required of ['src/extensions/account-connectors.js', 'src/core/runtime.js', 'src/aggregate.js', 'src/forward.js', 'packages/standalone/eac.mjs', 'packages/standalone/extensions.mjs', 'src/providers/registry.json']) assert.ok(files.includes(required), required)
    for (const file of files) assert.ok(fs.statSync(path.join(root, file)).isFile(), file)
    if (fs.existsSync(path.join(root, 'companions/account-connectors.json.gz'))) assert.ok(files.includes('companions/account-connectors.json.gz'))
  })
  check('actual staged desktop resources exclude account modules and undeclared web leftovers', () => {
    stageDesktopService(scratch)
    const files = walk(scratch)
    assert.equal(files.some(forbidden), false)
    if (fs.existsSync(path.join(root, 'companions/account-connectors.json.gz'))) assert.ok(files.includes('companions/account-connectors.json.gz'), 'desktop must carry the paired-update payload')
    const assets = JSON.parse(fs.readFileSync(path.join(root, 'packages/standalone/web/assets.json'), 'utf8'))
    const shippedAssets = files.filter(file => file.startsWith('packages/standalone/web/')).map(file => file.replace('packages/standalone/web/', ''))
    assert.deepEqual(shippedAssets.sort(), [...assets, 'index.html', 'assets.json', ...fs.existsSync(path.join(root, 'packages/standalone/web/splash.html')) ? ['splash.html'] : []].sort())
  })
  check('core JavaScript imports cannot restore removed account runtime', () => {
    for (const file of ['index.js', 'packages/standalone/service.mjs', 'packages/standalone/management.mjs', 'scripts/prepare-desktop.mjs', 'scripts/pack-standalone.mjs']) {
      const content = fs.readFileSync(path.join(root, file), 'utf8')
      assert.doesNotMatch(content, /(?:import\s*[\s\S]{0,150}?from\s*|import\s*\()\s*['"][^'"]*(?:vendor\/channel-pack|channels\/business|channels\/runtime|chan-relay)/, file)
    }
  })
  check('EAC, official API and normal themes survive the core UI rebuild', () => {
    const client = fs.readFileSync(path.join(root, 'client.js'), 'utf8')
    for (const name of ['EacAuth', 'useEacLogin', 'AggregatePage', 'SaverPage', 'RoutingPage', 'FreePage', 'GatewayPage', 'LedgerPage', 'LogsPage']) assert.match(client, new RegExp('function ' + name + '\\b'), name)
    assert.doesNotMatch(client, /function (?:ChannelsPage|ChannelCard)\b/)
    const assets = JSON.parse(fs.readFileSync(path.join(root, 'packages/standalone/web/assets.json'), 'utf8'))
    assert.ok(assets.some(name => name.startsWith('eac-')))
    assert.equal(assets.some(name => name.startsWith('channels-')), false)
    const css = fs.readFileSync(path.join(root, 'packages/standalone/web/app.css'), 'utf8')
    assert.ok(css.includes('data-theme=dark') || css.includes('data-theme="dark"'), 'dark theme remains')
    assert.ok(css.includes('data-theme=light') || css.includes('data-theme="light"'), 'light theme remains')
  })
  console.log(checks + ' core package boundary checks passed')
} finally {
  const relative = path.relative(scratchRoot, scratch)
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative))
  fs.rmSync(scratch, { recursive: true, force: true })
}
