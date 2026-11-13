import { DBOS, DBOSClient, type WorkflowHandle } from '@dbos-inc/dbos-sdk';
import type { ClientBase } from 'pg';
import { TransientError } from './core.js';

export const APPLICATION_NAME = 'agent-revision-lab';
// Durable checkpoint contract version, not the package release version.
// alpha.3 changes command authorization only and preserves alpha.2 checkpoints.
export const APPLICATION_VERSION = '0.1.0-alpha.2';
export const RUN_QUEUE = 'agent-revision-lab-runs';
const RUN_WORKFLOW = 'advanceAgentActivationV1';
const DEADLINE_WORKFLOW = 'expireAgentRun';
const WAKE_TOPIC = 'wake';
const RETRYABLE_CODES = new Set([
  '40001', '40P01', '55P03', // Serialization failure, deadlock, unavailable lock.
  '08000', '08001', '08003', '08006', '53300', '57P01', '57P02', '57P03',
  'ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'ETIMEDOUT', 'EPIPE', 'EAI_AGAIN',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET',
]);

export type TickResult = 'continue' | 'wait' | 'busy' | 'done';
export type RuntimeTick = (runId: string, executionId: string) => Promise<TickResult>;
export interface RuntimeHooks {
  settle(runId: string, executionId: string, outcome: TickResult): Promise<TickResult>;
  expire(runId: string): Promise<void>;
}

export interface RuntimeClient {
  /** When provided, transaction must be open on the same PostgreSQL database as DBOS. */
  enqueueRun(runId: string, transaction?: ClientBase, executionId?: string, delaySeconds?: number): Promise<WorkflowHandle<void>>;
  enqueueDeadline(runId: string, deadline: string, transaction: ClientBase): Promise<WorkflowHandle<void>>;
  /** Notifications wake the workflow; the application database holds authoritative command state. */
  wakeRun(executionId: string, commandId: string, transaction?: ClientBase): Promise<void>;
  /** Operator action: use only after confirming the named executor has stopped. */
  recoverRun(executionId: string, deadExecutorId: string): Promise<WorkflowHandle<void>>;
  workflowStatus(executionId: string): Promise<{ status: string; executorId?: string } | null>;
  close(): Promise<void>;
}

let attachedTick: RuntimeTick | undefined;

function shouldRetryTick(error: unknown): boolean {
  // Fetch can wrap a network error in a TypeError. Check a bounded cause chain
  // without treating every TypeError, timeout message, or SQL error as transient.
  for (let depth = 0; depth < 4 && error instanceof Error; depth++) {
    if (error instanceof TransientError) return true;
    if ('code' in error && typeof error.code === 'string') return RETRYABLE_CODES.has(error.code);
    error = error.cause;
  }
  return false;
}

/** Bind the application step implementation before launching DBOS in a worker process. */
export function attachRuntime(tick: RuntimeTick, hooks?: RuntimeHooks): void {
  if (attachedTick === tick) return;
  if (attachedTick) throw new Error('A runtime is already attached to this process');
  if (DBOS.isInitialized()) throw new Error('Attach the runtime before starting the worker');

  DBOS.registerWorkflow(async (runId: string): Promise<void> => {
    for (;;) {
      // Only the outcome is checkpointed. An interrupted tick reloads application
      // state and checks authorization on its next dispatch. The app's operation
      // ledger, rather than this checkpoint, governs external writes.
      const outcome = await DBOS.runStep(async () => {
        const result = await tick(runId, DBOS.workflowID!);
        return hooks ? hooks.settle(runId, DBOS.workflowID!, result) : result;
      }, {
        name: 'advance-run-v1',
        retriesAllowed: true,
        maxAttempts: 3,
        intervalSeconds: 1,
        backoffRate: 2,
        shouldRetry: shouldRetryTick,
      });
      // A business wait completes this activation and releases its queue slot.
      // Commands and deadlines enqueue independent activations transactionally.
      if (outcome !== 'continue') return;
    }
  }, { name: RUN_WORKFLOW });
  DBOS.registerWorkflow(async (runId: string): Promise<void> => {
    if (!hooks) throw new Error('The deadline workflow requires application hooks');
    await DBOS.runStep(() => hooks.expire(runId), {
      name: 'expire-run-v1', retriesAllowed: true, maxAttempts: 3,
      intervalSeconds: 1, backoffRate: 2, shouldRetry: shouldRetryTick,
    });
  }, { name: DEADLINE_WORKFLOW });
  attachedTick = tick;
}

/** Start a worker after the API has initialized the database. */
export async function launchRuntime(databaseUrl: string, executorId = 'lab-local'): Promise<void> {
  if (!attachedTick) throw new Error('Attach the runtime before starting the worker');
  if (DBOS.isInitialized()) throw new Error('A runtime is already running in this process');
  if (!executorId.trim()) throw new Error('The worker needs a stable, nonempty executor ID');

  DBOS.setConfig({
    name: APPLICATION_NAME,
    applicationVersion: APPLICATION_VERSION,
    systemDatabaseUrl: databaseUrl,
    executorID: executorId,
    listenQueues: [RUN_QUEUE],
    runMigrations: false,
    logLevel: 'warn',
  });
  try {
    await DBOS.launch();
    await DBOS.registerQueue(RUN_QUEUE, { globalConcurrency: 8, minPollingIntervalMs: 200 });
  } catch (error) {
    if (DBOS.isInitialized()) await DBOS.shutdown().catch(() => undefined);
    throw error;
  }
}

export async function shutdownRuntime(): Promise<void> {
  if (DBOS.isInitialized()) await DBOS.shutdown({ workflowCompletionTimeoutMS: 2_000 });
}

/** Open an enqueue/notify client. This does not start a worker. */
export async function createRuntimeClient(
  databaseUrl: string,
  options: { migrate?: boolean } = {},
): Promise<RuntimeClient> {
  if (options.migrate !== false) await DBOS.migrate(databaseUrl);
  const client = await DBOSClient.create({
    systemDatabaseUrl: databaseUrl,
    applicationName: APPLICATION_NAME,
    systemDatabasePoolSize: 4,
  });

  return {
    enqueueRun(runId, transaction, executionId = runId, delaySeconds = 0) {
      const enqueue = {
        queueName: RUN_QUEUE,
        workflowName: RUN_WORKFLOW,
        workflowID: executionId,
        appVersion: APPLICATION_VERSION,
        workflowIDReusePolicy: 'return-existing' as const,
        delaySeconds,
      };
      return transaction
        ? client.enqueueInTransaction<(id: string) => Promise<void>>(transaction, enqueue, runId)
        : client.enqueue<(id: string) => Promise<void>>(enqueue, runId);
    },
    enqueueDeadline(runId, deadline, transaction) {
      const deadlineMs = Date.parse(deadline);
      if (!Number.isFinite(deadlineMs)) throw new Error('A valid run deadline is required');
      return client.enqueueInTransaction<(id: string) => Promise<void>>(transaction, {
        queueName: RUN_QUEUE, workflowName: DEADLINE_WORKFLOW,
        workflowID: `${runId}:deadline`, appVersion: APPLICATION_VERSION,
        workflowIDReusePolicy: 'return-existing',
        delaySeconds: Math.max(0, (deadlineMs - Date.now()) / 1000),
      }, runId);
    },
    wakeRun(executionId, commandId, transaction) {
      // The command ledger handles repeats after a notification was consumed.
      const notificationId = `agent-revision-lab:${commandId}`;
      return transaction
        ? client.sendInTransaction(transaction, executionId, commandId, WAKE_TOPIC, notificationId)
        : client.send(executionId, commandId, WAKE_TOPIC, notificationId);
    },
    async recoverRun(executionId, deadExecutorId) {
      if (!deadExecutorId.trim()) throw new Error('A stopped executor ID is required for recovery');
      const workflow = await client.getWorkflow(executionId);
      if (
        workflow?.applicationName !== APPLICATION_NAME ||
        workflow.applicationVersion !== APPLICATION_VERSION ||
        workflow.workflowName !== RUN_WORKFLOW ||
        workflow.queueName !== RUN_QUEUE ||
        workflow.status !== 'PENDING' ||
        workflow.executorId !== deadExecutorId
      ) {
        throw new Error('Run is not pending on the specified executor and compatible application version');
      }
      // Checking ownership and re-enqueuing are not a liveness detector or a
      // compare-and-swap. The operator must keep the old worker stopped.
      return client.resumeWorkflow<void>(executionId, { queueName: RUN_QUEUE });
    },
    async workflowStatus(executionId) {
      const workflow = await client.getWorkflow(executionId);
      return workflow?.applicationName === APPLICATION_NAME && workflow.workflowName === RUN_WORKFLOW
        ? { status: workflow.status, executorId: workflow.executorId }
        : null;
    },
    close: () => client.destroy(),
  };
}
