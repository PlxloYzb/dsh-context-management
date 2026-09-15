/** Read-only preset compatibility audit helpers. */

export interface PresetCompatibility {
  /** True when the preset resolves compaction on the host plane (no isolate realm). */
  readonly inheritsHostCompaction: boolean
  /** True when the bridge can swap the composition's compaction backend in-realm. */
  readonly patchable: boolean
  readonly hasLocalBasic: boolean
  readonly hasLocalArc: boolean
  readonly isolatesCompaction: boolean
  readonly issues: readonly string[]
}

const BASIC_NAME = /(^|\n)\s*name:\s*['"]?@deepseek-ai\/dsh-compaction-basic['"]?\s*(?:\n|$)/
const ARC_NAME = /(^|\n)\s*name:\s*['"]?(?:cordis:)?dsh-context-management['"]?\s*(?:\n|$)/

/** Remove YAML comments without treating a quoted # as a comment marker. */
function withoutComments(text: string): string {
  return text.split(/\r?\n/).map(line => {
    let quote: string | undefined
    for (let index = 0; index < line.length; index++) {
      const char = line[index]!
      if (quote === '"' && char === '\\') { index++; continue }
      if (quote === "'" && char === "'" && line[index + 1] === "'") { index++; continue }
      if (char === quote) quote = undefined
      else if (!quote && (char === '"' || char === "'")) quote = char
      else if (!quote && char === '#' && (index === 0 || /\s/.test(line[index - 1]!))) return line.slice(0, index)
    }
    return line
  }).join('\n')
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length
}

/** True only when `compaction: true` occurs inside an `isolate:` mapping. */
export function isolatesCompaction(text: string): boolean {
  const lines = withoutComments(text).split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!
    // Common flow-style isolate mappings are equivalent to block mappings.
    if (/^\s*isolate:\s*\{\s*(?:[\w]+:\s*(?:true|false)\s*,\s*)*compaction:\s*true\s*(?:,\s*[\w]+:\s*(?:true|false)\s*)*\}\s*$/.test(line)) return true
    if (!/^\s*isolate:\s*$/.test(line)) continue
    const base = indentOf(line)
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const candidate = lines[cursor]!
      if (candidate.trim() === '' || candidate.trimStart().startsWith('#')) continue
      if (indentOf(candidate) <= base) break
      if (/^\s*compaction:\s*true\s*$/.test(candidate)) return true
    }
  }
  return false
}

/**
 * Audit one preset composition text against the bridge's takeover guards:
 * the bridge disables the official `compaction-basic` row by name and
 * inserts the engine row into its isolate group. This text audit recognizes
 * ordinary block/flow isolate mappings and named
 * rows. Runtime takeover uses the mounted Loader tree; nested Includes and
 * YAML aliases require that live audit rather than this text-only heuristic.
 */
export function inspectPresetComposition(text: string): PresetCompatibility {
  const uncommented = withoutComments(text)
  const hasLocalBasic = BASIC_NAME.test(uncommented)
  const hasLocalArc = ARC_NAME.test(uncommented)
  const isolated = isolatesCompaction(text)
  const issues = [
    ...(hasLocalBasic && hasLocalArc
      ? ['preset mounts both the official Basic row and a dsh-context-management row; two backends cannot share one realm']
      : []),
    ...(isolated && !hasLocalBasic && !hasLocalArc
      ? ['preset isolates a compaction realm but mounts neither the official basic row nor dsh-context-management; audit manually']
      : []),
  ]
  return {
    inheritsHostCompaction: !isolated,
    patchable: hasLocalArc || (isolated && hasLocalBasic),
    hasLocalBasic,
    hasLocalArc,
    isolatesCompaction: isolated,
    issues,
  }
}
