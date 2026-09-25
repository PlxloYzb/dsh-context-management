// Isolated host lifecycle for one long-run arm: private DSH_HOME, dedicated
// profile, frozen binary identity, and restart-safe launch bookkeeping.
import { spawn, execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { mkdir, readFile, writeFile, readdir, copyFile } from 'node:fs/promises'
import { join, resolve, dirname } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { createHash, randomUUID } from 'node:crypto'
import { webClient } from '../client.mjs'
import { writePrivateSettings } from '../local/private-settings.mjs'
import { atomicJson } from './context.mjs'

export const PINNED_HOST = resolve('.test-runtime/host-pins/dsh-0.1.2-rc.1/node_modules/.bin/dsh')
export const PINNED_HOST_PACKAGE = resolve('.test-runtime/host-pins/dsh-0.1.2-rc.1/node_modules/@deepseek-ai/dsh/package.json')
export const PINNED_HOST_VERSION = '0.1.2-rc.1'

export function sha256(value) { return createHash('sha256').update(value).digest('hex') }

export async function pinnedHostIdentity(dshBin = PINNED_HOST) {
  const realpath = execFileSync('realpath', [dshBin], { encoding: 'utf8' }).trim()
  const version = JSON.parse(await readFile(PINNED_HOST_PACKAGE, 'utf8')).version
  if (version !== PINNED_HOST_VERSION) throw new Error(`Pinned host version changed: ${version}`)
  const requested = resolve(dshBin)
  if (requested !== resolve(PINNED_HOST) && !requested.startsWith(resolve('.test-runtime/host-pins/'))) {
    throw new Error('EXPERIMENT_DSH_BIN must point at the pinned 0.1.2-rc.1 host')
  }
  const binaryBytes = await readFile(dshBin)
  const libRoot = dirname(dirname(realpath))
  return { requested, realpath, version, binarySha256: sha256(binaryBytes), libRoot }
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
  const bundles = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']
  if (command.pluginBundle) bundles.push('dsh-context-management')
  await writeFile(join(profileDir, 'package.json'), JSON.stringify({
    name: `dsh-profile-${profile}`,
    private: true,
    dependencies: {},
    dsh: { profile: { bundles, patchReload: 'live' } },
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
  // The host's shipped presets live beside the pinned package; copy them
  // byte-identically into the isolated home so shipped files stay read-only.
  const shippedPresets = resolve(dirname(dirname(dshBin)), '@deepseek-ai/dsh-agent-preset-registry/presets')
  const presetHashes = {}
  for (const id of ['standard', 'minimal', 'ptc', 'cordis']) {
    const source = join(shippedPresets, id, 'agent.cordis.yml')
    if (!existsSync(source)) throw new Error(`Shipped preset missing: ${source}`)
    presetHashes[id] = sha256(await readFile(source))
    const target = join(home, '.agent-presets', id)
    await mkdir(target, { recursive: true, mode: 0o700 })
    await copyFile(source, join(target, 'agent.cordis.yml'))
  }
  // The synthetic cwd carries the ownership marker the fixture tools and the
  // observer both require, so an unattributed session can never reach them.
  const marker = sessionMarker ?? 'dsh-context-experiment-'
  const cwd = join(root, `${marker}${arm.toLowerCase()}`)
  await mkdir(cwd, { recursive: true, mode: 0o700 })
  await writeFile(join(cwd, 'README.txt'), 'Synthetic experiment working directory. Only the assigned experiment tools are available.\n', { mode: 0o600 })
  return { home, profile, profileDir, settingsPath, shippedPresets, presetHashes, cwd, env, installLog, credentialsHash }
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
