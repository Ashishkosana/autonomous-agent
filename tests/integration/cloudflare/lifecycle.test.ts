import { afterAll, expect, it } from 'vitest';
import {
  configureIntegrationTimeouts,
  describeCloudflare,
  realSandbox,
  recordEvidence,
  uniqueSandboxId,
  type RealSandbox,
} from './gate.js';

/**
 * REAL CLOUDFLARE EXECUTION (credential-gated). Lifecycle experiment: what
 * sandbox-local state survives, and what does not. This is the evidence for
 * the architecture rule "sandbox-local state is not agent memory".
 *
 * The idle-stop observation needs to wait longer than the gateway's
 * AGENT_SANDBOX_SLEEP_AFTER ("5m" by default). It only runs when
 * AGENT_SANDBOX_IDLE_WAIT_MS is set, e.g. 360000.
 */
configureIntegrationTimeouts();

const IDLE_WAIT_MS = Number(process.env['AGENT_SANDBOX_IDLE_WAIT_MS'] ?? '0');

describeCloudflare('Cloudflare Sandbox · lifecycle', () => {
  const created: RealSandbox[] = [];
  const evidence: Record<string, unknown> = {};
  const open = (prefix: string): RealSandbox => {
    const sandbox = realSandbox(uniqueSandboxId(prefix));
    created.push(sandbox);
    return sandbox;
  };

  afterAll(async () => {
    recordEvidence('lifecycle', evidence);
    await Promise.all(created.map((s) => s.environment.destroy().catch(() => undefined)));
  });

  it('creation is lazy: the same sandbox id is reused by independent clients while the container is active', async () => {
    const a = open('agent-p3-life');
    const b = realSandbox(a.sandboxId);
    await a.environment.writeFile('/workspace/shared.txt', 'written by client A');
    expect(await b.environment.readFile('/workspace/shared.txt')).toBe('written by client A');
    const [stateA, stateB] = await Promise.all([
      a.environment.getState(),
      b.environment.getState(),
    ]);
    expect(stateA.metadata['placementId']).toEqual(stateB.metadata['placementId']);
    evidence['reuse'] = { sandboxId: a.sandboxId, placementId: stateA.metadata['placementId'] };
  });

  it('different sandbox ids are different containers: files do not leak between them', async () => {
    const x = open('agent-p3-iso-x');
    const y = open('agent-p3-iso-y');
    await x.environment.writeFile('/workspace/secret-of-x.txt', 'only x can see this');
    expect(await y.environment.fileExists('/workspace/secret-of-x.txt')).toBe(false);
    const hostX = (await x.environment.runCommand('hostname')).stdout.trim();
    const hostY = (await y.environment.runCommand('hostname')).stdout.trim();
    evidence['isolation'] = { hostX, hostY, distinctHostnames: hostX !== hostY };
  });

  it('destroy() ends the container: files and processes are gone, the id is reusable, state starts clean', async () => {
    const s = open('agent-p3-destroy');
    await s.environment.writeFile('/workspace/ephemeral.txt', 'will not survive');
    const proc = await s.environment.startProcess('sleep 900');
    expect(
      (await s.environment.getState()).processes.some((p) => p.processId === proc.processId),
    ).toBe(true);

    await s.environment.destroy();
    expect((await s.environment.getState()).status).toBe('stopped');

    // A new client for the same id talks to a fresh container.
    const again = realSandbox(s.sandboxId);
    const started = Date.now();
    expect(await again.environment.fileExists('/workspace/ephemeral.txt')).toBe(false);
    const live = await again.environment.getState();
    expect(live.processes.find((p) => p.processId === proc.processId)).toBeUndefined();
    evidence['destroy'] = {
      restartMs: Date.now() - started,
      processesAfter: live.processes.length,
    };
    await again.environment.destroy().catch(() => undefined);
  });

  it.skipIf(IDLE_WAIT_MS <= 0)(
    'after the idle period the container stops and sandbox-local files are lost',
    async () => {
      const s = open('agent-p3-idle');
      await s.environment.writeFile('/workspace/idle.txt', 'before idle');
      const before = await s.environment.getState();
      await new Promise((r) => setTimeout(r, IDLE_WAIT_MS));
      const survived = await s.environment.fileExists('/workspace/idle.txt');
      const after = await s.environment.getState();
      evidence['idle'] = {
        waitedMs: IDLE_WAIT_MS,
        fileSurvived: survived,
        placementBefore: before.metadata['placementId'],
        placementAfter: after.metadata['placementId'],
      };
      expect(survived).toBe(false);
    },
    IDLE_WAIT_MS + 240_000,
  );
});
