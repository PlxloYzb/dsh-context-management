// Campaign/run directory ownership and immutable run identity.
import { mkdir, readFile, writeFile, rename, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { sha256 } from './plan.mjs'

export const EVIDENCE_ROOT = '.test-runtime/longrun-20260915'

export function campaignRoot(campaign) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(campaign)) throw new Error('Campaign id must be lowercase kebab')
  return resolve(EVIDENCE_ROOT, campaign)
}

export function runDirectory(campaign, pairId, arm, runId) {
  return join(campaignRoot(campaign), pairId, arm, runId)
}

export async function ensurePrivateDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 })
}

export async function atomicJson(path, value, { mode = 0o600 } = {}) {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${randomUUID()}.tmp`
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode })
  await rename(temporary, path)
}

export async function readJson(path, fallback = undefined) {
  try { return JSON.parse(await readFile(path, 'utf8')) }
  catch (error) { if (error.code === 'ENOENT' && fallback !== undefined) return fallback; throw error }
}

// A run directory is immutable: its existence refuses a second run of the same id.
export async function createRunDirectory(path, runJson) {
  if (existsSync(path)) throw new Error(`RUN_DIRECTORY_EXISTS: ${path}`)
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await mkdir(path, { recursive: false, mode: 0o700 })
  for (const sub of ['events', 'objects', 'control', 'host', 'recovery', 'faults']) {
    await mkdir(join(path, sub), { recursive: true, mode: 0o700 })
  }
  await atomicJson(join(path, 'run.json'), runJson)
  return path
}

export function newRunId(pairId, arm, seed) {
  return `${pairId}-${arm}-${seed}-${randomUUID().slice(0, 8)}`
}

export async function listRuns(campaign, pairId) {
  const root = join(campaignRoot(campaign), pairId)
  if (!existsSync(root)) return []
  const rows = []
  for (const arm of await readdir(root)) {
    const armDir = join(root, arm)
    for (const runId of await readdir(armDir).catch(() => [])) {
      const runJson = join(armDir, runId, 'run.json')
      if (existsSync(runJson)) rows.push({ arm, runId, root: join(armDir, runId), run: await readJson(runJson) })
    }
  }
  return rows
}

export async function verifyFrozenHashes(root, names) {
  const hashes = {}
  for (const name of names) {
    const bytes = await readFile(join(root, name)).catch(() => null)
    hashes[name] = bytes ? sha256(bytes) : null
  }
  return hashes
}
