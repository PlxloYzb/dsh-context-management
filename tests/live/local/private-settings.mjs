import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { writeFile } from 'node:fs/promises'

// Operates only on an ignored, private experiment copy. Native Basic omits
// reasoningEffort, so its adapter default must also be explicitly minimal.
export async function writePrivateSettings(path, originalBytes, museMinimal = false, cacheRetention) {
  let bytes = originalBytes
  if (museMinimal) {
    const yaml = createRequire(import.meta.url)(resolve('.test-runtime/host-pins/dsh-0.1.2-rc.1/node_modules/yaml'))
    const config = yaml.parse(originalBytes.toString())
    const provider = config['llm-pi-ai']?.providers?.['opencode-go-muse']
    if (!provider?.models?.some(model => model.id === 'muse-spark-1.3-contributor')) throw new Error('Configured Muse route unavailable')
    provider.reasoning = 'minimal'
    if (cacheRetention !== undefined) {
      if (cacheRetention !== 'none') throw new Error('Only the explicit cache-isolation diagnostic is supported')
      provider.cacheRetention = cacheRetention
    }
    bytes = yaml.stringify(config)
  }
  await writeFile(path, bytes, { mode: 0o600 })
}
