# Release validation

## 0.1.0-alpha.2 — 2026-11-12 (Asia/Shanghai)

- `npm run verify` passed: TypeScript checks, 26 unit/UI tests, and Vite production build.
- `npm run test:integration` passed: 35 tests across six files, using an isolated temporary PostgreSQL database.
- New real-worker regressions cover admission after eight approval waits, deadline expiry without a command, command arrival before execution / during handoff / after completed waiting, cancellation, and an offline approval after worker death. Existing process-kill and actual outbound POST-count tests remain in the suite.
- Additional real-PostgreSQL regressions use mocked dispatch and effects to force advisory-lock contention and deadline recovery states. They verify a durable continuation is requested rather than parking an in-flight operation, and lookup occurs without publish. PENDING, ERROR and MAX_RECOVERY_ATTEMPTS_EXCEEDED cases retain the in-flight recovery path; a stopped execution without effects also requires explicit retry.
- Baseline regressions failed on the old behavior: the ninth run did not reach approval within the test bound, and a 2.5-second deadline remained waiting after 10 seconds with the old 15-second receive. These demonstrate bounded admission/deadline failures, not throughput or real-time timer guarantees.
- Isolated Microsoft Edge headless smoke passed: goal revision, approval, lost-receipt lookup, manual reconciliation, trace download and mobile width.
- npm audit against the official registry completed with zero vulnerabilities for the unchanged dependency lockfile. This is a dated check, not security certification.
- Independent source/test review found no outstanding blocker. This is review evidence, not an additional independent test run.

The workflow contract is versioned for alpha.2. Old pending checkpoints are not migrated; see [upgrade instructions](dbos-notes.md#upgrading-from-alpha1). Expiry can be delayed by queue/worker availability, and is deferred for in-flight writes or execution errors so recovery remains possible. Delayed deadline jobs remain stored until due. The queue still permits eight active workflows. No per-tenant fairness, large-scale capacity or real-model validation was added.

## Historical alpha.1 validation

Version: **0.1.0-alpha.1**. Validation date: **2026-11-09** (Asia/Shanghai).

### Local results

- Clean lockfile install with Node 22.23.2 and npm 10.9.8.
- TypeScript checks and Vite production build passed.
- 26 unit/UI tests passed: context grouping and budgets, strict arguments, timeouts/retries, mocked model protocol, and UI commands.
- 24 PostgreSQL integration tests passed: real HTTP tool effects, actual worker `SIGKILL` and same-ID replacement; state/command races; failed execution retry; malformed/late receipts; snapshot retention; redacted export; and deadline enforcement after waiting on a row lock.
- The crash test counts actual outbound POSTs, not just deduplicated report rows. After an old effect and a goal revision, the replacement performs a lookup; a new write requires new approval.
- Isolated Microsoft Edge headless browser smoke passed for revision/approval, lost-receipt recovery, manual reconciliation, metadata download, and a 390px layout. The README image is captured from the running local app.
- `npm audit --registry=https://registry.npmjs.org` reported zero advisories in the checked lockfile. This is a dated dependency check, not a security certification.
- The integration launcher was deliberately given an invalid test option and verified to propagate exit code 1. This guards against a native Postgres helper's shutdown hook masking failures.

### GitHub Actions results

[CI run 42522479080](https://github.com/linkangjun/agent-revision-lab/actions/runs/42522479080) passed for commit `82a7494960002e0f7b5e396211226f3375337900`: clean install, type checks, all 50 unit/UI and PostgreSQL integration tests, production build, dependency audit, and Docker Compose build/start plus API/worker smoke. The container check used the Ubuntu GitHub-hosted runner and the repository Compose definition.

### Boundaries

The default model is deterministic scripted code. OpenAI requests are protocol-tested with mocked HTTP, not with a paid live account. PostgreSQL, worker processes, HTTP receipts, and the browser in the checks above are real local processes.

The demo report service is synthetic. A real destination must provide its own idempotency and reconciliation contract. No claim is made about arbitrary tools executing exactly once, production tenancy/security, exact provider token accounting, 10,000 concurrent agents, throughput improvements, or independent user adoption.

Local Docker runtime validation was unavailable during development. The Compose path was runtime-verified in the successful GitHub Actions run above using `scripts/api-smoke.mjs`; this smoke does not establish production readiness, cross-host failover, or database disaster recovery.

## Reproduce

```sh
npm ci
npm run verify
npm run test:integration
npm audit --registry=https://registry.npmjs.org
```

`npm run test:integration` provisions an isolated temporary PostgreSQL cluster unless `ARL_TEST_DATABASE_URL` is supplied. The supplied database must be disposable. The browser smoke also writes synthetic runs; use a disposable local demo.

```sh
npm run demo
# In another terminal, with Microsoft Edge installed:
node tests/e2e/smoke.mjs
```
