import { LlmError } from '@deepseek-ai/dsh-llm'

/** DSH 0.1.2-rc.1 serializes pre-step failures only for LlmError.
 * Custom policy codes stay distinct from provider physical overflow and never
 * trigger its retry path. LlmError is also a public HarnessError subclass. */
export class ContextManagementError extends LlmError {
  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, code, options)
  }
}

export function invalidConfiguration(error: unknown): ContextManagementError {
  if (error instanceof ContextManagementError) return error
  return new ContextManagementError('CONTEXT_INVALID_CONFIG', error instanceof Error ? error.message : 'Invalid context configuration', { cause: error })
}

/** Await shared work without allowing one cancelled caller to cancel its peers. */
export async function waitForContext<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted()
  if (!signal) return operation
  let onAbort!: () => void
  const cancelled = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
  })
  try { return await Promise.race([operation, cancelled]) }
  finally { signal.removeEventListener('abort', onAbort) }
}

/**
 * Installed profiles may resolve a second (external) dsh-llm module instance.
 * The host loop checks instanceof LlmError, so use its public Loader resolver
 * to construct the boundary error in the same module realm as the loop.
 * No installation path, module-loader internals, or global factory is used.
 */
export async function runtimeContextError(ctx: { get(name: string): unknown }, error: unknown): Promise<unknown> {
  if (!(error instanceof ContextManagementError)) return error
  const loader = ctx.get('loader') as { import?(name: string): unknown } | undefined
  if (!loader?.import) return error
  try {
    const module: unknown = await loader.import('@deepseek-ai/dsh-llm')
    if (module && typeof module === 'object' && 'LlmError' in module && typeof module.LlmError === 'function') {
      const HostError = module.LlmError as typeof LlmError
      if (HostError === LlmError) return error
      return new HostError(error.message, error.code)
    }
  } catch { /* Keep the actionable policy error if host import is unavailable. */ }
  return error
}

export async function contextBoundary<T>(ctx: { get(name: string): unknown }, task: () => Promise<T>): Promise<T> {
  try { return await task() }
  catch (error) { throw await runtimeContextError(ctx, error) }
}
