// Experimental scheduler state only. This is deliberately not a runtime export.
export class SummaryJob {
  constructor(snapshot, generate, { timeoutMs = 60000, maxChars = 1400 } = {}) {
    this.snapshot = structuredClone(snapshot)
    this.controller = new AbortController()
    this.state = 'pending'
    this.startedAt = Date.now()
    this.settled = new Promise(resolve => { this.resolveSettled = resolve })
    this.timer = setTimeout(() => this.cancel('timeout'), timeoutMs)
    this.done = Promise.resolve().then(() => generate(this.controller.signal)).then(text => {
      if (this.state !== 'pending') return
      if (typeof text !== 'string' || !text.trim() || [...text].length > maxChars) { this.state = 'invalid'; return }
      this.text = text.trim(); this.state = 'ready'; this.finishedAt = Date.now()
    }, () => { if (this.state === 'pending') this.state = 'failed' }).finally(() => { clearTimeout(this.timer); this.resolveSettled() })
  }
  consume(current) {
    if (JSON.stringify(current) !== JSON.stringify(this.snapshot)) { this.cancel('stale'); return { status: 'stale' } }
    if (this.state !== 'ready') { const status = this.state; this.cancel(status === 'pending' ? 'late' : status); return { status } }
    this.state = 'consumed'
    const text = this.text; this.text = undefined
    return { status: 'ready', text }
  }
  cancel(reason = 'cancelled') {
    if (this.state === 'consumed') return
    this.state = reason; this.text = undefined
    clearTimeout(this.timer); this.controller.abort(new Error(reason))
    this.resolveSettled()
  }
}

export function overlapMs(a, b) { return Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start)) }
