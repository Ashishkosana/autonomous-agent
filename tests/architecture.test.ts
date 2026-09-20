import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Architectural rules enforced as tests, so that they fail loudly the moment
 * a shortcut is taken rather than being discovered in review.
 */

const SRC_ROOT = join(import.meta.dirname, '..', 'src');
const TESTS_ROOT = join(import.meta.dirname);
const WORKER_ROOT = join(import.meta.dirname, '..', 'worker', 'src');

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...listTsFiles(full));
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

function importSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const pattern =
    /(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (const match of source.matchAll(pattern)) {
    const spec = match[1] ?? match[2];
    if (spec) specifiers.push(spec);
  }
  return specifiers;
}

const srcFiles = listTsFiles(SRC_ROOT);
const CORE_DIRS = [
  'agent',
  'domain',
  'events',
  'evaluation',
  'memory',
  'models',
  'tools',
  'storage',
];

describe('architecture rules', () => {
  it('src contains files to check', () => {
    expect(srcFiles.length).toBeGreaterThan(0);
  });

  it('core runtime modules never import Cloudflare or vendor SDKs', () => {
    const forbidden = [
      /^@cloudflare\//,
      /^cloudflare:/,
      /^wrangler/,
      /^@anthropic-ai\//,
      /^openai/,
    ];
    for (const file of srcFiles) {
      const rel = relative(SRC_ROOT, file);
      const top = rel.split(/[\\/]/)[0] ?? '';
      if (!CORE_DIRS.includes(top)) continue;
      for (const spec of importSpecifiers(readFileSync(file, 'utf8'))) {
        for (const rule of forbidden) {
          expect(spec, `${rel} imports forbidden module ${spec}`).not.toMatch(rule);
        }
      }
    }
  });

  it('the execution-environment contract has no provider-specific imports', () => {
    const contract = readFileSync(join(SRC_ROOT, 'sandbox', 'execution-environment.ts'), 'utf8');
    expect(importSpecifiers(contract)).toEqual([]);
    expect(contract.toLowerCase()).not.toContain('@cloudflare');
  });

  it('src never imports from tests (test adapters are not production code)', () => {
    for (const file of srcFiles) {
      for (const spec of importSpecifiers(readFileSync(file, 'utf8'))) {
        expect(spec, `${relative(SRC_ROOT, file)} imports ${spec}`).not.toMatch(/tests\//);
      }
    }
  });

  /**
   * Third-party runtime dependencies are forbidden in src by default. When an
   * adapter genuinely needs one (e.g. a browser-automation driver), it is added
   * HERE as `{ file, packages }` — narrow, explicit, reviewed — never by
   * relaxing the rule. Core dirs (CORE_DIRS) may never appear in this list.
   */
  const THIRD_PARTY_ALLOWLIST: readonly { file: string; packages: readonly string[] }[] = [];

  it('src has no runtime dependencies on third-party packages outside the explicit adapter allowlist', () => {
    for (const entry of THIRD_PARTY_ALLOWLIST) {
      const top = entry.file.split('/')[0] ?? '';
      expect(CORE_DIRS, `allowlist entry ${entry.file} is in a core directory`).not.toContain(top);
    }
    for (const file of srcFiles) {
      const rel = relative(SRC_ROOT, file).split(/[\\/]/).join('/');
      const allowed = THIRD_PARTY_ALLOWLIST.find((e) => e.file === rel)?.packages ?? [];
      for (const spec of importSpecifiers(readFileSync(file, 'utf8'))) {
        const isRelative = spec.startsWith('.');
        const isNodeBuiltin = spec.startsWith('node:');
        const isAllowlisted = allowed.some((pkg) => spec === pkg || spec.startsWith(`${pkg}/`));
        expect(
          isRelative || isNodeBuiltin || isAllowlisted,
          `${rel} imports third-party module ${spec}`,
        ).toBe(true);
      }
    }
  });

  it('src never reads process.env; configuration is resolved by composition roots and passed in', () => {
    for (const file of srcFiles) {
      expect(
        readFileSync(file, 'utf8'),
        `${relative(SRC_ROOT, file)} reads process.env`,
      ).not.toMatch(/process\.env/);
    }
  });

  it('network egress from src is confined to named adapters', () => {
    // Matches both a direct call and taking the global as a default implementation.
    const callers = srcFiles
      .filter((file) => /(?<!typeof )(?<![.\w])fetch\s*(\(|;|\))/.test(readFileSync(file, 'utf8')))
      .map((file) => relative(SRC_ROOT, file).split(/[\\/]/).join('/'))
      .sort();
    expect(callers).toEqual([
      'models/openai-compatible/provider.ts',
      'sandbox/cloudflare/http-sandbox-client.ts',
    ]);
  });

  it('the model layer keeps credentials out of what it exposes: no field named apiKey on providers', () => {
    // Providers receive the key through config and must not retain it as a plain property.
    const providerSource = readFileSync(
      join(SRC_ROOT, 'models', 'openai-compatible', 'provider.ts'),
      'utf8',
    );
    expect(providerSource).not.toMatch(/this\.apiKey/);
    expect(providerSource).not.toMatch(/private\s+(readonly\s+)?apiKey/);
  });

  it('the Cloudflare SDK is imported only by the gateway Worker, never by src or tests', () => {
    const sdkImporters = [...srcFiles, ...listTsFiles(TESTS_ROOT), ...listTsFiles(WORKER_ROOT)]
      .filter((file) =>
        importSpecifiers(readFileSync(file, 'utf8')).some((spec) =>
          spec.startsWith('@cloudflare/'),
        ),
      )
      .map((file) => relative(join(import.meta.dirname, '..'), file))
      .sort();
    expect(sdkImporters).toEqual(['worker/src/index.ts', 'worker/src/sdk-sandbox-client.ts']);
  });

  it('only the Docker CLI runtime spawns processes; the local adapter itself is engine-agnostic', () => {
    const spawners = srcFiles
      .filter((file) =>
        importSpecifiers(readFileSync(file, 'utf8')).some((spec) => spec === 'node:child_process'),
      )
      .map((file) => relative(SRC_ROOT, file).split(/[\\/]/).join('/'));
    expect(spawners).toEqual(['sandbox/local/docker-cli-runtime.ts']);
    const adapter = readFileSync(
      join(SRC_ROOT, 'sandbox', 'local', 'local-linux-environment.ts'),
      'utf8',
    );
    expect(adapter).not.toMatch(/docker/i);
  });

  it('tools touch the world only through ExecutionEnvironment: no node builtins in src/tools', () => {
    const toolFiles = srcFiles.filter((file) => relative(SRC_ROOT, file).startsWith('tools'));
    expect(toolFiles.length).toBeGreaterThan(5);
    for (const file of toolFiles) {
      const source = readFileSync(file, 'utf8');
      for (const spec of importSpecifiers(source)) {
        expect(spec, `${relative(SRC_ROOT, file)} imports ${spec}`).toMatch(/^\.\.?\//);
      }
      expect(source, `${relative(SRC_ROOT, file)} spawns or reads the host`).not.toMatch(
        /child_process|readFileSync|writeFileSync|process\.(cwd|chdir)|(?<!typeof )(?<![.\w])fetch\s*\(/,
      );
    }
  });

  it('the agent core never depends on a concrete execution environment', () => {
    for (const file of srcFiles) {
      const rel = relative(SRC_ROOT, file);
      const top = rel.split(/[\\/]/)[0] ?? '';
      if (!CORE_DIRS.includes(top)) continue;
      for (const spec of importSpecifiers(readFileSync(file, 'utf8'))) {
        expect(spec, `${rel} imports a concrete environment ${spec}`).not.toMatch(
          /sandbox\/(cloudflare|local)\//,
        );
      }
    }
  });

  it('the gateway Worker only reaches into src/sandbox/cloudflare, never the agent core', () => {
    for (const file of listTsFiles(WORKER_ROOT)) {
      for (const spec of importSpecifiers(readFileSync(file, 'utf8'))) {
        if (!spec.includes('/src/')) continue;
        expect(spec, `${relative(WORKER_ROOT, file)} imports ${spec}`).toMatch(
          /\/src\/sandbox\/cloudflare\//,
        );
      }
    }
  });
});
