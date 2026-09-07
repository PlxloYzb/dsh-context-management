import assert from 'node:assert/strict'
import { isBuiltin } from 'node:module'
import { execFileSync } from 'node:child_process'
import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'
const hash = value => createHash('sha256').update(value).digest('hex')
const pkg = JSON.parse(await readFile('package.json','utf8'))
const packing = JSON.parse(execFileSync('npm',['pack','--dry-run','--ignore-scripts','--json'],{encoding:'utf8'}))[0]
const paths=packing.files.map(file=>file.path)
for(const required of ['package.json','README.md','CHANGELOG.md','LICENSE','NOTICE.md','SOURCE_REUSE.md','THIRD_PARTY_LICENSES.md','cordis.patch.yml','dist/index.js','dist/index.d.ts','dist/bridge.js','dist/bridge.d.ts']) assert.ok(paths.includes(required),required)
assert.ok(paths.every(path=>/^(dist\/|package\.json$|README\.md$|CHANGELOG\.md$|LICENSE$|NOTICE\.md$|SOURCE_REUSE\.md$|THIRD_PARTY_LICENSES\.md$|cordis\.patch\.yml$)/.test(path)))
const imports = new Set(), inventory=[]
for(const path of paths){
 const bytes=await readFile(path);inventory.push({path,bytes:bytes.length,sha256:hash(bytes)})
 if(!path.endsWith('.js'))continue
 const source=bytes.toString()
 assert.doesNotMatch(source,/\/Users\/|\/Workspace\/|dsh-arc-context\/src|codex-main\//)
 for(const match of source.matchAll(/(?:from\s*|import\s*)["']([^"']+)["']/g)){
  const specifier=match[1];imports.add(specifier)
  if(specifier.startsWith('.'))continue
  if(isBuiltin(specifier))continue
  assert.ok(Object.hasOwn(pkg.peerDependencies,specifier),`undeclared public host import ${specifier}`)
  assert.doesNotMatch(specifier,/\/(?:lib|src)\//)
 }
}
assert.equal(pkg.dependencies['acp-kernel'],'0.0.24')
const report={schemaVersion:1,pluginVersion:pkg.version,pluginCommit:null,hostVersion:'0.1.2-rc.1',checkedAt:new Date().toISOString(),lockHash:hash(await readFile('package-lock.json')),inventory,imports:[...imports].sort(),files:paths.length,unpackedSize:packing.unpackedSize,completed:true,failures:[]}
await mkdir('docs/evidence/release',{recursive:true});await writeFile('docs/evidence/release/package-audit.json',JSON.stringify(report,null,2)+'\n')
console.log(JSON.stringify({files:report.files,imports:report.imports,completed:true}))
