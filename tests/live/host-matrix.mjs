/**
 * Run the full suite against a SECOND host version, without touching the tree
 * the repository develops against.
 *
 * The plugin declares the 0.1.7 prerelease series as its peer range, so every
 * release in that series has to be exercised, not just the one installed here.
 * This script installs the named host packages from npm into an isolated tree
 * under `.test-runtime/`, writes a tsconfig that maps `@deepseek-ai/*` onto it,
 * and runs typecheck plus all four suites with that mapping. `node_modules` in
 * the repository is never modified, so the default suites keep testing the
 * development host.
 *
 * Usage: node tests/live/host-matrix.mjs [0.1.7-rc.2]
 *
 * The mapping is honoured by tsx through `TSX_TSCONFIG_PATH`, which is why the
 * generated tsconfig lives beside the installed tree rather than at the root.
 *
 * @module dsh-context-management/tests/live/host-matrix
 */

import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const version = process.argv[2] ?? '0.1.7-rc.2'
if (!/^\d+\.\d+\.\d+-[a-z0-9.]+$/.test(version)) throw new Error(`host version must be a prerelease semver, got ${JSON.stringify(version)}`)

const manifest = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'))
const devHost = manifest.devDependencies['@deepseek-ai/dsh-session']
/** Everything the suites import from the host, at the version under test. */
function dependencies() {
  const declared = { ...manifest.peerDependencies, ...manifest.devDependencies, ...manifest.dependencies }
  const out = {}
  for (const [name, range] of Object.entries(declared)) {
    // Only the 0.1.7 prerelease pins move; cordis, the cordis plugins,
    // schemastery and acp-kernel are versioned independently of the host.
    out[name] = range === devHost ? version : range
  }
  return out
}

const tree = join(repo, '.test-runtime', `host-${version}`)
const installed = join(tree, 'node_modules', '@deepseek-ai', 'dsh-session', 'package.json')
const wanted = dependencies()
function installedVersion() {
  if (!existsSync(installed)) return null
  return JSON.parse(readFileSync(installed, 'utf8')).version
}
function install() {
  mkdirSync(tree, { recursive: true })
  writeFileSync(join(tree, 'package.json'), JSON.stringify({ name: `host-probe-${version}`, private: true, type: 'module', dependencies: wanted }, null, 2) + '\n')
  execFileSync('npm', ['install', '--no-audit', '--no-fund', '--loglevel=error'], { cwd: tree, stdio: ['ignore', 'inherit', 'inherit'] })
  const found = installedVersion()
  if (found !== version) throw new Error(`host tree holds ${String(found)}, expected ${version}`)
}

/**
 * Map every `@deepseek-ai/*` specifier onto the installed tree. `paths` resolve
 * relative to the tsconfig, so the file is generated inside the tree; `extends`
 * and `include` reach back out to the repository.
 *
 * A subpath import is listed explicitly, and it is written WITHOUT an extension:
 * `paths` bypasses package `exports`, so a bare `@deepseek-ai/*` pattern would
 * leave `dsh-commands/brand` pointing at the development host and quietly mix two
 * trees in one run. The extensionless form is the one spelling both consumers
 * accept — TypeScript picks the sibling `brand.d.ts`, tsx picks `brand.js`.
 */
const tsconfig = join(tree, 'tsconfig.host.json')
function writeTsconfig() {
  writeFileSync(tsconfig, JSON.stringify({
    extends: '../../tsconfig.json',
    compilerOptions: {
      paths: {
        '@deepseek-ai/dsh-commands/brand': ['./node_modules/@deepseek-ai/dsh-commands/lib/types/brand'],
        '@deepseek-ai/*': ['./node_modules/@deepseek-ai/*'],
      },
    },
    include: ['../../src/**/*.ts'],
  }, null, 2) + '\n')
}

const suites = [
  { name: 'typecheck', command: 'npx', args: ['tsc', '-p', tsconfig, '--noEmit'] },
  { name: 'unit', command: 'node', args: ['--import', 'tsx', '--test', 'tests/*.test.ts'] },
  { name: 'integration', command: 'node', args: ['--import', 'tsx', '--test', 'tests/integration/*.test.ts'] },
  { name: 'reliability', command: 'node', args: ['--import', 'tsx', '--test', 'tests/reliability/*.test.ts'] },
  { name: 'live:local:unit', command: 'node', args: ['--test', 'tests/live/local/*.test.mjs'] },
]
const counts = /^# (tests|pass|fail|skipped) (\d+)$/gm
function run(suite) {
  const started = Date.now()
  const result = spawnSync(suite.command, suite.args, {
    cwd: repo,
    encoding: 'utf8',
    env: { ...process.env, TSX_TSCONFIG_PATH: tsconfig },
    maxBuffer: 64 * 1024 * 1024,
  })
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  const tally = {}
  for (const [, key, value] of output.matchAll(counts)) tally[key] = Number(value)
  return {
    suite: suite.name,
    status: result.status === 0 ? 'passed' : 'failed',
    seconds: Math.round((Date.now() - started) / 100) / 10,
    tests: tally.tests ?? null,
    passed: tally.pass ?? null,
    failed: tally.fail ?? null,
    skipped: tally.skipped ?? null,
  }
}

if (installedVersion() !== version) install()
writeTsconfig()
console.log(`host ${version} at ${tree}`)
const results = suites.map(run)
for (const row of results) console.log(`${row.status === 'passed' ? 'ok  ' : 'FAIL'} ${row.suite.padEnd(16)} ${row.passed ?? '-'}/${row.tests ?? '-'} passed, ${row.failed ?? '-'} failed, ${row.seconds}s`)

const report = {
  schemaVersion: 1,
  pluginVersion: manifest.version,
  pluginCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(),
  developmentHost: devHost,
  testedHost: version,
  hostTree: tree,
  mapping: 'tsconfig paths, honoured at runtime through TSX_TSCONFIG_PATH',
  dependencyHash: createHash('sha256').update(JSON.stringify(wanted)).digest('hex'),
  testedAt: new Date().toISOString(),
  completed: results.every(row => row.status === 'passed'),
  results,
}
const reports = join(repo, '.test-runtime', 'reports')
mkdirSync(reports, { recursive: true })
writeFileSync(join(reports, `host-matrix-${version}.json`), JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify({ testedHost: version, completed: report.completed }))
if (!report.completed) process.exitCode = 1
