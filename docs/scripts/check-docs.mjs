// Check review deliverables, not the as-yet-unimplemented plugin.
import assert from 'node:assert/strict'
import { readdir, readFile, access, writeFile } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'

const root = resolve('docs')
const files = (await readdir(root)).filter(f => f.endsWith('.md')).map(f => resolve(root, f))
files.push(resolve(root, 'archive/README.md'))
const failures = []
let links = 0
for (const file of files) {
  const text = await readFile(file, 'utf8')
  if ((text.match(/^```/gm) ?? []).length % 2) failures.push(`${file}: unclosed fence`)
  for (const match of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    const target = match[1]
    if (/^(https?:|#)/.test(target)) continue
    const path = resolve(dirname(file), target.replace(/:\d+$/, '').split('#')[0])
    try { await access(path); links++ } catch { failures.push(`${file}: missing ${target}`) }
  }
}
const manifest = JSON.parse(await readFile(resolve(root, 'evidence/source-manifest.json'), 'utf8'))
for (const entry of manifest.files) {
  const actual = createHash('sha256').update(await readFile(entry.path)).digest('hex')
  if (actual !== entry.sha256) failures.push(`Source changed: ${entry.path}`)
}
for (const file of ['web-smoke.json', 'web-smoke-fresh.json', 'projection-probe.json']) {
  const result = JSON.parse(await readFile(resolve(root, 'evidence', file), 'utf8'))
  if (!result.passed) failures.push(`${file}: expected recorded PASS`)
}
for (const file of ['web-smoke.mjs', 'projection-probe.mjs', 'check-docs.mjs']) {
  execFileSync(process.execPath, ['--check', resolve(root, 'scripts', file)])
}
assert((await readFile(resolve(root, 'SPEC.md'), 'utf8')).includes('尚未实现或发布'))
const report = {
  checkedAt: new Date().toISOString(), scope: 'documentation-only', markdownFiles: files.length,
  localLinksChecked: links, sourceHashesChecked: manifest.files.length,
  scriptsSyntaxChecked: 3, pluginGatesExecuted: false,
  excluded: ['Archived original SPEC/PLAN: preserved verbatim; historical relative links are not current navigation.'],
  failures, passed: failures.length === 0,
}
await writeFile(resolve(root, 'evidence/doc-check.json'), JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify(report, null, 2))
if (failures.length) process.exitCode = 1
