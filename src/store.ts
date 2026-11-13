import { randomUUID } from 'node:crypto';
import pg, { type PoolClient } from 'pg';
import type { Command, Operation, Run, RunDetail, RunEvent, Scenario } from './contracts.js';
import { canonicalHash } from './core.js';
import type { TickResult } from './durable.js';

export class Conflict extends Error { statusCode = 409; }
export class Invalid extends Error { statusCode = 400; }
export class Missing extends Error { statusCode = 404; }
export const terminal = (status: string) => ['SUCCEEDED', 'FAILED', 'CANCELLED', 'EXPIRED'].includes(status);
export interface Dispatcher {
  enqueueRun(id: string, client?: PoolClient, executionId?: string, delaySeconds?: number): Promise<unknown>;
  enqueueDeadline?(id: string, deadline: string, client: PoolClient): Promise<unknown>;
  workflowStatus?(id: string): Promise<{status:string} | null>;
  wakeRun(id: string, commandId: string, client?: PoolClient): Promise<unknown>;
}
export class Store {
  readonly pool: pg.Pool;
  constructor(databaseUrl: string, readonly dispatcher?: Dispatcher) {
    this.pool = new pg.Pool({ connectionString: databaseUrl, max: 12, connectionTimeoutMillis: 5000 });
    this.pool.on('error', () => { /* Active callers handle query failures; no credentials in logs. */ });
  }
  async init() {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS arl_runs (id text PRIMARY KEY, epoch bigint NOT NULL DEFAULT 0, data jsonb NOT NULL);
      CREATE TABLE IF NOT EXISTS arl_revisions (run_id text NOT NULL REFERENCES arl_runs(id), revision integer NOT NULL, snapshot jsonb NOT NULL, PRIMARY KEY(run_id,revision));
      CREATE TABLE IF NOT EXISTS arl_operations (id text PRIMARY KEY, run_id text NOT NULL REFERENCES arl_runs(id), data jsonb NOT NULL);
      CREATE INDEX IF NOT EXISTS arl_operations_run ON arl_operations(run_id);
      CREATE TABLE IF NOT EXISTS arl_events (id bigserial PRIMARY KEY, run_id text NOT NULL REFERENCES arl_runs(id), revision integer NOT NULL, type text NOT NULL, detail jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
      CREATE INDEX IF NOT EXISTS arl_events_run ON arl_events(run_id, id);
      CREATE TABLE IF NOT EXISTS arl_commands (run_id text NOT NULL REFERENCES arl_runs(id), id text NOT NULL, hash text NOT NULL, result jsonb NOT NULL, PRIMARY KEY(run_id,id));
      CREATE TABLE IF NOT EXISTS arl_demo_reports (operation_id text PRIMARY KEY, run_id text NOT NULL REFERENCES arl_runs(id), revision integer NOT NULL, args_hash text NOT NULL, report text NOT NULL);
    `);
  }
  async tx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const c = await this.pool.connect();
    try { await c.query('BEGIN'); const v = await fn(c); await c.query('COMMIT'); return v; }
    catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; }
    finally { c.release(); }
  }
  async get(id: string, c?: PoolClient, lock = false): Promise<Run> {
    const r = await (c ?? this.pool).query('SELECT data FROM arl_runs WHERE id=$1' + (lock ? ' FOR UPDATE' : ''), [id]);
    if (!r.rowCount) throw new Missing('Run not found');
    return r.rows[0].data;
  }
  async save(run: Run, c: PoolClient) {
    run.updatedAt = new Date().toISOString();
    await c.query('UPDATE arl_runs SET data=$2 WHERE id=$1', [run.id, JSON.stringify(run)]);
  }
  async event(c: PoolClient, run: Run, type: string, detail: Record<string, unknown> = {}) {
    await c.query('INSERT INTO arl_events(run_id,revision,type,detail) VALUES($1,$2,$3,$4)', [run.id, run.revision, type, JSON.stringify(detail)]);
  }
  async operations(id: string, c?: PoolClient): Promise<Operation[]> {
    const r = await (c ?? this.pool).query('SELECT data FROM arl_operations WHERE run_id=$1 ORDER BY data->>\'createdAt\',id', [id]);
    return r.rows.map(x => x.data);
  }
  async putOperation(op: Operation, c: PoolClient) {
    await c.query('INSERT INTO arl_operations(id,run_id,data) VALUES($1,$2,$3) ON CONFLICT(id) DO UPDATE SET data=EXCLUDED.data', [op.id, op.runId, JSON.stringify(op)]);
  }
  async create(input: { goal: string; scenario?: Scenario; model?: string; maxTurns?: number; durationMs?: number }): Promise<Run> {
    if (typeof input.goal !== 'string' || !input.goal.trim() || input.goal.length > 4000) throw new Invalid('Goal must contain 1–4000 characters');
    if (input.scenario && !['clean','lost-receipt','no-lookup'].includes(input.scenario)) throw new Invalid('Unknown scenario');
    if (input.model && !['scripted','openai'].includes(input.model)) throw new Invalid('Unknown model');
    const now = new Date().toISOString();
    const run: Run = { id: randomUUID(), goal: input.goal.trim(), revision: 1, status: 'QUEUED', model: input.model ?? 'scripted', scenario: input.scenario ?? 'clean', turns: 0, maxTurns: input.maxTurns ?? 12, deadline: new Date(Date.now() + (input.durationMs ?? 15 * 60_000)).toISOString(), messages: [], pending: [], final: null, error: null, context: null, createdAt: now, updatedAt: now };
    return this.tx(async c => {
      run.workflowId = run.id;
      await c.query('INSERT INTO arl_runs(id,data) VALUES($1,$2)', [run.id, JSON.stringify(run)]);
      await this.event(c, run, 'run.created', { model: run.model, scenario: run.scenario });
      if (this.dispatcher) {
        await this.dispatcher.enqueueRun(run.id, c);
        await this.dispatcher.enqueueDeadline?.(run.id, run.deadline, c);
      }
      return run;
    });
  }
  async list(): Promise<Run[]> {
    const r = await this.pool.query('SELECT data FROM arl_runs ORDER BY data->>\'createdAt\' DESC LIMIT 100');
    return r.rows.map(x => x.data);
  }
  async detail(id: string): Promise<RunDetail> {
    // A single snapshot prevents UI from mixing goal revisions with stale operation lists.
    return this.tx(async c => {
      await c.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
      const run = await this.get(id, c);
      const operations = await this.operations(id, c);
      const r = await c.query('SELECT id,revision,type,detail,created_at FROM arl_events WHERE run_id=$1 ORDER BY id LIMIT 2000', [id]);
      const events: RunEvent[] = r.rows.map(x => ({ id: Number(x.id), runId: id, revision: x.revision, type: x.type, detail: x.detail, createdAt: x.created_at.toISOString() }));
      const reports = (await c.query('SELECT operation_id AS "operationId",report,revision FROM arl_demo_reports WHERE run_id=$1', [id])).rows;
      return { run, operations, events, reports };
    });
  }
  async command(id: string, cmd: Command): Promise<Run> {
    if (!cmd || typeof cmd.commandId !== 'string' || !/^[\w-]{1,128}$/.test(cmd.commandId) || !Number.isSafeInteger(cmd.expectedRevision)) throw new Invalid('commandId and expectedRevision are required');
    if (!['approve','revise','cancel','reconcile','retry'].includes(cmd.kind)) throw new Invalid('Unknown command');
    const hash = canonicalHash(cmd);
    return this.tx(async c => {
      const run = await this.get(id, c, true);
      const duplicate = await c.query('SELECT hash,result FROM arl_commands WHERE run_id=$1 AND id=$2', [id, cmd.commandId]);
      if (duplicate.rowCount) {
        if (duplicate.rows[0].hash !== hash) throw new Conflict('Command ID was already used with different input');
        return duplicate.rows[0].result as Run;
      }
      if (run.revision !== cmd.expectedRevision) throw new Conflict('Goal changed. Refresh before submitting this command.');
      const ops = await this.operations(id, c);
      // A terminal goal stays terminal, but a stopped execution may still need
      // to look up an already-dispatched write. This exception cannot reopen the goal.
      const receiptRecovery = cmd.kind === 'retry' && ops.some(op => op.state === 'IN_FLIGHT');
      if (terminal(run.status) && cmd.kind !== 'reconcile' && !receiptRecovery) throw new Conflict('Run is terminal; create another run');
      const previousExecution = run.workflowId ?? run.id;
      let retrying = false;
      if (cmd.kind === 'revise') {
        if (typeof cmd.goal !== 'string' || !cmd.goal.trim() || cmd.goal.length > 4000) throw new Invalid('Goal must contain 1–4000 characters');
        await c.query('INSERT INTO arl_revisions(run_id,revision,snapshot) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[id,run.revision,JSON.stringify(run)]);
        run.goal = cmd.goal.trim(); run.revision++; run.messages = []; run.pending = []; run.final = null; run.context = null; run.error = null;
        run.status = ops.some(o => ['IN_FLIGHT','UNKNOWN'].includes(o.state)) ? 'WAITING_RECONCILIATION' : 'RUNNING';
        for (const op of ops) if (['PROPOSED','APPROVED'].includes(op.state)) { op.state = 'ABANDONED'; op.approvedUntil = null; await this.putOperation(op, c); }
        await this.event(c, run, 'goal.revised', { previousRevision: run.revision - 1, approvalsInvalidated: true });
      } else if (cmd.kind === 'retry') {
        if (!this.dispatcher?.workflowStatus) throw new Invalid('Durable execution is not configured');
        if (ops.some(o => o.state === 'UNKNOWN')) throw new Conflict('Reconcile the unknown operation before retrying');
        const execution=await this.dispatcher.workflowStatus(previousExecution);
        if (!execution || !['ERROR','MAX_RECOVERY_ATTEMPTS_EXCEEDED'].includes(execution.status)) throw new Conflict('Execution is not stopped with an error');
        retrying = true;
        run.error=null;
      } else if (cmd.kind === 'cancel') {
        run.status = 'CANCELLED';
        for (const op of ops) if (['PROPOSED','APPROVED'].includes(op.state)) { op.state = 'ABANDONED'; op.approvedUntil = null; await this.putOperation(op, c); }
        await this.event(c, run, 'run.cancelled', { inFlightCannotBeRetracted: ops.some(o => ['IN_FLIGHT','UNKNOWN'].includes(o.state)) });
      } else {
        const op = ops.find(o => o.id === cmd.operationId);
        if (!op) throw new Missing('Operation not found');
        if (cmd.kind === 'approve') {
          if (op.revision !== run.revision || op.state !== 'PROPOSED') throw new Conflict('This proposal is no longer current');
          if (ops.some(o => ['IN_FLIGHT','UNKNOWN'].includes(o.state))) throw new Conflict('Resolve the uncertain operation before approving new work');
          op.state = 'APPROVED'; op.approvedUntil = new Date(Date.now() + 5 * 60_000).toISOString(); run.status = 'RUNNING';
          await this.event(c, run, 'operation.approved', { operationId: op.id, argsHash: op.argsHash, expiresAt: op.approvedUntil });
        } else {
          if (op.state !== 'UNKNOWN') throw new Conflict('Only an uncertain operation can be manually reconciled');
          if (!['applied','not_applied'].includes(cmd.resolution ?? '') || typeof cmd.note !== 'string' || !cmd.note.trim() || cmd.note.length > 1000) throw new Invalid('A resolution and evidence note (1–1000 characters) are required');
          op.state = cmd.resolution === 'applied' ? 'CONFIRMED' : 'ABANDONED';
          op.result = cmd.resolution === 'applied' ? { ok: true, reportId: op.id, revision: op.revision, manuallyAttested: true } : { ok: false, error: 'Operator confirmed no effect; no automatic redispatch' };
          await this.event(c, run, 'operation.manually_reconciled', { operationId: op.id, resolution: cmd.resolution, note: cmd.note });
          if (!terminal(run.status)) run.status = 'RUNNING';
        }
        await this.putOperation(op, c);
      }
      if (this.dispatcher) {
        const hasInFlight = ops.some(op => op.state === 'IN_FLIGHT');
        const current = retrying ? undefined : await this.dispatcher.workflowStatus?.(previousExecution);
        const stoppedWithError = current && ['ERROR','MAX_RECOVERY_ATTEMPTS_EXCEEDED'].includes(current.status);
        // Editing a stopped run is not an implicit error retry. Its persisted
        // changes are read when an explicit retry is accepted.
        if ((!terminal(run.status) || hasInFlight) && (retrying || !stoppedWithError)) {
          run.workflowId = `${id}:command:${canonicalHash(cmd.commandId).slice(0, 32)}`;
          delete run.parkedExecutionId;
          await this.dispatcher.enqueueRun(id, c, run.workflowId);
          if (retrying) await this.storeRecoveryEvent(c,run,previousExecution);
        }
      }
      await this.save(run, c);
      await c.query('INSERT INTO arl_commands(run_id,id,hash,result) VALUES($1,$2,$3,$4)', [id, cmd.commandId, hash, JSON.stringify(run)]);
      return run;
    });
  }
  /** Serialize a wait/command handoff with the same run row used by commands. */
  async settleActivation(id: string, executionId: string, outcome: TickResult): Promise<TickResult> {
    return this.tx(async c => {
      const run = await this.get(id, c, true);
      if ((run.workflowId ?? id) !== executionId) return 'done';
      if (outcome === 'continue' || outcome === 'done') return outcome;
      if (outcome === 'wait' && (terminal(run.status) || run.status === 'WAITING_APPROVAL' || run.status === 'WAITING_RECONCILIATION')) {
        if (run.parkedExecutionId !== executionId) {
          run.parkedExecutionId = executionId;
          await this.event(c, run, 'execution.waiting', { executionId, status: run.status });
          await this.save(run, c);
        }
        return 'done';
      }
      // Advisory-lock contention is distinct from a business wait. Persist a
      // delayed successor so this activation can yield
      // fairly without dropping runnable work or occupying a slot with sleep.
      if (!this.dispatcher) throw new Error('Activation handoff requires a durable dispatcher');
      run.workflowId = `${id}:yield:${canonicalHash(executionId).slice(0, 32)}`;
      delete run.parkedExecutionId;
      await this.dispatcher.enqueueRun(id, c, run.workflowId, 0.2);
      await this.event(c, run, 'execution.yielded', { executionId, successor: run.workflowId });
      await this.save(run, c);
      return 'done';
    });
  }
  /** A deadline activation only expires business state; it never retries effects. */
  async expireRun(id: string): Promise<void> {
    await this.tx(async c => {
      const run = await this.get(id, c, true);
      if (terminal(run.status)) return;
      if (Date.now() < Date.parse(run.deadline)) throw new Error('Deadline activation ran before the run deadline');
      const ops = await this.operations(id, c);
      const execution = await this.dispatcher?.workflowStatus?.(run.workflowId ?? id);
      if (ops.some(op => op.state === 'IN_FLIGHT') ||
        (execution && ['ERROR', 'MAX_RECOVERY_ATTEMPTS_EXCEEDED'].includes(execution.status))) {
        // Keep explicit error retry/recovery reachable. In-flight work must be
        // reconciled first, even if DBOS changes PENDING to ERROR just after our
        // status read. The next successful activation enforces the overdue deadline.
        await this.event(c, run, 'deadline.deferred', { reason: ops.some(op => op.state === 'IN_FLIGHT') ? 'in_flight_operation' : 'execution_error' });
        return;
      }
      run.status = 'EXPIRED';
      for (const op of ops) {
        if (op.state === 'PROPOSED' || op.state === 'APPROVED') {
          op.state = 'ABANDONED'; op.approvedUntil = null;
          await this.putOperation(op, c);
        }
      }
      await this.event(c, run, 'run.expired', { source: 'deadline', unresolvedOperationsPreserved: true });
      await this.save(run, c);
    });
  }
  private async storeRecoveryEvent(c: PoolClient, run: Run, previousExecution: string) {
    await this.event(c,run,'execution.restarted',{previousExecution,executionId:run.workflowId});
  }
  async close() { await this.pool.end(); }
}
