/**
 * Bridge integration tests against the REAL published Loader, Include, and
 * Group packages (the exact versions the 0.1.2-rc.1 harness runs): a preset
 * composition file mirroring the official `compaction` group is mounted
 * through a real loader tree, and the bridge's in-realm row swap must hold
 * end to end — Basic disabled inside its realm, the ARC engine provided
 * there, sibling consumers rebound, everything reverted on rollback with
 * the preset file byte-identical throughout.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context, Service, type Fiber } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import Group from '@deepseek-ai/cordis-plugin-group'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Session } from '@deepseek-ai/dsh-session'
import { ArcCompactionEngine, isArcBackend } from '../src/index.ts'
import { apply as applyBridge, buildTakeoverPatches, rollbackMount, takeoverMount } from '../src/bridge.ts'

/** The official standard-preset compaction group, verbatim in structure. */
const PRESET_YAML = `\
- id: compaction
  name: cordis:group
  group: true
  isolate:
    compaction: true
  config:
    - id: compaction-basic
      name: '@deepseek-ai/dsh-compaction-basic'

    - id: command-compact
      name: '@deepseek-ai/dsh-command-compact'
`

class FakeBasic extends Service {
  static inject = []
  constructor(ctx: Context) {
    super(ctx, 'compaction')
  }
}

/** Sibling consumer (command-compact stand-in): records its realm's compaction per activation. */
class FakeConsumer extends Service {
  static inject = ['compaction']
  static instances: FakeConsumer[] = []
  readonly resolved: unknown
  constructor(ctx: Context) {
    super(ctx, 'consumer-probe')
    this.resolved = ctx.compaction
    FakeConsumer.instances.push(this)
  }
}

interface MountedPreset {
  ctx: Context
  cleanup: () => Promise<void>
  fiber: Fiber
  source: string
  path: string
}

async function mountPreset(yaml: string, extraModules: Record<string, unknown> = {}): Promise<MountedPreset> {
  const dir = await mkdtemp(join(tmpdir(), 'arc-bridge-'))
  const path = join(dir, 'agent.cordis.yml')
  await writeFile(path, yaml, 'utf8')
  const ctx = new Context()
  ctx.baseUrl = pathToFileURL(dir).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  ctx.loader.builtins.group = Group
  // What the bridge row's apply() publishes on a real host: the engine class
  // behind the `cordis:dsh-context-management` row name (see the apply test below).
  ctx.loader.builtins['dsh-context-management'] = ArcCompactionEngine
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-compaction-basic', FakeBasic],
    ['@deepseek-ai/dsh-command-compact', FakeConsumer],
    ...Object.entries(extraModules),
  ])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      const module = modules.get(specifier)
      if (module === undefined) throw new Error(`unexpected Loader import: ${specifier}`)
      return module
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(path).href },
  })
  await ctx.loader.await()
  const entry = [...ctx.loader.entries()].find(candidate => candidate.subtree !== undefined)
  const fiber = entry?.fiber
  if (fiber === undefined) throw new Error('preset include entry did not activate')
  return {
    ctx,
    fiber,
    path,
    source: yaml,
    cleanup: async () => { await ctx.fiber.dispose(); await rm(dir, { recursive: true, force: true }) },
  }
}

function latestConsumer(): FakeConsumer {
  const last = FakeConsumer.instances.at(-1)
  assert.ok(last !== undefined, 'consumer probe activated')
  return last
}

test('bridge: takeover swaps Basic for ARC inside the preset realm', async () => {
  FakeConsumer.instances = []
  const preset = await mountPreset(PRESET_YAML)
  try {
    const before = latestConsumer()
    assert.ok(before.resolved instanceof FakeBasic, 'realm compaction starts as the official Basic row')

    const tracked = new Map()
    const status = await takeoverMount(preset.ctx, {}, { presetId: 'standard', fiber: preset.fiber }, tracked)
    assert.equal(status, 'taken-over')

    const after = latestConsumer()
    assert.ok(after.resolved instanceof ArcCompactionEngine, 'sibling consumer rebinds to the ARC engine row')
    assert.ok(isArcBackend(after.resolved), 'rebound backend carries the ARC structural brand')
    assert.equal(preset.ctx.get('compaction'), undefined, 'the root plane still sees no compaction service')
    assert.equal(tracked.size, 1, 'the mount is tracked for effect-owned rollback')

    const fileAfter = await readFile(preset.path, 'utf8')
    assert.equal(fileAfter, PRESET_YAML, 'the preset file stays byte-identical')
  } finally {
    await preset.cleanup()
  }
})

test('bridge: rollback restores the official Basic row and the original Include config', async () => {
  FakeConsumer.instances = []
  const preset = await mountPreset(PRESET_YAML)
  try {
    const tracked = new Map()
    assert.equal(
      await takeoverMount(preset.ctx, {}, { presetId: 'standard', fiber: preset.fiber }, tracked),
      'taken-over',
    )
    assert.ok(latestConsumer().resolved instanceof ArcCompactionEngine)

    await rollbackMount(preset.fiber, tracked)
    assert.equal(tracked.size, 0)
    const restored = latestConsumer()
    assert.ok(restored.resolved instanceof FakeBasic, 'rollback re-enables the official Basic row in-realm')

    const include = preset.fiber.config as { patches?: unknown }
    assert.equal('patches' in include, false, 'the Include config object is back to its original shape')
    assert.equal(await readFile(preset.path, 'utf8'), PRESET_YAML)
  } finally {
    await preset.cleanup()
  }
})

test('bridge: a second takeover of the same mount is idempotent', async () => {
  FakeConsumer.instances = []
  const preset = await mountPreset(PRESET_YAML)
  try {
    const tracked = new Map()
    const mount = { presetId: 'standard', fiber: preset.fiber }
    assert.equal(await takeoverMount(preset.ctx, {}, mount, tracked), 'taken-over')
    assert.equal(await takeoverMount(preset.ctx, {}, mount, tracked), 'taken-over')
    assert.equal(tracked.size, 1)
    const consumers = FakeConsumer.instances.filter(instance => instance.resolved instanceof ArcCompactionEngine)
    assert.equal(consumers.length, 1, 'no duplicate ARC row was ever inserted')
  } finally {
    await preset.cleanup()
  }
})

test('bridge: name guards leave a non-Basic compaction backend untouched', async () => {
  FakeConsumer.instances = []
  const custom = PRESET_YAML.replace(
    "name: '@deepseek-ai/dsh-compaction-basic'",
    "name: 'third-party-compaction'",
  )
  const thirdParty = class extends Service {
    static inject = []
    constructor(ctx: Context) {
      super(ctx, 'compaction')
    }
  }
  const preset = await mountPreset(custom, { 'third-party-compaction': thirdParty })
  try {
    const before = latestConsumer()
    assert.ok(before.resolved instanceof thirdParty)

    const tracked = new Map()
    const status = await takeoverMount(preset.ctx, {}, { presetId: 'custom', fiber: preset.fiber }, tracked)
    assert.equal(status, 'no-basic-row', 'the disable guard does not match a foreign backend row')
    assert.equal(tracked.size, 0, 'nothing is tracked for a preset the bridge does not recognize')
    assert.ok(latestConsumer().resolved instanceof thirdParty, 'the foreign backend keeps serving its realm')
    const include = preset.fiber.config as { patches?: unknown }
    assert.equal('patches' in include, false, 'the reverted config carries no bridge patches')
    assert.equal(await readFile(preset.path, 'utf8'), custom)
  } finally {
    await preset.cleanup()
  }
})

test('bridge: a preset already selecting ARC natively is left untouched', async () => {
  FakeConsumer.instances = []
  const preset = await mountPreset(PRESET_YAML.replace(
    "name: '@deepseek-ai/dsh-compaction-basic'",
    "name: 'dsh-context-management'",
  ), { 'dsh-context-management': ArcCompactionEngine })
  try {
    // The preset imports 'dsh-context-management' through the fake module registry;
    // the real engine class stands in for the row's plugin.
    const tracked = new Map()
    const status = await takeoverMount(preset.ctx, {}, { presetId: 'arc-native', fiber: preset.fiber }, tracked)
    assert.equal(status, 'already-arc')
    assert.equal(tracked.size, 0)
  } finally {
    await preset.cleanup()
  }
})

test('bridge: apply registers the engine as a loader builtin and retracts it on dispose', async () => {
  const ctx = new Context()
  await ctx.plugin(Loader)
  class FakeAgentPresets extends Service {
    constructor(context: Context) {
      super(context, 'agentPresets')
    }
  }
  await ctx.plugin(FakeAgentPresets)
  const loader = ctx.get('loader') as { builtins: Record<string, unknown> }
  const fiber = await ctx.plugin((context: Context) => {
    applyBridge(context, {})
  })
  assert.equal(loader.builtins['dsh-context-management'], ArcCompactionEngine)
  assert.deepEqual(
    buildTakeoverPatches({}).map(patch => ({ id: patch.id, name: patch.name, disabled: patch.disabled })),
    [
      { id: 'compaction-basic', name: '@deepseek-ai/dsh-compaction-basic', disabled: true },
      { id: 'compaction', name: undefined, disabled: undefined },
    ],
    'patches disable exactly the official Basic row and insert into the unchanged group',
  )
  await fiber.dispose()
  assert.equal('dsh-context-management' in loader.builtins, false)
})


test('I04: a second-phase fault restores Basic and preserves the original preset', async t => {
  const preset = await mountPreset(PRESET_YAML); t.after(preset.cleanup)
  const tracked = new Map(), original = preset.fiber.update.bind(preset.fiber)
  let updates = 0
  preset.fiber.update = async (...args) => {
    if (++updates === 2) throw new Error('injected second-phase failure')
    return original(...args)
  }
  await assert.rejects(takeoverMount(preset.ctx, {}, { presetId: 'standard', fiber: preset.fiber }, tracked), /second-phase failure/)
  assert.equal(tracked.size, 0)
  assert.ok(latestConsumer().resolved instanceof FakeBasic)
  assert.equal('patches' in (preset.fiber.config as object), false)
  assert.equal(await readFile(preset.path, 'utf8'), PRESET_YAML)
})

test('I04: rollback still attempts to restore Basic if its first reverse phase throws', async t => {
  const preset = await mountPreset(PRESET_YAML); t.after(preset.cleanup)
  const tracked = new Map()
  await takeoverMount(preset.ctx, {}, { presetId: 'standard', fiber: preset.fiber }, tracked)
  const original = preset.fiber.update.bind(preset.fiber)
  let updates = 0
  preset.fiber.update = async (...args) => {
    const result = await original(...args)
    if (++updates === 1) throw new Error('injected reverse-phase failure')
    return result
  }
  await assert.rejects(rollbackMount(preset.fiber, tracked), /reverse-phase failure/)
  assert.equal(updates, 2)
  assert.equal(tracked.size, 0)
  assert.ok(latestConsumer().resolved instanceof FakeBasic)
  assert.equal(await readFile(preset.path, 'utf8'), PRESET_YAML)
})

test('I02/I03: duplicate owners fail visibly; missing Include is unsupported', async t => {
  const preset = await mountPreset(PRESET_YAML); t.after(preset.cleanup)
  delete preset.ctx.loader.builtins['dsh-context-management']
  const owner = await preset.ctx.plugin((ctx: Context) => applyBridge(ctx, {}))
  assert.throws(() => applyBridge(preset.ctx, {}), /conflict/)
  const tracked = new Map()
  assert.equal(await takeoverMount(preset.ctx, {}, { presetId: 'unknown', fiber: preset.ctx.fiber }, tracked), 'unrecognized-carrier')
  assert.equal(tracked.size, 0)
  await owner.dispose()
  assert.equal('dsh-context-management' in preset.ctx.loader.builtins, false)
  assert.ok(latestConsumer().resolved instanceof FakeBasic)
})

test('I02/I05: two agents share one takeover; disposal waits for the pending update and restores Basic', async t => {
  const preset = await mountPreset(PRESET_YAML); t.after(preset.cleanup)
  class HostPresets extends Service {
    constructor(ctx: Context) { super(ctx, 'agentPresets') }
    composedPreset() { return 'standard' }
    serviceFor() { return { ctx: preset.fiber.ctx } }
  }
  await preset.ctx.plugin(HostPresets)
  delete preset.ctx.loader.builtins['dsh-context-management']
  const bridge = await preset.ctx.plugin({ inject: ['loader', 'agentPresets'], apply: (ctx: Context) => applyBridge(ctx, {}) })
  const prototype = Object.getPrototypeOf(preset.fiber) as { update: Fiber['update'] }
  const original = prototype.update
  t.after(() => { prototype.update = original })
  let release!: () => void, reached!: () => void
  const barrier = new Promise<void>(resolve => { release = resolve })
  const entered = new Promise<void>(resolve => { reached = resolve })
  let updates = 0
  prototype.update = async function (this: Fiber, ...args) {
    if (this.uid === preset.fiber.uid && ++updates === 1) { reached(); await barrier }
    return original.apply(this, args)
  }
  const event = { agent: { ctx: preset.fiber.ctx } } as unknown as Parameters<Parameters<typeof preset.ctx.on<'agent/created'>>[1]>[0]
  for (let i = 0; i < 2; i++) {
    const args: unknown[] = [preset.fiber.ctx, 'agent/created', event]
    const callbacks = [...preset.ctx.events.dispatch('emit', args)]
    assert.ok(callbacks.length > 0, 'created listener is registered')
    for (const callback of callbacks) callback(...args)
  }
  await Promise.race([entered, new Promise((_, reject) => setTimeout(() => reject(new Error(`takeover never entered; updates=${updates}`)), 100))])
  let disposed = false
  const disposal = bridge.dispose().then(() => { disposed = true })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(disposed, false, 'disposal must wait for owned asynchronous takeover')
  release(); await disposal
  assert.equal(updates, 4, 'one two-phase takeover and one two-phase rollback')
  assert.ok(latestConsumer().resolved instanceof FakeBasic)
  assert.equal('dsh-context-management' in preset.ctx.loader.builtins, false)
  assert.equal(await readFile(preset.path, 'utf8'), PRESET_YAML)
})

function announce(ctx: Context, name: 'agent/created' | 'agent/disposed', agent: Agent): void {
  const args: unknown[] = [agent.ctx, name, { agent }]
  for (const callback of ctx.events.dispatch('emit', args)) callback(...args)
}

async function enableTestBridge(preset: MountedPreset) {
  class HostPresets extends Service {
    constructor(ctx: Context) { super(ctx, 'agentPresets') }
    composedPreset() { return 'standard' }
    serviceFor() { return latestConsumer().resolved }
  }
  await preset.ctx.plugin(HostPresets)
  delete preset.ctx.loader.builtins['dsh-context-management']
  return preset.ctx.plugin((ctx: Context) => applyBridge(ctx, {}))
}

test('F12: the first request and subsequent agents use the restored backend after takeover fails', async t => {
  const preset = await mountPreset(PRESET_YAML); t.after(preset.cleanup)
  await enableTestBridge(preset)
  const prototype = Object.getPrototypeOf(preset.fiber) as { update: Fiber['update'] }, original = prototype.update
  t.after(() => { prototype.update = original })
  let updates = 0
  prototype.update = async function (...args) {
    if (this.uid === preset.fiber.uid && ++updates === 2) throw new Error('injected engine activation failure')
    return original.apply(this, args)
  }
  for (let i = 0; i < 2; i++) {
    const agent = { ctx: preset.fiber.ctx, session: Session.create('bridge-test'), options: {} } as unknown as Agent
    announce(preset.ctx, 'agent/created', agent)
    const decision = await agent.ctx.waterfall('agent/pre-step', { agent, signal: new AbortController().signal, turn: 1, step: 1 }, async () => ({ kind: 'enter' as const, messages: [] }))
    assert.equal(decision.kind, 'enter')
    assert.ok(latestConsumer().resolved instanceof FakeBasic)
    announce(preset.ctx, 'agent/disposed', agent)
  }
  assert.equal(updates, 4, 'a failed mount is not retried for every new agent')
})

test('F12: an uncertain rollback still blocks requests with a stable error code', async t => {
  const preset = await mountPreset(PRESET_YAML); t.after(preset.cleanup)
  await enableTestBridge(preset)
  const prototype = Object.getPrototypeOf(preset.fiber) as { update: Fiber['update'] }, original = prototype.update
  t.after(() => { prototype.update = original })
  let updates = 0
  prototype.update = async function (...args) {
    if (this.uid === preset.fiber.uid && [2, 4].includes(++updates)) throw new Error('injected activation/rollback failure')
    return original.apply(this, args)
  }
  const agent = { ctx: preset.fiber.ctx, session: Session.create('bridge-test'), options: {} } as unknown as Agent
  announce(preset.ctx, 'agent/created', agent)
  await assert.rejects(agent.ctx.waterfall('agent/pre-step', { agent, signal: new AbortController().signal, turn: 1, step: 1 }, async () => ({ kind: 'enter' as const, messages: [] })), (error: unknown) => error instanceof Error && 'code' in error && error.code === 'CONTEXT_BACKEND_UNAVAILABLE')
  await assert.rejects(agent.ctx.waterfall('agent/pre-step', { agent, signal: new AbortController().signal, turn: 1, step: 2 }, async () => ({ kind: 'enter' as const, messages: [] })), (error: unknown) => error instanceof Error && 'code' in error && error.code === 'CONTEXT_BACKEND_UNAVAILABLE')
  announce(preset.ctx, 'agent/disposed', agent)
})

test('F14: per-agent readiness listeners are removed at agent disposal', async t => {
  const preset = await mountPreset(PRESET_YAML); t.after(preset.cleanup)
  await enableTestBridge(preset)
  const listeners = () => [...preset.ctx.events.dispatch('emit', [preset.fiber.ctx, 'agent/pre-step', {}])].length
  const baseline = listeners()
  for (let i = 0; i < 20; i++) {
    const agent = { ctx: preset.fiber.ctx, session: Session.create('bridge-test'), options: {} } as unknown as Agent
    announce(preset.ctx, 'agent/created', agent)
    await agent.ctx.waterfall('agent/pre-step', { agent, signal: new AbortController().signal, turn: 1, step: 1 }, async () => ({ kind: 'reject' as const }))
    const active = listeners()
    announce(preset.ctx, 'agent/disposed', agent)
    assert.equal(listeners(), active - 1, 'the readiness closure no longer retains this agent')
    if (i > 0) assert.equal(listeners(), baseline + 2, 'only the two engine policy/nudge listeners remain')
  }
})


test('profile coverage: renamed rows, nested groups and occupied ARC IDs use the actual Basic realm', async t => {
  for (const yaml of [
    PRESET_YAML.replaceAll('compaction-basic', 'custom-basic-id').replace("@deepseek-ai/dsh-custom-basic-id", '@deepseek-ai/dsh-compaction-basic').replace('id: compaction\n', 'id: custom-context\n'),
    '- id: outer\n  name: cordis:group\n  group: true\n  config:\n' + PRESET_YAML.split('\n').map(line => '    ' + line).join('\n'),
    PRESET_YAML.replace('    - id: command-compact', '    - id: compaction-arc'),
  ]) {
    const preset = await mountPreset(yaml)
    try {
      const tracked = new Map()
      assert.equal(await takeoverMount(preset.ctx, {}, { presetId: 'custom', fiber: preset.fiber }, tracked), 'taken-over')
      assert.ok(isArcBackend(latestConsumer().resolved))
      await rollbackMount(preset.fiber, tracked)
      assert.ok(latestConsumer().resolved instanceof FakeBasic)
      assert.equal(await readFile(preset.path, 'utf8'), yaml)
    } finally { await preset.cleanup() }
  }
})

test('profile coverage: a Basic row in a nested Include is patched in that Include namespace', async () => {
  const preset = await mountPreset('[]')
  try {
    const childPath = join(preset.path, '..', 'child.yml')
    await writeFile(childPath, PRESET_YAML)
    const include = preset.fiber.config as { path: string; patches?: unknown[] }
    include.patches = [{ insert: [{ id: 'child', name: 'cordis:include', config: { path: pathToFileURL(childPath).href } }] }]
    await preset.fiber.update(include, true)
    const tracked = new Map()
    assert.equal(await takeoverMount(preset.ctx, {}, { presetId: 'nested-include', fiber: preset.fiber }, tracked), 'taken-over')
    assert.ok(isArcBackend(latestConsumer().resolved))
    assert.equal(tracked.size, 1)
    for (const fiber of tracked.keys()) await rollbackMount(fiber, tracked)
    assert.ok(latestConsumer().resolved instanceof FakeBasic)
    assert.equal(await readFile(childPath, 'utf8'), PRESET_YAML)
  } finally { await preset.cleanup() }
})

test('profile coverage: no-compaction presets have no native backend to replace', async () => {
  const preset = await mountPreset('[]')
  try {
    const tracked = new Map()
    assert.equal(await takeoverMount(preset.ctx, {}, { presetId: 'minimal', fiber: preset.fiber }, tracked), 'no-basic-row')
    assert.equal(tracked.size, 0)
    assert.equal('patches' in (preset.fiber.config as object), false)
  } finally { await preset.cleanup() }
})
