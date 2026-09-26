// Host patch composition for one arm. The plugin under test is never modified;
// this only selects the frozen arm configuration and mounts observation tools.
import { writeFile, readFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { createRequire } from 'node:module'

// The host parses --patch overlays as YAML; serialize through a pinned host's
// own YAML implementation so the dialect always matches.
const yaml = createRequire(import.meta.url)(resolve('.test-runtime/host-pins/dsh-0.1.2-rc.1/node_modules/yaml'))

/**
 * The provider configuration the run needs, taken from the same private settings
 * the isolated home was seeded with.
 *
 * On 0.1.7 the `settings` bundle entry is disabled unless the profile carries a
 * `profileContext`, which only the Electron application supplies — so a
 * CLI-launched profile never reads `settings.yaml` and registers no provider at
 * all ("no adapter registered for provider ..."). Inlining the `llm-pi-ai`
 * section into this arm's patch keeps one source of truth (the user's settings,
 * already narrowed to Muse minimal) while making the provider available to a
 * CLI-launched profile. Only `apiKeyEnv` names travel, never key material.
 */
async function providerSection(runRoot) {
  const settings = yaml.parse(await readFile(join(runRoot, 'private-settings.yaml'), 'utf8'))
  const section = settings?.['llm-pi-ai']
  if (section === undefined || typeof section !== 'object') throw new Error('private settings carry no llm-pi-ai section')
  return section
}

export async function writeArmPatch({ root, command, control, runRoot, arm, route, mainMaxTokens, bare = false }) {
  const patchPath = resolve(root, 'host.patch.yml')
  const insert = []
  if (!bare) {
    insert.push({
      id: 'experiment-fixture-tools',
      name: resolve('tests/live/longrun/fixture-tools.mjs'),
      config: { controlRoot: control, fixturePath: resolve(runRoot, 'fixture.json') },
    })
    insert.push({
      id: 'experiment-observer',
      name: resolve('tests/live/longrun/observer.mjs'),
      config: {
        // The observer writes requests.jsonl plus the full snapshot and JSONL
        // event streams into one directory; the driver reads that directory as
        // its observed root. usage.jsonl lives in its own evidence subdirectory.
        output: resolve(runRoot, 'observed'),
        eventRoot: resolve(runRoot, 'observed'),
        usageRoot: resolve(runRoot, 'usage'),
        jobRoot: resolve(runRoot),
        route,
        mainMaxTokens,
        expectedContextWindow: 1048576,
        sessionMarker: 'dsh-context-experiment-',
        stopFile: resolve(runRoot, 'control', 'stop'),
      },
    })
    if (command.compaction.kind === 'native-basic') {
      // Probe only: measures whether our ledger reads the blocks the native
      // engine produces. It observes, never modifies, the session.
      insert.push({
        id: 'experiment-ledger-probe',
        name: resolve('tests/live/longrun/ledger-probe.mjs'),
        config: { output: resolve(runRoot, 'ledger-probe.json'), sessionId: null, ledgerModule: resolve('dist/index.js') },
      })
      insert.push({
        id: 'experiment-arm',
        name: resolve('tests/live/longrun/arm.mjs'),
        config: { output: resolve(runRoot), arm, compaction: command.compaction.config, mainMaxTokens, expectedContextWindow: 1048576 },
      })
    }
  }
  // The session-title model stream must be absent, and the model-facing skill
  // catalog is a large user-message blob unrelated to the experiment workload;
  // both are disabled without touching any shipped preset file.
  const patches = [
    { id: 'settings', config: { path: resolve(runRoot, 'private-settings.yaml') } },
    // The provider must be registered on the profile itself: the `settings`
    // entry above is inert without a profileContext.
    { id: 'llm-pi-ai', config: await providerSection(runRoot) },
    { id: 'session-title-llm', disabled: true },
    { id: 'tool-skill', disabled: true },
  ]
  if (command.pluginBundle) patches.push({ id: 'compaction-context-management-bridge', config: command.compaction.config })
  patches.push({ insert })
  await writeFile(patchPath, yaml.stringify(patches), { mode: 0o600 })
  return patchPath
}
