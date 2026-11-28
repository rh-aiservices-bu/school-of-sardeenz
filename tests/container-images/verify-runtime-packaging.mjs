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
import { log } from 'node:console';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execPath } from 'node:process';
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

// The last USER wins at runtime: a plain `includes('USER 1001:0')` would still pass if a later
// `USER 0` were added, so assert the effective identity instead.
function assertEndsWithNonRootUser(containerfile, label) {
  const users = [...containerfile.matchAll(/^USER\s+(\S+)\s*$/gm)].map((match) => match[1]);
  assert(users.length > 0, `${label} must declare a USER instruction`);
  assert(
    users.at(-1) === '1001:0',
    `${label} must end with USER 1001:0, found USER ${users.at(-1)}`,
  );
}

// `.trivyignore.yaml` suppressions silence *fixable* findings in the publish gate, so each entry
// must carry an expiry: Trivy stops honouring an `expired_at` date, but it accepts an entry
// without one, which would hide a fixable CRITICAL forever. The schema is enforced with a plain
// line scan — this guard takes no YAML dependency.
const trivyEntryStartPattern = /^\s*-\s+id:\s*(\S+)/;
const trivyExpiredAtFieldPattern = /^\s+expired_at\s*:/;
const trivyExpiryDatePattern = /^\s+expired_at:\s*\d{4}-\d{2}-\d{2}\s*$/;

function assertTrivySuppressionsExpire(source, label) {
  const lines = source.split(/\r?\n/);
  assert(
    lines.some((line) => /^vulnerabilities\s*:/.test(line)),
    `${label} must declare a top-level vulnerabilities: key`,
  );
  for (let start = 0; start < lines.length; start += 1) {
    const entry = trivyEntryStartPattern.exec(lines[start]);
    if (!entry) {
      continue;
    }
    const id = entry[1];
    let end = start + 1;
    while (end < lines.length && !trivyEntryStartPattern.test(lines[end])) {
      end += 1;
    }
    // Blank and comment lines carry no schema meaning, so a commented-out `expired_at` never
    // satisfies the check.
    const entryLines = lines.slice(start + 1, end).filter((line) => {
      const trimmed = line.trim();
      return trimmed !== '' && !trimmed.startsWith('#');
    });
    const declared = entryLines.filter((line) => trivyExpiredAtFieldPattern.test(line));
    const valid = entryLines.filter((line) => trivyExpiryDatePattern.test(line));
    assert(declared.length > 0, `${label} suppression ${id} must declare expired_at: YYYY-MM-DD`);
    assert(
      valid.length > 0,
      `${label} suppression ${id} must declare expired_at: YYYY-MM-DD, found: ${declared[0].trim()}`,
    );
    assert(
      valid.length === 1,
      `${label} suppression ${id} declares expired_at: YYYY-MM-DD more than once`,
    );
    start = end - 1;
  }
}

function expectTrivySuppressionRejected(source, expectedFragment) {
  try {
    assertTrivySuppressionsExpire(source, '<fixture>');
  } catch (error) {
    assert(
      error.message.includes(expectedFragment),
      `trivy suppression fixture was rejected with an unexpected message: ${error.message}`,
    );
    return;
  }
  throw new Error(`trivy suppression fixture must be rejected: ${expectedFragment}`);
}

// Negative and positive controls for the scan above, so the guard cannot rot into a no-op.
expectTrivySuppressionRejected(
  ['vulnerabilities:', '  - id: CVE-2024-0001', '    statement: no expiry'].join('\n'),
  'suppression CVE-2024-0001 must declare expired_at: YYYY-MM-DD',
);
expectTrivySuppressionRejected(
  ['vulnerabilities:', '  - id: CVE-2024-0003', '    # expired_at: 2026-12-31'].join('\n'),
  'suppression CVE-2024-0003 must declare expired_at: YYYY-MM-DD',
);
assertTrivySuppressionsExpire(
  ['vulnerabilities:', '  - id: CVE-2024-0002', '    expired_at: 2026-12-31'].join('\n'),
  '<fixture>',
);
assertTrivySuppressionsExpire('vulnerabilities: []', '<fixture>');

assertTrivySuppressionsExpire(
  readFileSync(join(repositoryRoot, '.trivyignore.yaml'), 'utf8'),
  '.trivyignore.yaml',
);

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

// Both service images build the full dependency tree in `deps` (tsc and Vite need
// devDependencies) and copy a production tree into `runtime`. These checks read the Dockerfile as
// per-stage instructions: a whole-file `includes()` cannot tell which stage a line belongs to, and
// `COPY --from=deps` is correct in the build stage while the same line in the runtime stage is a
// regression.
function parseStages(containerfile) {
  const instructions = [];
  let pending = '';
  for (const rawLine of containerfile.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) {
      continue;
    }
    const continued = line.endsWith('\\');
    pending = `${pending} ${continued ? line.slice(0, -1) : line}`.trim();
    if (!continued) {
      instructions.push(pending);
      pending = '';
    }
  }

  const stages = new Map();
  let current = null;
  for (const instruction of instructions) {
    const from = /^FROM\s+\S+(?:\s+AS\s+(\S+))?$/i.exec(instruction);
    if (from) {
      assert(from[1], `containerfile stage must be aliased: ${instruction}`);
      current = from[1].toLowerCase();
      stages.set(current, []);
      continue;
    }
    assert(current !== null, `containerfile instruction before the first FROM: ${instruction}`);
    stages.get(current).push(instruction);
  }
  return stages;
}

function expectPackagingRejected(containerfile, expectedFragment, check) {
  try {
    check(containerfile, 'fixture');
  } catch (error) {
    assert(
      error.message.includes(expectedFragment),
      `runtime packaging fixture was rejected with an unexpected message: ${error.message}`,
    );
    return;
  }
  throw new Error(`runtime packaging fixture must be rejected: ${expectedFragment}`);
}

const runtimeTrimInstruction = [
  'RUN rm -rf /usr/local/lib/node_modules/npm \\',
  '           /usr/local/lib/node_modules/corepack \\',
  '           /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack',
].join('\n');

// #350: the runtime service starts `node <entrypoint>` and never invokes a package manager, so the
// CLI bundle must be deleted. A static read cannot prove the image contents (the Trivy scan does),
// but it catches a silent reintroduction, and it pins the delete to the root layer before the
// effective USER: the runtime identity cannot remove root-owned paths.
const packageManagerCliPaths = [
  '/usr/local/lib/node_modules/npm',
  '/usr/local/lib/node_modules/corepack',
  '/usr/local/bin/npm',
  '/usr/local/bin/npx',
  '/usr/local/bin/corepack',
];

function assertRuntimeShipsNoPackageManager(containerfile, label) {
  const runtime = parseStages(containerfile).get('runtime');
  assert(runtime, `${label} must declare a runtime stage`);

  const removal = runtime.findIndex(
    (instruction) =>
      /^RUN\s+rm -rf\s/.test(instruction) &&
      packageManagerCliPaths.every((path) => instruction.includes(` ${path}`)),
  );
  assert(removal !== -1, `${label} runtime image must not ship the npm CLI bundle (#350)`);

  const tree = runtime[removal];
  assert(!tree.includes('/app'), `${label} must not delete the application dependency tree (#350)`);
  assert(
    !/(^|\s)\/usr\/local\/bin\/node(\s|$)/.test(tree),
    `${label} must not delete the node binary (#350)`,
  );

  const effectiveUser = runtime.findLastIndex((instruction) => /^USER\s+/.test(instruction));
  assert(effectiveUser !== -1, `${label} runtime stage must declare a USER instruction`);
  assert(
    removal < effectiveUser,
    `${label} must delete the npm CLI bundle as root, before its USER instruction (#350)`,
  );
}

const runtimeTrimFixture = [
  'FROM node:22-slim@sha256:' + '0'.repeat(64) + ' AS base',
  '',
  'FROM base AS runtime',
  '',
  'ENV NODE_ENV=production',
  '',
  runtimeTrimInstruction,
  '',
  'USER sardeenz',
  '',
  'CMD ["node", "index.js"]',
].join('\n');

// Positive and negative controls, so neither check can rot into a no-op.
assertRuntimeShipsNoPackageManager(runtimeTrimFixture, 'fixture');
// The worker's `USER 0` … `USER 1001:0` split is accepted: only the effective (last) USER counts.
assertRuntimeShipsNoPackageManager(
  runtimeTrimFixture.replace(runtimeTrimInstruction, `USER 0\n\n${runtimeTrimInstruction}`),
  'fixture',
);
expectPackagingRejected(
  runtimeTrimFixture.replace(runtimeTrimInstruction, ''),
  'must not ship the npm CLI bundle',
  assertRuntimeShipsNoPackageManager,
);
expectPackagingRejected(
  runtimeTrimFixture.replace(
    runtimeTrimInstruction,
    runtimeTrimInstruction.replace(
      '/usr/local/bin/corepack',
      '/usr/local/bin/corepack /app/node_modules',
    ),
  ),
  'must not delete the application dependency tree',
  assertRuntimeShipsNoPackageManager,
);
expectPackagingRejected(
  runtimeTrimFixture
    .replace(runtimeTrimInstruction, '')
    .replace('USER sardeenz', `USER sardeenz\n\n${runtimeTrimInstruction}`),
  'must delete the npm CLI bundle as root, before its USER instruction',
  assertRuntimeShipsNoPackageManager,
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
  if (service === 'dashboard') {
    assert(
      dockerfile.includes('COPY --from=deps /app/package.json ./package.json'),
      'dashboard build image must copy the root manifest before running a workspace script',
    );
  }
  assertRuntimeShipsNoPackageManager(dockerfile, service);
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

const workerBaseContainerfile = readFileSync(
  join(repositoryRoot, 'containers/worker-base/Containerfile'),
  'utf8',
);
assert(
  workerBaseContainerfile.includes('ARG NODE_MAJOR=22'),
  'worker-base must provide the Node.js major required by the repository and NVML binding',
);
assert(
  workerBaseContainerfile.includes(
    'useradd --uid 1001 --gid 0 --create-home --shell /sbin/nologin sardeenz',
  ),
  'worker-base must create the unprivileged sardeenz user (uid 1001, gid 0)',
);
assertEndsWithNonRootUser(workerBaseContainerfile, 'worker-base');

const workerContainerfile = readFileSync(
  join(repositoryRoot, 'containers/worker/Containerfile'),
  'utf8',
);
const workerDockerignore = readFileSync(
  join(repositoryRoot, 'containers/worker/Containerfile.dockerignore'),
  'utf8',
);
for (const requiredInstruction of [
  'ARG WORKER_BASE_IMAGE=',
  'USER 0',
  'chmod 0755 /opt/sardeenz',
  'USER 1001:0',
  'npx tsc --build runners/dev-worker/tsconfig.json',
  'npm ci --omit=dev --workspace=@sardeenz/dev-worker',
  'COPY --from=build /build/runners/dev-worker/dist ./runners/dev-worker/dist',
  'CMD ["node", "dist/index.js", "--mode=apptainer"]',
]) {
  assert(
    workerContainerfile.includes(requiredInstruction),
    `worker Containerfile is missing required packaging instruction: ${requiredInstruction}`,
  );
}
// The agent's code directory is root-owned and not group-writable: nothing writes there at runtime,
// and the engine SIF processes share uid 1001/gid 0 with the agent.
assert(
  !workerContainerfile.includes('0775'),
  'worker Containerfile must not make /opt/sardeenz group-writable',
);
assertEndsWithNonRootUser(workerContainerfile, 'worker');

for (const requiredInput of [
  'package.json',
  'package-lock.json',
  'tsconfig.base.json',
  'tsconfig.json',
  'packages/types/**',
  'runners/dev-worker/**',
]) {
  assert(
    workerDockerignore.includes(`!${requiredInput}`),
    `worker Containerfile ignore must allow required input ${requiredInput}`,
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
    execPath,
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

log('Verified service and worker runtime packaging.');
