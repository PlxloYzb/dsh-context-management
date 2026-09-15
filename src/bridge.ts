/**
 * dsh-context-management preset bridge — replace a mounted preset's official Basic
 * compaction backend with ARC inside its original service realm, through
 * official Loader patch semantics and zero file writes.
 *
 * Mechanism (every step is a public, documented Loader/Include behavior):
 *
 *  1. the bridge row (inserted by this package's `cordis.patch.yml` bundle
 *     layer) registers the engine class in the Loader's public builtin
 *     registry, the same registry app-boot itself uses for `cordis:group`;
 *  2. on agent creation, preset selection and request boundaries, the agent's
 *     scope is located through the public `standingMountFor()` export of
 *     `@deepseek-ai/dsh-agent-presets`;
 *  3. the mount's Include config gains runtime patches — disable the
 *     actual Basic row (guarded by its official package name) and
 *     insert the ARC engine row into its unchanged parent/isolate
 *     group — then `fiber.update(config, true)` re-reads the composition,
 *     re-applies the patches, and reconciles the tree transactionally;
 *  4. the group keeps its `isolate: { compaction: true }` realm, so the ARC
 *     engine provides `ctx.compaction` exactly where Basic did and the
 *     sibling rows (`command-compact`, `tool-result-pruner`) rebind to it
 *     without any change of their own.
 *
 * Nothing is ever written to disk: preset files, row ids, group nesting, and
 * user patches stay byte-identical, and both uninstall and a plain restart
 * remount the untouched original composition. The fiber mutation is owned by
 * a Cordis effect whose reverse update restores the original Include config
 * (the same transactional re-apply, run backwards).
 *
 * @module dsh-context-management/bridge
 */

import { standingMountFor } from '@deepseek-ai/dsh-agent-presets'
import { symbols, type Context, type Fiber } from '@deepseek-ai/cordis'
import type { Entry, EntryTree } from '@deepseek-ai/cordis-plugin-loader'
import type { Agent } from '@deepseek-ai/dsh-agent'
import ArcCompactionEngine, { Config, isArcBackend, validateContextConfig, type Config as ArcConfig } from './index.ts'
import { ContextManagementError, contextBoundary, waitForContext } from './errors.ts'

/** Loader builtin key the engine class is published under. */
const BUILTIN_KEY = 'dsh-context-management'
/** Composition row name that mounts the engine through the builtin registry. */
const BUILTIN_ROW_NAME = `cordis:${BUILTIN_KEY}`
/** Official preset composition ids, stable across the standard/code/cordis presets. */
const COMPACTION_GROUP_ID = 'compaction'
const BASIC_ROW_ID = 'compaction-basic'
const BASIC_ROW_NAME = '@deepseek-ai/dsh-compaction-basic'
/** Row id of the inserted engine row inside the compaction group. */
const ARC_ROW_ID = 'compaction-arc'

/** Structural loader patch shape (`PatchOptions` without the type-only dependency). */
interface EntryPatch {
  readonly id?: string
  readonly name?: string
  readonly disabled?: boolean
  readonly insert?: ReadonlyArray<Record<string, unknown>>
}

/** Live Include config of a preset mount. */
interface PresetIncludeConfig {
  readonly path: string
  patches?: EntryPatch[]
  readonly [key: string]: unknown
}

/** One patched preset mount, restorable by effect-owned teardown. */
interface TrackedMount {
  readonly tree: EntryTree
  latestConfig?: PresetIncludeConfig
  readonly config: PresetIncludeConfig
  readonly hadPatches: boolean
  readonly originalPatches: EntryPatch[] | undefined
  readonly owned: EntryPatch[]
}

/** A standing preset mount as the bridge addresses it. */
export interface PresetMountHandle {
  readonly presetId: string
  readonly fiber: Fiber
}

/** Outcome of one takeover attempt. */
export type TakeoverStatus =
  | 'taken-over'
  | 'already-arc'
  | 'no-basic-row'
  | 'unrecognized-carrier'

/**
 * Patches that swap Basic for ARC inside the preset's own compaction realm:
 * the name guard means only the official Basic row is ever disabled, and the
 * insert keeps the group (and therefore its isolate map) untouched.
 * @param config - ARC engine config applied to the inserted row.
 * @returns the patch list to append to the mount's Include config.
 */
export function buildTakeoverPatches(
  config: ArcConfig,
  target: { basicId: string; groupId?: string; arcId: string; row?: Record<string, unknown> } = {
    basicId: BASIC_ROW_ID, groupId: COMPACTION_GROUP_ID, arcId: ARC_ROW_ID,
  },
): [EntryPatch, EntryPatch] {
  return [
    { id: target.basicId, name: BASIC_ROW_NAME, disabled: true },
    {
      ...(target.groupId ? { id: target.groupId } : {}),
      insert: [{ ...target.row, id: target.arcId, name: BUILTIN_ROW_NAME, config: config as Record<string, unknown> }],
    },
  ]
}

function restorePatches(config: PresetIncludeConfig, hadPatches: boolean, original: EntryPatch[] | undefined): void {
  if (hadPatches) {
    config.patches = original
  } else {
    delete config.patches
  }
}

/** Same-path Include updates commit to tree.config without replacing fiber.config. */
function currentIncludeConfig(fiber: Fiber, tree: EntryTree): PresetIncludeConfig | undefined {
  const activeTree = fiber.entry?.subtree ?? tree
  const live = 'config' in activeTree ? activeTree.config as PresetIncludeConfig | undefined : undefined
  const cached = fiber.config as PresetIncludeConfig | undefined
  return typeof live?.path === 'string' && live.path === cached?.path ? live : cached
}

/**
 * Whether `start` belongs to the context subtree of `root`. For loader trees
 * the entry contexts chain through context prototypes (`_patchContext`
 * re-parents them with `setPrototypeOf`), so membership is a prototype-chain
 * walk from the impl's fiber context up to the mount fiber's context.
 */
function withinContext(start: Context | undefined, root: Context): boolean {
  let current: unknown = start
  for (let hops = 0; current !== undefined && current !== null && hops < 100; hops += 1) {
    if (current === root) return true
    current = Object.getPrototypeOf(current)
  }
  return false
}

/**
 * The service one preset mount publishes under `name`, or undefined. This is
 * the ownership relation `AgentPresets.serviceFor` reads (impl.name match
 * with the impl's fiber inside the mount fiber), mirrored locally so the
 * bridge stays testable against a bare Loader and works without a live
 * agent-presets service instance.
 * @param ctx - any context of the runtime whose service store is inspected.
 * @param mount - the standing mount to look inside.
 * @param name - the service name as the preset's rows resolve it.
 */
function serviceWithin(ctx: Context, mount: PresetMountHandle, name: string): unknown {
  const root = mount.fiber.ctx
  const store = ctx.reflect.store
  for (const key of Object.getOwnPropertySymbols(store)) {
    const impl = store[key] as { name?: string; fiber?: Fiber; value?: unknown } | undefined
    if (impl === undefined || impl.name !== name) continue
    if (withinContext(impl.fiber?.ctx, root)) return impl.value
  }
  return undefined
}

/**
 * Swap one standing preset mount's compaction backend in-realm. The mount's
 * live Include config object is mutated in place — never replaced — so the
 * tree keeps its original config identity (the harness-base record for bare
 * `@deepseek-ai/*` imports is keyed by that object).
 *
 * The swap runs as TWO sequential Include updates, not one: a group update
 * force-restarts every unchanged sibling row, so retiring Basic and mounting
 * ARC in the same update would race Basic's re-construction against the
 * engine's service registration inside the realm. Sequential updates give
 * the ordering the concurrent reconcile cannot: phase 1 disables the Basic
 * row (nothing new starts), phase 2 inserts the engine row into the vacated
 * realm.
 *
 * @param ctx - the bridge's Cordis context.
 * @param config - ARC engine config applied to the inserted row.
 * @param mount - the standing preset mount to patch.
 * @param tracked - effect-owned registry of patched mounts (restored on dispose).
 * @returns the takeover outcome; `fiber.update` failures propagate after
 *          in-place rollback of the config mutation.
 */
export async function takeoverMount(
  ctx: Context,
  config: ArcConfig,
  mount: PresetMountHandle,
  tracked: Map<Fiber, TrackedMount>,
): Promise<TakeoverStatus> {
  if (isArcBackend(serviceWithin(ctx, mount, 'compaction'))) {
    return [...tracked.keys()].some(carrier => withinContext(carrier.ctx, mount.fiber.ctx)) ? 'taken-over' : 'already-arc'
  }
  // A previous success is not evidence about a reloaded Include. Release our
  // old patches before discovering the currently mounted provider again.
  for (const [carrier] of [...tracked]) {
    if (withinContext(carrier.ctx, mount.fiber.ctx)) await rollbackMount(carrier, tracked)
  }
  if (typeof (mount.fiber.config as { path?: unknown } | undefined)?.path !== 'string') return 'unrecognized-carrier'
  const backend = serviceWithin(ctx, mount, 'compaction') as { ctx?: Context } | undefined
  const entry: Entry | undefined = backend?.ctx?.fiber.entry
  if (!entry || entry.options.name !== BASIC_ROW_NAME) return 'no-basic-row'
  // Discover the actual row and its owning Include. IDs and group nesting are
  // user-defined; a nested Include has its own patch namespace.
  const treeFiber = entry.parent.tree.ctx.fiber
  const carrier = treeFiber.uid === mount.fiber.uid ? mount.fiber : treeFiber
  const include = currentIncludeConfig(carrier, entry.parent.tree)
  if (typeof include?.path !== 'string') return 'unrecognized-carrier'
  const groupId = entry.parent === entry.parent.tree.root ? undefined : entry.parent.ctx.fiber.entry?.options.id
  if (entry.parent !== entry.parent.tree.root && !groupId) return 'unrecognized-carrier'
  const occupied = new Set([...entry.parent.tree.entries()].map(row => row.options.id))
  let arcId = ARC_ROW_ID
  for (let suffix = 1; occupied.has(arcId); suffix++) arcId = `${ARC_ROW_ID}-${suffix}`
  const hadPatches = Object.hasOwn(include, 'patches')
  const originalPatches = include.patches
  const base = Array.isArray(originalPatches) ? originalPatches : []
  const [retireBasic, mountArc] = buildTakeoverPatches(config, {
    basicId: entry.options.id, groupId, arcId, row: { ...entry.options },
  })
  // Reverse of the takeover, same two-phase ordering: withdraw the engine row
  // first (Basic stays disabled), then re-enable Basic in the vacated realm.
  const revert = async (): Promise<void> => {
    await rollbackMount(carrier, tracked)
  }

  include.patches = [...base, retireBasic]
  tracked.set(carrier, { tree: entry.parent.tree, config: include, hadPatches, originalPatches, owned: [retireBasic, mountArc] })
  try {
    await carrier.update(include, true)
    // The name guard did not match: a foreign backend still owns the realm,
    // and inserting ARC beside it would collide. Leave the preset untouched.
    const serving = serviceWithin(ctx, mount, 'compaction')
    if (serving !== undefined && !isArcBackend(serving)) {
      await revert()
      return 'no-basic-row'
    }
    include.patches = [...(include.patches ?? []), mountArc]
    await carrier.update(include, true)
  } catch (error) {
    try { await revert() } catch (rollbackError) { throw new AggregateError([error, rollbackError], 'context takeover and rollback failed') }
    throw error
  }
  if (isArcBackend(serviceWithin(ctx, mount, 'compaction'))) return 'taken-over'

  // The updated composition did not publish ARC. Undo both phases and report.
  await revert()
  return 'no-basic-row'
}

/**
 * Revert one patched mount with the same two-phase ordering, run backwards:
 * first remove the inserted engine row (Basic stays disabled, so the engine
 * leaves the realm unopposed), then re-enable the official Basic row in the
 * vacated realm.
 * @param fiber - the standing mount's Include fiber previously patched.
 * @param tracked - the effect-owned registry of patched mounts.
 */
export async function rollbackMount(fiber: Fiber, tracked: Map<Fiber, TrackedMount>): Promise<void> {
  const record = tracked.get(fiber)
  if (record === undefined) return
  tracked.delete(fiber)
  const { owned } = record
  if (fiber.uid === null) {
    restorePatches(record.config, record.hadPatches, record.originalPatches)
    return
  }
  // External Include updates may replace the config object or remove our
  // patches. Teardown must preserve that new composition, not replay the old.
  const config = record.latestConfig ?? currentIncludeConfig(fiber, record.tree)
  if (!config) throw new Error('context rollback lost its Include configuration')
  if (!config.patches?.some(patch => owned.includes(patch))) return
  const sameConfig = config === record.config
  const hadPatches = sameConfig ? record.hadPatches : Object.hasOwn(config, 'patches')
  const originalPatches = sameConfig ? record.originalPatches : config.patches.filter(patch => !owned.includes(patch))
  try {
    config.patches = config.patches?.filter(patch => patch !== owned[1]) ?? []
    await fiber.update(config, true)
  } finally {
    const remaining = config.patches?.filter(patch => !owned.includes(patch)) ?? []
    if (remaining.length === (originalPatches?.length ?? 0) && remaining.every((p, i) => p === originalPatches?.[i])) restorePatches(config, hadPatches, originalPatches)
    else config.patches = remaining
    await fiber.update(config, true)
  }
}

export const name = 'dsh-context-management-bridge'
export const inject = ['loader']
export { Config }

/**
 * Install the preset bridge. The engine is published as a loader builtin for
 * preset rows, every agent creation swaps its standing preset's Basic row for
 * ARC in-realm, and disposing the bridge fiber first reverts every patched
 * mount (transactional re-apply of the original Include config) and then
 * removes the builtin registration. A process restart reaches the same
 * unpatched state from the untouched files.
 *
 * @param ctx - host context carrying the public Loader and agent-presets services.
 * @param config - ARC configuration applied to every replaced Basic row.
 */
/** Resolve through the host-owned service instance when package copies differ.
 * dsh-agent-presets keeps its mount registry module-local, so a peer installed
 * next to this package may expose an empty standingMountFor registry.
 */
async function hostMountFor(ctx: Context, agent: Agent): Promise<PresetMountHandle | undefined> {
  const direct = standingMountFor(agent.ctx)
  if (direct) return direct
  // Resolve the host's public registry even when this installed package has a
  // different peer-module instance. Works for presets with no backend too.
  try {
    const module: unknown = await ctx.loader.import('@deepseek-ai/dsh-agent-presets')
    if (module && typeof module === 'object' && 'standingMountFor' in module && typeof module.standingMountFor === 'function') {
      const resolve = module.standingMountFor as typeof standingMountFor
      const mount = resolve(agent.ctx)
      if (mount) return mount
    }
  } catch { /* Older embedded hosts can still expose a service-owned mount. */ }
  const presets = ctx.get('agentPresets') as {
    composedPreset(context: Context): string | undefined
    serviceFor(agent: Agent, name: 'compaction'): unknown
  } | undefined
  const presetId = presets?.composedPreset(agent.ctx)
  const facade = presets?.serviceFor(agent, 'compaction') as { ctx?: Context; [symbols.original]?: { ctx?: Context } } | undefined
  const backend = facade?.[symbols.original] ?? facade
  if (!presetId || !backend?.ctx) return undefined
  let fiber = backend.ctx.fiber
  for (let hops = 0; hops < 100; hops++) {
    const config = fiber.config as { path?: unknown } | undefined
    if (typeof config?.path === 'string') return { presetId, fiber }
    const parent = fiber.parent.fiber
    if (parent === fiber) return undefined
    fiber = parent
  }
  return undefined
}

export function apply(ctx: Context, config: ArcConfig): void {
  // Validate before registering a builtin or touching a standing preset.
  try { validateContextConfig(config) }
  catch (error) {
    process.stderr.write(`[dsh-context-management] CONTEXT_INVALID_CONFIG: ${String(error)}; preset backends were not changed. Fix the plugin configuration and reload.\n`)
    throw error
  }
  const loader = ctx.get('loader') as { builtins: Record<string, unknown> }
  if (loader.builtins[BUILTIN_KEY] !== undefined) throw new Error('conflict: context backend builtin already registered')
  loader.builtins[BUILTIN_KEY] = ArcCompactionEngine
  const tracked = new Map<Fiber, TrackedMount>()
  const operations = new WeakMap<Fiber, Promise<void>>()
  const fallbacks = new WeakMap<Fiber, unknown>()
  const blocked = new WeakMap<Fiber, { backend: unknown; error: ContextManagementError }>()
  const inFlight = new Set<Promise<void>>()
  const agents = new Map<Agent, () => void>()
  let closing = false
  // Include may replace its tree on a path change, then replace only the
  // tree's config on a same-path update. Observe successful Loader updates
  // around the native hook, including updates that leave no serving backend.
  ctx.on('internal/update', async function (candidate: unknown, _noSave, next) {
    const record = tracked.get(this)
    await next()
    if (record && candidate && typeof candidate === 'object' && 'path' in candidate && typeof candidate.path === 'string') {
      record.latestConfig = candidate as PresetIncludeConfig
    }
  }, { global: true, prepend: true })
  ctx.effect(() => async () => {
    closing = true
    for (const dispose of [...agents.values()]) dispose()
    await Promise.allSettled(inFlight)
    const errors: unknown[] = []
    for (const [fiber] of [...tracked.entries()].reverse()) {
      try { await rollbackMount(fiber, tracked) } catch (error) { errors.push(error) }
    }
    tracked.clear()
    if (loader.builtins[BUILTIN_KEY] === ArcCompactionEngine) delete loader.builtins[BUILTIN_KEY]
    if (errors.length) throw new AggregateError(errors, 'context bridge rollback failed')
  }, 'dsh-context-management.bridge')
  ctx.on('agent/disposed', ({ agent }) => agents.get(agent)?.())
  const ensure = async (agent: Agent): Promise<PresetMountHandle | undefined> => {
    if (closing) throw new Error('context bridge is closing')
    if (ctx.get('agentPresets') === undefined) return undefined
    const mount = await hostMountFor(ctx, agent)
    if (closing) throw new Error('context bridge is closing')
    if (!mount) return undefined
    let operation = operations.get(mount.fiber)
    if (!operation) {
      const previous = serviceWithin(ctx, mount, 'compaction')
      const failure = blocked.get(mount.fiber)
      if (failure?.backend === previous && failure !== undefined) throw failure.error
      blocked.delete(mount.fiber)
      // A verified rollback stays usable. Retry it only after an actual reload
      // changes the service, avoiding repeated failed swaps on every request.
      if (previous !== undefined && fallbacks.get(mount.fiber) === previous) return mount
      operation = takeoverMount(ctx, config, mount, tracked).then(status => {
        if (status !== 'taken-over' && status !== 'already-arc') ctx.logger.warn(`context takeover: ${status} for preset ${mount.presetId}`)
      }).catch(error => {
        const restored = serviceWithin(ctx, mount, 'compaction')
        // A completed reverse update must also restore the actual service. A
        // failed/uncertain rollback must never turn into an unguarded request.
        const available = !(error instanceof AggregateError) && previous !== undefined && restored !== undefined
          && !isArcBackend(restored) && Object.getPrototypeOf(previous) === Object.getPrototypeOf(restored)
        if (!available) {
          const failure = new ContextManagementError('CONTEXT_BACKEND_UNAVAILABLE', 'Context takeover failed and the original backend could not be verified. Fix the plugin configuration and restart the profile.', { cause: error })
          blocked.set(mount.fiber, { backend: restored, error: failure })
          throw failure
        }
        fallbacks.set(mount.fiber, restored)
        const message = `CONTEXT_TAKEOVER_FALLBACK: context takeover failed for preset ${mount.presetId}; the original compaction backend is restored and active. Fix the plugin configuration and reload to enable dsh-context-management.`
        ctx.logger.error(message)
        // CLI/Web logger sinks differ; this notice must remain visible at boot.
        process.stderr.write(`[dsh-context-management] ${message}\n`)
      })
      operations.set(mount.fiber, operation)
      inFlight.add(operation)
      const owned = operation
      const release = (): void => {
        inFlight.delete(owned)
        if (operations.get(mount.fiber) === owned) operations.delete(mount.fiber)
      }
      void owned.then(release, release)
    }
    await operation
    return mount
  }
  // Selecting a preset also changes the native command catalog, even when the
  // user invokes /compact before submitting the first model prompt.
  ctx.on('agent-preset/selected', sessionId => {
    if (closing) return
    for (const agent of agents.keys()) {
      if (agent.session.id === sessionId) void ensure(agent).catch(error => ctx.logger.error(String(error)))
    }
  })
  const attach = (agent: Agent): void => {
    if (closing || agents.has(agent)) return
    const listeners: (() => void)[] = []
    const dispose = (): void => { for (const remove of listeners.splice(0)) remove(); agents.delete(agent) }
    agents.set(agent, dispose)
    let assembledMount: Fiber | undefined
    // Resolve the current mount on every boundary: an empty session can switch
    // presets without creating a new Agent or emitting agent/created again.
    listeners.push(agent.ctx.on('system-prompt/assemble', async (_assembly, context, next) => contextBoundary(ctx, async () => {
      const mount = await waitForContext(ensure(agent), context.signal)
      if (mount && assembledMount !== mount.fiber) {
        assembledMount = mount.fiber
        context.signal?.throwIfAborted()
        return agent.ctx.systemPrompt.assemble(context)
      }
      return next()
    })))
    listeners.push(agent.ctx.on('agent/pre-step', async (payload, next) => {
      await contextBoundary(ctx, () => waitForContext(ensure(agent), payload.signal))
      return next()
    }))
    void ensure(agent).catch(error => ctx.logger.error(String(error)))
  }
  ctx.on('agent/created', ({ agent }) => attach(agent))
  // Hot enabling the bundle must cover agents created before this bridge.
  for (const agent of ctx.get('agents')?.list() ?? []) attach(agent)
}
