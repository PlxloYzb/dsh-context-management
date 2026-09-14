import { writeFile, rename, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

export async function atomicJson(path, value) {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${randomUUID()}.tmp`
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })
  await rename(temporary, path)
}

export function verifyRequestRoute(request, route) {
  if (request.provider !== route.provider || request.model !== route.model) throw new Error('BLOCKED_ROUTE: actual request differs from frozen route')
}
