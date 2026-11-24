#!/usr/bin/env node
// Fails when a container build file this repository builds pulls a base image that is not
// pinned by digest. Build inputs are pinned as `name:tag@sha256:<64 hex>`; stage aliases,
// ARG-substituted references and `scratch` are not pinnable and are exempt. Freshness is
// Dependabot's job (.github/dependabot.yml docker entries) — this check is purely syntactic.
//
// Deliberate limits: no digest freshness check, no existence/network check, no parsing of
// `COPY --from=` (that is an image stage, not a pull), no .dockerignore awareness.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { error, log } from 'node:console';
import { argv, exit } from 'node:process';

const repositoryRoot = resolve(import.meta.dirname, '../..');
const containerFilePattern = /^(Dockerfile|Containerfile)(\..+)?$/i;
const skipDirectories = new Set([
  '.git',
  '.omp',
  'node_modules',
  'site',
  'dist',
  'coverage',
  'logs',
]);
const digestPattern = /^sha256:[0-9a-f]{64}$/;
// A well-formed FROM: optional flags, the image, an optional `AS <alias>` and an optional
// trailing comment. Any other FROM-shaped line is a violation, never a silent skip.
const fromPattern = /^FROM\s+(?:--\S+\s+)*(\S+)(?:\s+AS\s+(\S+))?\s*(?:#.*)?$/i;
const fromDirectivePattern = /^FROM\b/i;

const usage = `Usage: node tests/container-images/verify-image-pins.mjs [--root <dir>]

Fails when a Dockerfile/Containerfile FROM pulls an image that is not pinned as
name:tag@sha256:<64 hex>. Stage aliases, ARG-substituted references and \`scratch\` are exempt.`;

function parseArguments(argv) {
  let root = repositoryRoot;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') {
      log(usage);
      exit(0);
    }
    if (argument === '--root') {
      const value = argv[index + 1];
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

function collectContainerFiles(directory, found = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const fullPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!skipDirectories.has(entry.name)) {
        collectContainerFiles(fullPath, found);
      }
      continue;
    }
    if (entry.isFile() && containerFilePattern.test(entry.name)) {
      found.push(fullPath);
    }
  }
  return found;
}

// Joins backslash continuations so a FROM split over several physical lines is parsed as one
// directive; the reported line number is the first physical line of the logical line.
function logicalLines(source) {
  const physicalLines = source.split('\n');
  const lines = [];
  for (let index = 0; index < physicalLines.length; index += 1) {
    const lineNumber = index + 1;
    let text = physicalLines[index].trimEnd();
    while (text.endsWith('\\') && index + 1 < physicalLines.length) {
      text = `${text.slice(0, -1)}${physicalLines[index + 1].trimStart()}`.trimEnd();
      index += 1;
    }
    lines.push({ lineNumber, text });
  }
  return lines;
}

function classifyImage(image, aliases) {
  if (image.includes('$') || image.toLowerCase() === 'scratch') {
    return { kind: 'exempt' };
  }
  if (aliases.has(image.toLowerCase())) {
    return { kind: 'exempt' };
  }

  const digestIndex = image.lastIndexOf('@');
  if (digestIndex === -1) {
    return { kind: 'violation', reason: 'missing @sha256:<64 hex> digest' };
  }
  const reference = image.slice(0, digestIndex);
  const digest = image.slice(digestIndex + 1);
  if (!digestPattern.test(digest)) {
    return { kind: 'violation', reason: 'malformed digest (expected 64 lowercase hex characters)' };
  }
  const lastSegment = reference.split('/').at(-1) ?? '';
  if (!lastSegment.includes(':')) {
    return {
      kind: 'violation',
      reason: 'digest is not a human tag@digest reference (expected name:tag@sha256:…)',
    };
  }
  return { kind: 'pinned' };
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

  let rootIsDirectory = false;
  try {
    rootIsDirectory = statSync(root).isDirectory();
  } catch {
    rootIsDirectory = false;
  }
  if (!rootIsDirectory) {
    error(`--root must be an existing directory: ${root}`);
    exit(2);
  }

  const containerFiles = collectContainerFiles(root).sort();
  if (containerFiles.length === 0) {
    error(`No Dockerfile/Containerfile found under ${root}.`);
    exit(2);
  }

  const violations = [];
  let pinned = 0;
  let exempt = 0;
  let filesWithFrom = 0;

  for (const file of containerFiles) {
    const aliases = new Set();
    let sawFrom = false;
    for (const { lineNumber, text } of logicalLines(readFileSync(file, 'utf8'))) {
      const directive = text.trim();
      if (directive.startsWith('#')) {
        continue;
      }
      const match = fromPattern.exec(directive);
      if (match === null) {
        if (!fromDirectivePattern.test(directive)) {
          continue;
        }
        sawFrom = true;
        violations.push({
          file: relative(root, file),
          lineNumber,
          directive,
          reason:
            'unparseable FROM directive (expected "FROM <image> [AS <alias>]", optional trailing comment)',
        });
        continue;
      }
      sawFrom = true;
      const image = match[1];
      const alias = match[2];
      if (alias !== undefined) {
        aliases.add(alias.toLowerCase());
      }
      const classification = classifyImage(image, aliases);
      if (classification.kind === 'pinned') {
        pinned += 1;
      } else if (classification.kind === 'exempt') {
        exempt += 1;
      } else {
        violations.push({
          file: relative(root, file),
          lineNumber,
          directive,
          reason: classification.reason,
        });
      }
    }
    if (sawFrom) {
      filesWithFrom += 1;
    }
  }

  if (filesWithFrom === 0) {
    error(`No FROM directive parsed across ${containerFiles.length} container file(s).`);
    exit(2);
  }

  violations.sort((left, right) =>
    left.file === right.file
      ? left.lineNumber - right.lineNumber
      : left.file.localeCompare(right.file),
  );

  if (violations.length > 0) {
    for (const violation of violations) {
      log(
        `FAIL ${violation.file}:${violation.lineNumber}: ${violation.directive} — ${violation.reason}`,
      );
    }
    log(`${violations.length} unpinned FROM line(s) across ${filesWithFrom} container file(s).`);
    exit(1);
  }

  log(
    `Verified ${pinned} pinned FROM line(s) across ${filesWithFrom} container file(s); ` +
      `${exempt} alias/ARG/scratch FROM line(s) exempt.`,
  );
}

main();
