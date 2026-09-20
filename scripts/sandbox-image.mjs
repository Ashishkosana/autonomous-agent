#!/usr/bin/env node
// Builds or removes the local sandbox image, and cleans up sandbox containers.
// Plain Node so the same command works from PowerShell, cmd, WSL and bash.
//
//   node scripts/sandbox-image.mjs build    # docker build → agent-sandbox-local:0.1.0
//   node scripts/sandbox-image.mjs clean    # remove every container labelled agent.sandbox=1
//   node scripts/sandbox-image.mjs remove   # clean, then remove the image
//
// The tag must match src/sandbox/local/sandbox-spec.ts and sandbox/local-linux/Dockerfile
// (asserted by tests/sandbox/local-linux-environment.test.ts).

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export const IMAGE = 'agent-sandbox-local:0.1.0';
const LABEL = 'agent.sandbox=1';
const CONTEXT = join(dirname(fileURLToPath(import.meta.url)), '..', 'sandbox', 'local-linux');

function docker(args, { capture = false } = {}) {
  const result = spawnSync('docker', args, {
    stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.error) {
    console.error(`docker could not be started: ${result.error.message}`);
    console.error('Is Docker Desktop / Docker Engine installed and running?');
    process.exit(2);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
  return result.stdout ?? '';
}

const command = process.argv[2];
switch (command) {
  case 'build':
    docker(['build', '--tag', IMAGE, CONTEXT]);
    console.log(`\nBuilt ${IMAGE}`);
    break;
  case 'clean': {
    const ids = docker(['ps', '--all', '--quiet', '--filter', `label=${LABEL}`], { capture: true })
      .split(/\s+/)
      .filter(Boolean);
    if (ids.length === 0) console.log('No sandbox containers to remove.');
    else {
      docker(['rm', '--force', ...ids]);
      console.log(`Removed ${ids.length} sandbox container(s).`);
    }
    break;
  }
  case 'remove': {
    const ids = docker(['ps', '--all', '--quiet', '--filter', `label=${LABEL}`], { capture: true })
      .split(/\s+/)
      .filter(Boolean);
    if (ids.length > 0) docker(['rm', '--force', ...ids]);
    docker(['image', 'rm', IMAGE]);
    console.log(`Removed ${IMAGE}`);
    break;
  }
  default:
    console.error('usage: node scripts/sandbox-image.mjs <build|clean|remove>');
    process.exit(64);
}
