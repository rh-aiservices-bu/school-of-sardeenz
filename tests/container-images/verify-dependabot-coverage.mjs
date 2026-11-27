#!/usr/bin/env node
// Fails when the Dependabot registry and the checked-in image pins drift from what this repository
// ships. Every containers/runners/<engine>/<version>/ build directory needs a docker entry in
// .github/dependabot.yml (or a documented skip), every docker entry must point at a directory that
// exists, every shipped runners.yaml entry must resolve to a build directory via its runnerType and
// version prefix (catalog `0.26` ↔ directory `0.26.0`), and every image under deployment/prereq/
// must be pinned as `name:tag@sha256:<64 hex>` with a dated tag. The four platform bases keep
// `:latest` by policy (deployment/README.md) and are out of scope.
//
// Deliberate limits: no network or registry check, no digest freshness check, no automation of the
// prereq image bumps (Dependabot has no ecosystem for raw Kubernetes manifests — its `docker`
// entries are keyed on build directories), no validation of the non-docker ecosystems beyond their
// directory bookkeeping.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { error, log } from 'node:console';
import { argv, exit } from 'node:process';

const repositoryRoot = resolve(import.meta.dirname, '../..');
const containerFilePattern = /^(Dockerfile|Containerfile)(\..+)?$/i;
const runnerRoot = 'containers/runners';
const prereqRoot = 'deployment/prereq';
const dependabotPath = '.github/dependabot.yml';
const catalogPath = 'runners.yaml';
const digestPattern = /^sha256:[0-9a-f]{64}$/;

// Shipped-but-unregistered runner version directories, by decision. The #233 decision comment
// (2026-11-11) registers only the catalog's current versions; ADR-030 decision 1 repeats the
// exception, and containers/README.md documents it. These entries still ship in runners.yaml, so
// they get no base-image update PRs by design — a new version directory that is not current does
// NOT belong here.
const documentedSkips = new Map([
  ['containers/runners/vllm/0.21.0', '#233 (2026-11-11): catalog is retiring it'],
  [
    'containers/runners/vllm/0.24.0',
    '#233 (2026-11-11): entries track the catalog current versions',
  ],
]);

const usage = `Usage: node tests/container-images/verify-dependabot-coverage.mjs [--root <dir>]

Fails when a containers/runners/<engine>/<version>/ build directory has no docker entry in
.github/dependabot.yml (or an entry points at a directory that is gone), when a shipped runners.yaml
entry is neither registered nor a documented skip, and when an image under deployment/prereq/ is not
pinned as name:tag@sha256:<64 hex> with a dated tag.`;

function parseArguments(args) {
  let root = repositoryRoot;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--help' || argument === '-h') {
      log(usage);
      exit(0);
    }
    if (argument === '--root') {
      const value = args[index + 1];
      if (value === undefined) {
        throw new Error('--root requires a directory argument');
      }
      root = resolve(value);
      index += 1;
      continue;
    }
    throw new Error(`unexpected argument: ${argument}`);
  }
  return root;
}

function stripValue(raw) {
  const withoutComment = raw.replace(/\s+#.*$/, '').trim();
  const quoted = /^(['"])(.*)\1$/.exec(withoutComment);
  return quoted === null ? withoutComment : quoted[2];
}

// dependabot.yml as a flat entry list: a `- package-ecosystem:` line opens an entry, `directory:`
// fills it. The plural `directories:` form is rejected rather than guessed at.
function parseDependabot(source) {
  const entries = [];
  let current = null;
  source.split('\n').forEach((line, index) => {
    const lineNumber = index + 1;
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) {
      return;
    }
    if (/^directories\s*:/.test(trimmed)) {
      throw new Error(`unhandled dependabot form: directories: (${dependabotPath}:${lineNumber})`);
    }
    const ecosystem = /^-\s+package-ecosystem:\s*(.+?)\s*$/.exec(trimmed);
    if (ecosystem !== null) {
      current = { ecosystem: stripValue(ecosystem[1]), directory: null, lineNumber };
      entries.push(current);
      return;
    }
    const directory = /^directory:\s*(.+?)\s*$/.exec(trimmed);
    if (directory !== null) {
      if (current === null) {
        throw new Error(
          `directory: outside any package-ecosystem entry (${dependabotPath}:${lineNumber})`,
        );
      }
      current.directory = stripValue(directory[1]);
    }
  });
  for (const entry of entries) {
    if (entry.directory === null) {
      throw new Error(
        `package-ecosystem entry has no directory: (${dependabotPath}:${entry.lineNumber})`,
      );
    }
  }
  return entries;
}

// runners.yaml as a flat entry list. The field anchors require exactly four spaces of indentation,
// so `description: >-` continuation lines (six spaces) and flow sequences never fill a field.
function parseCatalog(source) {
  const entries = [];
  let current = null;
  source.split('\n').forEach((line, index) => {
    const lineNumber = index + 1;
    const start = /^ {2}- id:\s*(.+?)\s*$/.exec(line);
    if (start !== null) {
      current = {
        id: stripValue(start[1]),
        engine: null,
        runnerType: null,
        version: null,
        lineNumber,
      };
      entries.push(current);
      return;
    }
    const field = /^ {4}(engine|runnerType|version):\s*(.+?)\s*$/.exec(line);
    if (field !== null) {
      if (current === null) {
        throw new Error(`catalog field outside any runner entry (${catalogPath}:${lineNumber})`);
      }
      current[field[1]] = stripValue(field[2]);
    }
  });
  for (const entry of entries) {
    if (entry.runnerType === null || entry.version === null) {
      throw new Error(
        `catalog entry ${entry.id} is missing runnerType or version (${catalogPath}:${entry.lineNumber})`,
      );
    }
  }
  return entries;
}

// The catalog stores an engine version ('0.26'), the build directories carry the full build version
// ('0.26.0'). Prefix matching is the alias map: no hand-maintained table to keep in sync.
function versionMatches(directoryName, catalogVersion) {
  return directoryName === catalogVersion || directoryName.startsWith(`${catalogVersion}.`);
}

function directoryExists(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function hasBuildFile(directory) {
  return readdirSync(directory, { withFileTypes: true }).some(
    (entry) => entry.isFile() && containerFilePattern.test(entry.name),
  );
}

function collectRunnerVersionDirectories(root) {
  const runnersDirectory = join(root, runnerRoot);
  const found = [];
  for (const engine of readdirSync(runnersDirectory, { withFileTypes: true })) {
    if (!engine.isDirectory()) {
      continue;
    }
    const enginePath = join(runnersDirectory, engine.name);
    for (const version of readdirSync(enginePath, { withFileTypes: true })) {
      if (!version.isDirectory()) {
        continue;
      }
      if (!hasBuildFile(join(enginePath, version.name))) {
        continue;
      }
      found.push({
        path: `${runnerRoot}/${engine.name}/${version.name}`,
        engine: engine.name,
        version: version.name,
      });
    }
  }
  return found.sort((left, right) => left.path.localeCompare(right.path));
}

function collectPrereqImages(root) {
  const prereqDirectory = join(root, prereqRoot);
  const files = readdirSync(prereqDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.yaml'))
    .map((entry) => join(prereqDirectory, entry.name))
    .sort();

  const images = [];
  for (const file of files) {
    const lines = readFileSync(file, 'utf8').split('\n');
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index].trimEnd();
      const reference = /^\s*image:\s*(\S+)\s*$/.exec(line);
      if (reference !== null) {
        images.push({
          file: `${prereqRoot}/${file.slice(prereqDirectory.length + 1)}`,
          lineNumber: index + 1,
          reference: reference[1],
        });
        continue;
      }
      if (/^\s*image\s*:/.test(line)) {
        throw new Error(
          `unparseable image: line (expected "image: <reference>", no trailing content) at ` +
            `${file.slice(prereqDirectory.length + 1)}:${index + 1}`,
        );
      }
    }
  }
  return images;
}

function classifyPrereqImage(reference) {
  const digestIndex = reference.lastIndexOf('@');
  const taggedName = digestIndex === -1 ? reference : reference.slice(0, digestIndex);
  // The tag is checked first so `:latest` reports the tag problem, not the missing digest.
  const lastSegment = taggedName.split('/').at(-1) ?? '';
  const tagIndex = lastSegment.lastIndexOf(':');
  if (tagIndex <= 0 || tagIndex === lastSegment.length - 1) {
    return {
      kind: 'violation',
      reason: 'unparseable image reference (expected name:tag@sha256:<64 hex>)',
    };
  }
  if (lastSegment.slice(tagIndex + 1) === 'latest') {
    return { kind: 'violation', reason: 'tag is :latest — pin the dated sclorg tag' };
  }
  if (digestIndex === -1) {
    return { kind: 'violation', reason: 'missing @sha256:<64 hex> digest' };
  }
  if (!digestPattern.test(reference.slice(digestIndex + 1))) {
    return {
      kind: 'violation',
      reason: 'malformed digest (expected 64 lowercase hex characters)',
    };
  }
  return { kind: 'pinned' };
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function assertRejected(action, fragment, label) {
  try {
    action();
  } catch (caught) {
    assert(
      caught.message.includes(fragment),
      `${label} fixture was rejected with an unexpected message: ${caught.message}`,
    );
    return;
  }
  throw new Error(`${label} fixture must be rejected: ${fragment}`);
}

function assertViolation(classification, fragment, label) {
  assert(
    classification.kind === 'violation',
    `${label} fixture must be a violation, got ${JSON.stringify(classification)}`,
  );
  assert(
    classification.reason.includes(fragment),
    `${label} fixture reason was "${classification.reason}", expected "${fragment}"`,
  );
}

// Negative and positive controls, so the parsers and the classifier cannot rot into no-ops.
function runFixtureChecks() {
  const dependabotFixture = [
    'updates:',
    '  - package-ecosystem: "docker"',
    '    directory: "/containers/worker"',
    '  - package-ecosystem: docker # unquoted, trailing comment',
    '    directory: "/containers/worker-base" # inline note',
  ].join('\n');
  assert(
    parseDependabot(dependabotFixture).length === 2,
    'dependabot fixture must parse two entries',
  );
  assertRejected(
    () =>
      parseDependabot(
        [
          'updates:',
          '  - package-ecosystem: "docker"',
          '    directories:',
          '      - "/containers"',
        ].join('\n'),
      ),
    'unhandled dependabot form: directories:',
    'directories:',
  );

  const catalogFixture = [
    'runners:',
    '  - id: vllm-0.26',
    '    description: >-',
    '      a folded block that reads like fields',
    '      runnerType: not-a-field',
    '      version: 9.9',
    "    runnerType: 'vllm'",
    "    version: '0.26'",
  ].join('\n');
  const catalogEntries = parseCatalog(catalogFixture);
  assert(catalogEntries.length === 1, 'catalog fixture must parse one entry');
  assert(
    catalogEntries[0].runnerType === 'vllm' && catalogEntries[0].version === '0.26',
    `catalog fixture parsed as ${JSON.stringify(catalogEntries[0])}`,
  );
  assert(
    versionMatches('0.26.0', catalogEntries[0].version) &&
      !versionMatches('0.24.0', catalogEntries[0].version),
    'version alias rule must match catalog 0.26 to directory 0.26.0 only',
  );

  const digest = 'a'.repeat(64);
  assert(
    classifyPrereqImage(`quay.io/sclorg/valkey-8-c10s:20261125@sha256:${digest}`).kind === 'pinned',
    'dated tag + digest must classify as pinned',
  );
  assertViolation(
    classifyPrereqImage('quay.io/sclorg/valkey-8-c10s:latest'),
    'tag is :latest',
    ':latest-only',
  );
  assertViolation(
    classifyPrereqImage(`quay.io/sclorg/valkey-8-c10s:latest@sha256:${digest}`),
    'tag is :latest',
    'latest@sha256',
  );
  assertViolation(
    classifyPrereqImage('quay.io/sclorg/valkey-8-c10s:20261125@sha256:xyz'),
    'malformed digest',
    'malformed digest',
  );
  assertViolation(
    classifyPrereqImage('quay.io/sclorg/valkey-8-c10s'),
    'unparseable image reference',
    'untagged reference',
  );
}

function main() {
  let root;
  try {
    root = parseArguments(argv.slice(2));
  } catch (argumentError) {
    error(argumentError.message);
    error(usage);
    exit(2);
  }

  if (!directoryExists(root)) {
    error(`--root must be an existing directory: ${root}`);
    exit(2);
  }

  try {
    runFixtureChecks();
  } catch (fixtureError) {
    error(`checker self-fixture failed: ${fixtureError.message}`);
    exit(2);
  }

  let dependabotEntries;
  let catalogEntries;
  let runnerDirectories;
  let prereqImages;
  try {
    dependabotEntries = parseDependabot(readFileSync(join(root, dependabotPath), 'utf8'));
    catalogEntries = parseCatalog(readFileSync(join(root, catalogPath), 'utf8'));
    runnerDirectories = collectRunnerVersionDirectories(root);
    prereqImages = collectPrereqImages(root);
  } catch (inputError) {
    error(inputError.message);
    exit(2);
  }

  if (catalogEntries.length === 0) {
    error(`No runner catalog entry parsed from ${catalogPath}.`);
    exit(2);
  }
  if (runnerDirectories.length === 0) {
    error(`No runner build directory found under ${runnerRoot}.`);
    exit(2);
  }
  if (prereqImages.length === 0) {
    error(`No image: reference found under ${prereqRoot}/.`);
    exit(2);
  }

  const violations = [];
  const fail = (location, lineNumber, detail, reason) => {
    violations.push({ location, lineNumber, detail, reason });
  };

  const dockerEntries = dependabotEntries.filter((entry) => entry.ecosystem === 'docker');
  const normalize = (directory) => (directory === '/' ? '/' : directory.replace(/\/+$/, ''));
  const dockerDirectories = new Set(dockerEntries.map((entry) => normalize(entry.directory)));

  // 1. Every docker directory exists (a removed directory leaves a dead entry) and, for a runner
  //    directory, still holds a build file.
  for (const entry of dockerEntries) {
    const directory = normalize(entry.directory);
    const directoryPath = join(root, directory);
    if (!directoryExists(directoryPath)) {
      fail(
        dependabotPath,
        entry.lineNumber,
        directory,
        'docker entry points at a missing directory — a removed directory leaves a dead entry',
      );
      continue;
    }
    if (directory.startsWith(`/${runnerRoot}/`) && !hasBuildFile(directoryPath)) {
      fail(
        dependabotPath,
        entry.lineNumber,
        directory,
        'docker entry points at a directory with no Dockerfile/Containerfile',
      );
    }
  }

  // 2. No duplicate docker directories — Dependabot rejects overlapping directories.
  const firstLineByDirectory = new Map();
  for (const entry of dockerEntries) {
    const directory = normalize(entry.directory);
    const firstLine = firstLineByDirectory.get(directory);
    if (firstLine === undefined) {
      firstLineByDirectory.set(directory, entry.lineNumber);
      continue;
    }
    fail(
      dependabotPath,
      entry.lineNumber,
      `${directory} (first entry at line ${firstLine})`,
      'duplicate docker entry — Dependabot rejects overlapping directories',
    );
  }

  // 3. Catalog closure: every shipped runners.yaml entry resolves to at least one build directory,
  //    and every build directory is registered or a documented skip. This is the acceptance
  //    criterion — a new version directory without an entry names that directory.
  const catalogEntriesFor = (directory) =>
    catalogEntries.filter(
      (entry) =>
        entry.runnerType.toLowerCase() === directory.engine &&
        versionMatches(directory.version, entry.version),
    );

  for (const entry of catalogEntries) {
    const engineDirectory = entry.runnerType.toLowerCase();
    const matches = runnerDirectories.filter(
      (directory) =>
        directory.engine === engineDirectory && versionMatches(directory.version, entry.version),
    );
    if (matches.length === 0) {
      fail(
        catalogPath,
        entry.lineNumber,
        `${entry.id} (version ${entry.version})`,
        `shipped catalog entry has no build directory under ${runnerRoot}/${engineDirectory}/`,
      );
    }
  }

  let registeredDirectories = 0;
  let skippedDirectories = 0;
  for (const directory of runnerDirectories) {
    if (dockerDirectories.has(`/${directory.path}`)) {
      registeredDirectories += 1;
      continue;
    }
    if (documentedSkips.has(directory.path)) {
      skippedDirectories += 1;
      continue;
    }
    const shippers = catalogEntriesFor(directory).map((entry) => entry.id);
    fail(
      directory.path,
      undefined,
      'runner version directory has no docker entry',
      `${shippers.length > 0 ? `shipped by ${shippers.join(', ')} — ` : ''}` +
        `add a /${directory.path} docker entry to ${dependabotPath}, or a documented skip naming ` +
        'its decision',
    );
  }

  // 4. The skip list is a decision, not a pass: a skip whose directory is gone, whose entry now
  //    exists, or whose catalog entry disappeared is stale and must be removed.
  for (const [skipPath, note] of documentedSkips) {
    const segments = skipPath.split('/');
    const engine = segments.at(-2) ?? '';
    const version = segments.at(-1) ?? '';
    const shipped = catalogEntries.some(
      (entry) =>
        entry.runnerType.toLowerCase() === engine && versionMatches(version, entry.version),
    );
    if (!runnerDirectories.some((directory) => directory.path === skipPath)) {
      fail(
        skipPath,
        undefined,
        'stale or contradictory documented skip',
        `${note} — no build directory at that path`,
      );
    } else if (dockerDirectories.has(`/${skipPath}`)) {
      fail(
        skipPath,
        undefined,
        'stale or contradictory documented skip',
        `${note} — a docker entry now registers it`,
      );
    } else if (!shipped) {
      fail(
        skipPath,
        undefined,
        'stale or contradictory documented skip',
        `${note} — no shipped ${catalogPath} entry resolves to it`,
      );
    }
  }

  // 5. The prereq backing services are hand-pinned (no Dependabot ecosystem covers raw manifests).
  let prereqPins = 0;
  for (const image of prereqImages) {
    const classification = classifyPrereqImage(image.reference);
    if (classification.kind === 'pinned') {
      prereqPins += 1;
      continue;
    }
    fail(image.file, image.lineNumber, image.reference, classification.reason);
  }

  violations.sort((left, right) =>
    left.location === right.location
      ? (left.lineNumber ?? 0) - (right.lineNumber ?? 0)
      : left.location.localeCompare(right.location),
  );

  if (violations.length > 0) {
    for (const violation of violations) {
      const location =
        violation.lineNumber === undefined
          ? violation.location
          : `${violation.location}:${violation.lineNumber}`;
      log(`FAIL ${location}: ${violation.detail} — ${violation.reason}`);
    }
    log(
      `${violations.length} image-currency violation(s) across ${dockerEntries.length} docker ` +
        `entr(ies), ${runnerDirectories.length} runner version dir(s), ${catalogEntries.length} ` +
        `catalog entr(ies) and ${prereqImages.length} prereq image(s).`,
    );
    exit(1);
  }

  log(
    `Verified ${dockerEntries.length} docker entr(ies): ${registeredDirectories} runner version ` +
      `dir(s) registered, ${skippedDirectories} documented skip(s); ${catalogEntries.length} ` +
      `catalog entr(ies) covered; ${prereqPins} prereq image pin(s).`,
  );
}

main();
