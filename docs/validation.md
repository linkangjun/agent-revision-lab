# Release validation

Version: **0.1.0-alpha.1**. Validation date: **2026-11-09** (Asia/Shanghai).

## Local results

- Clean lockfile install with Node 22.23.2 and npm 10.9.8.
- TypeScript checks and Vite production build passed.
- 26 unit/UI tests passed: context grouping and budgets, strict arguments, timeouts/retries, mocked model protocol, and UI commands.
- 24 PostgreSQL integration tests passed: real HTTP tool effects, actual worker `SIGKILL` and same-ID replacement; state/command races; failed execution retry; malformed/late receipts; snapshot retention; redacted export; and deadline enforcement after waiting on a row lock.
- The crash test counts actual outbound POSTs, not just deduplicated report rows. After an old effect and a goal revision, the replacement performs a lookup; a new write requires new approval.
- Isolated Microsoft Edge headless browser smoke passed for revision/approval, lost-receipt recovery, manual reconciliation, metadata download, and a 390px layout. The README image is captured from the running local app.
- `npm audit --registry=https://registry.npmjs.org` reported zero advisories in the checked lockfile. This is a dated dependency check, not a security certification.
- The integration launcher was deliberately given an invalid test option and verified to propagate exit code 1. This guards against a native Postgres helper's shutdown hook masking failures.

## Boundaries

The default model is deterministic scripted code. OpenAI requests are protocol-tested with mocked HTTP, not with a paid live account. PostgreSQL, worker processes, HTTP receipts, and the browser in the checks above are real local processes.

The demo report service is synthetic. A real destination must provide its own idempotency and reconciliation contract. No claim is made about arbitrary tools executing exactly once, production tenancy/security, exact provider token accounting, 10,000 concurrent agents, throughput improvements, or independent user adoption.

The Compose definition is included. Local Docker runtime validation was unavailable during development; CI is configured to build and start it and run `scripts/api-smoke.mjs`. Consult the actual CI result for the commit/tag rather than inferring success from the configuration alone.

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
