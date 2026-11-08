import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRuntimeClient, type RuntimeClient } from '../../src/durable.js';

const databaseUrl = process.env.ARL_TEST_DATABASE_URL;
const project = fileURLToPath(new URL('../../', import.meta.url));
const workerScript = `
  import { attachRuntime, launchRuntime, shutdownRuntime } from './src/durable.ts';
  const attempts = new Map();
  attachRuntime(async (runId) => {
    const count = (attempts.get(runId) ?? 0) + 1;
    attempts.set(runId, count);
    process.send({ runId, count });
    if ((runId.startsWith('transient-') && count === 1) || runId.startsWith('exhausted-')) {
      throw Object.assign(new Error('Synthetic serialization failure'), { code: '40001' });
    }
    if (runId.startsWith('permanent-') && count === 1) {
      throw Object.assign(new Error('Synthetic check constraint violation'), { code: '23514' });
    }
    return 'done';
  });
  await launchRuntime(process.env.ARL_TEST_DATABASE_URL, process.env.ARL_TEST_EXECUTOR_ID);
  process.once('SIGTERM', async () => { await shutdownRuntime(); process.disconnect(); });
  process.send('ready');
`;

async function poll<T>(check: () => Promise<T | undefined> | T | undefined, label: string): Promise<T> {
  const deadline = Date.now() + 10_000;
  do {
    const value = await check();
    if (value !== undefined) return value;
    await sleep(50);
  } while (Date.now() < deadline);
  throw new Error(`Timed out waiting for ${label}`);
}

describe.skipIf(!databaseUrl)('DBOS runtime execution failures', () => {
  let runtime: RuntimeClient | undefined;
  let worker: ChildProcess | undefined;
  let workerExited: Promise<unknown> | undefined;
  const attempts = new Map<string, number>();

  beforeAll(async () => {
    runtime = await createRuntimeClient(databaseUrl!);
    const executorId = `runtime-errors-${randomUUID()}`;
    let ready = false;
    let stopped = false;
    worker = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', workerScript], {
      cwd: project,
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      env: { PATH: process.env.PATH, ARL_TEST_DATABASE_URL: databaseUrl, ARL_TEST_EXECUTOR_ID: executorId },
    });
    workerExited = new Promise(resolve => {
      const end = () => { stopped = true; resolve(undefined); };
      worker!.once('error', end);
      worker!.once('close', end);
    });
    worker.on('message', (message: 'ready' | { runId: string; count: number }) => {
      if (message === 'ready') ready = true;
      else attempts.set(message.runId, message.count);
    });
    await poll(() => {
      if (stopped) throw new Error('Runtime fixture exited before readiness');
      return ready ? true : undefined;
    }, 'runtime fixture readiness');
  }, 60_000);

  afterAll(async () => {
    if (worker && worker.exitCode === null && worker.signalCode === null) {
      worker.kill('SIGTERM');
      const timer = setTimeout(() => worker?.kill('SIGKILL'), 4_000);
      try { await workerExited; } finally { clearTimeout(timer); }
    }
    await runtime?.close();
  }, 15_000);

  async function waitForTerminal(executionId: string) {
    return poll(async () => {
      const status = (await runtime!.workflowStatus(executionId))?.status;
      return status === 'SUCCESS' || status === 'ERROR' ? status : undefined;
    }, 'terminal workflow status');
  }

  async function observedAttempts(runId: string, minimum: number) {
    return poll(() => {
      const count = attempts.get(runId) ?? 0;
      return count >= minimum ? count : undefined;
    }, 'fixture attempt count');
  }

  it('retries a transient serialization failure and succeeds on the second attempt', async () => {
    const id = `transient-${randomUUID()}`;
    const handle = await runtime!.enqueueRun(id);
    expect(handle.workflowID).toBe(id);
    expect(await waitForTerminal(id)).toBe('SUCCESS');
    expect(await observedAttempts(id, 2)).toBe(2);
  }, 15_000);

  it('stops after three attempts when a transient failure persists', async () => {
    const id = `exhausted-${randomUUID()}`;
    await runtime!.enqueueRun(id);
    expect(await waitForTerminal(id)).toBe('ERROR');
    expect(await observedAttempts(id, 3)).toBe(3);
  }, 15_000);

  it('preserves a permanent failure when a new execution reenters the same application run', async () => {
    const runId = `permanent-${randomUUID()}`;
    await runtime!.enqueueRun(runId);
    expect(await waitForTerminal(runId)).toBe('ERROR');
    expect(await observedAttempts(runId, 1)).toBe(1);

    const executionId = randomUUID();
    const db = new Client({ connectionString: databaseUrl });
    await db.connect();
    try {
      await db.query('CREATE TEMP TABLE fixture_run (id text PRIMARY KEY, execution_id text NOT NULL)');
      await db.query('INSERT INTO fixture_run VALUES ($1, $1)', [runId]);
      await db.query('BEGIN');
      await db.query('UPDATE fixture_run SET execution_id=$1 WHERE id=$2', [executionId, runId]);
      const handle = await runtime!.enqueueRun(runId, db, executionId);
      expect(handle.workflowID).toBe(executionId);
      expect(await runtime!.workflowStatus(executionId)).toBeNull();
      await db.query('COMMIT');
      expect((await db.query('SELECT execution_id FROM fixture_run WHERE id=$1', [runId])).rows).toEqual([{ execution_id: executionId }]);
      expect(await waitForTerminal(executionId)).toBe('SUCCESS');
      expect((await runtime!.workflowStatus(runId))?.status).toBe('ERROR');
      expect(await observedAttempts(runId, 2)).toBe(2);
      expect(attempts.has(executionId)).toBe(false);
    } finally {
      await db.end();
    }
  }, 15_000);

  it('rolls back both the execution pointer and enqueue when the application transaction aborts', async () => {
    const runId = randomUUID();
    const executionId = randomUUID();
    const db = new Client({ connectionString: databaseUrl });
    await db.connect();
    try {
      await db.query('CREATE TEMP TABLE fixture_run (id text PRIMARY KEY, execution_id text NOT NULL)');
      await db.query('INSERT INTO fixture_run VALUES ($1, $1)', [runId]);
      await db.query('BEGIN');
      await db.query('UPDATE fixture_run SET execution_id=$1 WHERE id=$2', [executionId, runId]);
      expect((await runtime!.enqueueRun(runId, db, executionId)).workflowID).toBe(executionId);
      await db.query('ROLLBACK');
      expect((await db.query('SELECT execution_id FROM fixture_run WHERE id=$1', [runId])).rows).toEqual([{ execution_id: runId }]);
      expect(await runtime!.workflowStatus(executionId)).toBeNull();
      expect(attempts.has(runId)).toBe(false);
    } finally {
      await db.end();
    }
  }, 15_000);
});
