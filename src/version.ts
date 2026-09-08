import { readFileSync } from 'node:fs'

declare const __CONTEXT_PACKAGE_VERSION__: string

// Builds inline the package version. Source-level tests read the same manifest.
function sourceVersion(): string {
  const value: unknown = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  if (!value || typeof value !== 'object' || !('version' in value) || typeof value.version !== 'string') throw new Error('Invalid package version')
  return value.version
}
export const PACKAGE_VERSION = typeof __CONTEXT_PACKAGE_VERSION__ === 'undefined' ? sourceVersion() : __CONTEXT_PACKAGE_VERSION__
