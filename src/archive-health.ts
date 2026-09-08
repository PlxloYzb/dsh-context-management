import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { readCompactionSummary, validCompactionReplacement, type WindowMetadata } from './region.ts'

export function validWindowMetadata(value: unknown, operationId: string): value is WindowMetadata {
  if (!value || typeof value !== 'object') return false
  const m = value as Partial<WindowMetadata>
  return m.schemaVersion === 1 && m.kind === 'window' && m.operationId === operationId
    && typeof m.fromWindowId === 'string' && m.fromWindowId.length > 0
    && typeof m.toWindowId === 'string' && m.toWindowId.length > 0
    && Number.isSafeInteger(m.generationAfter) && m.generationAfter! > 0
    && Array.isArray(m.parentBlockIds) && m.parentBlockIds.every(id => typeof id === 'string' && id !== operationId)
    && !!m.route && typeof m.route.provider === 'string' && typeof m.route.model === 'string'
    && !!m.seed && m.seed.formatVersion === 1 && typeof m.seed.incomplete === 'boolean'
    && ['model', 'manual', 'pressure', 'context-overflow'].includes(m.trigger ?? '')
    && (m.requestId === undefined || typeof m.requestId === 'string')
    && (m.incomingUserId === undefined || typeof m.incomingUserId === 'string')
}

export function archiveHealth(events: readonly SessionEvent[]): { incomplete: boolean; orphanSummaries: number; appliedUnclosed: number; unsupportedSchema: number; corruptMetadata: number } {
  const summaries = new Map<string, SessionEvent>(), replacements = new Set<string>(), closed = new Set<string>()
  let unsupportedSchema = 0, corruptMetadata = 0
  for (const event of events) {
    if (event.type === 'compaction/summary') {
      const data = readCompactionSummary(event)
      if (summaries.has(data.compactionId)) corruptMetadata++
      summaries.set(data.compactionId, event)
      if (data.contextManagement !== undefined) {
        if (data.contextManagement?.schemaVersion !== 1) unsupportedSchema++
        else if (!validWindowMetadata(data.contextManagement, data.compactionId)) corruptMetadata++
      }
    } else if (event.type === 'user/message') {
      const source = event.data.source as { plugin?: string; compactionId?: string }
      if (typeof event.surfaceOp === 'object' && source.plugin === 'compact' && source.compactionId) {
        const summary = summaries.get(source.compactionId)
        if (!summary || !validCompactionReplacement(summary, event) || replacements.has(source.compactionId)) corruptMetadata++
        else replacements.add(source.compactionId)
      }
    } else if (event.type === 'compaction/end' && event.data.error === undefined) closed.add(event.data.compactionId)
  }
  let orphanSummaries = 0, appliedUnclosed = 0
  for (const id of summaries.keys()) {
    if (!replacements.has(id)) orphanSummaries++
    else if (!closed.has(id)) appliedUnclosed++
  }
  return { incomplete: orphanSummaries + appliedUnclosed + unsupportedSchema + corruptMetadata > 0, orphanSummaries, appliedUnclosed, unsupportedSchema, corruptMetadata }
}
