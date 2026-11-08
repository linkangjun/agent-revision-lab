# Security and deployment boundary

This alpha is a trusted, single-user local workbench. It is not a hosted service. Do not expose the API, database, or demo tool service to other users. There is no user authentication, tenant isolation, or arbitrary-code sandbox. A tool allowlist is not an OS isolation boundary.

The API binds to loopback by default and checks Host/Origin. The separate demo tool service requires an internal process token. The supplied Compose configuration publishes only a loopback web port and uses an isolated development database with trust authentication. These choices are for a local demonstration, not production hardening.

Keep credentials only in your own process environment. Do not attach real prompts or documents to issues. Diagnostic exports omit content bodies, but retain operational metadata and hashes; review them before sharing.

If you find a vulnerability, use GitHub's private vulnerability reporting for this repository when enabled. If unavailable, open a minimal issue requesting a private channel without exploit details, secrets, or affected user data. There is no guaranteed security response SLA in this alpha.

Current recovery bounds: a request already dispatched cannot be recalled; a database ownership fence does not fence an arbitrary external service; unconfirmed writes are never automatically redispatched. Do not use this demonstration for financial or otherwise irreversible operations.
