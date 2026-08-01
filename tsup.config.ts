import { defineConfig } from 'tsup';

/**
 * One pass, all entries.
 *
 * Splitting the React entries into a second pass (to give them a `'use client'`
 * banner) would emit a second copy of the core into their chunk, so anyone
 * importing both `keepline` and `keepline/react` would ship the state machine
 * twice. The directive is prepended after the build instead — see
 * `scripts/postbuild.mjs`.
 */
export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'react/index': 'src/react/index.ts',
    'compat/index': 'src/compat/index.ts',
    'testing/index': 'src/testing/index.ts',
    'sentry/index': 'src/sentry/index.ts',
    'logger/index': 'src/logger/index.ts'
  },
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
  splitting: true,
  target: 'es2022',
  external: ['react', 'react-dom']
});
