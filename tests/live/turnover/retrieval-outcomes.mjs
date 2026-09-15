const RETRIEVAL_TOOLS = new Set(['search_context', 'decompress'])

const textOf = content => content
  .flatMap(block => block?.content ?? [])
  .filter(part => part?.type === 'text' && typeof part.text === 'string')
  .map(part => part.text)
  .join('')

/** Match historical retrieval calls with their durable tool-result events. */
export function retrievalOutcomes(events) {
  const calls = new Map(), results = new Map()
  for (const event of events) {
    const message = event?.data?.message
    if (event?.type === 'assistant/message') for (const block of message?.content ?? []) {
      if (block?.type === 'tool-call' && RETRIEVAL_TOOLS.has(block.name) && typeof block.id === 'string') calls.set(block.id, block.name)
    }
    if (event?.type === 'tool/result') {
      const callId = message?.source?.callId
      const block = message?.content?.find(part => part?.type === 'tool-result')
      if (typeof callId === 'string' && block) results.set(callId, textOf([block]))
    }
  }
  let successes = 0, failures = 0, missingResults = 0
  const statusCounts = {}
  for (const callId of calls.keys()) {
    const text = results.get(callId)
    if (text === undefined) {
      missingResults++
      statusCounts['missing-result'] = (statusCounts['missing-result'] ?? 0) + 1
      continue
    }
    let outcome
    try { outcome = JSON.parse(text) } catch { outcome = null }
    const status = typeof outcome?.status === 'string' ? outcome.status : 'invalid-result'
    statusCounts[status] = (statusCounts[status] ?? 0) + 1
    if (status === 'success') successes++
    else failures++
  }
  return { attempts: calls.size, successes, failures, missingResults, statusCounts }
}
