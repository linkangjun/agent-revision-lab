# Durable execution with DBOS

The alpha uses the public API of `@dbos-inc/dbos-sdk@5.4.0` and one PostgreSQL database. No Enterprise suspend feature is required. The API initializes the DBOS schema before starting workers. Each worker uses a **different stable executor ID**. All execution and deadline jobs share one queue with a global limit of eight active workflows.

## Short executions and waiting runs

A business run and its durable execution are separate. An execution advances the engine until it finishes or needs external input. At an approval or reconciliation wait, that execution completes, releasing its queue slot. A successful execution checkpoint does **not** mean the business run succeeded: the workbench derives the result from the application run status.

Run creation and its initial DBOS enqueue commit together. Commands serialize on the run row and commit both their state change and the next execution enqueue together. Repeating the same command ID returns the recorded response without scheduling another execution. The application stores the current execution ID; superseded executions cannot advance it. Temporary lock contention is retried through a delayed continuation rather than treated as an approval wait.

A separate, delayed deadline job is enqueued at run creation on the same queue. It checks the current business state and expires a normally waiting run even when no new command arrives. An in-flight write or an errored execution defers expiry to preserve the explicit recovery/retry path; the next recovered execution reconciles any in-flight intent before enforcing the overdue deadline. It does not authorize a model call or a new write. This is eventual expiry after the deadline, subject to worker availability and queue scheduling, not a real-time timer guarantee.

Each tick remains a DBOS step with at most three attempts for explicitly transient failures. Integrity and validation failures stop that execution. A later attempt reads the current goal, approval and operation ledger. An uncertain external write is looked up or left for manual reconciliation; it is never blindly sent again. DBOS checkpoints do not guarantee exactly-once effects at an arbitrary HTTP service.

## Recovering a stopped worker

Worker startup re-enqueues pending workflows assigned to its executor ID and application version. Confirm that the original process is stopped, then start a replacement with the **same executor ID**. Do not run two workers with that ID at once. An approval wait whose short execution already completed does not need crash recovery; its next command creates another execution.

An operator can also recover a specific pending execution from a confirmed-dead executor using `RuntimeClient.recoverRun(executionId, deadExecutorId)`. It checks assignment and version before re-enqueuing through the public DBOS client. Those calls are not an atomic ownership transfer. Keep the old worker stopped and coordinate recovery with any restarts; do not use this to take work from a live or partitioned worker.

Independent executors can take queued work. This release does not automatically detect another executor's failure. DBOS ownership and application generation checks cannot retract HTTP requests already sent. Their receipts remain facts to reconcile against the operation ledger.

## Retrying a failed execution

An execution that ends in `ERROR` or `MAX_RECOVERY_ATTEMPTS_EXCEEDED` stays available for inspection. Address the cause before issuing the explicit retry command. It atomically creates a new execution for the same run and retains the goal, revision and operation history. Ordinary commands and the deadline job must not silently retry an errored execution. Resolve unknown operations before retrying.

## Upgrading from alpha.1

The workflow contract changed in alpha.2. Finish existing runs with the alpha.1 API and workers before upgrading. Do not mix API/worker versions or expect old checkpoints to migrate automatically. For the synthetic local demo, using a fresh disposable database is the simplest upgrade path. Back up or retain any records you need before choosing a new database; upgrading does not authorize deletion of existing data.

## Limits

Waiting releases execution capacity, but this is not a fairness or throughput guarantee. Each run retains a delayed deadline job until it becomes eligible, even if the run finished sooner; it then exits without changing terminal state. Execution and command history grow with activity. There is no history-retention service, tenant isolation, rate-budget policy, or 10,000-run benchmark.

References: [DBOS TypeScript client](https://docs.dbos.dev/typescript/reference/client), [DBOS queues](https://docs.dbos.dev/typescript/tutorials/queue-tutorial), and [SDK 5.4.0](https://www.npmjs.com/package/@dbos-inc/dbos-sdk/v/5.4.0).
