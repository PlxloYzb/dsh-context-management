import { defineConfig } from 'tsup'

// Build ESM entry points and shared chunks. Inline acp-kernel; the public
// @deepseek-ai/* host seams remain external and are pinned as peers.
export default defineConfig({
  entry: ['src/index.ts', 'src/bridge.ts', 'src/preset-cli.ts'],
  format: ['esm'],
  target: 'node22',
  dts: false,
  sourcemap: true,
  clean: true,
  noExternal: ['acp-kernel'],
  external: [/^@deepseek-ai\//],
})
