#!/usr/bin/env node
// Fails when the control-plane integration suite did not actually execute any test.
//
// The suite cannot demand its services: every file guards itself with
// `describe.skipIf(!(await canConnect()))` and `vitest.integration.config.ts` sets
// `passWithNoTests: true`, so vitest exits 0 in two silent-skip shapes — services
// unreachable (every test pending) and an `include` glob matching no file. CI parses the
// JSON report the run wrote and requires executed tests and zero skipped ones.
//
// Usage: node control-plane/scripts/verify-integration-report.mjs <vitest-json-report>

import { error, log } from 'node:console';
import { readFileSync } from 'node:fs';
import { argv, exit } from 'node:process';

const reportPath = argv[2];
if (!reportPath) {
  error('usage: verify-integration-report.mjs <vitest-json-report>');
  exit(2);
}

let report;
try {
  report = JSON.parse(readFileSync(reportPath, 'utf8'));
} catch (err) {
  error(`No readable vitest JSON report at ${reportPath}: ${err.message}`);
  exit(1);
}

if (typeof report !== 'object' || report === null || Array.isArray(report)) {
  error(
    `No readable vitest JSON report at ${reportPath}: expected a JSON object, got ${JSON.stringify(report)}`,
  );
  exit(1);
}

const total = report.numTotalTests ?? 0;
const passed = report.numPassedTests ?? 0;
const pending = report.numPendingTests ?? 0;
const failed = report.numFailedTests ?? 0;
log(`integration report: total=${total} passed=${passed} pending=${pending} failed=${failed}`);

if (total === 0) {
  error('No integration tests were collected — the vitest `include` glob matched nothing.');
  exit(1);
}
if (pending > 0) {
  error(
    `${pending} of ${total} tests were skipped — canConnect() did not reach Postgres/Redis, so the run proved nothing.`,
  );
  exit(1);
}
if (passed === 0 || failed > 0) {
  error(`Integration suite did not pass: ${passed} passed, ${failed} failed.`);
  exit(1);
}
log('Integration suite executed and passed every test.');
