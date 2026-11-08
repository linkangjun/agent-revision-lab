import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Model, ModelReply, Operation, RunStatus } from '../../src/contracts.js';
import { Engine, type Effects } from '../../src/engine.js';
import { scriptedModel } from '../../src/models.js';
import { startServer } from '../../src/server.js';
import { Store } from '../../src/store.js';

const goal = 'Compare stable API versions. Exclude beta.';
const revisedGoal = 'Compare stable API versions and include pagination. Exclude beta.';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

const receipt = (op: Operation) => ({ ok: true, reportId: op.id, revision: op.revision });

function stubEffects() {
  return {
    publish: vi.fn<Effects['publish']>(async op => receipt(op)),
    lookup: vi.fn<Effects['lookup']>(async () => ({ found: false })),
  };
}

describe('Release regressions on Postgres', () => {
  let store: Store;
  let app: Awaited<ReturnType<typeof startServer>>;
  let origin: string;
  const ids: string[] = [];

  beforeAll(async () => {
    const databaseUrl = process.env.ARL_TEST_DATABASE_URL;
    if (!databaseUrl) throw new Error('Set ARL_TEST_DATABASE_URL to an isolated Postgres test database');
    app = await startServer({ databaseUrl, internalToken: 'integration-only-placeholder-token', port: 0 });
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('Expected a TCP server address');
    origin = 'http://127.0.0.1:' + address.port;
    // A separate store lets tests tick the engine deterministically, without a queued workflow.
    store = new Store(databaseUrl);
  });

  afterAll(async () => {
    try {
      if (ids.length) await store.tx(async c => {
        await c.query('DELETE FROM arl_revisions WHERE run_id = ANY($1::text[])', [ids]);
        await c.query('DELETE FROM arl_commands WHERE run_id = ANY($1::text[])', [ids]);
        await c.query('DELETE FROM arl_events WHERE run_id = ANY($1::text[])', [ids]);
        await c.query('DELETE FROM arl_operations WHERE run_id = ANY($1::text[])', [ids]);
        await c.query('DELETE FROM arl_runs WHERE id = ANY($1::text[])', [ids]);
      });
    } finally {
      await Promise.all([store?.close(), app?.close()]);
    }
  });

  async function create() {
    const run = await store.create({ goal });
    ids.push(run.id);
    return run.id;
  }

  async function reach(engine: Engine, id: string, status: RunStatus) {
    for (let step = 0; step < 16; step++) {
      if ((await store.get(id)).status === status) return;
      if (await engine.tick(id) !== 'continue') break;
    }
    expect((await store.get(id)).status).toBe(status);
  }

  async function approve(engine: Engine, id: string) {
    await reach(engine, id, 'WAITING_APPROVAL');
    const [operation] = await store.operations(id);
    await store.command(id, {
      kind: 'approve', commandId: 'approve', expectedRevision: 1, operationId: operation.id,
    });
    return operation;
  }

  async function postCommand(id: string, body: unknown) {
    const response = await fetch(origin + '/api/runs/' + id + '/commands', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  }

  it('returns 400 for malformed commands without changing the run or operation', async () => {
    const effects = stubEffects();
    effects.publish.mockRejectedValueOnce(new Error('Synthetic missing receipt'));
    const engine = new Engine(store, { effects });
    const id = await create();
    const op = await approve(engine, id);
    await reach(engine, id, 'WAITING_RECONCILIATION');
    const before = await store.detail(id);

    expect(await postCommand(id, { kind: 'cancel', commandId: 7, expectedRevision: 1 }))
      .toMatchObject({ status: 400, body: { error: expect.stringContaining('commandId') } });
    expect(await postCommand(id, { kind: 'revise', commandId: 'revise', expectedRevision: 1, goal: { text: 'New goal' } }))
      .toMatchObject({ status: 400, body: { error: expect.stringContaining('Goal') } });
    expect(await postCommand(id, {
      kind: 'reconcile', commandId: 'reconcile', expectedRevision: 1, operationId: op.id, resolution: 'applied', note: 42,
    })).toMatchObject({ status: 400, body: { error: expect.stringContaining('note') } });

    expect(await store.detail(id)).toEqual(before);
  });

  it('exposes the archived goal, messages, and context after resetting the active revision', async () => {
    const engine = new Engine(store, { effects: stubEffects() });
    const id = await create();
    await reach(engine, id, 'WAITING_APPROVAL');
    const before = await store.get(id);
    expect(before.messages).not.toHaveLength(0);
    expect(before.context).not.toBeNull();

    await store.command(id, { kind: 'revise', commandId: 'revise', expectedRevision: 1, goal: revisedGoal });
    expect(await store.get(id)).toMatchObject({
      revision: 2, goal: revisedGoal, messages: [], pending: [], context: null,
    });
    const response = await fetch(origin + '/api/runs/' + id + '/revisions');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([{ revision: 1, snapshot: before }]);
  });

  it('exports diagnostic events without disclosing model-controlled names and call IDs', async () => {
    const privateName = 'synthetic-private-tool-name';
    const privateCallId = 'synthetic-private-call-id';
    const privateReport = 'synthetic-private-report cites ev_users_name';
    const respond = vi.fn<Model['respond']>()
      .mockResolvedValueOnce({
        stop: 'tools', text: '',
        calls: [
          { id: 'bad-tool', name: privateName, arguments: {} },
          { id: 'inspect', name: 'inspect_specs', arguments: { includePagination: false } },
        ],
      })
      .mockResolvedValueOnce({
        stop: 'tools', text: '',
        calls: [{ id: privateCallId, name: 'publish_report', arguments: { report: privateReport } }],
      });
    const engine = new Engine(store, { model: { name: 'fixture', respond }, effects: stubEffects() });
    const id = await create();
    await reach(engine, id, 'WAITING_APPROVAL');
    const [operation] = await store.operations(id);
    expect(operation).toMatchObject({ callId: privateCallId, args: { report: privateReport } });

    const response = await fetch(origin + '/api/runs/' + id + '/export');
    expect(response.status).toBe(200);
    const raw = await response.text();
    for (const secret of [privateName, privateCallId, privateReport]) expect(raw).not.toContain(secret);
    expect(JSON.parse(raw)).toMatchObject({
      format: 'agent-revision-lab/incident-v1',
      run: { id, status: 'WAITING_APPROVAL' },
      operations: [expect.objectContaining({ id: operation.id, state: 'PROPOSED' })],
      events: expect.arrayContaining([
        expect.objectContaining({ type: 'model.tools_requested', detail: { tools: ['unknown', 'inspect_specs'] } }),
        expect.objectContaining({ type: 'tool.rejected', detail: { tool: 'unknown', reason: 'invalid_arguments' } }),
        expect.objectContaining({ type: 'operation.proposed', detail: expect.objectContaining({ operationId: operation.id }) }),
      ]),
    });
  });

  it.each(['report ID', 'revision'])('does not accept mismatched %s in write or lookup receipts', async field => {
    function mismatchedReceipt(op: Operation) {
      return field === 'report ID'
        ? { ...receipt(op), reportId: 'unrelated-operation' }
        : { ...receipt(op), revision: op.revision + 1 };
    }
    const effects = stubEffects();
    effects.publish.mockImplementationOnce(async op => mismatchedReceipt(op));
    effects.lookup.mockImplementationOnce(async op => ({ found: true, result: mismatchedReceipt(op) }));
    const engine = new Engine(store, { effects });
    const id = await create();
    const op = await approve(engine, id);

    await engine.tick(id);
    expect(await store.operations(id)).toMatchObject([{ id: op.id, state: 'IN_FLIGHT', result: null, attempts: 1 }]);
    await reach(engine, id, 'WAITING_RECONCILIATION');
    expect(await engine.tick(id)).toBe('wait');
    const detail = await store.detail(id);
    expect(detail.operations).toMatchObject([{ id: op.id, state: 'UNKNOWN', result: null, attempts: 1 }]);
    expect(detail.run.final).toBeNull();
    expect(detail.events.map(event => event.type)).not.toContain('run.succeeded');
    expect(effects.lookup).toHaveBeenCalledTimes(1);
    expect(effects.publish).toHaveBeenCalledTimes(1);
  });

  it('expires a final model response waiting on a run row lock beyond the deadline', async () => {
    const entered = deferred<void>();
    const reply = deferred<ModelReply>();
    const respond: Model['respond'] = async (...args) => {
      const scripted = await scriptedModel.respond(...args);
      if (scripted.stop !== 'final') return scripted;
      entered.resolve();
      return reply.promise;
    };
    const engine = new Engine(store, { model: { name: 'fixture', respond }, effects: stubEffects() });
    const id = await create();
    await approve(engine, id);
    await engine.tick(id);
    expect(await store.operations(id)).toMatchObject([{ state: 'CONFIRMED' }]);
    expect((await store.get(id)).pending).toEqual([]);
    const deadline = Date.now() + 2_000;
    await store.tx(async c => {
      const run = await store.get(id, c, true);
      run.deadline = new Date(deadline).toISOString();
      await store.save(run, c);
    });

    const ticking = engine.tick(id);
    const finalReply: ModelReply = { stop: 'final', text: 'Late response must not be stored.', calls: [] };
    try {
      await Promise.race([
        entered.promise,
        ticking.then(() => { throw new Error('Engine returned before asking the model to finalize'); }),
      ]);
      await store.tx(async c => {
        await store.get(id, c, true);
        const { rows: [{ pid }] } = await c.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
        reply.resolve(finalReply);
        // Verify the model finished in time and its result write is waiting on this transaction.
        let blocked = false;
        while (Date.now() < deadline) {
          const { rows } = await store.pool.query(
            "SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND $1 = ANY(pg_blocking_pids(pid))", [pid],
          );
          if (rows.length) { blocked = true; break; }
          await delay(10);
        }
        expect(blocked).toBe(true);
        await delay(Math.max(0, deadline - Date.now()) + 25);
      });
    } finally {
      reply.resolve(finalReply);
      await ticking;
    }

    const { run, events } = await store.detail(id);
    expect(run).toMatchObject({ status: 'EXPIRED', final: null, error: null });
    expect(run.messages.map(message => message.content)).not.toContain(finalReply.text);
    expect(events.map(event => event.type)).toContain('run.expired');
    expect(events.map(event => event.type)).not.toContain('run.succeeded');
  });
});
