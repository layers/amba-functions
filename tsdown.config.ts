import { defineConfig } from 'tsdown';

/**
 * Two entries — main + errors subpath:
 *
 *   dist/index.js + dist/index.d.ts        — `@layers/amba-functions`
 *   dist/errors.js + dist/errors.d.ts      — `@layers/amba-functions/errors`
 *
 * The errors subpath exists so downstream packages can re-export the typed
 * error hierarchy without pulling in the rest of the SDK (the runtime-only
 * `defineFunction` surface, the AI client, etc.).
 *
 * `hash: false` keeps emitted filenames stable so they match
 * `package.json` `types` / `exports`.
 */
export default defineConfig({
  entry: ['src/index.ts', 'src/errors.ts'],
  format: 'esm',
  dts: true,
  hash: false,
  clean: true,
  sourcemap: false,
});
