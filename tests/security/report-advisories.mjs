#!/usr/bin/env node
// Renders the nightly dependency-advisory sweep (.github/workflows/advisories.yml, #338) into one
// tracking-issue body plus the status the workflow turns into an exit condition. It reads the four
// tool outputs the audit job writes: `npm audit --json` for the root lockfile (every workspace),
// `cargo audit --format json` for proxy/Cargo.lock, and two `pip-audit --format json` runs — the
// constrained CI install from #182 and requirements-docs.txt.
//
// Status is `incomplete` (exit 2) when any of the four checks is missing, empty, unparseable or
// carries a tool `error` object: a sweep that silently skipped a leg must never look green. Findings
// (exit 1) come only from actual advisories — npm entries at high/critical (the issue's threshold;
// moderate and below appear in the count line only), every cargo-audit vulnerability (RUSTSEC has no
// severity scale, so nothing is filtered) and every pip-audit vuln. cargo-audit's
// unmaintained/unsound warnings and pip-audit's `skip_reason`s are reported in their own sections
// and never affect the status.
//
// Deliberate limits: no network and no CVE-database lookups, no severity normalisation across the
// three tools (each tool's own scale is shown), and the findings table is capped at 100 rows because
// an issue body is capped at 65 535 characters — the workflow-run artifact holds the full output.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { URL } from 'node:url';
import { error, log } from 'node:console';
import { argv, env, exit } from 'node:process';

const ISSUE_TITLE = 'Nightly dependency advisories';
const MAX_ROWS = 100;

const CHECKS = [
  {
    id: 'npm',
    file: 'npm.json',
    label: 'npm audit (root lockfile = every workspace)',
    tool: 'npm audit',
  },
  { id: 'cargo', file: 'cargo.json', label: 'cargo audit (proxy/Cargo.lock)', tool: 'cargo audit' },
  {
    id: 'pip-runners',
    file: 'pip-runners.json',
    label: 'pip-audit (constrained runner install, runners/ci-constraints.txt)',
    tool: 'pip-audit',
  },
  {
    id: 'pip-docs',
    file: 'pip-docs.json',
    label: 'pip-audit (requirements-docs.txt)',
    tool: 'pip-audit',
  },
];

const usage = `Usage: node tests/security/report-advisories.mjs --input <dir> [--out <dir>] [--help]

Reads npm.json, cargo.json, pip-runners.json and pip-docs.json from <dir> (the shapes
.github/workflows/advisories.yml writes), writes issue-title.txt, issue-body.md and status.txt into
<out> (default: <dir>), prints a markdown summary and exits 0 (clean), 1 (findings) or 2 (a check
did not run).`;

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toCount(value) {
  return Number.isFinite(value) ? value : 0;
}

function count(amount, singular, plural = `${singular}s`) {
  return `${amount} ${amount === 1 ? singular : plural}`;
}

// Upstream data is never escaped into markdown. Every value a tool reports — ids, titles, package
// names, versions, severity strings, skip reasons, error messages — passes through the whitelist
// sanitiser for its field before it is stored on a row or a bullet, so a value that reaches the body
// cannot contain a markdown control character in the first place. Escaping was the previous design
// and it leaked one vector per round: GFM unescapes `\|` in a table row before inline parsing, so a
// raw `|` in a title split the row, and then a `\|` in a title double-escaped into an escaped
// backslash followed by a splitting pipe, which let the text after the pipe render as a live
// autolink. A whitelist cannot double-escape, because nothing is escaped at all.
const ID_CHARS = /[^A-Za-z0-9.-]/;
const NAME_CHARS = /[^A-Za-z0-9._@/+:-]/;
const VERSION_CHARS = /[^A-Za-z0-9.+~<>=-]/g;
const TEXT_MARKUP_CHARS = new Set('\\`|[]()<>*_~!#@');
const SEVERITIES = new Set(['low', 'moderate', 'medium', 'high', 'critical', 'unknown']);
const TEXT_LIMIT = 300;

// Advisory ids (GHSA-…, RUSTSEC-…, PYSEC-…, CVE-…): letters, digits, a dot and a hyphen only. An id
// carrying anything else is not repaired — a repaired id could read as a different, real advisory —
// it is dropped to `unknown`.
function sanitiseId(value) {
  const id = String(value ?? '').trim();
  return id === '' || ID_CHARS.test(id) ? 'unknown' : id;
}

// Package, dependency and crate names, including npm scopes (`@scope/name`): no character in this
// set can open markup. As with ids, a name carrying anything else is dropped to `unknown` rather
// than repaired. `@` is the npm scope sigil and stays — a scoped name can read as an @-mention, but
// it is not a link, carries no payload, and the report must show the real package name.
function sanitiseName(value) {
  const name = String(value ?? '').trim();
  return name === '' || NAME_CHARS.test(name) ? 'unknown' : name;
}

// Version and range values (`1.2.3`, `^1.2`, `>=2.0.0`, `<2.0.0`): comparison operators are the only
// reason `<`/`>` are allowed at all, so an HTML-tag-shaped run is removed first, then every
// remaining character outside the set becomes a separator — never dropped, so `3.0.0 | 3.1.0`
// cannot merge into one bogus version — and whitespace is collapsed.
function sanitiseVersion(value) {
  return String(value ?? '')
    .replace(/<\/?[A-Za-z][^<>]*>/g, ' ')
    .replace(VERSION_CHARS, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Severity is a closed set. npm reports it as free text, so anything outside the set — including a
// crafted `high | critical …` — becomes `unknown`. The Severity column's other two renderings are
// not upstream text: cargo's `CVSS <number>` is formatted from a `Number.isFinite` check, and
// pip-audit has no severity scale, shown as an em dash.
function sanitiseSeverity(value) {
  const severity = String(value ?? '')
    .trim()
    .toLowerCase();
  return SEVERITIES.has(severity) ? severity : 'unknown';
}

// Free text: advisory titles, the first line of a description, skip reasons, tool error messages.
// Markup-capable characters are removed outright, then the two GFM autolink-literal triggers are
// broken with a space (`https://x` → `https: //x`, `www.x` → `www .x`), because a bare URL is
// autolinked even in plain prose — and a trailing `www.` alone is enough for remark-gfm to emit
// a link — then whitespace is collapsed and the value truncated. What is left reads like the
// upstream sentence and cannot produce a link, an @-mention, emphasis, raw HTML or an entity. The
// cap keeps one crafted field from exhausting the 65 535-character issue body.
function sanitiseText(value) {
  const text = [...String(value ?? '').replace(/\r?\n|\t/g, ' ')]
    .filter((character) => !TEXT_MARKUP_CHARS.has(character))
    .join('')
    .replace(/(https?|ftp):\/\//gi, '$1: //')
    .replace(/www\./gi, 'www .')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > TEXT_LIMIT ? `${text.slice(0, TEXT_LIMIT).trimEnd()}…` : text;
}

// The one place a markdown table cell is assembled. Every value reaching it has been sanitised for
// its field, so no pipe, backslash or backtick can arrive: the cell only has to keep the row on one
// line. Nothing is escaped here, which is why there is no double-escape to get wrong.
function cell(value) {
  return String(value ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .trim();
}

// The `name version` pair the Package column shows: name and version go through their own whitelists
// and are joined, because the name whitelist has no space and the version whitelist is not a name.
function packageCell(name, version) {
  return [sanitiseName(name), sanitiseVersion(version)].filter(Boolean).join(' ');
}

// Only an absolute http(s) destination becomes a link: any other scheme (`javascript:`, `data:`) or
// an unparseable value is rejected, and the caller renders the id as plain text instead. `(`, `)`,
// `|` and `\` are percent-encoded so a crafted URL cannot leave the destination or split the table
// row. The label is the sanitised advisory id — `sanitiseId` guarantees it holds no markdown
// character — never raw upstream text.
function linkMarkdown(url, label) {
  let parsed;
  try {
    parsed = new URL(String(url ?? ''));
  } catch {
    return '';
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
  const href = parsed.href.replace(
    /[()|\\]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `[${label}](${href})`;
}

function list(value) {
  if (Array.isArray(value)) {
    return value.filter((entry) => typeof entry === 'string' && entry !== '');
  }
  return [];
}

function parseArguments(args) {
  let input;
  let out;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--help' || argument === '-h') {
      log(usage);
      exit(0);
    }
    if (argument === '--input' || argument === '--out') {
      const value = args[index + 1];
      if (value === undefined) {
        throw new Error(`${argument} requires a directory argument`);
      }
      if (argument === '--input') input = value;
      else out = value;
      index += 1;
      continue;
    }
    throw new Error(`unexpected argument: ${argument}`);
  }
  if (input === undefined) {
    throw new Error('--input is required');
  }
  return { input, out: out ?? input };
}

function readJson(directory, file) {
  const path = join(directory, file);
  // A problem message reaches a list bullet, and part of it can come from the tool's own output
  // (its `error` object, or a JSON parse error quoting the payload), so it is free text like any
  // other upstream value.
  const problem = (detail) => ({ problem: sanitiseText(detail) });
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (readError) {
    return problem(`missing file ${path}: ${readError.code ?? readError.message}`);
  }
  if (text.trim() === '') {
    return problem(`empty file ${path}`);
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch (parseError) {
    return problem(`unparseable file ${path}: ${parseError.message}`);
  }
  if (!isObject(data)) {
    return problem(`unexpected JSON shape at ${path}: expected an object`);
  }
  if (data.error !== undefined && data.error !== null) {
    const message = isObject(data.error)
      ? (data.error.summary ?? data.error.message ?? data.error.code ?? JSON.stringify(data.error))
      : String(data.error);
    return problem(`the tool reported an error: ${message}`);
  }
  return { data };
}

function npmAdvisories(vulnerabilities, entry) {
  // `via[]` holds either an advisory object or a dependency name; a name only means "vulnerable
  // through that dependency", so the advisory object lives on the named entry (walk one level).
  const advisories = [];
  const seen = new Set();
  const collect = (candidate) => {
    if (!isObject(candidate)) return;
    for (const via of Array.isArray(candidate.via) ? candidate.via : []) {
      if (!isObject(via)) continue;
      const key = `${via.url ?? ''}|${via.title ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      advisories.push(via);
    }
  };
  collect(entry);
  if (advisories.length === 0) {
    for (const via of Array.isArray(entry.via) ? entry.via : []) {
      if (typeof via === 'string') collect(vulnerabilities[via]);
    }
  }
  return advisories;
}

function npmAdvisoryId(advisory) {
  // GHSA ids are written lowercase in advisory URLs; keep the id as GitHub publishes it.
  const match = /(GHSA-[a-z0-9-]+)/i.exec(String(advisory.url ?? ''));
  return match ? match[1] : '';
}

function parseNpm(data) {
  if (!isObject(data.vulnerabilities) || !isObject(data.metadata)) {
    return { problem: 'unexpected JSON shape (missing `vulnerabilities` or `metadata`)' };
  }
  const counts = isObject(data.metadata.vulnerabilities) ? data.metadata.vulnerabilities : {};
  const dependencies = isObject(data.metadata.dependencies) ? data.metadata.dependencies : {};
  const rows = [];
  for (const [name, entry] of Object.entries(data.vulnerabilities)) {
    if (!isObject(entry)) continue;
    const severity = String(entry.severity ?? '').toLowerCase();
    if (severity !== 'high' && severity !== 'critical') continue;
    const fixed = isObject(entry.fixAvailable) ? entry.fixAvailable.version : '';
    const pkg = sanitiseName(name);
    const advisories = npmAdvisories(data.vulnerabilities, entry);
    if (advisories.length === 0) {
      rows.push({
        ecosystem: 'npm',
        tool: 'npm audit',
        package: pkg,
        advisoryId: 'unknown',
        advisoryTitle: 'see the audit report',
        severity: sanitiseSeverity(severity),
        fixed: sanitiseVersion(fixed),
        link: '',
      });
      continue;
    }
    for (const advisory of advisories) {
      const advisoryId = sanitiseId(npmAdvisoryId(advisory));
      rows.push({
        ecosystem: 'npm',
        tool: 'npm audit',
        package: pkg,
        advisoryId,
        advisoryTitle: sanitiseText(advisory.title),
        severity: sanitiseSeverity(advisory.severity ?? severity),
        fixed: sanitiseVersion(fixed),
        // Built from the sanitised id, never from `advisory.url`: that URL is upstream-controlled
        // and a valid `https://attacker.example/…` passes `linkMarkdown`'s scheme check, so taking
        // it would put a live link an attacker chose into a security issue. An advisory without a
        // GHSA id renders its id as plain text.
        link: advisoryId === 'unknown' ? '' : `https://github.com/advisories/${advisoryId}`,
      });
    }
  }
  return {
    rows,
    packages: Number.isFinite(dependencies.total) ? dependencies.total : undefined,
    summary: `${toCount(counts.high)} high, ${toCount(counts.critical)} critical (${toCount(
      counts.moderate,
    )} moderate, ${toCount(counts.low)} low, ${toCount(counts.info)} info; ${toCount(
      counts.total,
    )} vulnerable package(s))`,
  };
}

function parseCargo(data) {
  if (!isObject(data.vulnerabilities) || !Array.isArray(data.vulnerabilities.list)) {
    return { problem: 'unexpected JSON shape (missing `vulnerabilities.list`)' };
  }
  const rows = [];
  for (const entry of data.vulnerabilities.list) {
    if (!isObject(entry) || !isObject(entry.advisory)) continue;
    const advisory = entry.advisory;
    const pkg = isObject(entry.package) ? entry.package : {};
    const patched = list(entry.versions?.patched).map(sanitiseVersion).filter(Boolean);
    const advisoryId = sanitiseId(advisory.id);
    rows.push({
      ecosystem: 'cargo',
      tool: 'cargo audit',
      package: packageCell(pkg.name ?? advisory.package, pkg.version),
      advisoryId,
      advisoryTitle: sanitiseText(advisory.title),
      severity: Number.isFinite(advisory.cvss) ? `CVSS ${advisory.cvss}` : '—',
      fixed: patched.length > 0 ? patched.join(', ') : 'none',
      // Built from the sanitised id, so the destination cannot carry a crafted path segment.
      link: advisoryId === 'unknown' ? '' : `https://rustsec.org/advisories/${advisoryId}`,
    });
  }
  const warnings = [];
  for (const kind of ['unmaintained', 'unsound']) {
    for (const entry of Array.isArray(data.warnings?.[kind]) ? data.warnings[kind] : []) {
      if (!isObject(entry)) continue;
      const advisory = isObject(entry.advisory) ? entry.advisory : {};
      const pkg = isObject(entry.package) ? entry.package : {};
      const warningId =
        advisory.id === undefined || advisory.id === null ? '' : sanitiseId(advisory.id);
      warnings.push(
        `cargo ${kind}: ${[
          packageCell(pkg.name ?? advisory.package, pkg.version),
          warningId ? `(${warningId})` : '',
        ]
          .filter(Boolean)
          .join(' ')}`,
      );
    }
  }
  const dependencyCount = data.lockfile?.['dependency-count'];
  return {
    rows,
    packages: Number.isFinite(dependencyCount) ? dependencyCount : undefined,
    warnings,
    summary: `${count(rows.length, 'vulnerability', 'vulnerabilities')}${
      warnings.length > 0 ? `, ${count(warnings.length, 'warning')}` : ''
    }`,
  };
}

function parsePip(data) {
  if (!Array.isArray(data.dependencies)) {
    return { problem: 'unexpected JSON shape (missing `dependencies` array)' };
  }
  const rows = [];
  const skipped = [];
  for (const dependency of data.dependencies) {
    if (!isObject(dependency)) continue;
    const name = dependency.name ?? 'unknown';
    const version = dependency.version ?? '';
    const pkg = packageCell(name, version);
    if (typeof dependency.skip_reason === 'string' && dependency.skip_reason !== '') {
      skipped.push(`${pkg}: ${sanitiseText(dependency.skip_reason)}`);
    }
    for (const vuln of Array.isArray(dependency.vulns) ? dependency.vulns : []) {
      if (!isObject(vuln)) continue;
      const fixed = list(vuln.fix_versions).map(sanitiseVersion).filter(Boolean);
      // pip-audit descriptions are multi-line; the report keeps the first line only.
      const description = String(vuln.description ?? '').split('\n')[0];
      const advisoryId = sanitiseId(vuln.id);
      rows.push({
        ecosystem: 'pip',
        tool: 'pip-audit',
        package: pkg,
        advisoryId,
        advisoryTitle: sanitiseText(description),
        severity: '—',
        fixed: fixed.length > 0 ? fixed.join(', ') : 'none',
        // Built from the sanitised id, so the destination cannot carry a crafted path segment.
        link: advisoryId === 'unknown' ? '' : `https://osv.dev/vulnerability/${advisoryId}`,
      });
    }
  }
  return {
    rows,
    skipped,
    packages: data.dependencies.length,
    summary: `${count(rows.length, 'advisory', 'advisories')}${
      skipped.length > 0 ? `, ${skipped.length} not audited` : ''
    }`,
  };
}

function runUrl() {
  const server = env.GITHUB_SERVER_URL;
  const runId = env.GITHUB_RUN_ID;
  const repository = env.GITHUB_REPOSITORY;
  if (!server || !runId || !repository) return undefined;
  return `${server}/${repository}/actions/runs/${runId}`;
}

function provenanceLine(timestamp) {
  const sha = env.GITHUB_SHA;
  const url = runUrl();
  const parts = [`**Generated:** ${timestamp}`];
  parts.push(sha ? `**Commit:** \`${sha}\`` : '**Commit:** unknown (local run)');
  parts.push(url ? `**Run:** [workflow run](${url})` : '**Run:** local run');
  return parts.join(' · ');
}

function packageCount(check) {
  return check.packages === undefined ? 'package count not reported' : `${check.packages} packages`;
}

function renderSummary(checks, status) {
  const lines = [`## Dependency advisories — ${status}`, ''];
  for (const check of checks) {
    lines.push(
      `- **${check.label}:** ${
        check.problem === undefined ? check.summary : `did not run — ${check.problem}`
      }`,
    );
  }
  return lines.join('\n');
}

function renderBody(checks, rows, status, timestamp) {
  const banner = '<!-- maintained by .github/workflows/advisories.yml -->';
  if (status === 'clean') {
    const audited = checks.map((check) => `\`${check.label}\` (${packageCount(check)})`).join(', ');
    return `${banner}\n\nNo dependency advisories above the threshold as of ${timestamp} (commit ${
      env.GITHUB_SHA ? `\`${env.GITHUB_SHA}\`` : 'unknown'
    }${runUrl() ? `, [workflow run](${runUrl()})` : ', local run'}). Four checks ran and reported nothing above the threshold: ${audited}.\n`;
  }

  const lines = [banner, '', '# Dependency advisories', '', provenanceLine(timestamp), ''];
  lines.push('## Checks', '');
  for (const check of checks) {
    lines.push(
      `- **${check.label}** — ${
        check.problem === undefined
          ? `${check.summary} (${packageCount(check)})`
          : `did not run: ${check.problem}`
      }`,
    );
  }
  lines.push(
    '',
    'Only npm advisories at high/critical are listed as findings; moderate and below appear in the count above.',
    '',
  );
  const incomplete = checks.filter((check) => check.problem !== undefined);
  if (incomplete.length > 0) {
    lines.push(
      '## Checks that did not run',
      '',
      'The sweep is incomplete — these legs have no trustworthy result, so the run is red:',
      '',
    );
    for (const check of incomplete) {
      lines.push(`- **${check.label}:** ${check.problem}`);
    }
    lines.push('');
  } else {
    lines.push('## Checks that did not run', '', 'None — all four checks ran.', '');
  }

  lines.push('## Findings', '');
  if (rows.length === 0) {
    lines.push('None reported by the checks that ran.', '');
  } else {
    lines.push('| Ecosystem | Tool | Package | Advisory | Severity | Fixed in | Link |');
    lines.push('| --- | --- | --- | --- | --- | --- | --- |');
    for (const row of rows.slice(0, MAX_ROWS)) {
      // The id is the last fallback: a rejected destination still tells the reader which advisory
      // the row is about, and it is plain text by construction (`sanitiseId`).
      const link = linkMarkdown(row.link, row.advisoryId) || row.advisoryId;
      const advisory = [row.advisoryId, row.advisoryTitle].filter(Boolean).join(' ');
      lines.push(
        `| ${cell(row.ecosystem)} | ${cell(row.tool)} | ${cell(row.package)} | ${cell(
          advisory,
        )} | ${cell(row.severity)} | ${cell(row.fixed)} | ${link} |`,
      );
    }
    if (rows.length > MAX_ROWS) {
      lines.push('', `… ${rows.length - MAX_ROWS} more — see the workflow run artifact.`);
    }
    lines.push('');
  }

  const skipped = checks.flatMap((check) => check.skipped ?? []);
  lines.push('## Not audited', '');
  if (skipped.length === 0) {
    lines.push('None.');
  } else {
    for (const entry of skipped) lines.push(`- ${entry}`);
  }
  lines.push('');

  const warnings = checks.flatMap((check) => check.warnings ?? []);
  lines.push('## Other warnings', '');
  if (warnings.length === 0) {
    lines.push('None.');
  } else {
    lines.push('These do not block and do not affect the status, but they are maintenance debt:');
    lines.push('');
    for (const entry of warnings) lines.push(`- ${entry}`);
  }
  lines.push('');

  lines.push(
    '## How to fix',
    '',
    '- **npm:** `npm audit fix` (or `npm audit fix --force` for a semver-major bump), then re-run `make lint typecheck test`.',
    '- **cargo:** `cargo update -p <crate>` in `proxy/`, then `cargo test`; a transitive-only fix may need the dependent crate bumped.',
    '- **pip:** bump the pin in `runners/ci-constraints.txt` (or the shim `[test]` extra) and regenerate with `make python-constraints`. The shim runtime trees stay unpinned by design — a runtime fix is a base-image bump, not a constraints edit.',
    '',
    '## Re-run locally',
    '',
    'The four checks, their inputs and a fixture rehearsal are documented in the',
    '[*Security and supply-chain checks*](https://github.com/' +
      (env.GITHUB_REPOSITORY ?? 'rh-aiservices-bu/school-of-sardeenz') +
      '/blob/dev/docs/development/setup.md#security-and-supply-chain-checks) section of',
    '`docs/development/setup.md`:',
    '`node tests/security/report-advisories.mjs --input <dir>` renders a body from saved tool output.',
    '',
  );
  return `${lines.join('\n')}\n`;
}

function main() {
  let options;
  try {
    options = parseArguments(argv.slice(2));
  } catch (parseError) {
    error(parseError.message);
    error(usage);
    exit(2);
  }

  const checks = CHECKS.map((check) => {
    const result = readJson(options.input, check.file);
    if (result.problem !== undefined) {
      return { ...check, problem: result.problem };
    }
    const parsed =
      check.id === 'npm'
        ? parseNpm(result.data)
        : check.id === 'cargo'
          ? parseCargo(result.data)
          : parsePip(result.data);
    return { ...check, ...parsed };
  });

  const rows = checks.flatMap((check) => check.rows ?? []);
  const incomplete = checks.filter((check) => check.problem !== undefined);
  const status = incomplete.length > 0 ? 'incomplete' : rows.length > 0 ? 'findings' : 'clean';
  const exitCode = status === 'incomplete' ? 2 : status === 'findings' ? 1 : 0;
  const timestamp = new Date().toISOString();

  mkdirSync(options.out, { recursive: true });
  writeFileSync(join(options.out, 'issue-title.txt'), `${ISSUE_TITLE}\n`);
  writeFileSync(join(options.out, 'status.txt'), `${status}\n`);
  writeFileSync(join(options.out, 'issue-body.md'), renderBody(checks, rows, status, timestamp));

  log(renderSummary(checks, status));
  if (status !== 'clean') {
    log(`\nIssue body written to ${join(options.out, 'issue-body.md')}.`);
  }
  exit(exitCode);
}

main();
