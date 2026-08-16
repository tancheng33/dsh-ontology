import { defineConfig } from 'tsdown'

/**
 * Self-contained build: transpiles `src/` and emits declarations without
 * project references, so `prepare` works after a bare `github:` install where
 * no monorepo checkout is present.
 */
export default defineConfig({
  entry: ['src/index.ts', 'src/ontology.ts'],
  outDir: 'lib',
  format: 'esm',
  platform: 'node',
  dts: { emitDtsOnly: false, sourcemap: false },
  clean: true,
  // Peer deps resolve from the host harness installation, never bundled.
  external: [/^@deepseek-ai\/(?!schemastery)/],
})
