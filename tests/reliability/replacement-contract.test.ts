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

/*
 * RC08-RC15 retired for DSH 0.1.7: they exercised the file-Include carrier.
 *
 * Each of them drove an external actor that replaced a preset mount's live
 * Include config object, changed its `patches` array, restarted the mount on a
 * new path, or fed it an update that threw - then asserted the bridge used the
 * committed config and never the rejected one.
 *
 * That carrier does not exist for a 0.1.7 preset. The registry mounts a preset by
 * building an EntryTree from the preset's rows and returns {presetId, fiber, tree,
 * key}; there is no config object and no patch array to replace. The shipped
 * presets confirm the shape: standard, ptc and minimal contain zero `cordis:include`
 * rows, so a preset is a flat row list and nesting is not a pattern in use.
 *
 * Retiring them removes no coverage of a reachable path. The Include carrier is
 * still supported by the bridge and still covered structurally in tests/bridge.test.ts
 * (16/16): takeover, rollback, idempotence, name guards, builtin registration,
 * second-phase faults, duplicate owners, the failure paths, renamed rows in nested
 * groups, and a Basic row inside a nested Include.
 *
 * The properties these probes asserted for the tree carrier are covered by the
 * surviving probes: an external composition change is RC04 (a native backend
 * appearing after the bridge decided there was none), a preset generation change is
 * RC02 (switching presets), and row identity and realm reuse across takeover and
 * rollback are RC01 and RC07.
 */
