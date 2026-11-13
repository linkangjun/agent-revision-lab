import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { Operation, Run } from '../../src/contracts.js';
import { canonicalHash } from '../../src/core.js';
import { Engine } from '../../src/engine.js';
import { Store } from '../../src/store.js';
const url=process.env.ARL_TEST_DATABASE_URL;
describe.skipIf(!url)('atomic execution retry command',()=>{
  it('changes execution once, preserves domain state, and rolls back a failed enqueue',async()=>{
    const enqueues:string[]=[]; let fail=false;
    const store=new Store(url!,{
      async enqueueRun(id,c,executionId=id){ if(fail)throw new Error('Synthetic enqueue failure');expect(c).toBeDefined();enqueues.push(executionId); },
      async wakeRun(){},async workflowStatus(){return {status:'ERROR'};},
    });
    try{
      await store.init(); const run=await store.create({goal:'Synthetic retry contract'});
      fail=true;
      await expect(store.command(run.id,{kind:'retry',commandId:randomUUID(),expectedRevision:1})).rejects.toThrow('enqueue');
      expect((await store.get(run.id)).workflowId).toBe(run.id);
      fail=false;const command={kind:'retry' as const,commandId:randomUUID(),expectedRevision:1};
      const [a,b]=await Promise.all([store.command(run.id,command),store.command(run.id,command)]);
      expect(a.workflowId).not.toBe(run.id);expect(a.workflowId).toBe(b.workflowId);expect(enqueues).toHaveLength(2);
      expect(a.goal).toBe(run.goal);expect(a.revision).toBe(1);
      expect((await store.detail(run.id)).events.filter(e=>e.type==='execution.restarted')).toHaveLength(1);
    }finally{await store.close();}
  });

  it.each([
    ['ERROR', 'clean'], ['MAX_RECOVERY_ATTEMPTS_EXCEEDED', 'clean'],
    ['ERROR', 'no-lookup'], ['MAX_RECOVERY_ATTEMPTS_EXCEEDED', 'no-lookup'],
  ] as const)('recovers only the pending receipt of a cancelled %s execution (%s)', async (status, scenario) => {
    const enqueues: string[] = [];
    const store = new Store(url!, {
      async enqueueRun(id, client, executionId = id) { expect(client).toBeDefined(); enqueues.push(executionId); },
      async wakeRun() {}, async workflowStatus() { return { status }; },
    });
    const model = { name: 'unused', respond: vi.fn(async () => { throw new Error('A terminal run must never call the model'); }) };
    const effects = {
      publish: vi.fn(async () => { throw new Error('A terminal run must never redispatch a write'); }),
      lookup: vi.fn(async (operation: Operation) => ({ found: true, result: { ok: true, reportId: operation.id, revision: operation.revision } })),
    };
    try {
      await store.init();
      const run = await store.create({ goal: 'Synthetic cancelled receipt recovery', scenario, durationMs: -100 });
      const operation = await seedInFlight(store, run);
      const cancelled = await store.command(run.id, { kind: 'cancel', commandId: randomUUID(), expectedRevision: 1 });
      expect(cancelled.status).toBe('CANCELLED');
      expect(cancelled.workflowId).toBe(run.id);
      expect(enqueues).toHaveLength(1); // Cancellation is not an implicit error retry.
      await store.expireRun(run.id);
      expect((await store.operations(run.id))[0].state).toBe('IN_FLIGHT');

      const command = { kind: 'retry' as const, commandId: randomUUID(), expectedRevision: 1 };
      const recovered = await store.command(run.id, command);
      expect(recovered.status).toBe('CANCELLED');
      expect(recovered.workflowId).not.toBe(run.id);
      expect(await store.command(run.id, command)).toEqual(recovered);
      expect(enqueues).toHaveLength(2);
      expect((await store.detail(run.id)).events.filter(event => event.type === 'execution.restarted')).toHaveLength(1);

      const engine = new Engine(store, { model, effects });
      expect(await engine.tick(run.id, recovered.workflowId)).toBe('continue');
      expect(await engine.tick(run.id, recovered.workflowId)).toBe('done');
      expect((await store.get(run.id)).status).toBe('CANCELLED');
      expect((await store.operations(run.id))[0]).toMatchObject({ state: scenario === 'clean' ? 'CONFIRMED' : 'UNKNOWN', attempts: 1 });
      expect(effects.lookup).toHaveBeenCalledTimes(scenario === 'clean' ? 1 : 0);
      if (scenario === 'no-lookup') {
        await expect(store.command(run.id, { kind: 'retry', commandId: randomUUID(), expectedRevision: 1 })).rejects.toThrow();
        const resolved = await store.command(run.id, {
          kind: 'reconcile', commandId: randomUUID(), expectedRevision: 1, operationId: operation.id,
          resolution: 'applied', note: 'Synthetic external receipt verified by the operator',
        });
        expect(resolved.status).toBe('CANCELLED');
        expect((await store.operations(run.id))[0]).toMatchObject({ state: 'CONFIRMED', attempts: 1, result: { manuallyAttested: true } });
        expect(enqueues).toHaveLength(2);
      }
      expect(model.respond).not.toHaveBeenCalled();
      expect(effects.publish).not.toHaveBeenCalled();
      await expect(store.command(run.id, { kind: 'retry', commandId: randomUUID(), expectedRevision: 1 })).rejects.toThrow('Run is terminal');
      expect(enqueues).toHaveLength(2);
    } finally { await store.close(); }
  });

  it.each(['SUCCEEDED', 'FAILED', 'CANCELLED', 'EXPIRED'] as const)('does not reopen a terminal %s run without an in-flight operation', async status => {
    const enqueues: string[] = [];
    const store = new Store(url!, {
      async enqueueRun(id, _client, executionId = id) { enqueues.push(executionId); },
      async wakeRun() {}, async workflowStatus() { return { status: 'ERROR' }; },
    });
    try {
      await store.init();
      const run = await store.create({ goal: 'Synthetic terminal retry rejection' });
      await store.tx(async client => { run.status = status; await store.save(run, client); });
      await expect(store.command(run.id, { kind: 'retry', commandId: randomUUID(), expectedRevision: 1 })).rejects.toThrow('Run is terminal');
      expect((await store.get(run.id)).status).toBe(status);
      expect(enqueues).toHaveLength(1);
    } finally { await store.close(); }
  });

  it('rejects terminal receipt retry while its durable execution is still pending', async () => {
    const enqueues: string[] = [];
    const store = new Store(url!, {
      async enqueueRun(id, _client, executionId = id) { enqueues.push(executionId); },
      async wakeRun() {}, async workflowStatus() { return { status: 'PENDING' }; },
    });
    try {
      await store.init();
      const run = await store.create({ goal: 'Synthetic pending execution remains owned' });
      await seedInFlight(store, run);
      const cancelled = await store.command(run.id, { kind: 'cancel', commandId: randomUUID(), expectedRevision: 1 });
      const before = enqueues.length;
      await expect(store.command(run.id, { kind: 'retry', commandId: randomUUID(), expectedRevision: 1 })).rejects.toThrow('Execution is not stopped with an error');
      expect((await store.get(run.id)).workflowId).toBe(cancelled.workflowId);
      expect((await store.get(run.id)).status).toBe('CANCELLED');
      expect((await store.operations(run.id))[0]).toMatchObject({ state: 'IN_FLIGHT', attempts: 1 });
      expect(enqueues).toHaveLength(before);
    } finally { await store.close(); }
  });
});

async function seedInFlight(store: Store, run: Run): Promise<Operation> {
  const args = { report: 'Synthetic cited compatibility report with ev_users_name.' };
  const operation: Operation = {
    id: `${run.id}:effect`, runId: run.id, revision: 1, callId: 'publish', tool: 'publish_report',
    args, argsHash: canonicalHash(args), state: 'IN_FLIGHT', result: null, attempts: 1,
    approvedUntil: new Date(Date.now() + 60_000).toISOString(), createdAt: new Date().toISOString(),
  };
  await store.tx(async client => {
    run.status = 'RUNNING';
    await store.save(run, client);
    await store.putOperation(operation, client);
  });
  return operation;
}
