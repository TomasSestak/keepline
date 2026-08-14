import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temporary = await mkdtemp(join(tmpdir(), 'keepline-package-smoke-'));
const npmCache = join(temporary, 'npm-cache');

const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    encoding: 'utf8',
    env: {
      ...process.env,
      npm_config_cache: npmCache,
      ...options.env
    }
  });

  if (result.status !== 0) {
    throw new Error(
      [`${command} ${args.join(' ')} failed`, result.stdout, result.stderr]
        .filter(Boolean)
        .join('\n')
    );
  }

  return result.stdout.trim();
};

const entryPoints = [
  'keepline',
  'keepline/react',
  'keepline/compat',
  'keepline/testing',
  'keepline/sentry',
  'keepline/logger'
];

try {
  run('bun', ['run', 'build']);

  const packed = JSON.parse(
    run('npm', [
      'pack',
      '--json',
      '--ignore-scripts',
      '--pack-destination',
      temporary
    ])
  )[0];
  assert.ok(packed?.filename, 'npm pack did not return a tarball');

  const allowedTopLevel = new Set([
    'CHANGELOG.md',
    'LICENSE',
    'MIGRATION.md',
    'README.md',
    'package.json'
  ]);
  for (const file of packed.files) {
    const allowed =
      file.path.startsWith('dist/') || allowedTopLevel.has(file.path);
    assert.ok(allowed, `unexpected file in package: ${file.path}`);
  }

  const packageJson = JSON.parse(
    await readFile(join(root, 'package.json'), 'utf8')
  );
  for (const [subpath, target] of Object.entries(packageJson.exports)) {
    if (subpath === './package.json') continue;
    for (const mode of ['import', 'require']) {
      const branch = target[mode];
      assert.ok(branch?.default, `${subpath} has no ${mode} target`);
      assert.ok(branch?.types, `${subpath} has no ${mode} type target`);
      await readFile(join(root, branch.default));
      await readFile(join(root, branch.types));
    }
  }

  for (const entry of [
    'dist/react/index.js',
    'dist/react/index.cjs',
    'dist/compat/index.js',
    'dist/compat/index.cjs'
  ]) {
    const source = await readFile(join(root, entry), 'utf8');
    assert.ok(
      source.startsWith("'use client';"),
      `${entry} is not a client entry`
    );
  }

  for (const file of packed.files.filter((item) =>
    /\.(?:js|cjs)$/.test(item.path)
  )) {
    const source = await readFile(join(root, file.path), 'utf8');
    const comments = source.match(/^\/\/# sourceMappingURL=.*$/gm) ?? [];
    assert.ok(
      comments.length <= 1,
      `${file.path} has duplicate sourcemap comments`
    );
  }

  await writeFile(
    join(temporary, 'package.json'),
    JSON.stringify({ private: true, type: 'module' })
  );
  const tarball = join(temporary, packed.filename);
  run(
    'npm',
    [
      'install',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      tarball,
      'react@18.3.1',
      '@types/react@18.3.12'
    ],
    { cwd: temporary }
  );

  const expectedExports = {
    keepline: 'createSocket',
    'keepline/react': 'useSocket',
    'keepline/compat': 'useWebSocket',
    'keepline/testing': 'MockWebSocket',
    'keepline/sentry': 'createSentryReporter',
    'keepline/logger': 'createConsoleLogger'
  };
  await writeFile(
    join(temporary, 'esm.mjs'),
    `import assert from 'node:assert/strict';\n${entryPoints
      .map(
        (entry, index) =>
          `import * as entry${index} from ${JSON.stringify(entry)};\nassert.equal(typeof entry${index}[${JSON.stringify(expectedExports[entry])}], 'function');`
      )
      .join('\n')}\n`
  );
  await writeFile(
    join(temporary, 'cjs.cjs'),
    `'use strict';\nconst assert = require('node:assert/strict');\n${entryPoints
      .map(
        (entry) =>
          `assert.equal(typeof require(${JSON.stringify(entry)})[${JSON.stringify(expectedExports[entry])}], 'function');`
      )
      .join('\n')}\n`
  );
  run(process.execPath, ['esm.mjs'], { cwd: temporary });
  run(process.execPath, ['cjs.cjs'], { cwd: temporary });

  await writeFile(
    join(temporary, 'consumer.ts'),
    `import { createSocket, type SocketOptions } from 'keepline';\nconst options: SocketOptions = { url: null };\ncreateSocket(options).destroy();\n`
  );
  await writeFile(
    join(temporary, 'consumer.cts'),
    `import keepline = require('keepline');\nconst options: keepline.SocketOptions = { url: null };\nkeepline.createSocket(options).destroy();\n`
  );
  await writeFile(
    join(temporary, 'consumer-browser.ts'),
    `import { createSocket } from 'keepline';
import { useSocket, type UseSocketOptions } from 'keepline/react';
import { ReadyState, useWebSocket, type CompatOptions } from 'keepline/compat';
import { MockWebSocket, type InstallOptions } from 'keepline/testing';
import { createSentryReporter, type SentryLike } from 'keepline/sentry';
import { createConsoleLogger, type ConsoleLoggerOptions } from 'keepline/logger';

const hookOptions: UseSocketOptions = { url: null };
const compatOptions: CompatOptions = { reconnectAttempts: 1 };
const installOptions: InstallOptions = { autoOpen: false };
const sentry: SentryLike = { addBreadcrumb() {}, captureException: () => undefined };
const loggerOptions: ConsoleLoggerOptions = { level: 'silent' };
const browserSocket = createSocket({
  url: null,
  socketFactory: (url, protocols) =>
    protocols === undefined
      ? new WebSocket(url)
      : new WebSocket(url, protocols)
});
const native = browserSocket.getWebSocket();
native?.send('package-smoke');
// @ts-expect-error Minimal custom transports do not promise EventTarget extras.
native?.dispatchEvent(new Event('package-smoke'));
void [useSocket, hookOptions, useWebSocket, ReadyState, compatOptions, MockWebSocket, installOptions];
createSentryReporter({ sentry });
createConsoleLogger(loggerOptions);
`
  );
  await writeFile(
    join(temporary, 'consumer-browser.cts'),
    `import keepline = require('keepline');
import react = require('keepline/react');
import compat = require('keepline/compat');
import testing = require('keepline/testing');
import sentryEntry = require('keepline/sentry');
import logger = require('keepline/logger');

const hookOptions: react.UseSocketOptions = { url: null };
const compatOptions: compat.CompatOptions = { reconnectAttempts: 1 };
const installOptions: testing.InstallOptions = { autoOpen: false };
const sentry: sentryEntry.SentryLike = { addBreadcrumb() {}, captureException: () => undefined };
const loggerOptions: logger.ConsoleLoggerOptions = { level: 'silent' };
const browserSocket = keepline.createSocket({
  url: null,
  socketFactory: (url, protocols) =>
    protocols === undefined
      ? new WebSocket(url)
      : new WebSocket(url, protocols)
});
const native = browserSocket.getWebSocket();
native?.send('package-smoke');
// @ts-expect-error Minimal custom transports do not promise EventTarget extras.
native?.dispatchEvent(new Event('package-smoke'));
void [react.useSocket, hookOptions, compat.useWebSocket, compat.ReadyState, compatOptions, testing.MockWebSocket, installOptions];
sentryEntry.createSentryReporter({ sentry });
logger.createConsoleLogger(loggerOptions);
`
  );
  await writeFile(
    join(temporary, 'tsconfig.root.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        lib: ['ES2022'],
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        strict: true,
        noEmit: true,
        skipLibCheck: false,
        types: []
      },
      include: ['consumer.ts', 'consumer.cts']
    })
  );
  await writeFile(
    join(temporary, 'tsconfig.browser.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        lib: ['ES2022', 'DOM'],
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        strict: true,
        noEmit: true,
        skipLibCheck: false,
        types: []
      },
      include: ['consumer-browser.ts', 'consumer-browser.cts']
    })
  );
  run(
    process.execPath,
    [join(root, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.root.json'],
    { cwd: temporary }
  );
  run(
    process.execPath,
    [
      join(root, 'node_modules/typescript/bin/tsc'),
      '-p',
      'tsconfig.browser.json'
    ],
    { cwd: temporary }
  );

  console.info(
    `package smoke passed on Node ${process.versions.node}: ${packed.filename}`
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
