#!/usr/bin/env node
// Runs the REAL-MODEL verification suite (tests/integration/model) in
// "require" mode: if no model endpoint is configured the run FAILS instead
// of skipping, so it can never pass vacuously.
//
//   AGENT_MODEL_PROVIDER=openai-compatible \
//   AGENT_MODEL_BASE_URL=https://<endpoint>/v1 \
//   AGENT_MODEL_NAME=<model> \
//   AGENT_MODEL_API_KEY=<key, if the endpoint needs one> \
//   node scripts/test-model.mjs
//
// The embedding suite (E-008) in the same directory is gated separately on
// AGENT_EMBEDDING_PROVIDER / AGENT_EMBEDDING_BASE_URL / AGENT_EMBEDDING_MODEL and
// skips when unset; set AGENT_REQUIRE_REAL_EMBEDDING=1 to make it mandatory.
//
// Evidence is written OUTSIDE the repository to AGENT_SANDBOX_EVIDENCE_DIR or
// <os tmp>/agent-sandbox-evidence. It contains a safe configuration summary
// (whether a key is configured) and never the key itself.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const evidenceDir =
  process.env.AGENT_SANDBOX_EVIDENCE_DIR ?? join(tmpdir(), 'agent-sandbox-evidence');
mkdirSync(evidenceDir, { recursive: true });
const reportFile = join(evidenceDir, 'vitest-model.json');

const vitest = join(root, 'node_modules', 'vitest', 'vitest.mjs');
const args = [
  vitest,
  'run',
  'tests/integration/model',
  '--reporter=default',
  '--reporter=json',
  `--outputFile=${reportFile}`,
];

const result = spawnSync(process.execPath, args, {
  cwd: root,
  stdio: 'inherit',
  env: {
    ...process.env,
    AGENT_REQUIRE_REAL_MODEL: '1',
    AGENT_SANDBOX_EVIDENCE_DIR: evidenceDir,
  },
});

console.log('\n================ REAL MODEL VERIFICATION SUMMARY ================');
console.log(
  `Endpoint: ${process.env.AGENT_MODEL_BASE_URL ?? '(unset)'}  Model: ${process.env.AGENT_MODEL_NAME ?? '(unset)'}  Key configured: ${process.env.AGENT_MODEL_API_KEY ? 'yes' : 'no'}`,
);
console.log(
  `Embeddings: ${process.env.AGENT_EMBEDDING_BASE_URL ?? '(unset)'}  Model: ${process.env.AGENT_EMBEDDING_MODEL ?? '(unset)'}  Key configured: ${process.env.AGENT_EMBEDDING_API_KEY ? 'yes' : 'no'}`,
);
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
