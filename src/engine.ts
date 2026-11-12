import type { PoolClient } from 'pg';
import type { Model, Operation, Run, ToolCall, ToolSpec } from './contracts.js';
import { buildContext, canonicalHash, validateCall, withTimeout } from './core.js';
import { Store, terminal } from './store.js';
import { scriptedModel, createOpenAIModel } from './models.js';

export const tools: ToolSpec[] = [
  { name: 'inspect_specs', description: 'Read the synthetic stable v1/v2 API evidence. Beta endpoints are excluded. Cite evidence IDs in the report.', effect: 'read', parameters: { type: 'object', properties: { includePagination: { type: 'boolean' } }, required: ['includePagination'], additionalProperties: false } },
  { name: 'publish_report', description: 'Publish the report after a human approves this exact operation. Include ev_users_name, and ev_orders_limit if pagination was requested. Requires approval.', effect: 'write', parameters: { type: 'object', properties: { report: { type: 'string', minLength: 20, maxLength: 12000 } }, required: ['report'], additionalProperties: false } },
];
export const inspectSpecs = (includePagination: boolean) => ({ ok: true, scope: 'stable', excluded: ['beta'], includePagination, evidence: [
  { id: 'ev_users_name', resource: 'synthetic/stable-v1.json -> synthetic/stable-v2.json', pointer: '/users/name', before: 'required', after: 'removed' },
  ...(includePagination ? [{ id: 'ev_orders_limit', resource: 'synthetic/stable-v1.json -> synthetic/stable-v2.json', pointer: '/orders/limit', before: 100, after: 50 }] : []),
] });
export interface Effects {
  publish(operation: Operation, signal: AbortSignal): Promise<unknown>;
  lookup(operation: Operation, signal: AbortSignal): Promise<{ found: boolean; result?: unknown }>;
}
export interface EngineOptions { model?: Model; effects: Effects; callTimeoutMs?: number; allowedTools?: string[]; afterEffect?: (op: Operation) => Promise<void> }
class SupersededActivation extends Error {}
export class Engine {
  constructor(readonly store: Store, readonly options: EngineOptions) {}
  async tick(id: string, executionId?: string): Promise<'continue' | 'wait' | 'busy' | 'done'> {
    const lock = await this.store.pool.connect();
    let held = false;
    const controller = new AbortController();
    const lost = () => controller.abort(new Error('Database ownership connection lost'));
    const receiptMatches = (op: Operation, result: unknown) => {
      const r = result as {ok?: boolean; reportId?: string; revision?: number} | null;
      return !!r && r.ok === true && r.reportId === op.id && r.revision === op.revision;
    };
    lock.on('error', lost);
    try {
      const r = await lock.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS held', ['arl:' + id]);
      held = r.rows[0].held;
      if (!held) return 'busy';
      const claim = await lock.query(
        'UPDATE arl_runs SET epoch=epoch+1 WHERE id=$1 AND ($2::text IS NULL OR COALESCE(data->>\'workflowId\',id)=$2) RETURNING epoch',
        [id, executionId ?? null],
      );
      if (!claim.rowCount) return 'done';
      const epoch = String(claim.rows[0].epoch);
      const mutate = async <T>(fn: (run: Run, c: PoolClient) => Promise<T>): Promise<T> => this.store.tx(async c => {
        const run = await this.store.get(id, c, true);
        if (executionId && (run.workflowId ?? id) !== executionId) throw new SupersededActivation();
        const actual = String((await c.query('SELECT epoch FROM arl_runs WHERE id=$1', [id])).rows[0].epoch);
        if (controller.signal.aborted || actual !== epoch) throw new Error('Execution ownership changed');
        const value = await fn(run, c); await this.store.save(run, c); return value;
      });
      let run = await this.store.get(id);
      const ops = await this.store.operations(id);
      // An intent left in flight is never blindly replayed, even if its goal is current.
      const uncertain = ops.find(o => o.state === 'IN_FLIGHT');
      if (uncertain) {
        let found: {found: boolean; result?: unknown} = { found: false };
        if (run.scenario !== 'no-lookup') {
          try { found = await withTimeout(s => this.options.effects.lookup(uncertain, s), this.options.callTimeoutMs ?? 10_000, controller.signal); }
          catch { /* A failed lookup is still uncertainty, not permission to write. */ }
        }
        await mutate(async (live, c) => {
          const op = (await this.store.operations(id, c)).find(o => o.id === uncertain.id)!;
          if (op.state !== 'IN_FLIGHT') return;
          if (found.found && receiptMatches(op, found.result)) await this.confirm(live, op, found.result, c, true);
          else {
            op.state = 'UNKNOWN'; await this.store.putOperation(op, c);
            if (!terminal(live.status)) live.status = 'WAITING_RECONCILIATION';
            await this.store.event(c, live, 'operation.uncertain', { operationId: op.id, operationRevision: op.revision, reason: run.scenario === 'no-lookup' ? 'Tool has no lookup contract' : 'Lookup did not confirm an outcome', automaticRedispatch: false });
          }
        });
        return 'continue';
      }
      if (terminal(run.status)) return 'done';
      if (Date.now() >= Date.parse(run.deadline)) {
        await mutate(async (live, c) => { if (!terminal(live.status)) { live.status = 'EXPIRED'; await this.store.event(c, live, 'run.expired'); } }); return 'done';
      }
      if (ops.some(o => o.state === 'UNKNOWN')) return 'wait';
      const pending = run.pending[0];
      if (pending) {
        const spec = tools.find(t => t.name === pending.name);
        const validation = validateCall(pending, tools);
        if (!validation.ok || !spec || !(this.options.allowedTools ?? tools.map(t => t.name)).includes(pending.name)) {
          await mutate(async (live, c) => {
            if (live.revision !== run.revision || terminal(live.status)) return;
            this.result(live, pending, { ok: false, error: validation.ok ? 'Tool permission denied' : validation.error });
            await this.store.event(c, live, 'tool.rejected', { tool: spec?.name ?? 'unknown', reason: validation.ok ? 'permission_denied' : 'invalid_arguments' });
          }); return 'continue';
        }
        if (spec.effect === 'read') {
          const output = inspectSpecs((pending.arguments as {includePagination: boolean}).includePagination);
          await mutate(async (live, c) => {
            if (live.revision !== run.revision || terminal(live.status)) return;
            this.result(live, pending, output); await this.store.event(c, live, 'tool.completed', { tool: pending.name, callId: pending.id, evidenceCount: output.evidence.length });
          }); return 'continue';
        }
        const operationId = `${id}:r${run.revision}:${canonicalHash(pending.id).slice(0,24)}`;
        let op = ops.find(o => o.id === operationId);
        if (!op) {
          await mutate(async (live, c) => {
            if (live.revision !== run.revision || terminal(live.status)) return;
            const report = (pending.arguments as {report: string}).report;
            // This example's completion contract requires evidence actually read in this revision.
            const evidenceIds = live.messages.filter(m => m.role === 'tool').flatMap(m => {
              try { const data = JSON.parse(m.content); return Array.isArray(data.evidence) ? data.evidence.map((e: {id: string}) => e.id) : []; } catch { return []; }
            });
            if (!evidenceIds.includes('ev_users_name') || !evidenceIds.every((e: string) => report.includes(e))) {
              this.result(live, pending, { ok: false, error: 'Read the specs first and cite every returned evidence ID in the report.' });
              await this.store.event(c, live, 'tool.rejected', { tool: pending.name, reason: 'missing_evidence' }); return;
            }
            op = { id: operationId, runId: id, revision: live.revision, callId: pending.id, tool: pending.name, args: pending.arguments, argsHash: canonicalHash(pending.arguments), state: 'PROPOSED', result: null, attempts: 0, approvedUntil: null, createdAt: new Date().toISOString() };
            await this.store.putOperation(op, c); live.status = 'WAITING_APPROVAL';
            await this.store.event(c, live, 'operation.proposed', { operationId, argsHash: op.argsHash });
          }); return 'continue';
        }
        if (op.state === 'PROPOSED') return 'wait';
        if (op.state === 'CONFIRMED' || op.state === 'ABANDONED') {
          await mutate(async (live, c) => {
            if (live.revision !== run.revision || terminal(live.status)) return;
            this.result(live, pending, op!.result ?? {ok:false,error:'Operation abandoned; approval is no longer valid'});
            await this.store.event(c, live, 'tool.receipt_reused', { operationId });
          }); return 'continue';
        }
        if (op.state !== 'APPROVED') return 'wait';
        const claimed = await mutate(async (live, c) => {
          const current = (await this.store.operations(id, c)).find(o => o.id === operationId)!;
          if (live.revision !== current.revision || terminal(live.status) || current.state !== 'APPROVED') return false;
          if (Date.parse(live.deadline) <= Date.now()) { live.status = 'EXPIRED'; await this.store.event(c, live, 'run.expired'); return false; }
          if (canonicalHash(current.args) !== current.argsHash) throw new Error('Operation argument integrity failure');
          if (!current.approvedUntil || Date.parse(current.approvedUntil) <= Date.now()) {
            current.state = 'PROPOSED'; current.approvedUntil = null; await this.store.putOperation(current, c); live.status = 'WAITING_APPROVAL';
            await this.store.event(c, live, 'approval.expired', { operationId }); return false;
          }
          current.state = 'IN_FLIGHT'; current.attempts++; await this.store.putOperation(current, c); live.status = 'RUNNING';
          await this.store.event(c, live, 'operation.dispatched', { operationId, operationRevision: current.revision, epoch }); op = current; return true;
        });
        if (!claimed) return 'continue';
        // Claim and network dispatch cannot be atomic with an arbitrary remote system.
        // A concurrent revision can only prevent future dispatches; this one must be reconciled.
        try {
          const result = await withTimeout(s => this.options.effects.publish(op!, s), Math.min(this.options.callTimeoutMs ?? 10_000, Math.max(1, Date.parse(run.deadline) - Date.now())), controller.signal);
          if (!receiptMatches(op, result)) throw new Error('Invalid external receipt');
          await this.options.afterEffect?.(op);
          await mutate(async (live, c) => {
            const current = (await this.store.operations(id, c)).find(o => o.id === operationId)!;
            if (current.state === 'IN_FLIGHT') await this.confirm(live, current, result, c, false);
          });
        } catch {
          // Leave intent in flight; a later durable step looks it up. Never issue a second write.
          await mutate(async (live, c) => { await this.store.event(c, live, 'operation.receipt_missing', { operationId, automaticRedispatch: false }); });
        }
        return 'continue';
      }
      if (run.turns >= run.maxTurns) {
        await mutate(async (live, c) => { if (!terminal(live.status)) { live.status = 'FAILED'; live.error = 'Model turn budget exhausted'; await this.store.event(c, live, 'run.budget_exhausted'); } }); return 'done';
      }
      let projected;
      try { projected = buildContext(run.goal, run.revision, run.messages, tools); }
      catch {
        await mutate(async (live, c) => { if (live.revision === run.revision && !terminal(live.status)) { live.status = 'FAILED'; live.error = 'Required context cannot fit the configured budget'; await this.store.event(c, live, 'context.rejected'); } }); return 'continue';
      }
      const canCall = await mutate(async (live, c) => {
        if (live.revision !== run.revision || terminal(live.status)) return false;
        if (Date.parse(live.deadline) <= Date.now()) { live.status = 'EXPIRED'; await this.store.event(c, live, 'run.expired'); return false; }
        live.turns++; live.context = projected; live.status = 'RUNNING';
        await this.store.event(c, live, 'model.requested', { turn: live.turns, estimatedTokens: projected.estimatedTokens, omittedMessages: projected.omittedMessages, tokenCounter: projected.tokenCounter }); return true;
      });
      if (!canCall) return 'continue';
      try {
        const model = this.options.model ?? (run.model === 'openai' ? createOpenAIModel() : scriptedModel);
        const reply = await withTimeout(s => model.respond(projected.messages, tools, s), Math.min(this.options.callTimeoutMs ?? 30_000, Math.max(1, Date.parse(run.deadline) - Date.now())), controller.signal);
        await mutate(async (live, c) => {
          if (live.revision !== run.revision || terminal(live.status)) { await this.store.event(c, live, 'model.result_stale', { responseRevision: run.revision }); return; }
          if (Date.parse(live.deadline) <= Date.now()) { live.status = 'EXPIRED'; await this.store.event(c, live, 'run.expired'); return; }
          if (reply.stop === 'length') { live.status = 'FAILED'; live.error = 'Model output was truncated; no tool arguments were executed'; await this.store.event(c, live, 'model.truncated'); return; }
          if (reply.stop === 'tools') {
            if (!reply.calls.length || reply.calls.length > 8 || new Set(reply.calls.map(x => x.id)).size !== reply.calls.length || reply.calls.some(x => !/^[\w-]{1,128}$/.test(x.id) || live.messages.some(m => m.toolCalls?.some(t => t.id === x.id)))) {
              live.status = 'FAILED'; live.error = 'Invalid or reused tool call IDs'; return;
            }
            live.messages.push({ role: 'assistant', content: reply.text, toolCalls: reply.calls }); live.pending = reply.calls;
            await this.store.event(c, live, 'model.tools_requested', { tools: reply.calls.map(x => tools.some(t => t.name === x.name) ? x.name : 'unknown') });
          } else {
            const completed = (await this.store.operations(id, c)).some(o => o.revision === live.revision && o.state === 'CONFIRMED');
            live.messages.push({ role: 'assistant', content: reply.text });
            live.status = completed ? 'SUCCEEDED' : 'FAILED'; live.final = reply.text;
            live.error = completed ? null : 'Model stopped before an approved report was confirmed';
            await this.store.event(c, live, completed ? 'run.succeeded' : 'run.incomplete');
          }
        });
      } catch {
        await mutate(async (live, c) => {
          if (live.revision !== run.revision || terminal(live.status)) return;
          live.status = Date.parse(live.deadline) <= Date.now() ? 'EXPIRED' : 'FAILED'; live.error = 'Model request failed or timed out. Inspect adapter configuration; start a new run to retry.';
          await this.store.event(c, live, 'model.failed');
        });
      }
      return 'continue';
    } catch (error) {
      // A command installed a newer activation. Any already-sent effect keeps
      // its IN_FLIGHT intent; the new activation reconciles it before dispatch.
      if (error instanceof SupersededActivation) return 'done';
      throw error;
    } finally {
      if (held) await lock.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', ['arl:' + id]).catch(() => {});
      lock.removeListener('error', lost);
      lock.release(controller.signal.aborted);
    }
  }
  private result(run: Run, call: ToolCall, result: unknown) {
    if (run.pending[0]?.id !== call.id) return;
    run.messages.push({ role: 'tool', content: JSON.stringify(result), toolCallId: call.id });
    run.pending.shift(); run.status = 'RUNNING';
  }
  private async confirm(run: Run, op: Operation, result: unknown, c: PoolClient, recovered: boolean) {
    op.state = 'CONFIRMED'; op.result = result; await this.store.putOperation(op, c);
    const stale = op.revision !== run.revision || terminal(run.status);
    if (!stale && run.pending[0]?.id === op.callId) this.result(run, run.pending[0], result);
    if (!terminal(run.status) && !(await this.store.operations(run.id, c)).some(o => ['UNKNOWN','IN_FLIGHT'].includes(o.state))) run.status = 'RUNNING';
    await this.store.event(c, run, recovered ? 'operation.recovered' : 'operation.confirmed', { operationId: op.id, operationRevision: op.revision, staleForCurrentGoal: stale });
  }
}
