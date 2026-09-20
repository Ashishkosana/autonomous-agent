#!/usr/bin/env node
// Runs the REAL local-Docker integration suite (tests/integration/local) in
// "require" mode: if Docker or the sandbox image is missing the run FAILS
// instead of skipping, so it can never pass vacuously.
//
//   node scripts/test-local.mjs            # full suite, prints a summary to paste back
//   node scripts/test-local.mjs e-003      # only files whose name contains "e-003"
//
// Evidence (raw JSON from every test, plus vitest's own report) is written
// OUTSIDE the repository to AGENT_SANDBOX_EVIDENCE_DIR or <os tmp>/agent-sandbox-evidence.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const evidenceDir =
  process.env.AGENT_SANDBOX_EVIDENCE_DIR ?? join(tmpdir(), 'agent-sandbox-evidence');
mkdirSync(evidenceDir, { recursive: true });
const reportFile = join(evidenceDir, 'vitest-local.json');

const filter = process.argv[2];
const vitest = join(root, 'node_modules', 'vitest', 'vitest.mjs');
const args = [
  vitest,
  'run',
  filter ? `tests/integration/local/${filter}` : 'tests/integration/local',
  '--reporter=default',
  '--reporter=json',
  `--outputFile=${reportFile}`,
];

const result = spawnSync(process.execPath, args, {
  cwd: root,
  stdio: 'inherit',
  env: {
    ...process.env,
    AGENT_REQUIRE_LOCAL_DOCKER: '1',
    AGENT_SANDBOX_EVIDENCE_DIR: evidenceDir,
  },
});

console.log('\n================ LOCAL DOCKER INTEGRATION SUMMARY ================');
if (existsSync(reportFile)) {
  const report = JSON.parse(readFileSync(reportFile, 'utf8'));
  for (const file of report.testResults ?? []) {
    const rel = file.name.replace(root, '').replace(/^[\\/]/, '');
    console.log(`\n${rel}`);
    for (const test of file.assertionResults ?? []) {
      const mark = test.status === 'passed' ? 'PASS' : test.status === 'failed' ? 'FAIL' : 'SKIP';
      console.log(`  ${mark}  ${test.title}  (${test.duration ?? 0} ms)`);
      for (const message of test.failureMessages ?? []) {
        console.log(`        ${String(message).split('\n')[0]}`);
      }
    }
  }
  console.log(
    `\nTotals: ${report.numPassedTests} passed, ${report.numFailedTests} failed, ${report.numPendingTests} skipped, ${report.numTotalTests} total`,
  );
} else {
  console.log('vitest did not produce a report — see output above.');
}
console.log(`Evidence directory: ${evidenceDir}`);
console.log(`Exit code: ${result.status ?? 1}`);
process.exit(result.status ?? 1);
