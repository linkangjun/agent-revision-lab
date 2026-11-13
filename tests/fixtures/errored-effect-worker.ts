import { Store } from '../../src/store.js';
import { Engine } from '../../src/engine.js';
import { httpEffects } from '../../src/effects.js';
import { attachRuntime, createRuntimeClient, launchRuntime, shutdownRuntime } from '../../src/durable.js';

const databaseUrl = process.env.DATABASE_URL;
const token = process.env.ARL_INTERNAL_TOKEN;
const apiUrl = process.env.ARL_API_URL;
if (!databaseUrl || !token || !apiUrl || process.env.NODE_ENV !== 'test' || !process.send) {
  throw new Error('The errored-effect fixture requires its isolated test environment and IPC');
}
const runtime = await createRuntimeClient(databaseUrl, { migrate: false });
const store = new Store(databaseUrl, runtime);
await store.init();
const engine = new Engine(store, {
  effects: httpEffects(apiUrl, token),
  // The real publisher has committed. Withhold the receipt from the ledger.
  afterEffect: async () => { throw new Error('Synthetic receipt persistence failure'); },
});
const failedRuns = new Set<string>();
attachRuntime(async (runId, executionId) => {
  const outcome = await engine.tick(runId, executionId);
  if (!failedRuns.has(runId) && (await store.operations(runId)).some(op => op.state === 'IN_FLIGHT')) {
    failedRuns.add(runId);
    // Throw outside Engine's receipt handler so DBOS records an actual ERROR.
    // This is permanent: transient retry must not hide the stopped execution.
    throw new Error('Synthetic permanent execution failure after the HTTP effect');
  }
  return outcome;
}, {
  settle: (runId, executionId, outcome) => store.settleActivation(runId, executionId, outcome),
  expire: runId => store.expireRun(runId),
});
await launchRuntime(databaseUrl, process.env.ARL_EXECUTOR_ID);
console.log('Agent worker ready');
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => void (async () => {
  await shutdownRuntime();
  await store.close();
  await runtime.close();
  process.exit(0);
})());
