import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { Operation } from '../../src/contracts.js';
import { canonicalHash } from '../../src/core.js';
import { Engine, type Effects } from '../../src/engine.js';
import { Store } from '../../src/store.js';

const databaseUrl = process.env.ARL_TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)('activation handoff and deadline recovery', () => {
  it('yields on advisory contention and reconciles an in-flight write instead of parking the successor', async () => {
    const enqueues: Array<{ executionId: string; delaySeconds?: number }> = [];
    const store = new Store(databaseUrl!, {
      async enqueueRun(id, client, executionId = id, delaySeconds) {
        expect(client).toBeDefined();
        enqueues.push({ executionId, delaySeconds });
      },
      async wakeRun() {},
      async workflowStatus() { return { status: 'PENDING' }; },
    });
    const effects: Effects = {
      publish: vi.fn(async () => { throw new Error('A contended activation must not redispatch an in-flight write'); }),
      lookup: vi.fn(async (op: Operation) => ({ found: true, result: { ok: true, reportId: op.id, revision: op.revision } })),
    };
    try {
      await store.init();
      const run = await store.create({ goal: 'Synthetic contention during effect reconciliation', durationMs: 60_000 });
      const args = { report: 'Synthetic cited compatibility report with ev_users_name.' };
      const op: Operation = {
        id: `${run.id}:effect`, runId: run.id, revision: 1, callId: 'publish', tool: 'publish_report',
        args, argsHash: canonicalHash(args), state: 'IN_FLIGHT', result: null, attempts: 1,
        approvedUntil: new Date(Date.now() + 60_000).toISOString(), createdAt: new Date().toISOString(),
      };
      await store.tx(async c => {
        run.status = 'WAITING_RECONCILIATION';
        await store.save(run, c);
        await store.putOperation(op, c);
      });
      const executionId = run.workflowId ?? run.id;
      const engine = new Engine(store, { effects });
      const owner = await store.pool.connect();
      try {
        await owner.query('SELECT pg_advisory_lock(hashtextextended($1,0))', ['arl:' + run.id]);
        const outcome = await engine.tick(run.id, executionId);
        expect(outcome).toBe('busy');
        expect(await store.settleActivation(run.id, executionId, outcome)).toBe('done');
        const successor = await store.get(run.id);
        expect(successor.workflowId).not.toBe(executionId);
        expect(successor.status).toBe('WAITING_RECONCILIATION');
        expect(successor.parkedExecutionId).toBeUndefined();
        expect(enqueues).toEqual([
          { executionId, delaySeconds: undefined },
          { executionId: successor.workflowId, delaySeconds: 0.2 },
        ]);
        expect((await store.detail(run.id)).events.some(event => event.type === 'execution.waiting')).toBe(false);
        expect(effects.lookup).not.toHaveBeenCalled();
        expect(effects.publish).not.toHaveBeenCalled();
      } finally {
        await owner.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', ['arl:' + run.id]);
        owner.release();
      }

      const successor = await store.get(run.id);
      expect(await engine.tick(run.id, successor.workflowId)).toBe('continue');
      expect(effects.lookup).toHaveBeenCalledTimes(1);
      expect(effects.publish).not.toHaveBeenCalled();
      expect((await store.operations(run.id))[0]).toMatchObject({ state: 'CONFIRMED', attempts: 1 });
      expect((await store.detail(run.id)).events).toContainEqual(expect.objectContaining({ type: 'operation.recovered' }));
    } finally {
      await store.close();
    }
  });

  it.each(['PENDING', 'ERROR', 'MAX_RECOVERY_ATTEMPTS_EXCEEDED'])('keeps an overdue %s execution with an in-flight write recoverable', async initialStatus => {
    let status = initialStatus;
    const enqueues: string[] = [];
    const store = new Store(databaseUrl!, {
      async enqueueRun(id, client, executionId = id) { expect(client).toBeDefined(); enqueues.push(executionId); },
      async wakeRun() {},
      async workflowStatus() { return { status }; },
    });
    const args = { report: 'Synthetic cited compatibility report with ev_users_name.' };
    const effects: Effects = {
      publish: vi.fn(async () => { throw new Error('A deadline must not redispatch a write'); }),
      lookup: vi.fn(async (op: Operation) => ({ found: true, result: { ok: true, reportId: op.id, revision: op.revision } })),
    };
    try {
      await store.init();
      const run = await store.create({ goal: 'Synthetic recovery after deadline', durationMs: -100 });
      const op: Operation = {
        id: `${run.id}:effect`, runId: run.id, revision: 1, callId: 'publish', tool: 'publish_report',
        args, argsHash: canonicalHash(args), state: 'IN_FLIGHT', result: null, attempts: 1,
        approvedUntil: new Date(Date.now() + 60_000).toISOString(), createdAt: new Date().toISOString(),
      };
      await store.tx(async c => {
        run.status = 'RUNNING';
        await store.save(run, c);
        await store.putOperation(op, c);
      });

      await store.expireRun(run.id);
      expect((await store.get(run.id)).status).toBe('RUNNING');
      expect((await store.operations(run.id))[0]).toMatchObject({ state: 'IN_FLIGHT', attempts: 1 });
      expect((await store.detail(run.id)).events).toContainEqual(expect.objectContaining({
        type: 'deadline.deferred', detail: { reason: 'in_flight_operation' },
      }));
      expect(effects.lookup).not.toHaveBeenCalled();
      expect(effects.publish).not.toHaveBeenCalled();

      // A pending execution may fail immediately after the deadline check.
      // Its persisted in-flight intent still needs an explicit recovery path.
      if (status === 'PENDING') status = 'ERROR';
      const retry = { kind: 'retry' as const, commandId: randomUUID(), expectedRevision: 1 };
      const restarted = await store.command(run.id, retry);
      expect(restarted.workflowId).not.toBe(run.id);
      expect(await store.command(run.id, retry)).toEqual(restarted);
      expect(enqueues).toHaveLength(2);
      const engine = new Engine(store, { effects });
      expect(await engine.tick(run.id, restarted.workflowId)).toBe('continue');
      expect(effects.lookup).toHaveBeenCalledTimes(1);
      expect((await store.operations(run.id))[0]).toMatchObject({ state: 'CONFIRMED', attempts: 1 });
      expect(await engine.tick(run.id, restarted.workflowId)).toBe('done');
      expect((await store.get(run.id)).status).toBe('EXPIRED');
      expect(effects.publish).not.toHaveBeenCalled();
    } finally {
      await store.close();
    }
  });

  it('preserves an overdue execution error without effects until an explicit retry', async () => {
    const enqueues: string[] = [];
    const store = new Store(databaseUrl!, {
      async enqueueRun(id, client, executionId = id) { expect(client).toBeDefined(); enqueues.push(executionId); },
      async wakeRun() {},
      async workflowStatus() { return { status: 'ERROR' }; },
    });
    const model = { name: 'unused', respond: vi.fn(async () => { throw new Error('Expiry must not call a model'); }) };
    const effects = {
      publish: vi.fn(async () => { throw new Error('Expiry must not write'); }),
      lookup: vi.fn(async () => ({ found: false })),
    };
    try {
      await store.init();
      const run = await store.create({ goal: 'Synthetic stopped execution', durationMs: -100 });
      await store.expireRun(run.id);
      const preserved = await store.get(run.id);
      expect(preserved.status).toBe('QUEUED');
      expect(preserved.workflowId).toBe(run.id);
      expect(enqueues).toHaveLength(1);
      expect((await store.detail(run.id)).events).toContainEqual(expect.objectContaining({
        type: 'deadline.deferred', detail: { reason: 'execution_error' },
      }));

      const restarted = await store.command(run.id, { kind: 'retry', commandId: randomUUID(), expectedRevision: 1 });
      expect(enqueues).toHaveLength(2);
      expect(await new Engine(store, { model, effects }).tick(run.id, restarted.workflowId)).toBe('done');
      expect((await store.get(run.id)).status).toBe('EXPIRED');
      expect(model.respond).not.toHaveBeenCalled();
      expect(effects.publish).not.toHaveBeenCalled();
      expect(effects.lookup).not.toHaveBeenCalled();
    } finally {
      await store.close();
    }
  });

});
