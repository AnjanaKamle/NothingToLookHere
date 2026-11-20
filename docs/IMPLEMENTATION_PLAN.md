# Implementation plan

Five phases. Each one ends with something runnable and tested. The design behind it is in
[ARCHITECTURE.md](ARCHITECTURE.md). Phases 3–5 are a working outline; each phase's brief takes
precedence.

## Phase 1 — Foundation ✅

- npm-workspaces monorepo: `apps/api`, `apps/web`, `apps/mobile`, `packages/protocol`.
- PostgreSQL 18 via Docker Compose, plus a separate test database.
- API: config validation, DB pool, `/api/health`, Socket.IO attached (no events yet), Node test runner.
- Web: Vite + React shell, dev proxy for `/api` and `/socket.io`.
- Mobile: Expo SDK 58 app with `expo-dev-client` (development-build workflow).
- Docs: architecture, this plan, README.

## Phase 2 — Database and AP database deliverables ✅

- `db/` workspace: `001_initial_schema.sql` (9 tables, CHECK constraints, transition and write-once
  triggers, justified indexes), a forward-only migration runner with checksums and an advisory lock.
- `db/queries.sql`: all 42 application queries (43 after phase 3) with stable IDs, loaded by ID at runtime.
- One-time challenge approval and consumption as single guarded statements, tested against real
  PostgreSQL, including a two-connection race.
- AP deliverables in `dbms/`: normalization notes, ER diagram (Mermaid source + PNG), generated
  schema and query files. The test suite fails if they drift from the canonical sources.

## Phase 3 — API, cryptographic checks, real-time approval ✅

- Express routes → controllers (zod validation, one error format) → services → catalogued SQL.
- Password sign-in that yields only an enrollment challenge; development-only account script.
- Enrollment with proof of possession; key rotation; device list/revoke; activity log.
- QR challenges with HttpOnly binding cookies and HMAC watch tokens; ES256 verification against the
  registered key; one-time decision and session issuance in single guarded statements.
- Socket.IO: per-challenge rooms, reconnect-safe status ack, expiry events, session revocation push.
- Session listing/revocation, logout; recovery (password + code) with full revocation.
- Signed-message formats and an ES256 test vector in `packages/protocol`.
- docs/API.md, docs/RECOVERY.md. Tests cover the flow, forged/replayed/concurrent requests, and logs.

## Phase 4 — Trusted-phone app and browser client ✅

- Native `device-key` Expo module: Secure Enclave (Swift) and Android Keystore/StrongBox (Kotlin),
  non-exportable, user presence per signature, exportability checked at runtime, no software fallback.
- Phone screens: sign in, recover, enroll, home, scan (camera permission states), approve/reject
  with request details and countdown, browsers (revoke), phones (revoke/remove), recovery codes.
- Browser: QR with countdown and expiry warning, real-time wait with reconnect re-subscription and
  HTTP fallback, approved/rejected/expired/cancelled/failed states, session view with live revocation.
- Fixed: production web builds were bundling React's development build (root `.env` NODE_ENV).
- docs/CLIENTS.md. Swift crypto layer verified against the API; browser flow verified end to end.
  **Not yet verified:** compiling the native modules and running on physical devices.

## Phase 5 — Integration, verification, submission ✅

- Fresh-checkout run of the README (new copy without node_modules or .env, its own PostgreSQL):
  install, migrate, tests, account creation, API health, web build all succeeded.
- `npm run smoke`: end-to-end check against the running dev stack (enrollment through recovery,
  including invalid signature, unknown and revoked devices, duplicate approval, replay, network
  loss, rejection, expiry).
- Docs-consistency test: routes match docs/API.md both ways; all API env vars are in .env.example.
- Log audit: API logs carry no payloads; PostgreSQL now runs with `log_error_verbosity=terse`, so
  constraint errors no longer dump row contents (found during the audit).
- docker-compose: dropped the fixed container name so a second checkout can run side by side.
- AP: measured timings and raw `EXPLAIN (ANALYZE, BUFFERS)` plans for all 43 queries
  (`npm run db:benchmark`, `dbms/05_query_timings.md` and `dbms/plans/`), with analysis in dbms/01 §9 (FK cascade cost of
  the challenge purge).
- README rewritten as the final project guide.

## Still open

- Build and run the phone app on a physical iPhone and Android phone; work through the manual device
  test in docs/CLIENTS.md and fix anything the native compile turns up.
- Open decisions in ARCHITECTURE.md: device certificates, relay mitigation (number matching),
  multi-instance deployment, notifications, Android key attestation, production HTTPS.
