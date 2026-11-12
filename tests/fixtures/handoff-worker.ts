import { Store } from '../../src/store.js';
import { Engine } from '../../src/engine.js';
import { httpEffects } from '../../src/effects.js';
import { attachRuntime, createRuntimeClient, launchRuntime, shutdownRuntime } from '../../src/durable.js';

const databaseUrl = process.env.DATABASE_URL;
const token = process.env.ARL_INTERNAL_TOKEN;
if (!databaseUrl || !token || process.env.NODE_ENV !== 'test' || !process.send) {
  throw new Error('The handoff fixture requires its isolated test environment and IPC');
}
const runtime = await createRuntimeClient(databaseUrl, { migrate: false });
const store = new Store(databaseUrl, runtime);
await store.init();
const engine = new Engine(store, { effects: httpEffects(process.env.ARL_API_URL!, token) });
let paused = false;
attachRuntime(async (runId, executionId) => {
  const outcome = await engine.tick(runId, executionId);
  if (outcome === 'wait' && !paused) {
    paused = true;
    // The business WAITING state is committed, but the DBOS step has not yet
    // checkpointed or performed its waiting handoff. No database lock is held.
    await new Promise<void>(resolve => {
      process.once('message', () => resolve());
      process.send!({ waitingBeforeHandoff: runId });
    });
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
