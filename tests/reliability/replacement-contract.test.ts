/**
 * Replacement contract probes for candidate a607d1c.
 * Real published Cordis, Loader, AgentPresetRegistry and Basic packages; synthetic
 * sessions and a consumer probe. No adapter, network request or daily profile.
 * Run: node --import tsx --test tests/reliability/replacement-contract.test.ts
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context, Service, symbols } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import Group from '@deepseek-ai/cordis-plugin-group'
import { AgentPresetRegistry, standingMountFor, serviceForAgent } from '@deepseek-ai/dsh-agent-preset-registry'
import type { PresetDefinition } from '@deepseek-ai/dsh-agent-preset-registry'
import { load as loadYaml } from 'js-yaml'
import { AgentRegistry, agentCarrier, agentEvents, type Agent } from '@deepseek-ai/dsh-agent'
import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic'
import { LlmRuntime } from '@deepseek-ai/dsh-llm'
import { createScope } from '@deepseek-ai/dsh-scope'
import { SessionId, SessionStore } from '@deepseek-ai/dsh-session'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { TokenMeter } from '@deepseek-ai/dsh-token-meter'
import ArcCompactionEngine, { isArcBackend } from '../../src/index.ts'
import { apply as applyBridge, rollbackMount, takeoverMount } from '../../src/bridge.ts'
import { inspectPresetComposition } from '../../src/preset-compat.ts'

const basicYaml = `- id: context-realm
  name: cordis:group
  group: true
  isolate:
    compaction: true
  config:
    - id: native-custom-id
      name: '@deepseek-ai/dsh-compaction-basic'
      config:
        thresholdRatio: 0.71
        retainTokens: 4096
        summarizationProvider: synthetic
        summarizationModel: fixture
        maxTokens: 1024
        compactionRetries: 2
        maxOverflowRetries: 0
        auto: true
    - id: consumer
      name: cordis:replacement-probe
`

interface Consumer {
  readonly ctx: Context
  readonly resolved: unknown
  disposed: boolean
}

function original(value: unknown): unknown {
  if (value !== null && typeof value === 'object') {
    return (value as { [symbols.original]?: unknown })[symbols.original] ?? value
  }
  return value
}

async function fixture(compositions: Record<string, string> = { standard: basicYaml }) {
  const directory = await mkdtemp(join(tmpdir(), 'ctx-replacement-contract-'))
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(TokenMeter)
  await ctx.plugin(JsonlSessionPersistence, { root: directory, compression: 'none', writeBatchMaxDelayMs: 10 })
  const runtime = { ctx, root: directory, async close() {
    try { await ctx.fiber.dispose() } finally { await rm(directory, { recursive: true, force: true }) }
  } }
  ctx.baseUrl = new URL('../../package.json', import.meta.url).href
  await ctx.plugin(Loader)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(AgentRegistry)
  ctx.loader.builtins.group = Group
  ctx.loader.builtins.include = Include
  const consumers: Consumer[] = []
  ctx.loader.builtins['replacement-probe'] = {
    inject: ['compaction'],
    apply(context: Context) {
      const consumer: Consumer = { ctx: context, resolved: original(context.compaction), disposed: false }
      consumers.push(consumer)
      context.effect(() => () => { consumer.disposed = true })
    },
  }
  class ThirdParty extends Service {
    constructor(context: Context) { super(context, 'compaction') }
  }
  ctx.loader.builtins['replacement-third-party'] = ThirdParty
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (specifier === '@deepseek-ai/dsh-compaction-basic') return BasicCompactionEngine
      if (specifier === '@deepseek-ai/dsh-agent-preset-registry') return import('@deepseek-ai/dsh-agent-preset-registry')
      throw new Error(`unexpected component import: ${specifier}`)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  const root = join(runtime.root, 'presets')
  const paths = new Map<string, string>()
  // DSH 0.1.7 registers presets as definitions; the registry no longer discovers
  // them from `roots` on disk. The files are still written so the tests can keep
  // asserting that a takeover never edits them.
  await ctx.plugin(AgentPresetRegistry, { default: Object.keys(compositions)[0]! })
  for (const [id, yaml] of Object.entries(compositions)) {
    const path = join(root, id, 'agent.cordis.yml')
    await mkdir(join(root, id), { recursive: true })
    await writeFile(path, yaml)
    paths.set(id, path)
    await ctx.agentPresets.register({ id, plugins: loadYaml(yaml) as PresetDefinition['plugins'] })
  }
  let sequence = 0
  const createAgent = async (presetId: string, announce = true) => {
    const id = SessionId(`replacement-contract-${++sequence}`)
    // The host dispatch contract uses the Agent object itself as its scope key.
    const agent = { id, session: ctx.sessions.create(id), options: {}, status: 'idle' } as unknown as Agent
    const scope = createScope(ctx, agent)
    Object.assign(agent, { ctx: scope.ctx })
    await ctx.agentPresets.mount(scope.ctx, presetId)
    if (announce) {
      ctx.agents.register(agent)
      // register() announces through an effect generator, and the bridge attaches
      // on agent/created; let that settle before the caller drives a boundary.
      for (let tick = 0; tick < 4; tick += 1) await new Promise(resolve => setImmediate(resolve))
    }
    return agent
  }
  const enableBridge = () => ctx.plugin((context: Context) => applyBridge(context, { autoNudge: false }))
  const boundary = (agent: Agent) => agentEvents(ctx, agent).waterfall('agent/pre-step', {
    signal: new AbortController().signal, turn: 1, step: 1, messages: [],
  }, async () => ({ kind: 'reject' as const }))
  const backend = (agent: Agent) => original(serviceForAgent(ctx, agent, 'compaction'))
  return { ...runtime, paths, consumers, createAgent, enableBridge, boundary, backend, ThirdParty }
}

function serviceKeys(ctx: Context, value: unknown): symbol[] {
  return Object.getOwnPropertySymbols(ctx.reflect.store).filter(key => {
    const impl = ctx.reflect.store[key] as { value?: unknown } | undefined
    return original(impl?.value) === original(value)
  })
}

test('RC01: real Basic retires its fiber and automatic listeners; ARC owns the same service symbol and consumer realm', async t => {
  const h = await fixture(); t.after(h.close)
  const events = ['agent/pre-step', 'agent/status', 'agent/request-error', 'session/event']
  const agent = await h.createAgent('standard', false)
  const mount = standingMountFor(agent.ctx)!
  const basic = h.backend(agent)
  assert.ok(basic instanceof BasicCompactionEngine)
  const basicFiber = [...mount.tree.entries()].find(row => row.options.name === '@deepseek-ai/dsh-compaction-basic')?.fiber
  assert.ok(basicFiber)
  const basicConfig = structuredClone(basic.config)
  const beforeConsumer = h.consumers.at(-1)!
  const realmKeys = serviceKeys(h.ctx, basic)
  assert.equal(realmKeys.length, 1)
  let pressureCalls = 0
  basic.compactIfNeeded = async () => { pressureCalls++; return null }
  await h.boundary(agent)
  assert.equal(pressureCalls, 1, 'the real Basic pre-step listener was active before takeover')
  // dispatch() returns newly bound functions on each read; compare the
  // exported host listener records instead, identified by their owning fiber.
  const callbacks = events.map(event => (h.ctx.events._hooks[event] ?? [])
    .filter(hook => hook.ctx.fiber.uid === basicFiber.uid))
  assert.ok(callbacks.every(list => list.length === 1), 'Basic owns exactly one of each automatic listener')
  h.ctx.loader.builtins['dsh-context-management'] = ArcCompactionEngine
  const tracked = new Map()
  // DSH 0.1.7 mounts a preset as an entry tree rather than a file-backed
  // Include, so the pre-existing external element to preserve is a row of that
  // tree - here the consumer probe the preset declares itself.
  const rowsBefore = [...mount.tree.entries()].map(row => `${row.options.id}:${row.options.name}`)
  assert.ok(rowsBefore.some(row => row.startsWith('consumer:')), 'the preset declares an unrelated row')
  assert.equal(await takeoverMount(h.ctx, { autoNudge: false }, mount, tracked), 'taken-over')
  const arc = h.backend(agent)
  assert.ok(arc instanceof ArcCompactionEngine)
  assert.deepEqual(serviceKeys(h.ctx, arc), realmKeys, 'the same private compaction symbol is reused')
  assert.equal(basicFiber.uid, null, 'the exact original Basic fiber has disposed')
  assert.equal(beforeConsumer.disposed, true)
  assert.ok(h.consumers.at(-1)!.resolved === arc, 'consumer and AgentPresetRegistry resolve the identical original backend')
  assert.equal(h.ctx.get('compaction'), undefined)
  events.forEach((event, index) => {
    const after = h.ctx.events._hooks[event] ?? []
    for (const callback of callbacks[index]!) {
      assert.equal(after.includes(callback), false, `${event}: original Basic callback withdrawn`)
    }
  })
  await h.boundary(agent)
  assert.equal(pressureCalls, 1, 'the retired Basic cannot compact subsequent steps')
  await rollbackMount(mount.fiber, tracked)
  const restored = h.backend(agent)
  assert.ok(restored instanceof BasicCompactionEngine)
  assert.notEqual(restored, basic)
  assert.deepEqual(restored.config, basicConfig, 'all original Basic options return unchanged')
  assert.deepEqual([...mount.tree.entries()].map(row => `${row.options.id}:${row.options.name}`), rowsBefore, 'the original row set returns')
  assert.deepEqual(serviceKeys(h.ctx, restored), realmKeys)
  assert.equal(await readFile(h.paths.get('standard')!, 'utf8'), basicYaml)
})

test('RC02: real AgentPresetRegistry switches one blank agent through Basic, minimal, third-party and another Basic realm', async t => {
  const third = basicYaml.replace("name: '@deepseek-ai/dsh-compaction-basic'", 'name: cordis:replacement-third-party')
  const h = await fixture({ standard: basicYaml, minimal: '[]', third, second: basicYaml }); t.after(h.close)
  const bridge = await h.enableBridge()
  const agent = await h.createAgent('standard')
  await h.boundary(agent)
  const firstArc = h.backend(agent)
  assert.ok(isArcBackend(firstArc))
  const initialMount = standingMountFor(agent.ctx)!
  for (const preset of ['minimal', 'third', 'second', 'standard']) {
    await h.ctx.agentPresets.select(agent, preset)
    await h.boundary(agent)
    if (preset === 'minimal') assert.equal(h.backend(agent), undefined)
    else if (preset === 'third') assert.ok(h.backend(agent) instanceof h.ThirdParty)
    else assert.ok(isArcBackend(h.backend(agent)))
  }
  assert.equal(standingMountFor(agent.ctx)!.fiber, initialMount.fiber)
  assert.equal(h.backend(agent), firstArc, 'returning to an existing standing preset reuses one ARC instance')
  await bridge.dispose()
  assert.ok(h.backend(agent) instanceof BasicCompactionEngine)
  for (const [id, yaml] of Object.entries({ standard: basicYaml, minimal: '[]', third, second: basicYaml })) {
    assert.equal(await readFile(h.paths.get(id)!, 'utf8'), yaml)
  }
})

test('RC03: enabling the bridge after an agent was created takes over at its next safe boundary', async t => {
  const h = await fixture(); t.after(h.close)
  const agent = await h.createAgent('standard')
  assert.ok(h.backend(agent) instanceof BasicCompactionEngine)
  await h.enableBridge()
  await h.boundary(agent)
  assert.ok(isArcBackend(h.backend(agent)), 'an already-live agent must not retain Basic after bridge activation')
})

test('RC04: a native Basic row appearing later in the mounted tree is retried at a boundary', async t => {
  const h = await fixture({ minimal: '[]' }); t.after(h.close)
  await h.enableBridge()
  const agent = await h.createAgent('minimal')
  await h.boundary(agent)
  assert.equal(h.backend(agent), undefined)
  const mount = standingMountFor(agent.ctx)!
  // A later composition adds a native backend in a realm of its own. The bridge
  // cached "no backend here" for this mount, and that must not survive the
  // composition changing under it.
  await mount.tree.create({
    name: '@deepseek-ai/dsh-compaction-basic',
    config: { thresholdRatio: 0.71, retainTokens: 4096, summarizationProvider: 'synthetic', summarizationModel: 'fixture', maxTokens: 1024, compactionRetries: 2, maxOverflowRetries: 0, auto: true },
  })
  await mount.tree.await()
  assert.ok(h.backend(agent) instanceof BasicCompactionEngine, 'the late native backend serves')
  await h.boundary(agent)
  assert.ok(isArcBackend(h.backend(agent)), 'a cached no-basic result must not survive changed live composition')
})

test('RC05: bridge disposal and reactivation rebind a newly created agent without mutating native config', async t => {
  const h = await fixture(); t.after(h.close)
  const firstBridge = await h.enableBridge()
  const first = await h.createAgent('standard')
  await h.boundary(first)
  assert.ok(isArcBackend(h.backend(first)))
  await firstBridge.dispose()
  assert.ok(h.backend(first) instanceof BasicCompactionEngine)
  const secondBridge = await h.enableBridge()
  const second = await h.createAgent('standard')
  await h.boundary(second)
  assert.ok(isArcBackend(h.backend(second)))
  assert.equal(h.backend(first), h.backend(second), 'existing and new agents share the same standing realm')
  await secondBridge.dispose()
  assert.ok(h.backend(second) instanceof BasicCompactionEngine)
  assert.equal(await readFile(h.paths.get('standard')!, 'utf8'), basicYaml)
})

test('RC06: compatibility audit recognizes valid YAML comments and inline isolation accepted by the real host', async t => {
  const yaml = basicYaml.replace('  isolate:\n    compaction: true', '  isolate: { compaction: true }')
    .replace("name: '@deepseek-ai/dsh-compaction-basic'", "name: '@deepseek-ai/dsh-compaction-basic' # official native provider")
  const h = await fixture({ standard: yaml }); t.after(h.close)
  await h.enableBridge()
  const agent = await h.createAgent('standard')
  await h.boundary(agent)
  assert.ok(isArcBackend(h.backend(agent)), 'real host and bridge successfully replace this valid composition')
  const report = inspectPresetComposition(yaml)
  assert.equal(report.patchable, true, 'read-only compatibility audit must agree with the exercised host composition')
  assert.equal(report.inheritsHostCompaction, false)
})

test('RC07: a renamed Basic row in a nested group is taken over beside the ids the preset already uses', async t => {
  // DSH 0.1.7 mounts a preset as an entry tree, so the row ids and the group
  // nesting are the preset author's, and the engine row has to find a free id
  // beside whatever the preset already declared.
  const nested = `- id: wrapper
  name: cordis:group
  group: true
  isolate:
    compaction: true
  config:
    - id: native-custom-id
      name: '@deepseek-ai/dsh-compaction-basic'
    - id: compaction-arc
      name: cordis:replacement-probe
`
  const h = await fixture({ nested }); t.after(h.close)
  const agent = await h.createAgent('nested', false)
  const mount = standingMountFor(agent.ctx)!
  const before = h.backend(agent)
  assert.ok(before instanceof BasicCompactionEngine)
  const realm = serviceKeys(h.ctx, before)
  const rows = () => [...mount.tree.entries()].map(row => `${row.options.id}:${row.options.name}`)
  const rowsBefore = rows()
  assert.ok(rowsBefore.some(row => row.startsWith('compaction-arc:')), 'the preset already uses the engine id')
  h.ctx.loader.builtins['dsh-context-management'] = ArcCompactionEngine
  const tracked = new Map()
  assert.equal(await takeoverMount(h.ctx, { autoNudge: false }, mount, tracked), 'taken-over')
  const arc = h.backend(agent)
  assert.ok(isArcBackend(arc))
  assert.deepEqual(serviceKeys(h.ctx, arc), realm, 'the engine takes over the same private realm')
  assert.equal(tracked.size, 1)
  const after = rows()
  assert.ok(after.some(row => row.startsWith('compaction-arc:')), 'the pre-existing row keeps its own id')
  // The tree mints its own id for a row created without one, so an id the preset
  // already uses cannot collide with the engine row.
  assert.ok(after.some(row => row.endsWith(':cordis:dsh-context-management')), 'the engine row is created')
  assert.equal(after.filter(row => row.endsWith(':cordis:dsh-context-management')).length, 1, 'exactly one engine row')
  for (const fiber of tracked.keys()) await rollbackMount(fiber, tracked)
  assert.ok(h.backend(agent) instanceof BasicCompactionEngine)
  assert.deepEqual(rows(), rowsBefore, 'the original row set returns')
})

test('RC08: an earlier successful takeover is verified again after runtime patches are reloaded', async t => {
  const h = await fixture(); t.after(h.close)
  await h.enableBridge()
  const agent = await h.createAgent('standard')
  await h.boundary(agent)
  assert.ok(isArcBackend(h.backend(agent)))
  const mount = standingMountFor(agent.ctx)!
  const config = mount.fiber.config as { path: string; patches?: Array<{ insert?: unknown }> }
  // External runtime reconfiguration uses the same safe two-phase order.
  // It restores source composition without writing the source preset file.
  config.patches = config.patches?.filter(patch => patch.insert === undefined)
  await mount.fiber.update(config, true)
  delete config.patches
  await mount.fiber.update(config, true)
  assert.ok(h.backend(agent) instanceof BasicCompactionEngine)
  await h.boundary(agent)
  assert.ok(isArcBackend(h.backend(agent)), 'a prior success must not hide a later native backend')
  assert.equal(await readFile(h.paths.get('standard')!, 'utf8'), basicYaml)
})

test('RC09: rollback preserves a replacement Include config object and its new external patches', async t => {
  const h = await fixture(); t.after(h.close)
  const bridge = await h.enableBridge()
  const agent = await h.createAgent('standard')
  await h.boundary(agent)
  assert.ok(isArcBackend(h.backend(agent)))
  const mount = standingMountFor(agent.ctx)!
  const previous = mount.fiber.config as { path: string; patches: unknown[] }
  const externalPatch = {
    id: 'native-custom-id', name: '@deepseek-ai/dsh-compaction-basic',
    config: { thresholdRatio: 0.63, retainTokens: 2039, auto: false, maxTokens: 1536 },
  }
  const externalConsumerPatch = { id: 'consumer', name: 'cordis:replacement-probe', config: { marker: 'external-after-takeover' } }
  const newConfig = {
    ...previous,
    externalOwner: { marker: 'new-include-object' },
    patches: [...previous.patches, externalPatch, externalConsumerPatch],
  }
  await mount.fiber.update(newConfig, true)
  assert.ok(mount.tree instanceof Include)
  const liveInclude = mount.tree
  assert.ok(liveInclude.config === newConfig, 'same-path update installs the new object on the Include instance')
  assert.ok(isArcBackend(h.backend(agent)))
  const beforeConsumer = [...mount.tree.entries()].find(row => row.options.id === 'consumer')
  assert.deepEqual(beforeConsumer?.options.config, externalConsumerPatch.config, 'external patches were actually applied before disposal')
  await bridge.dispose()
  const restored = h.backend(agent)
  assert.ok(restored instanceof BasicCompactionEngine)
  assert.equal(restored.config.thresholdRatio, 0.63, 'rollback preserves the external native policy update')
  assert.ok(liveInclude.config === newConfig, 'rollback retains the externally supplied live Include config identity')
  assert.deepEqual(newConfig.patches, [externalPatch, externalConsumerPatch])
  assert.equal(newConfig.externalOwner.marker, 'new-include-object')
  assert.equal(restored.config.retainTokens, 2039)
  assert.equal(restored.config.maxTokens, 1536)
  assert.equal(restored.config.auto, false)
  const consumer = [...mount.tree.entries()].find(row => row.options.id === 'consumer')
  assert.deepEqual(consumer?.options.config, externalConsumerPatch.config, 'the external consumer patch remains effective')
  assert.equal(await readFile(h.paths.get('standard')!, 'utf8'), basicYaml)
})

test('RC10: reacquiring Basic after an external new-config reload preserves that owner through later disposal', async t => {
  const h = await fixture(); t.after(h.close)
  const bridge = await h.enableBridge()
  const agent = await h.createAgent('standard')
  await h.boundary(agent)
  const mount = standingMountFor(agent.ctx)!
  const previous = mount.fiber.config as { path: string; patches: Array<{ insert?: unknown }> }
  const externalPatch = {
    id: 'native-custom-id', name: '@deepseek-ai/dsh-compaction-basic',
    config: { thresholdRatio: 0.64, retainTokens: 3011, auto: false, maxTokens: 2560 },
  }
  const nextPath = join(h.root, 'external-reload.yml')
  const nextSource = basicYaml.replace('id: consumer', 'id: external-consumer')
  await writeFile(nextPath, nextSource)
  // Retire ARC first, then supply a new path/object with only the external
  // owner's patch. This is a safe external reconfiguration, not bridge API.
  await mount.fiber.update({ ...previous, patches: previous.patches.filter(patch => patch.insert === undefined) }, true)
  const externalPatches = [externalPatch]
  const newConfig = { path: pathToFileURL(nextPath).href, patches: externalPatches, externalOwner: 'replacement-path' }
  await mount.fiber.update(newConfig, true)
  const restored = h.backend(agent)
  assert.ok(restored instanceof BasicCompactionEngine)
  assert.equal(restored.config.retainTokens, 3011)
  await h.boundary(agent)
  assert.ok(isArcBackend(h.backend(agent)), 'the current native instance is reacquired')
  assert.ok(mount.fiber.config === newConfig)
  assert.ok(newConfig.patches.includes(externalPatch))
  await bridge.dispose()
  const finalBackend = h.backend(agent)
  assert.ok(finalBackend instanceof BasicCompactionEngine)
  assert.ok(mount.fiber.config === newConfig)
  assert.ok(newConfig.patches === externalPatches, 'the new owner patch-array identity is restored')
  assert.equal(newConfig.path, pathToFileURL(nextPath).href)
  assert.equal(newConfig.externalOwner, 'replacement-path')
  assert.equal(finalBackend.config.thresholdRatio, 0.64)
  assert.equal(finalBackend.config.retainTokens, 3011)
  assert.equal(finalBackend.config.maxTokens, 2560)
  assert.equal(finalBackend.config.auto, false)
  assert.equal(await readFile(nextPath, 'utf8'), nextSource)
  assert.equal(await readFile(h.paths.get('standard')!, 'utf8'), basicYaml)
})

test('RC11: repeated bridge disable/re-enable covers the same already-live Agent without another creation event', async t => {
  const h = await fixture(); t.after(h.close)
  const agent = await h.createAgent('standard')
  const mount = standingMountFor(agent.ctx)!
  const listenerCount = () => [...h.ctx.events.dispatch('emit', [agentCarrier(agent), 'agent/pre-step', {}])].length
  const originalCount = listenerCount()
  const native = h.backend(agent)
  assert.ok(native instanceof BasicCompactionEngine)
  const config = structuredClone(native.config)
  let activeCount: number | undefined
  for (let cycle = 0; cycle < 3; cycle++) {
    const bridge = await h.enableBridge()
    await h.boundary(agent)
    assert.ok(isArcBackend(h.backend(agent)), `cycle ${cycle}: pre-existing agent is attached at bridge activation`)
    assert.ok(standingMountFor(agent.ctx)!.fiber === mount.fiber)
    assert.deepEqual(h.ctx.agents.list().map(value => value.id), [agent.id])
    assert.ok(h.ctx.agents.get(agent.id) === agent)
    activeCount ??= listenerCount()
    assert.equal(listenerCount(), activeCount, 'readiness and engine listeners do not accumulate')
    await bridge.dispose()
    assert.equal(listenerCount(), originalCount, 'bridge and engine listeners are fully withdrawn')
    const after = h.backend(agent)
    assert.ok(after instanceof BasicCompactionEngine)
    assert.deepEqual(after.config, config)
    await h.boundary(agent)
  }
  assert.equal(await readFile(h.paths.get('standard')!, 'utf8'), basicYaml)
})

test('RC12: first takeover preserves a same-path Include replacement configured before the bridge existed', async t => {
  const h = await fixture(); t.after(h.close)
  const agent = await h.createAgent('standard')
  const mount = standingMountFor(agent.ctx)!
  assert.ok(mount.tree instanceof Include)
  const liveInclude = mount.tree
  const before = mount.fiber.config as { path: string; patches?: unknown[] }
  const externalPatch = {
    id: 'native-custom-id', name: '@deepseek-ai/dsh-compaction-basic',
    config: { thresholdRatio: 0.66, retainTokens: 1777, auto: false, maxTokens: 2048 },
  }
  const externalPatches = [externalPatch]
  const newConfig = { ...before, patches: externalPatches, externalOwner: 'before-bridge' }
  await mount.fiber.update(newConfig, true)
  assert.ok(liveInclude.config === newConfig)
  const native = h.backend(agent)
  assert.ok(native instanceof BasicCompactionEngine)
  assert.equal(native.config.retainTokens, 1777)
  const bridge = await h.enableBridge()
  await h.boundary(agent)
  assert.ok(isArcBackend(h.backend(agent)))
  assert.ok(liveInclude.config === newConfig, 'first takeover starts from current Include config, not stale fiber config')
  assert.ok(newConfig.patches.includes(externalPatch))
  await bridge.dispose()
  assert.ok(liveInclude.config === newConfig)
  assert.ok(newConfig.patches === externalPatches)
  const after = h.backend(agent)
  assert.ok(after instanceof BasicCompactionEngine)
  assert.equal(after.config.thresholdRatio, 0.66)
  assert.equal(after.config.retainTokens, 1777)
  assert.equal(after.config.maxTokens, 2048)
  assert.equal(after.config.auto, false)
  assert.equal(newConfig.externalOwner, 'before-bridge')
  assert.equal(await readFile(h.paths.get('standard')!, 'utf8'), basicYaml)
})

test('RC13: rollback uses the current Include after a path restart followed by a same-path config update', async t => {
  const h = await fixture(); t.after(h.close)
  const bridge = await h.enableBridge()
  const agent = await h.createAgent('standard')
  await h.boundary(agent)
  const mount = standingMountFor(agent.ctx)!
  const previous = mount.fiber.config as { path: string; patches: unknown[] }
  const nextPath = join(h.root, 'restarted-include.yml')
  await writeFile(nextPath, basicYaml)
  const restartedConfig = { ...previous, path: pathToFileURL(nextPath).href, patches: [...previous.patches] }
  await mount.fiber.update(restartedConfig, true)
  assert.ok(isArcBackend(h.backend(agent)))
  const externalPatch = {
    id: 'native-custom-id', name: '@deepseek-ai/dsh-compaction-basic',
    config: { thresholdRatio: 0.68, retainTokens: 1889, auto: false, maxTokens: 3072 },
  }
  const liveConfig = { ...restartedConfig, patches: [...restartedConfig.patches, externalPatch], externalOwner: 'after-restart' }
  await mount.fiber.update(liveConfig, true)
  assert.ok(isArcBackend(h.backend(agent)))
  await bridge.dispose()
  const native = h.backend(agent)
  assert.ok(native instanceof BasicCompactionEngine)
  assert.equal(native.config.thresholdRatio, 0.68, 'the policy applied to the current Include survives bridge disposal')
  assert.equal(native.config.retainTokens, 1889)
  assert.equal(native.config.maxTokens, 3072)
  assert.equal(native.config.auto, false)
  assert.deepEqual(liveConfig.patches, [externalPatch])
  assert.equal(await readFile(nextPath, 'utf8'), basicYaml)
  assert.equal(await readFile(h.paths.get('standard')!, 'utf8'), basicYaml)
})

test('RC14: external no-backend configuration survives disposal after a path restart and same-path update', async t => {
  const h = await fixture(); t.after(h.close)
  const bridge = await h.enableBridge()
  const agent = await h.createAgent('standard')
  await h.boundary(agent)
  const mount = standingMountFor(agent.ctx)!
  const previous = mount.fiber.config as { path: string; patches: unknown[] }
  const nextPath = join(h.root, 'external-no-backend.yml')
  await writeFile(nextPath, basicYaml)
  const restarted = { ...previous, path: pathToFileURL(nextPath).href, patches: [...previous.patches] }
  await mount.fiber.update(restarted, true)
  const disableNative = { id: 'native-custom-id', name: '@deepseek-ai/dsh-compaction-basic', disabled: true }
  const disableArc = { id: 'compaction-arc', name: 'cordis:dsh-context-management', disabled: true }
  const externalPolicy = {
    id: 'native-custom-id', name: '@deepseek-ai/dsh-compaction-basic',
    config: { thresholdRatio: 0.62, retainTokens: 1993, auto: false },
  }
  const external = [disableNative, disableArc, externalPolicy]
  const liveConfig = { ...restarted, patches: [...restarted.patches, ...external], externalOwner: 'explicit-no-backend' }
  await mount.fiber.update(liveConfig, true)
  assert.equal(h.backend(agent), undefined, 'the external update actually removed the current compaction service')
  await bridge.dispose()
  assert.equal(h.backend(agent), undefined, 'bridge disposal does not re-enable externally disabled Basic')
  assert.deepEqual(liveConfig.patches, external, 'only the two bridge-owned patches are removed')
  assert.equal(liveConfig.externalOwner, 'explicit-no-backend')
  assert.equal(await readFile(nextPath, 'utf8'), basicYaml)
  assert.equal(await readFile(h.paths.get('standard')!, 'utf8'), basicYaml)
})

test('RC15: a rejected Include update is never used as the committed config during bridge disposal', async t => {
  const h = await fixture(); t.after(h.close)
  const bridge = await h.enableBridge()
  const agent = await h.createAgent('standard')
  await h.boundary(agent)
  const mount = standingMountFor(agent.ctx)!
  assert.ok(mount.tree instanceof Include)
  const liveInclude = mount.tree
  const previous = mount.fiber.config as { path: string; patches: unknown[] }
  const acceptedPolicy = {
    id: 'native-custom-id', name: '@deepseek-ai/dsh-compaction-basic',
    config: { thresholdRatio: 0.67, retainTokens: 2027, auto: false },
  }
  const goodConfig = { ...previous, patches: [...previous.patches, acceptedPolicy], externalOwner: 'accepted' }
  await mount.fiber.update(goodConfig, true)
  const rejectedPolicy = { ...acceptedPolicy, config: { thresholdRatio: 0.51, retainTokens: 911, auto: false } }
  h.ctx.loader.builtins['replacement-reject'] = () => { throw new Error('injected external Include update rejection') }
  const failingInsertion = { id: 'context-realm', insert: [{ id: 'rejected-entry', name: 'cordis:replacement-reject' }] }
  const rejectedConfig = { ...goodConfig, patches: [...goodConfig.patches, rejectedPolicy, failingInsertion], externalOwner: 'rejected' }
  await assert.rejects(async () => { await mount.fiber.update(rejectedConfig, true) }, /injected external Include update rejection/)
  assert.ok(liveInclude.config === goodConfig, 'the host did not commit the rejected Include object')
  assert.ok(isArcBackend(h.backend(agent)), 'the accepted backend remains available after host rollback')
  await bridge.dispose()
  const native = h.backend(agent)
  assert.ok(native instanceof BasicCompactionEngine)
  assert.equal(native.config.thresholdRatio, 0.67, 'the rejected native policy never enters bridge restoration')
  assert.equal(native.config.retainTokens, 2027)
  assert.equal(native.config.auto, false)
  assert.ok(liveInclude.config === goodConfig)
  assert.deepEqual(goodConfig.patches, [acceptedPolicy])
  assert.equal(goodConfig.externalOwner, 'accepted')
  assert.equal(await readFile(h.paths.get('standard')!, 'utf8'), basicYaml)
})
