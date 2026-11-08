import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Command, Model, Operation, Run, RunStatus } from '../../src/contracts.js';
import { canonicalHash } from '../../src/core.js';
import { Engine, type Effects } from '../../src/engine.js';
import { scriptedModel } from '../../src/models.js';
import { Store } from '../../src/store.js';

const initialGoal = 'Compare stable API versions. Exclude beta.';
const revisedGoal = 'Compare stable API versions, including pagination. Exclude beta.';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function stubEffects() {
  return {
    publish: vi.fn<Effects['publish']>(async op => ({ ok: true, reportId: op.id, revision: op.revision })),
    lookup: vi.fn<Effects['lookup']>(async () => ({ found: false })),
  };
}

describe('Engine and Store on Postgres (stub model/effects, no workflow dispatcher)', () => {
  let store: Store;
  const ids: string[] = [];

  beforeAll(async () => {
    const url = process.env.ARL_TEST_DATABASE_URL;
    if (!url) throw new Error('Set ARL_TEST_DATABASE_URL to an isolated Postgres test database');
    store = new Store(url);
    await store.init();
  });

  afterAll(async () => {
    if (!store) return;
    try {
      // Clean up only runs created by this suite.
      if (ids.length) await store.tx(async c => {
        await c.query('DELETE FROM arl_demo_reports WHERE run_id = ANY($1::text[])', [ids]);
        await c.query('DELETE FROM arl_commands WHERE run_id = ANY($1::text[])', [ids]);
        await c.query('DELETE FROM arl_events WHERE run_id = ANY($1::text[])', [ids]);
        await c.query('DELETE FROM arl_operations WHERE run_id = ANY($1::text[])', [ids]);
        await c.query('DELETE FROM arl_revisions WHERE run_id = ANY($1::text[])', [ids]);
        await c.query('DELETE FROM arl_runs WHERE id = ANY($1::text[])', [ids]);
      });
    } finally {
      await store.close();
    }
  });

  async function create(overrides: Partial<Parameters<Store['create']>[0]> = {}) {
    const run = await store.create({ goal: initialGoal, ...overrides });
    ids.push(run.id);
    return run;
  }

  async function reach(engine: Engine, id: string, status: RunStatus): Promise<Run> {
    for (let step = 0; step < 16; step++) {
      const run = await store.get(id);
      if (run.status === status) return run;
      const outcome = await engine.tick(id);
      if (outcome === 'done' || outcome === 'wait') break;
    }
    const run = await store.get(id);
    expect(run.status).toBe(status);
    return run;
  }

  async function propose(engine: Engine, id: string) {
    await reach(engine, id, 'WAITING_APPROVAL');
    const [operation] = await store.operations(id);
    expect(operation.state).toBe('PROPOSED');
    return operation;
  }

  function approval(op: Operation, commandId = 'approve-report'): Command {
    return { kind: 'approve', commandId, expectedRevision: op.revision, operationId: op.id };
  }

  it('invalidates an old proposal and rejects its approval even with the fresh revision number', async () => {
    const effects = stubEffects();
    const engine = new Engine(store, { effects });
    const run = await create();
    const old = await propose(engine, run.id);

    await store.command(run.id, {
      kind: 'revise', commandId: 'revise-goal', expectedRevision: 1, goal: revisedGoal,
    });
    await expect(store.command(run.id, approval(old))).rejects.toMatchObject({ statusCode: 409 });
    await expect(store.command(run.id, {
      ...approval(old), commandId: 'approve-stale-proposal', expectedRevision: 2,
    })).rejects.toMatchObject({ statusCode: 409 });

    await reach(engine, run.id, 'WAITING_APPROVAL');
    const operations = await store.operations(run.id);
    expect(operations.find(op => op.id === old.id)).toMatchObject({ state: 'ABANDONED', approvedUntil: null });
    const current = operations.find(op => op.revision === 2);
    expect(current).toMatchObject({ state: 'PROPOSED', args: { report: expect.stringContaining('ev_orders_limit') } });
    expect(effects.publish).not.toHaveBeenCalled();
  });

  it('applies concurrent duplicate revision commands once and rejects ID reuse with different input', async () => {
    const run = await create();
    const command: Command = {
      kind: 'revise', commandId: 'same-id', expectedRevision: 1, goal: revisedGoal,
    };

    const outcomes = await Promise.all([store.command(run.id, command), store.command(run.id, command)]);
    expect(outcomes.map(x => x.revision)).toEqual([2, 2]);
    expect((await store.get(run.id)).revision).toBe(2);
    const { events } = await store.detail(run.id);
    expect(events.filter(event => event.type === 'goal.revised')).toHaveLength(1);
    await expect(store.command(run.id, { ...command, goal: 'Different command payload' }))
      .rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining('different input') });
  });

  it('discards all calls from truncated model output and never calls the model again after failure', async () => {
    const respond = vi.fn<Model['respond']>().mockResolvedValue({
      stop: 'length', text: 'partial',
      calls: [{ id: 'truncated', name: 'inspect_specs', arguments: { includePagination: true } }],
    });
    const effects = stubEffects();
    const engine = new Engine(store, { model: { name: 'stub', respond }, effects });
    const run = await create();

    const failed = await reach(engine, run.id, 'FAILED');
    expect(failed.pending).toEqual([]);
    expect(failed.error).toContain('truncated');
    expect(await engine.tick(run.id)).toBe('done');
    expect(respond).toHaveBeenCalledTimes(1);
    const { events, operations } = await store.detail(run.id);
    expect(events.map(event => event.type)).toContain('model.truncated');
    expect(events.map(event => event.type)).not.toContain('tool.completed');
    expect(operations).toEqual([]);
    expect(effects.publish).not.toHaveBeenCalled();
  });

  it('denies a registered write tool before creating an operation or calling the effect', async () => {
    const effects = stubEffects();
    const engine = new Engine(store, { effects, allowedTools: ['inspect_specs'] });
    const run = await create();

    await reach(engine, run.id, 'FAILED');
    const { operations, events } = await store.detail(run.id);
    expect(operations).toEqual([]);
    expect(events).toContainEqual(expect.objectContaining({
      type: 'tool.rejected', detail: { tool: 'publish_report', reason: 'permission_denied' },
    }));
    expect(effects.publish).not.toHaveBeenCalled();
  });

  it('honors the turn budget and an elapsed deadline without invoking the model again', async () => {
    const respond = vi.fn(scriptedModel.respond);
    const effects = stubEffects();
    const engine = new Engine(store, { model: { name: 'counted-script', respond }, effects });
    const exhausted = await create({ maxTurns: 1 });
    expect((await reach(engine, exhausted.id, 'FAILED')).error).toContain('turn budget');
    expect(await engine.tick(exhausted.id)).toBe('done');

    const expired = await create();
    await store.tx(async client => {
      const live = await store.get(expired.id, client, true);
      live.deadline = new Date(Date.now() - 1000).toISOString();
      await store.save(live, client);
    });
    expect(await engine.tick(expired.id)).toBe('done');
    expect(await engine.tick(expired.id)).toBe('done');
    expect((await store.get(expired.id)).status).toBe('EXPIRED');
    expect(respond).toHaveBeenCalledTimes(1);
    expect(effects.publish).not.toHaveBeenCalled();
  });

  it('passes a paired error back to the model for malformed read arguments', async () => {
    const respond = vi.fn<Model['respond']>()
      .mockResolvedValueOnce({
        stop: 'tools', text: '',
        calls: [{ id: 'bad-read', name: 'inspect_specs', arguments: { includePagination: 'yes' } }],
      })
      .mockResolvedValueOnce({ stop: 'final', text: 'Could not read.', calls: [] });
    const engine = new Engine(store, { model: { name: 'stub', respond }, effects: stubEffects() });
    const run = await create();

    await reach(engine, run.id, 'FAILED');
    const [projected] = respond.mock.calls[1];
    expect(projected.at(-2)?.toolCalls?.[0].id).toBe('bad-read');
    const reply = projected.at(-1);
    expect(reply).toMatchObject({ role: 'tool', toolCallId: 'bad-read' });
    expect(JSON.parse(reply!.content)).toMatchObject({ ok: false, error: expect.stringContaining('boolean') });
    expect((await store.detail(run.id)).events.map(event => event.type)).not.toContain('tool.completed');
  });

  it('records an old in-flight receipt as history after a revision without advancing the new goal', async () => {
    const entered = deferred<Operation>();
    const receipt = deferred<unknown>();
    const effects = stubEffects();
    effects.publish.mockImplementationOnce(async op => {
      entered.resolve(op);
      return receipt.promise;
    });
    const engine = new Engine(store, { effects });
    const run = await create();
    const op = await propose(engine, run.id);
    await store.command(run.id, approval(op));

    const ticking = engine.tick(run.id);
    try {
      const dispatched = await Promise.race([
        entered.promise,
        ticking.then(() => { throw new Error('Worker returned before dispatching the approved write'); }),
      ]);
      expect(dispatched).toMatchObject({ id: op.id, state: 'IN_FLIGHT' });
      const revised = await store.command(run.id, {
        kind: 'revise', commandId: 'while-in-flight', expectedRevision: 1, goal: revisedGoal,
      });
      expect(revised).toMatchObject({ revision: 2, status: 'WAITING_RECONCILIATION', messages: [], pending: [] });
    } finally {
      receipt.resolve({ ok: true, reportId: op.id, revision: op.revision });
      await ticking;
    }

    const after = await store.detail(run.id);
    expect(after.run).toMatchObject({ revision: 2, status: 'RUNNING', messages: [], pending: [], final: null });
    expect(after.operations[0]).toMatchObject({ id: op.id, revision: 1, state: 'CONFIRMED' });
    expect(after.events).toContainEqual(expect.objectContaining({
      type: 'operation.confirmed', revision: 2,
      detail: expect.objectContaining({ operationRevision: 1, staleForCurrentGoal: true }),
    }));
    await reach(engine, run.id, 'WAITING_APPROVAL');
    expect((await store.operations(run.id)).find(candidate => candidate.revision === 2))
      .toMatchObject({ state: 'PROPOSED', args: { report: expect.stringContaining('ev_orders_limit') } });
    expect(effects.publish).toHaveBeenCalledTimes(1);
  });

  it('parks a revised goal while a write has no confirmable outcome', async () => {
    const effects = stubEffects();
    effects.publish.mockRejectedValueOnce(new Error('No receipt'));
    const respond = vi.fn(scriptedModel.respond);
    const engine = new Engine(store, { effects, model: { name: 'counted-script', respond } });
    const run = await create({ scenario: 'no-lookup' });
    const op = await propose(engine, run.id);
    await store.command(run.id, approval(op));
    await reach(engine, run.id, 'WAITING_RECONCILIATION');
    expect((await store.operations(run.id))[0]).toMatchObject({ state: 'UNKNOWN', attempts: 1 });
    await store.command(run.id, {
      kind: 'revise', commandId: 'revise-unknown', expectedRevision: 1, goal: revisedGoal,
    });

    expect(await engine.tick(run.id)).toBe('wait');
    expect(await engine.tick(run.id)).toBe('wait');
    const after = await store.detail(run.id);
    expect(after.run).toMatchObject({ revision: 2, status: 'WAITING_RECONCILIATION', pending: [] });
    expect(after.operations).toHaveLength(1);
    expect(after.events).toContainEqual(expect.objectContaining({
      type: 'operation.uncertain', detail: expect.objectContaining({ automaticRedispatch: false }),
    }));
    expect(effects.lookup).not.toHaveBeenCalled();
    expect(effects.publish).toHaveBeenCalledTimes(1);
    expect(respond).toHaveBeenCalledTimes(2);
  });

  it('refuses to dispatch if stored operation arguments no longer match the approved hash', async () => {
    const effects = stubEffects();
    const engine = new Engine(store, { effects });
    const run = await create();
    const op = await propose(engine, run.id);
    expect(op.argsHash).toBe(canonicalHash(op.args));
    await store.command(run.id, approval(op));
    await store.tx(async client => {
      const [current] = await store.operations(run.id, client);
      await store.putOperation({ ...current, args: { report: 'A changed report with ev_users_name' } }, client);
    });

    await expect(engine.tick(run.id)).rejects.toThrow(/argument integrity/i);
    expect(effects.publish).not.toHaveBeenCalled();
    expect((await store.operations(run.id))[0].attempts).toBe(0);
  });
});
