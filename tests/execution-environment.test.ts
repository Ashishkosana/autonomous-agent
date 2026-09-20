import { describeExecutionEnvironmentContract } from './support/execution-environment-contract.js';
import { FakeExecutionEnvironment } from './support/fake-execution-environment.js';

/**
 * The shared contract suite proven against the in-memory fake, so the
 * contract itself is exercised even with no infrastructure at all.
 * The Cloudflare adapter runs the same suite in `tests/sandbox/` (fake client)
 * and `tests/integration/cloudflare/` (real sandbox, credential-gated).
 */
describeExecutionEnvironmentContract('fake', async () => new FakeExecutionEnvironment());
