import { readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');

/**
 * Prepend `'use client'` to the entries that contain hooks.
 *
 * Required for the Next.js App Router: without it, importing a hook from a
 * server component fails with an error that points at the consumer's code
 * rather than at the missing directive. Bundlers do not reliably carry a
 * source-level directive through bundling, and tsup's `banner` option is global
 * rather than per-entry, so it is applied here.
 */
const DIRECTIVE = "'use client';";

const CLIENT_ENTRIES = [
  'react/index.js',
  'react/index.cjs',
  'compat/index.js',
  'compat/index.cjs'
];

const listJsFiles = async (directory) => {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await listJsFiles(path)));
    else if (/\.(js|cjs)$/.test(entry.name)) files.push(path);
  }

  return files;
};

/**
 * tsup emits the `sourceMappingURL` comment twice per file. Harmless to most
 * tooling, but a duplicate confuses some sourcemap readers — and a published
 * artifact should be clean.
 */
const dedupeSourceMapComment = (source) => {
  const pattern = /^\/\/# sourceMappingURL=.*$/gm;
  const matches = source.match(pattern);
  if (!matches || matches.length < 2) return source;

  let seen = 0;
  return source.replace(pattern, (match) => {
    seen += 1;
    return seen === matches.length ? match : '';
  });
};

let clientPatched = 0;

for (const path of await listJsFiles(dist)) {
  const relative = path.slice(dist.length + 1);
  const source = await readFile(path, 'utf8');
  let next = dedupeSourceMapComment(source);

  if (
    CLIENT_ENTRIES.includes(relative) &&
    !next.startsWith(DIRECTIVE) &&
    !next.startsWith('"use client"')
  ) {
    // Same line, no newline: a leading line would shift every mapping in the
    // sourcemap by one.
    next = `${DIRECTIVE}${next}`;
    clientPatched += 1;
  }

  if (next === source) continue;
  await writeFile(path, next, 'utf8');
}

for (const entry of CLIENT_ENTRIES) {
  const source = await readFile(join(dist, entry), 'utf8').catch(() => null);
  if (source === null || !source.startsWith(DIRECTIVE)) {
    console.error(`postbuild: ${entry} is missing the 'use client' directive`);
    process.exitCode = 1;
  }
}

console.info(
  `postbuild: 'use client' added to ${clientPatched} entr(ies), sourcemap comments deduped`
);
