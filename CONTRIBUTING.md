# Contributing

Start with a concrete failure: the input, the timing of the fault, and the invariant that must hold. Small, reproducible changes are easier to review than additional framework integrations.

1. Use Node.js 22.12+ and `npm ci`.
2. Add a regression at the relevant boundary. Pure logic belongs in `tests/`; PostgreSQL/process behavior belongs in `tests/integration/`.
3. Run `npm run verify` and `npm run test:integration`. UI changes should also run the documented browser smoke.
4. Update public behavior and validation limits in the documentation. Do not turn a mocked test into a live-model or scale claim.
5. Open a pull request describing the failure, the change, and commands actually run.

Maintain the core contracts: intent before dispatch; current goal and exact operation approval; unknown outcomes require reconciliation; terminal goals never restart from late results. Keep transient read retries separate from side-effectful writes.

Use synthetic or public fixtures. Never include credentials, personal browser profiles, private repositories, raw production incidents or confidential prompts. Commit no generated databases or environment files. Contributors retain copyright to their contributions under the repository's MIT license.
