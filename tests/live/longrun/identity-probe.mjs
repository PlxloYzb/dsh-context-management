// Runtime diagnostic: does a plugin-loaded copy of @deepseek-ai/dsh-llm see the
// agent-loop request marks the host sets?
//
// Usage: COREPACK_ENABLE_AUTO_PIN=0 EXPERIMENT_DSH_BIN=<pinned dsh> \
//          node tests/live/longrun/identity-probe.mjs
//
// Runtime identity reproduction, faithful module resolution.
//
// The probe file is written *beside the installed plugin* inside the profile's
// pnpm virtual store, so its `@deepseek-ai/dsh-llm` import resolves exactly the
// way the product plugin's own import does. It then reports, at runtime, whether
// that copy recognises a request the host marked as an agent-loop request.
import { mkdir, readFile, writeFile, readdir, mkdtemp } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { prepareIsolatedHome, launchHost, PINNED_HOST } from './host.mjs'
import { arcBridgeConfig, loadPlan } from './plan.mjs'

const yaml = createRequire(import.meta.url)(resolve('.test-runtime/host-pins/dsh-0.1.2-rc.1/node_modules/yaml'))
const { plan, geometry } = await loadPlan('docs/experiments/muse-longrun-v1.plan.json')
const root = resolve('.test-runtime/identity-probe/run')
await mkdir(root, { recursive: true })
const settingsBytes = await readFile(join(homedir(), '.dsh/settings.yaml'))
const home = await prepareIsolatedHome({
  root, arm: 'ARC_DEFERRED', dshBin: PINNED_HOST,
  tarball: resolve('.test-runtime/longrun-20260915/artifacts/b31f49e922de79e8810a40f2932cf8c00b681fdfc989fe5d26bbe1a41940fa12.tgz'),
  seedSettingsBytes: settingsBytes,
  command: { pluginBundle: true },
})

// Locate the installed plugin directory inside the pnpm virtual store.
async function findPluginDir(base) {
  const store = join(base, 'node_modules', '.pnpm')
  for (const entry of await readdir(store).catch(() => [])) {
    if (!entry.startsWith('dsh-context-management@')) continue
    const candidate = join(store, entry, 'node_modules', 'dsh-context-management')
    if (existsSync(join(candidate, 'dist', 'index.js'))) return candidate
  }
  return null
}
const pluginDir = await findPluginDir(home.profileDir)
if (!pluginDir) throw new Error('installed plugin directory not found in the profile store')

const probePath = join(pluginDir, 'lr3m-identity-probe.mjs')
await writeFile(probePath, `import { writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { isAgentLoopRequest } from '@deepseek-ai/dsh-llm'
export const inject = ['llm']
export function apply(ctx, config) {
  const require = createRequire(import.meta.url)
  const rows = []
  ctx.on('llm/stream', async function* (request, next) {
    rows.push({
      at: new Date().toISOString(),
      purpose: request.purpose ?? null,
      probeDshLlm: require.resolve('@deepseek-ai/dsh-llm'),
      probeRecognizesAgentLoopRequest: isAgentLoopRequest(request),
    })
    writeFileSync(config.output, JSON.stringify(rows, null, 2) + '\\n', { mode: 0o600 })
    yield* next()
  })
}
`, { mode: 0o600 })

const output = join(root, 'identity.json')
const patch = join(root, 'host.patch.yml')
await writeFile(patch, yaml.stringify([
  { id: 'settings', config: { path: home.settingsPath } },
  { id: 'session-title-llm', disabled: true },
  { id: 'tool-skill', disabled: true },
  { id: 'compaction-context-management-bridge', config: arcBridgeConfig(plan, geometry) },
  { insert: [{ id: 'identity-probe', name: probePath, config: { output } }] },
]), { mode: 0o600 })

// launchHost passes the explicit per-child environment (DSH_HOME) that the
// shared short-harness startHost does not.
const host = await launchHost({ dshBin: PINNED_HOST, root, profile: home.profile, patch, port: 3394, env: home.env }, 'identity')
const result = { hostDshLlm: resolve(dirname(PINNED_HOST), '..', '@deepseek-ai/dsh-llm/lib/index.js'), pluginDir, probePath }
try {
  const cwd = await mkdtemp(join(tmpdir(), 'dsh-context-experiment-identity-'))
  const { sessionId } = await host.client.call('session/create', { cwd, agentPreset: 'standard' })
  await host.client.call('session/selectModel', { sessionId, ...plan.environment.model })
  await host.client.prompt(sessionId, 'Synthetic identity probe. Reply exactly PROBE_OK. Do not use tools.', 180000)
  result.rows = JSON.parse(await readFile(output, 'utf8'))
  const row = result.rows[0] ?? null
  result.sameRealPath = row ? row.probeDshLlm === result.hostDshLlm : null
  result.verdict = row?.probeRecognizesAgentLoopRequest === true ? 'PLUGIN SEES HOST MARK' : 'PLUGIN CANNOT SEE HOST MARK'
} catch (error) {
  result.error = String(error.message ?? error)
} finally { await host.stop().catch(() => {}) }
console.log(JSON.stringify(result, null, 2))
