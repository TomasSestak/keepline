import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import * as babel from '@babel/core';

/**
 * Fail the build if any hook or component stops being React Compiler friendly.
 *
 * The compiler never sees this package's source — consumers install the built
 * `dist` — so a bail-out here breaks nothing at runtime. It is still worth
 * guarding: a bail-out always means the code broke a Rule of React, and the
 * rules exist because breaking them is how you get bugs that only appear under
 * concurrent rendering. Keeping the source compilable is the cheapest way to
 * keep the rules enforced.
 *
 * The usual offender is the "latest ref" pattern — assigning `ref.current`
 * during render instead of in an effect.
 */
const collectSources = (directory) => {
  const files = [];

  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) files.push(...collectSources(path));
    else if (/\.tsx?$/.test(path)) files.push(path);
  }

  return files;
};

const presetsFor = (filename) =>
  filename.endsWith('.tsx')
    ? [
        ['@babel/preset-typescript', {}],
        // JSX parsing is per-extension: enabling it for a plain `.ts` file makes
        // every generic arrow (`<T = unknown>() => …`) look like a JSX tag.
        ['@babel/preset-react', { runtime: 'automatic' }]
      ]
    : [['@babel/preset-typescript', {}]];

let compiled = 0;
const failures = [];

for (const filename of collectSources('src')) {
  const events = [];

  try {
    babel.transformFileSync(filename, {
      filename,
      babelrc: false,
      configFile: false,
      presets: presetsFor(filename),
      plugins: [
        [
          'babel-plugin-react-compiler',
          {
            panicThreshold: 'none',
            logger: { logEvent: (_f, e) => events.push(e) }
          }
        ]
      ]
    });
  } catch (error) {
    failures.push(
      `${filename}: could not parse — ${error.message.split('\n')[0]}`
    );
    continue;
  }

  for (const event of events) {
    const where = `${filename}${event.fnLoc ? `:${event.fnLoc.start.line}` : ''}`;

    if (event.kind === 'CompileSuccess') {
      compiled += 1;
      continue;
    }
    if (event.kind === 'CompileError' || event.kind === 'CompileSkip') {
      const reason =
        event.detail?.reason ?? event.detail?.description ?? event.kind;
      failures.push(`${where} — ${reason}`);
    }
  }
}

if (failures.length > 0) {
  console.error('React Compiler bailed out:\n');
  for (const failure of failures) console.error(`  ${failure}`);
  console.error(
    `\n${compiled} compiled, ${failures.length} failed. Most bail-outs are a ref written during render — move it into an effect.`
  );
  process.exit(1);
}

console.info(`React Compiler: ${compiled}/${compiled} compiled, 0 bail-outs`);
