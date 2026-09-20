import { afterAll, expect, it } from 'vitest';
import { spawnCollect } from '../../../src/sandbox/local/docker-cli-runtime.js';
import type { LocalLinuxEnvironment } from '../../../src/sandbox/local/local-linux-environment.js';
import { LOCAL_SANDBOX_IMAGE } from '../../../src/sandbox/local/sandbox-spec.js';
import {
  configureIntegrationTimeouts,
  describeLocalDocker,
  recordEvidence,
  runtime,
  startSandbox,
} from './gate.js';

/**
 * REAL LOCAL LINUX EXECUTION (Docker-gated). Lifecycle experiment:
 *
 *   start → use → stop → destroy → start again
 *
 * proving that sandbox-local state is disposable, that two sandboxes are
 * isolated from each other, and that the container really carries the
 * reviewed resource limits and security options (read back from the engine).
 */
configureIntegrationTimeouts();

describeLocalDocker('LocalLinuxEnvironment · lifecycle', () => {
  const opened: LocalLinuxEnvironment[] = [];
  const evidence: Record<string, unknown> = {};
  const open = async (prefix: string) => {
    const env = await startSandbox(prefix);
    opened.push(env);
    return env;
  };

  afterAll(async () => {
    recordEvidence('lifecycle', evidence);
    await Promise.all(opened.map((e) => e.destroy().catch(() => undefined)));
  });

  it('start → use → stop → destroy: state is observable at every step', async () => {
    const env = await open('agent-p3b-life');
    const ready = await env.getState();
    expect(ready.status).toBe('ready');
    expect(ready.metadata['containerStatus']).toBe('running');

    await env.writeFile('/workspace/life.txt', 'alive');
    const handle = await env.startProcess('sleep 600');

    await env.stop();
    const stopped = await env.getState();
    expect(stopped.status).toBe('stopped');
    expect(stopped.metadata['containerStatus']).toBe('exited');
    expect(stopped.processes.find((p) => p.processId === handle.processId)?.status).toBe('killed');
    await expect(env.readFile('/workspace/life.txt')).rejects.toMatchObject({
      code: 'unavailable',
    });
    // The container still exists (inspectable, e.g. for post-mortem) until destroy.
    expect(await runtime.inspectContainer(env.containerName)).toBe('exited');

    await env.destroy();
    expect(await runtime.inspectContainer(env.containerName)).toBeUndefined();
    const gone = await env.getState();
    expect(gone.status).toBe('stopped');
    expect(gone.metadata['phase']).toBe('destroyed');
    evidence['lifecycle'] = {
      ready: ready.metadata,
      stopped: stopped.metadata,
      gone: gone.metadata,
    };
  });

  it('destroy removes sandbox-local files; a new sandbox is a fresh Linux', async () => {
    const first = await open('agent-p3b-fresh');
    await first.writeFile('/workspace/memory.txt', 'I will not survive destroy');
    await first.runCommand(
      'mkdir -p ~/.cache && echo token > ~/.cache/state && git config --global user.name agent',
    );
    const firstHost = (await first.runCommand('hostname')).stdout.trim();
    await first.destroy();

    const second = await open('agent-p3b-fresh');
    expect(await second.fileExists('/workspace/memory.txt')).toBe(false);
    expect((await second.runCommand('test -e ~/.cache/state; echo $?')).stdout.trim()).toBe('1');
    expect(
      (await second.runCommand('git config --global user.name; echo "rc=$?"')).stdout,
    ).toContain('rc=1');
    expect((await second.runCommand('ls -A /workspace')).stdout.trim()).toBe('');
    const secondHost = (await second.runCommand('hostname')).stdout.trim();
    expect(secondHost).not.toBe(firstHost);
    evidence['freshness'] = { firstHost, secondHost };
  });

  it('two sandboxes are isolated from each other: files, processes, hostnames', async () => {
    const x = await open('agent-p3b-iso-x');
    const y = await open('agent-p3b-iso-y');
    await x.writeFile('/workspace/secret-of-x.txt', 'only x can see this');
    await x.startProcess('sleep 600 # xmarker');
    expect(await y.fileExists('/workspace/secret-of-x.txt')).toBe(false);
    expect((await y.runCommand('pgrep -f "[x]marker" | wc -l')).stdout.trim()).toBe('0');
    expect((await y.getState()).processes).toEqual([]);
    const hostX = (await x.runCommand('hostname')).stdout.trim();
    const hostY = (await y.runCommand('hostname')).stdout.trim();
    expect(hostX).not.toBe(hostY);
    evidence['isolation'] = { hostX, hostY };
  });

  it('the engine confirms the reviewed limits and security options on the running container', async () => {
    const env = await open('agent-p3b-inspect');
    const inspect = await spawnCollect('docker', ['inspect', env.containerName], {
      timeoutMs: 30_000,
    });
    expect(inspect.exitCode).toBe(0);
    const [info] = JSON.parse(inspect.stdout) as Array<{
      Config: {
        Image: string;
        User: string;
        WorkingDir: string;
        Env: string[];
        Labels: Record<string, string>;
      };
      HostConfig: {
        NanoCpus: number;
        Memory: number;
        MemorySwap: number;
        PidsLimit: number;
        CapDrop: string[] | null;
        CapAdd: string[] | null;
        SecurityOpt: string[] | null;
        Privileged: boolean;
        NetworkMode: string;
        Binds: string[] | null;
        Mounts: unknown[] | null;
        PortBindings: Record<string, unknown> | null;
        Init: boolean | null;
      };
      Mounts: unknown[];
    }>;
    expect(info).toBeDefined();
    const h = info!.HostConfig;
    expect(info!.Config.Image).toBe(LOCAL_SANDBOX_IMAGE);
    expect(info!.Config.User).toBe('agent');
    expect(info!.Config.WorkingDir).toBe('/workspace');
    expect(info!.Config.Labels).toMatchObject({ 'agent.sandbox': '1' });
    expect(h.NanoCpus).toBe(2_000_000_000);
    expect(h.Memory).toBe(2 * 1024 ** 3);
    expect(h.MemorySwap).toBe(2 * 1024 ** 3);
    expect(h.PidsLimit).toBe(256);
    expect(h.CapDrop).toEqual(['ALL']);
    expect(h.CapAdd ?? []).toEqual([]);
    expect(h.SecurityOpt).toEqual(['no-new-privileges:true']);
    expect(h.Privileged).toBe(false);
    expect(h.NetworkMode).toBe('bridge');
    expect(h.Binds ?? []).toEqual([]);
    expect(info!.Mounts).toEqual([]);
    expect(Object.keys(h.PortBindings ?? {})).toEqual([]);
    expect(h.Init).toBe(true);
    // Only our fixed variables reach the container; none of the host's.
    const envNames = info!.Config.Env.map((e) => e.split('=')[0]);
    expect(envNames).toEqual(expect.arrayContaining(['AGENT_SANDBOX', 'LANG', 'PYTHONUNBUFFERED']));
    for (const forbidden of [
      'USERPROFILE',
      'APPDATA',
      'CLOUDFLARE_API_TOKEN',
      'GITHUB_TOKEN',
      'SSH_AUTH_SOCK',
    ])
      expect(envNames).not.toContain(forbidden);
    evidence['inspect'] = {
      image: info!.Config.Image,
      user: info!.Config.User,
      hostConfig: {
        NanoCpus: h.NanoCpus,
        Memory: h.Memory,
        MemorySwap: h.MemorySwap,
        PidsLimit: h.PidsLimit,
        CapDrop: h.CapDrop,
        SecurityOpt: h.SecurityOpt,
        Privileged: h.Privileged,
        NetworkMode: h.NetworkMode,
        Binds: h.Binds,
        Init: h.Init,
      },
      mounts: info!.Mounts,
      envNames,
    };
  });
});
