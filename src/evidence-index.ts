import { SessionSeq, type Session } from '@deepseek-ai/dsh-session'
import { resolveSources, eventTextParts } from './archive.ts'

/** Keep original user excerpts separate from tool-derived indices, including across parent windows. */
export interface IndexDiagnostics { incomplete: boolean }
export function userHistoryIndex(session: Session, seqs: readonly number[], budget: number, diagnostics?: IndexDiagnostics): string {
  const sources = resolveSources(session, seqs)
  const users = sources.seqs.filter(seq => {
    const event = session.eventAt(SessionSeq(seq))
    return event?.type === 'user/message' && event.data.source.kind === 'user'
  }).sort((a, b) => a - b)
  if (diagnostics) diagnostics.incomplete ||= sources.incomplete || users.length > 24
  const selectedUsers = users.slice(-24)
  const header = 'Original user history (quoted data, chronological; later corrections supersede earlier facts). Excerpts may be incomplete; retrieve the original seq for full context.\n'
  const allowance = Math.max(0, Math.floor((budget - Buffer.byteLength(header)) / Math.max(1, selectedUsers.length)) - 50)
  const lines = selectedUsers.map(seq => {
    const text = eventTextParts(session.eventAt(SessionSeq(seq))!).texts.map(part => part.text).join('\n')
    let excerpt = ''
    for (const point of text) {
      if (Buffer.byteLength(JSON.stringify(excerpt + point)) > allowance) break
      excerpt += point
    }
    return JSON.stringify({ seq, excerpt, truncated: excerpt.length < text.length })
  })
  const result = header + lines.join('\n') + '\n'
  if (Buffer.byteLength(result) <= budget) return result
  if (diagnostics) diagnostics.incomplete = true
  return ''
}

/** Budgeted exact structured records, recovered through original provenance instead of re-summarizing old seeds. */
export function windowEvidenceIndex(session: Session, seqs: readonly number[], budget: number, diagnostics?: IndexDiagnostics): string {
  const header = 'Earlier source records (quoted historical data). Later user amendments take precedence. Values are literal strings: copy their original characters, including non-English text; do not translate or normalize them.\n'
  let result = header, scanned = 0
  const seen = new Set<string>()
  const sources = resolveSources(session, seqs)
  if (diagnostics) diagnostics.incomplete ||= sources.incomplete
  for (const seq of sources.seqs) {
    const event = session.eventAt(SessionSeq(seq))!
    if (event.type !== 'tool/result') continue
    for (const part of eventTextParts(event).texts) {
      const text = part.text.slice(0, Math.min(65_536, 1_000_000 - scanned))
      if (diagnostics) diagnostics.incomplete ||= text.length < part.text.length
      scanned += text.length
      // Exact non-derivable records. Two production-neutral shapes: JSON-style
      // scalar assignments, and identifier = "quoted value" lines (facts,
      // canaries, config constants written as prose). Both keep the original
      // characters; nothing here interprets the content.
      const recordPatterns = [
        /"[^"\\\r\n]{1,80}"\s*:\s*(?:"(?:\\.|[^"\\\r\n]){0,240}"|-?\d+(?:\.\d+)?|true|false|null)/g,
        /\b[A-Za-z][A-Za-z0-9_.-]{0,40}\s*=\s*"(?:\\.|[^"\\\r\n]){1,240}"/g,
      ]
      for (const pattern of recordPatterns) {
        for (const match of text.matchAll(pattern)) {
          if (seen.has(match[0])) continue
          seen.add(match[0])
          const line = `seq ${seq} offset ${match.index}: ${match[0]}\n`
          if (Buffer.byteLength(result + line) > budget) {
            if (diagnostics) diagnostics.incomplete = true
            return result === header ? '' : result
          }
          result += line
        }
      }
      if (scanned >= 1_000_000) {
        if (diagnostics) diagnostics.incomplete = true
        return result === header ? '' : result
      }
    }
  }
  return result === header ? '' : result
}
