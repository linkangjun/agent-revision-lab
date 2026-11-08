# Durable execution with DBOS

The alpha uses the public API of `@dbos-inc/dbos-sdk@5.4.0` and one PostgreSQL database. The API initializes the DBOS schema through `DBOS.migrate` before starting workers. Each worker registers the same workflow and queue and uses a **different stable executor ID**. Multiple workers share the queue's global limit of eight running workflows. A waiting workflow still occupies one slot in this alpha; the limit is not a model request limit.

## What a checkpoint means

The first DBOS workflow ID is the application run ID. The API can enqueue it inside the same PostgreSQL transaction that creates the run. User commands can likewise commit their state changes and their wake notifications together. A notification targets the current execution and tells the worker to read the application run state; the message itself does not authorize a goal or an operation.

Each tick runs as one DBOS step. It gets at most three attempts (one initial attempt and up to two retries with delays of one and two seconds). Retries are limited to explicitly transient errors and a short allowlist of PostgreSQL and network error codes, such as serialization failure or connection reset. Integrity and validation failures stop the workflow. Each attempt reads fresh application state, checks the current goal and authorization, and consults the persisted operation intent. If a write was already dispatched, it looks for a receipt or records uncertainty. DBOS does not guarantee that an HTTP request has exactly one effect.

The workflow uses a bounded durable receive when waiting for input. A command sent before the worker reaches the receive remains queued. The timeout triggers another state read so the worker can also enforce the run deadline. Waiting remains subject to the queue capacity described above.

## Recovering a stopped worker

In self-hosted SDK 5.4.0, worker startup re-enqueues pending workflows for its own executor ID and application version. For a crash, confirm that the original process is stopped, then start a replacement with the **same executor ID**. Do not run two workers with that ID at once.

An operator can also recover a specific pending execution from a confirmed-dead executor using `RuntimeClient.recoverRun(executionId, deadExecutorId)`. It checks the execution's DBOS assignment and application version, then asks the public DBOS client to re-enqueue it. This check and re-enqueue are separate calls. Keep the original process stopped and coordinate recovery with any restarts. Do not use this method to move work off a live or possibly partitioned worker.

Independent executors can take new work from the shared queue. This release does not automatically detect the failure of a different executor. DBOS ownership guards DBOS checkpoints; it does not cancel requests already sent to external systems. Application code still has to enforce its own state and operation rules.

## Retrying a failed execution

If the active DBOS workflow ends in `ERROR` or `MAX_RECOVERY_ATTEMPTS_EXCEEDED`, inspect and address the cause before requesting a retry. The retry command updates the run's current execution ID and enqueues a new workflow in one PostgreSQL transaction. The application run ID and its state, goal, approvals, and operation history are preserved. The new workflow reads that state on entry; it does not replay the failed workflow's checkpoints. The previous workflow remains available with its original terminal status. Pending workflows use the stopped-worker recovery path above.

The application version pins the workflow contract. Drain or finish old runs with compatible workers before replacing a build that changes step ordering or tool contracts. No automatic cross-version migration is configured.

References: [DBOS TypeScript client](https://docs.dbos.dev/typescript/reference/client), [DBOS queues](https://docs.dbos.dev/typescript/tutorials/queue-tutorial), and [SDK 5.4.0](https://www.npmjs.com/package/@dbos-inc/dbos-sdk/v/5.4.0).
