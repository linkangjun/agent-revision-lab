import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Command, Operation, Run, RunDetail, Scenario } from '../../src/contracts.js';
import { startServer } from '../../src/server.js';

const databaseUrl = process.env.ARL_TEST_DATABASE_URL;
const fixtureGoal = 'Compare stable v1 and v2, exclude beta, and publish a cited compatibility report.';
const project = fileURLToPath(new URL('../../', import.meta.url));
const workerEntry = fileURLToPath(new URL('../../src/worker.ts', import.meta.url));
type Exit = { code: number | null; signal: NodeJS.Signals | null };
type Worker = { child: ChildProcess; exit?: Exit; ready: boolean; executorId: string };

async function poll<T>(check: () => Promise<T | undefined> | T | undefined, description: string, timeoutMs = 12_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  do {
    const value = await check();
    if (value !== undefined) return value;
    await sleep(100);
  } while (Date.now() < deadline);
  throw new Error(`Timed out waiting for ${description}`);
}

describe.skipIf(!databaseUrl)('durable workflow on a disposable PostgreSQL database', () => {
  let app: Awaited<ReturnType<typeof startServer>>;
  let apiUrl: string;
  const token = randomUUID().replaceAll('-', '');
  const workers = new Set<Worker>();
  let publisherWrites = 0;

  beforeAll(async () => {
    app = await startServer({ databaseUrl: databaseUrl!, internalToken: token, port: 0 });
    apiUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    // Count actual HTTP write attempts, including duplicates the publisher would deduplicate.
    app.server.prependListener('request', req => {
      if (req.method === 'POST' && req.url === '/internal/reports') publisherWrites++;
    });
  }, 60_000);

  beforeEach(() => { publisherWrites = 0; });

  async function startWorker(options: { executorId?: string; killAfterEffect?: boolean } = {}): Promise<Worker> {
    const executorId = options.executorId ?? `integration-${randomUUID()}`;
    // Run the entry point directly in one process so SIGKILL targets the actual worker.
    const child = spawn(process.execPath, ['--import', 'tsx', workerEntry], {
      cwd: project,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        PATH: process.env.PATH,
        NODE_ENV: 'test',
        DATABASE_URL: databaseUrl,
        ARL_API_URL: apiUrl,
        ARL_INTERNAL_TOKEN: token,
        ARL_EXECUTOR_ID: executorId,
        ...(options.killAfterEffect ? { ARL_TEST_KILL_AFTER_EFFECT: '1' } : {}),
      },
    });
    const worker: Worker = { child, ready: false, executorId };
    child.once('error', () => { worker.exit = { code: null, signal: null }; });
    child.once('close', (code, signal) => { worker.exit = { code, signal }; });
    let partial = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      partial = (partial + chunk).slice(-4_096);
      if (partial.includes('Agent worker ready')) worker.ready = true;
    });
    // Do not include arbitrary child output or connection details in test logs.
    child.stderr.resume();
    workers.add(worker);
    return poll(() => {
      if (worker.exit) throw new Error(`Worker exited before readiness (code ${worker.exit.code}, signal ${worker.exit.signal})`);
      return worker.ready ? worker : undefined;
    }, 'worker readiness');
  }

  afterEach(async () => {
    for (const worker of workers) if (!worker.exit) worker.child.kill('SIGTERM');
    try {
      await poll(() => [...workers].every(w => w.exit) ? true : undefined, 'worker shutdown', 5_000);
    } finally {
      for (const worker of workers) if (!worker.exit) worker.child.kill('SIGKILL');
      await poll(() => [...workers].every(w => w.exit) ? true : undefined, 'child process exit', 3_000);
      workers.clear();
    }
  }, 10_000);

  afterAll(async () => { await app?.close(); }, 15_000);

  async function request<T>(path: string, input?: unknown): Promise<{ status: number; data: T }> {
    const response = await fetch(`${apiUrl}${path}`, {
      signal: AbortSignal.timeout(5_000),
      ...(input === undefined ? {} : {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      }),
    });
    return { status: response.status, data: await response.json() as T };
  }

  async function createRun(scenario: Scenario): Promise<string> {
    const response = await request<{ id: string }>('/api/runs', { goal: fixtureGoal, scenario, model: 'scripted' });
    expect(response.status).toBe(201);
    return response.data.id;
  }

  async function detail(id: string): Promise<RunDetail> {
    const response = await request<RunDetail>(`/api/runs/${id}`);
    expect(response.status).toBe(200);
    return response.data;
  }

  async function waitForStatus(id: string, status: Run['status']): Promise<RunDetail> {
    return poll(async () => {
      const state = await detail(id);
      if (state.run.status === status) return state;
      if (['FAILED', 'CANCELLED', 'EXPIRED', 'SUCCEEDED'].includes(state.run.status)) {
        throw new Error(`Run reached ${state.run.status} while waiting for ${status}`);
      }
      return undefined;
    }, status);
  }

  function proposal(detail: RunDetail): Operation {
    const pending = detail.operations.find(op => op.revision === detail.run.revision && op.state === 'PROPOSED');
    expect(pending, 'the current goal needs its own approval').toBeDefined();
    return pending!;
  }

  function command(id: string, input: Command) {
    return request<Run>(`/api/runs/${id}/commands`, input);
  }

  function approval(op: Operation): Command {
    return { commandId: randomUUID(), expectedRevision: op.revision, kind: 'approve', operationId: op.id };
  }

  it('publishes a clean report only after approval and deduplicates the approval command', async () => {
    await startWorker();
    const id = await createRun('clean');
    const waiting = await waitForStatus(id, 'WAITING_APPROVAL');
    expect(waiting.reports).toHaveLength(0);
    const op = proposal(waiting);
    expect(op.attempts).toBe(0);

    const approve = approval(op);
    const accepted = await command(id, approve);
    expect(accepted.status).toBe(200);
    expect(await command(id, approve)).toEqual(accepted);
    expect((await command(id, { ...approve, operationId: randomUUID() })).status).toBe(409);

    const done = await waitForStatus(id, 'SUCCEEDED');
    expect(done.reports).toHaveLength(1);
    expect(publisherWrites).toBe(1);
    expect(done.reports[0]).toMatchObject({ operationId: op.id, revision: 1, report: expect.stringContaining('ev_users_name') });
    expect(done.operations).toMatchObject([{ id: op.id, attempts: 1, state: 'CONFIRMED' }]);
    expect(done.events.filter(e => e.type === 'operation.approved')).toHaveLength(1);
  }, 60_000);

  it('recovers a lost HTTP receipt without dispatching a second write', async () => {
    await startWorker();
    const id = await createRun('lost-receipt');
    const op = proposal(await waitForStatus(id, 'WAITING_APPROVAL'));
    expect((await command(id, approval(op))).status).toBe(200);

    const done = await waitForStatus(id, 'SUCCEEDED');
    expect(done.reports).toHaveLength(1);
    expect(publisherWrites).toBe(1);
    expect(done.reports[0].operationId).toBe(op.id);
    expect(done.operations).toMatchObject([{ id: op.id, state: 'CONFIRMED', attempts: 1 }]);
    expect(done.events.filter(e => e.type === 'operation.dispatched')).toHaveLength(1);
    expect(done.events).toContainEqual(expect.objectContaining({
      type: 'operation.recovered',
      detail: expect.objectContaining({ operationId: op.id, staleForCurrentGoal: false }),
    }));
  }, 60_000);

  it('parks an uncertain write without a lookup contract until an operator records evidence', async () => {
    await startWorker();
    const id = await createRun('no-lookup');
    const op = proposal(await waitForStatus(id, 'WAITING_APPROVAL'));
    expect((await command(id, approval(op))).status).toBe(200);

    const waiting = await waitForStatus(id, 'WAITING_RECONCILIATION');
    expect(waiting.reports).toHaveLength(1);
    expect(publisherWrites).toBe(1);
    expect(waiting.operations).toMatchObject([{ id: op.id, state: 'UNKNOWN', attempts: 1 }]);
    expect(waiting.events.some(e => e.type === 'operation.recovered')).toBe(false);
    const note = 'Verified this report in the fixture publisher ledger.';
    const reconcile: Command = { commandId: randomUUID(), expectedRevision: 1, kind: 'reconcile', operationId: op.id, resolution: 'applied', note };
    expect((await command(id, reconcile)).status).toBe(200);

    const done = await waitForStatus(id, 'SUCCEEDED');
    expect(done.reports).toHaveLength(1);
    expect(publisherWrites).toBe(1);
    expect(done.operations).toMatchObject([{ id: op.id, state: 'CONFIRMED', attempts: 1, result: { manuallyAttested: true } }]);
    const exported = await request<unknown>(`/api/runs/${id}/export`);
    expect(exported.status).toBe(200);
    expect(JSON.stringify(exported.data)).not.toContain(note);
    expect(JSON.stringify(exported.data)).not.toContain(fixtureGoal);
    expect(JSON.stringify(exported.data)).not.toContain(JSON.stringify(done.reports[0].report));
  }, 60_000);

  it.skipIf(process.platform === 'win32')('recovers a SIGKILL after the effect without advancing the revised goal', async () => {
    const original = await startWorker({ killAfterEffect: true });
    const id = await createRun('clean');
    const oldOp = proposal(await waitForStatus(id, 'WAITING_APPROVAL'));
    expect((await command(id, approval(oldOp))).status).toBe(200);

    const exit = await poll(() => original.exit, 'worker killed after committing the external effect');
    expect(exit.signal).toBe('SIGKILL');
    const interrupted = await detail(id);
    expect(interrupted.reports).toHaveLength(1);
    expect(publisherWrites).toBe(1);
    expect(interrupted.reports[0]).toMatchObject({ operationId: oldOp.id, revision: 1 });
    expect(interrupted.operations).toMatchObject([{ id: oldOp.id, state: 'IN_FLIGHT', attempts: 1 }]);

    const revise: Command = {
      commandId: randomUUID(), expectedRevision: 1, kind: 'revise',
      goal: 'Compare stable v1 and v2, exclude beta, and include pagination in the cited compatibility report.',
    };
    const revised = await command(id, revise);
    expect(revised.status).toBe(200);
    expect(revised.data).toMatchObject({ revision: 2, status: 'WAITING_RECONCILIATION' });
    expect(await command(id, revise)).toEqual(revised);
    expect((await command(id, approval(oldOp))).status).toBe(409);

    const replacement = await startWorker({ executorId: original.executorId });
    expect(replacement.child.pid).not.toBe(original.child.pid);
    const waiting = await waitForStatus(id, 'WAITING_APPROVAL');
    const newOp = proposal(waiting);
    expect(newOp.id).not.toBe(oldOp.id);
    expect(newOp.revision).toBe(2);
    expect(newOp.args).toMatchObject({ report: expect.stringContaining('ev_orders_limit') });
    expect(waiting.reports).toHaveLength(1);
    expect(publisherWrites).toBe(1);
    expect(waiting.operations.find(o => o.id === oldOp.id)).toMatchObject({ state: 'CONFIRMED', attempts: 1 });
    expect(waiting.events.filter(e => e.type === 'goal.revised')).toHaveLength(1);
    expect(waiting.events).toContainEqual(expect.objectContaining({
      type: 'operation.recovered', revision: 2,
      detail: expect.objectContaining({ operationId: oldOp.id, operationRevision: 1, staleForCurrentGoal: true }),
    }));
    expect(waiting.run.messages.some(m => m.role === 'tool' && m.content.includes(oldOp.id))).toBe(false);
    expect((await command(id, { ...approval(oldOp), expectedRevision: 2 })).status).toBe(409);

    expect((await command(id, approval(newOp))).status).toBe(200);
    const done = await waitForStatus(id, 'SUCCEEDED');
    expect(done.reports).toHaveLength(2);
    expect(publisherWrites).toBe(2);
    expect(done.reports).toEqual(expect.arrayContaining([
      expect.objectContaining({ operationId: oldOp.id, revision: 1 }),
      expect.objectContaining({ operationId: newOp.id, revision: 2 }),
    ]));
    expect(done.operations.every(o => o.state === 'CONFIRMED' && o.attempts === 1)).toBe(true);
  }, 60_000);
});
