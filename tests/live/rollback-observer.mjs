// Inject one ARC row initialization failure in an isolated release profile.
export const inject = ['loader']
export function apply(ctx) {
  let injected = false
  ctx.on('loader/patch-context', async (entry, next) => {
    if (!injected && entry.options.id === 'compaction-arc') {
      injected = true
      throw new Error('synthetic release rollback fixture: ARC initialization failed')
    }
    return next()
  })
}
