// Load a historical src/archive.ts (by git revision) as a module without
// polluting src/: rewrite its relative imports to absolute file URLs and cache
// the result in the private run directory. Test tooling only; no runtime use.
import { execFileSync } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const cache = resolve('.test-runtime/nightly-20260915/bench-modules')

export async function loadArchiveAtRevision(rev) {
  const source = execFileSync('git', ['show', `${rev}:src/archive.ts`], { encoding: 'utf8' })
  const srcDir = resolve('src')
  const rewritten = source.replace(/from '\.\/([^']+)'/g, (_match, file) => `from ${JSON.stringify(pathToFileURL(join(srcDir, file)).href)}`)
  if (rewritten === source) throw new Error(`Revision ${rev} has no relative imports to rewrite; refusing an unchecked module`)
  await mkdir(cache, { recursive: true })
  const target = join(cache, `archive-${rev.replace(/[^a-z0-9]/gi, '')}.ts`)
  await writeFile(target, rewritten, { mode: 0o600 })
  return import(pathToFileURL(target).href)
}
