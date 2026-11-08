import { Store } from './store.js';
import { Engine } from './engine.js';
import { httpEffects } from './effects.js';
import { attachRuntime, launchRuntime, shutdownRuntime } from './durable.js';
const databaseUrl = process.env.DATABASE_URL;
const token = process.env.ARL_INTERNAL_TOKEN;
if (!databaseUrl || !token) throw new Error('DATABASE_URL and ARL_INTERNAL_TOKEN are required');
const store = new Store(databaseUrl);
await store.init();
const engine = new Engine(store, {
  effects: httpEffects(process.env.ARL_API_URL ?? 'http://127.0.0.1:4317',token),
  afterEffect: process.env.ARL_TEST_KILL_AFTER_EFFECT === '1' ? async () => {
    if (process.env.NODE_ENV !== 'test') throw new Error('Fault injection is only available in test mode');
    process.kill(process.pid,'SIGKILL');
  } : undefined,
});
attachRuntime(id=>engine.tick(id));
await launchRuntime(databaseUrl,process.env.ARL_EXECUTOR_ID ?? 'lab-local');
console.log('Agent worker ready');
for (const signal of ['SIGINT','SIGTERM'] as const) process.once(signal,()=>void (async()=>{await shutdownRuntime();await store.close();process.exit(0);})());
