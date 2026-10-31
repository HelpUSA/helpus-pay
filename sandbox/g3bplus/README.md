# G3-B+ HelpUS Pay — PostgreSQL transactional fixture

**Isolated preparation only; does not replace deployed `api/sandbox/pix_service.ts` or the G3-B mock server.**

- Disposable PostgreSQL 16 on 127.0.0.1 only, named `g3bplus_*` and user `g3bplus_*`, with `HELPUS_G3BPLUS_LOCAL_ONLY=1`; production is unconditionally rejected.
- `pg_store.mjs` uses transactions and per-key advisory locks for idempotent order + charge creation, cancellation/settlement races, cross-tenant row isolation, durable event replay and ACID outbox.
- `pg_jwt_http.mjs` independently verifies Ed25519 lab JWTs from the pinned HelpUS Auth public JWKS over loopback. Tokens require the right tenant, service ID and scope before any HTTP action.
- `g3lab_outbox` supports at-least-once **synthetic** callback retries. `MANUAL_REVIEW` entries are **not** refunds; no bank is ever contacted or automatically refunded. Failures remain pending for manual disposition.
- State survives new connections/restarted Node workers while the ephemeral PostgreSQL service exists; it is not HA, disaster-recovery or production persistence.
- Test `node --test sandbox/g3bplus/pg_store.test.mjs`, then `node --test sandbox/g3bplus/pg_jwt_http.test.mjs` using pinned Auth checkout. The GitHub Actions workflow provides the disposable database and test credentials, never production secrets.
- Nested `package-lock.json` makes the isolated PostgreSQL driver deterministic; root frontend dependencies are unchanged.

**Remaining operational P0:** identity lifecycle, network deployment model, independent tenants/DB roles, backup/restore, retention, worker leases under real failures, observability, PSP verification, refund governance and risk/security signoff. G3-C is NOT authorized.