// Isolated host lifecycle for one long-run arm: private DSH_HOME, dedicated
// profile, frozen binary identity, and restart-safe launch bookkeeping.
import { spawn, execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync, realpathSync, writeFileSync, mkdirSync } from 'node:fs'
import { mkdir, readFile, writeFile, readdir, copyFile } from 'node:fs/promises'
import { join, resolve, dirname } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { createHash, randomUUID } from 'node:crypto'
import { webClient } from '../client.mjs'
import { writePrivateSettings } from '../local/private-settings.mjs'
import { atomicJson } from './context.mjs'

/**
 * Host selection. The protocol freezes one host per revision, but which pin that
 * is has to be selectable: the harness originally targeted 0.1.2-rc.1 and the
 * product now targets the 0.1.7 prerelease series, whose host layout differs in
 * three ways this module has to absorb — the shipped presets moved from
 * `dsh-agent-presets/presets/<id>/agent.cordis.yml` to
 * `dsh-web-app/presets/<id>.patch.yml`, a profile needs an explicit
 * `packageManager` or the plugin command resolves a pnpm that ships no
 * `bin/pnpm.cjs`, and the pin may hold only a `dsh` symlink rather than the whole
 * host tree. The default stays the 0.1.2 pin so nothing changes unless
 * `EXPERIMENT_DSH_BIN` (or `EXPERIMENT_HOST_PIN`) selects another.
 */
export const DEFAULT_HOST_PIN = '.test-runtime/host-pins/dsh-0.1.2-rc.1'
export const HOST_PIN_ROOT = process.env.EXPERIMENT_HOST_PIN
  ? resolve('.test-runtime/host-pins', process.env.EXPERIMENT_HOST_PIN)
  : resolve(DEFAULT_HOST_PIN)
export const PINNED_HOST = resolve(process.env.EXPERIMENT_DSH_BIN ?? join(HOST_PIN_ROOT, 'node_modules/.bin/dsh'))
export const PINNED_HOST_PACKAGE = resolve(dirname(PINNED_HOST), '..', '@deepseek-ai/dsh/package.json')

export function sha256(value) { return createHash('sha256').update(value).digest('hex') }

/**
 * Whether this host needs the profile's `packageManager` stated explicitly.
 * 0.1.7 resolves pnpm through corepack, which otherwise picks a version that
 * publishes only `pnpm.mjs` while the plugin command runs `bin/pnpm.cjs`.
 */
export function hostNeedsPackageManager(version) {
  const triple = /^(\d+)\.(\d+)\.(\d+)/.exec(version)
  if (triple === null) throw new Error(`Unparseable host version ${JSON.stringify(version)}`)
  const [major, minor, patch] = triple.slice(1).map(Number)
  return major > 0 || minor > 1 || (minor === 1 && patch >= 7)
}

/** The host's own pnpm pin, read from the runtime manifest when it ships one. */
export function hostPackageManager(dshBin, version) {
  if (!hostNeedsPackageManager(version)) return null
  const manifest = resolve(dirname(dshBin), '..', '@deepseek-ai/dsh-desktop-runtime/runtime.json')
  try {
    const parsed = JSON.parse(readFileSync(manifest, 'utf8'))
    if (typeof parsed.pnpm === 'string' && parsed.pnpm.length > 0) return `pnpm@${parsed.pnpm}`
  } catch { /* a CLI install ships no runtime manifest; fall through */ }
  return 'pnpm@11.7.0'
}

export async function pinnedHostIdentity(dshBin = PINNED_HOST) {
  const realpath = execFileSync('realpath', [dshBin], { encoding: 'utf8' }).trim()
  const packagePath = resolve(dirname(dshBin), '..', '@deepseek-ai/dsh/package.json')
  const version = JSON.parse(await readFile(packagePath, 'utf8')).version
  const requested = resolve(dshBin)
  if (!requested.startsWith(resolve('.test-runtime/host-pins/'))) {
    throw new Error('EXPERIMENT_DSH_BIN must point at a pinned host under .test-runtime/host-pins/')
  }
  const binaryBytes = await readFile(dshBin)
  const libRoot = dirname(dirname(realpath))
  return { requested, realpath, packagePath, version, binarySha256: sha256(binaryBytes), libRoot }
}

/**
 * Where this host's shipped preset definitions live. Returns the layout name
 * alongside the per-preset paths so evidence records which shape was used.
 *
 * The pin may hold only a `dsh` symlink, so the search starts from the resolved
 * package rather than the pin directory: 0.1.7 keeps its host packages nested
 * under the `dsh` package, while the 0.1.2 pin keeps them flat beside it.
 */
export async function shippedPresetFiles(dshBin, version) {
  const dshPackage = realpathSync(resolve(dirname(dshBin), '..', '@deepseek-ai/dsh'))
  const candidates = [
    { layout: '0.1.7-bundle-patch', root: join(dshPackage, 'node_modules/@deepseek-ai/dsh-web-app/presets'), file: id => `${id}.patch.yml` },
    { layout: '0.1.7-bundle-patch', root: join(dirname(dirname(dshPackage)), '@deepseek-ai/dsh-web-app/presets'), file: id => `${id}.patch.yml` },
    { layout: '0.1.2-agent-presets', root: join(dirname(dirname(dshPackage)), '@deepseek-ai/dsh-agent-presets/presets'), file: id => join(id, 'agent.cordis.yml') },
  ]
  const ids = ['standard', 'minimal', 'ptc', 'cordis']
  const found = []
  for (const candidate of candidates) {
    if (!existsSync(candidate.root)) continue
    const files = Object.fromEntries(ids.map(id => [id, join(candidate.root, candidate.file(id))]))
    if (ids.every(id => existsSync(files[id]))) return { layout: candidate.layout, files }
    found.push(candidate.root)
  }
  throw new Error(`No shipped preset definitions found for host ${version}; looked in ${found.join(', ')}`)
}

export async function distManifest(directory, relative = '') {
  const entries = await readdir(join(directory, relative), { withFileTypes: true })
  const files = []
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const path = join(relative, entry.name)
    if (entry.isDirectory()) files.push(...await distManifest(directory, path))
    else if (entry.isFile()) files.push([path, sha256(await readFile(join(directory, path)))])
  }
  return files
}

export function canonicalDistEntries(entries) {
  return entries.map(([path, digest]) => `${path}\0${digest}\n`).join('')
}

export function distManifestHash(entries) { return sha256(canonicalDistEntries(entries)) }

// Creates the per-run isolated home and profile. ARC profiles additionally
// install the packaged plugin; Basic profiles never load it.
export async function prepareIsolatedHome({ root, arm, command, tarball, seedSettingsBytes, dshBin = PINNED_HOST, sessionMarker }) {
  const home = join(root, 'home')
  const profile = `lr3m-${arm.toLowerCase()}-${randomUUID().slice(0, 8)}`
  const profileDir = join(home, 'profiles', profile)
  await mkdir(profileDir, { recursive: true, mode: 0o700 })
  await mkdir(join(home, '.agent-presets'), { recursive: true, mode: 0o700 })
  const hostVersion = JSON.parse(await readFile(resolve(dirname(dshBin), '..', '@deepseek-ai/dsh/package.json'), 'utf8')).version
  const packageManager = hostPackageManager(dshBin, hostVersion)
  const bundles = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']
  if (command.pluginBundle) bundles.push('dsh-context-management')
  await writeFile(join(profileDir, 'package.json'), JSON.stringify({
    name: `dsh-profile-${profile}`,
    private: true,
    dependencies: {},
    dsh: { profile: { bundles, patchReload: 'live' } },
    // Stated only where the host needs it, so the 0.1.2 pin is untouched.
    ...(packageManager === null ? {} : { packageManager }),
  }, null, 2), { mode: 0o600 })
  await writeFile(join(root, 'npmrc'), '', { mode: 0o600 })
  const env = {
    ...process.env,
    DSH_HOME: home,
    COREPACK_ENABLE_AUTO_PIN: '0',
    npm_config_cache: join(root, 'npm-cache'),
    npm_config_userconfig: join(root, 'npmrc'),
  }
  const installLog = []
  if (command.pluginBundle) {
    if (!tarball || !existsSync(tarball)) throw new Error(`Candidate tarball unavailable: ${tarball}`)
    const out = execFileSync(dshBin, ['plugin', '--profile', profile, 'add', tarball], { env, cwd: root, encoding: 'utf8', timeout: 180000 })
    installLog.push({ step: 'plugin-add', out })
  }
  const settingsPath = join(root, 'private-settings.yaml')
  await writePrivateSettings(settingsPath, seedSettingsBytes, true)
  // The provider route authenticates through the host credentials service. The
  // isolated home needs a 0600 copy of the user's credential records; the copy
  // lives under the ignored run directory and is never exported publicly.
  const credentialsSource = join(homedir(), '.dsh', '.credentials.yaml')
  let credentialsHash = null
  if (existsSync(credentialsSource)) {
    const bytes = await readFile(credentialsSource)
    credentialsHash = sha256(bytes)
    await writeFile(join(home, '.credentials.yaml'), bytes, { mode: 0o600 })
  }
  // Shipped presets are hashed as evidence that they stay unmodified. Where the
  // host loads them from its own bundle (0.1.7), copying is skipped: the bundle
  // copy is already read-only, and a copy into the isolated home would not be the
  // file the host actually reads.
  const shipped = await shippedPresetFiles(dshBin, hostVersion)
  const shippedPresets = dirname(shipped.files.standard)
  const presetHashes = {}
  for (const id of ['standard', 'minimal', 'ptc', 'cordis']) {
    const source = shipped.files[id]
    if (source === undefined || !existsSync(source)) throw new Error(`Shipped preset missing: ${source}`)
    presetHashes[id] = sha256(await readFile(source))
    if (shipped.layout === '0.1.2-agent-presets') {
      const target = join(home, '.agent-presets', id)
      await mkdir(target, { recursive: true, mode: 0o700 })
      await copyFile(source, join(target, 'agent.cordis.yml'))
    }
  }
  // The synthetic cwd carries the ownership marker the fixture tools and the
  // observer both require, so an unattributed session can never reach them.
  const marker = sessionMarker ?? 'dsh-context-experiment-'
  const cwd = join(root, `${marker}${arm.toLowerCase()}`)
  await mkdir(cwd, { recursive: true, mode: 0o700 })
  await writeFile(join(cwd, 'README.txt'), 'Synthetic experiment working directory. Only the assigned experiment tools are available.\n', { mode: 0o600 })
  return { home, profile, profileDir, settingsPath, shippedPresets, presetLayout: shipped.layout, hostVersion, packageManager, presetHashes, cwd, env, installLog, credentialsHash }
}

// Starts one owned host process. `launchId` is recorded before the process can
// emit anything so a crash window is always attributable.
export async function launchHost(spec, launchId) {
  const log = join(spec.root, 'host', `web-${launchId}.log`)
  await mkdir(dirname(log), { recursive: true })
  await writeFile(log, '', { mode: 0o600 })
  const child = spawn(spec.dshBin, ['--profile', spec.profile, '--patch', spec.patch, '--host', '127.0.0.1', '--port', String(spec.port), '--no-open'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: spec.root,
    env: spec.env ?? process.env,
  })
  child.stdout.on('data', data => appendFileSync(log, data))
  child.stderr.on('data', data => appendFileSync(log, data))
  const launch = {
    launchId, pid: child.pid, startedAt: new Date().toISOString(),
    startedAtMs: Date.now(), profile: spec.profile, port: spec.port, dshBin: spec.dshBin,
    startIdentity: processStartIdentity(child.pid),
  }
  await atomicJson(join(spec.root, 'host', `launch-${launchId}.json`), launch)
  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return { alreadyExited: true, pid: child.pid }
    const exited = new Promise(resolvePromise => child.once('exit', resolvePromise))
    child.kill('SIGTERM')
    const timer = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL') }, 10000)
    await exited
    clearTimeout(timer)
    return { alreadyExited: false, pid: child.pid, exitCode: child.exitCode, signalCode: child.signalCode }
  }
  const client = await webClient(log, spec.port)
  return { child, log, client, stop, launch }
}

export function processStartIdentity(pid) {
  try { return execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8' }).trim() }
  catch { return null }
}

export function processAlive(pid) {
  try { process.kill(pid, 0); return true } catch { return false }
}

// Verifies a restart against the pre-restart durable prefix.
export async function verifyRestart({ before, after, host }) {
  const problems = []
  if (host.child.pid === before.pid) problems.push('restart did not create a new host process')
  if (!before.exited) problems.push('original host process did not exit')
  if (!after.length) problems.push('no persisted history after restart')
  if (before.paginationHash !== after.paginationHash) problems.push('paginated history changed across restart')
  return { ok: problems.length === 0, problems }
}
