#!/usr/bin/env node

import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const repositoryRoot = resolve(import.meta.dirname, '../..');
const typesDirectory = join(repositoryRoot, 'packages/types');
const runtimeManifestPath = join(typesDirectory, 'package.runtime.json');
const runtimeManifest = JSON.parse(readFileSync(runtimeManifestPath, 'utf8'));

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

assert(runtimeManifest.main === './dist/index.js', 'runtime manifest must use dist/index.js');
assert(runtimeManifest.types === './dist/index.d.ts', 'runtime manifest must use dist/index.d.ts');
assert(
  runtimeManifest.exports?.['.']?.import === './dist/index.js',
  'runtime exports.import must use dist/index.js',
);
assert(
  runtimeManifest.exports?.['.']?.types === './dist/index.d.ts',
  'runtime exports.types must use dist/index.d.ts',
);

for (const service of ['control-plane', 'dashboard']) {
  const dockerfile = readFileSync(join(repositoryRoot, `containers/${service}/Dockerfile`), 'utf8');
  const dockerignore = readFileSync(
    join(repositoryRoot, `containers/${service}/Dockerfile.dockerignore`),
    'utf8',
  );
  assert(
    dockerfile.includes('COPY --from=build /app/packages/types/dist ./packages/types/dist'),
    `${service} runtime image must copy the compiled shared types`,
  );
  assert(
    dockerfile.includes(
      'COPY --from=build /app/packages/types/package.runtime.json ./packages/types/package.json',
    ),
    `${service} runtime image must use the shared runtime package manifest`,
  );
  assert(
    dockerignore.includes('# This Dockerfile builds from the repository root.'),
    `${service} must use a Dockerfile-specific ignore file for its root build context`,
  );
  const allowlistRule = `!${service}/**`;
  const dockerignoreRules = dockerignore
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
  const allowlistIndex = dockerignoreRules.indexOf(allowlistRule);
  assert(allowlistIndex !== -1, `${service} Docker ignore must allow its source tree`);
  for (const requiredInput of [
    'package.json',
    'package-lock.json',
    'tsconfig.base.json',
    'tsconfig.json',
    'packages/contracts/**',
    'packages/types/**',
    'packages/utils/package.json',
    `${service}/**`,
  ]) {
    assert(
      dockerignore.includes(`!${requiredInput}`),
      `${service} Docker ignore must allow required input ${requiredInput}`,
    );
  }
  for (const excludedArtifact of [
    '**/node_modules/',
    '**/dist/',
    '**/*.tsbuildinfo',
    '**/*.log',
    '**/logs/',
    '**/.npmrc',
    '**/coverage/',
    '**/test-results/',
    '**/playwright-report/',
    '**/.env',
    '**/.env.*',
  ]) {
    const exclusionIndex = dockerignoreRules.lastIndexOf(excludedArtifact);
    assert(exclusionIndex !== -1, `${service} Docker ignore must exclude ${excludedArtifact}`);
    assert(
      exclusionIndex > allowlistIndex,
      `${service} Docker ignore must place ${excludedArtifact} after ${allowlistRule}`,
    );
  }
  assert(
    dockerignoreRules.slice(allowlistIndex + 1).every((rule) => !rule.startsWith('!')),
    `${service} Docker ignore must not re-include paths after its terminal exclusions`,
  );
}

const compiledTypes = join(typesDirectory, 'dist');
assert(
  existsSync(join(compiledTypes, 'index.js')),
  'packages/types/dist/index.js must be built first',
);
assert(
  existsSync(join(compiledTypes, 'index.d.ts')),
  'packages/types/dist/index.d.ts must be built first',
);

const fixture = mkdtempSync(join(tmpdir(), 'sardeenz-types-runtime-'));
try {
  const fixturePackage = join(fixture, 'packages/types');
  mkdirSync(fixturePackage, { recursive: true });
  cpSync(compiledTypes, join(fixturePackage, 'dist'), { recursive: true });
  cpSync(runtimeManifestPath, join(fixturePackage, 'package.json'));

  const packageLink = join(fixture, 'node_modules/@sardeenz/types');
  mkdirSync(join(fixture, 'node_modules/@sardeenz'), { recursive: true });
  symlinkSync('../../packages/types', packageLink, 'dir');
  assert(lstatSync(packageLink).isSymbolicLink(), 'runtime workspace link must be a symlink');

  const result = spawnSync(
    process.execPath,
    ['--input-type=module', '--eval', "await import('@sardeenz/types')"],
    { cwd: fixture, encoding: 'utf8' },
  );
  assert(
    result.status === 0,
    `runtime @sardeenz/types resolution failed: ${result.stderr || result.stdout}`,
  );
} finally {
  rmSync(fixture, { recursive: true, force: true });
}

console.log('Verified service runtime package resolution.');
