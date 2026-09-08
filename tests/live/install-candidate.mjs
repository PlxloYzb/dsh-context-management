const releaseVersion = JSON.parse(await (await import('node:fs/promises')).readFile('package.json', 'utf8')).version
const evidenceRoot = `docs/evidence/v${releaseVersion.replaceAll('.', '')}`
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, copyFile, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { homedir } from 'node:os'

const profile = process.argv[2] ?? 'ctx-v011-test'
if (!/^ctx-v01[01]-[a-z0-9-]+$/.test(profile)) throw new Error('Candidate installation is restricted to isolated ctx-v010-* or ctx-v011-* profiles')
const hash = data => createHash('sha256').update(data).digest('hex')
await mkdir('.test-runtime', { recursive: true })
execFileSync('npm', ['pack', '--ignore-scripts', '--pack-destination', '.test-runtime'], { stdio: ['ignore', 'pipe', 'pipe'] })
const { name, version } = JSON.parse(await readFile('package.json', 'utf8'))
const filename = `${name}-${version}.tgz`, temporary = resolve('.test-runtime', filename)
const tarballHash = hash(await readFile(temporary))
const dir = resolve('.test-runtime/candidates', tarballHash)
await mkdir(dir, { recursive: true })
const tarball = join(dir, filename)
await copyFile(temporary, tarball)
// A content-addressed URL prevents pnpm from reusing an older same-version file dependency.
const output = execFileSync('dsh', ['plugin', '--profile', profile, 'add', tarball], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
await writeFile(resolve('.test-runtime', `install-${profile}.log`), output)
const profileRoot = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'profiles', profile)
const installedRoot = join(profileRoot, 'node_modules', name)
async function files(root, relative = '') {
  const result = []
  for (const entry of await readdir(join(root, relative), { withFileTypes: true })) {
    const path = join(relative, entry.name)
    if (entry.isDirectory()) result.push(...await files(root, path))
    else result.push(path)
  }
  return result.sort()
}
const inventory = []
for (const path of await files('dist')) {
  const expected = hash(await readFile(join('dist', path)))
  const actual = hash(await readFile(join(installedRoot, 'dist', path)))
  if (actual !== expected) throw new Error(`Installed artifact differs from the candidate: dist/${path}`)
  inventory.push({ path: `dist/${path}`, sha256: actual })
}
const report = { schemaVersion: 1, pluginVersion: version, pluginCommit: null, hostVersion: '0.1.2-rc.1',
  profile, installedAt: new Date().toISOString(), tarballHash, tarball, lockHash: hash(await readFile('package-lock.json')), inventory, installedFilesVerified: true }
await mkdir(`${evidenceRoot}/install`, { recursive: true })
await writeFile(`${evidenceRoot}/install/${profile}-${tarballHash.slice(0, 12)}.json`, JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify({ profile, tarballHash, tarball, verifiedFiles: inventory.length }))
