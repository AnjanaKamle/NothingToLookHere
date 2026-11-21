# Database design and normalization

The database supports a course-size sign-in flow. A user signs in on a phone browser, approves a one-time browser login request, and can later revoke the browser session. The schema is described in Prisma at `prisma/schema.prisma` and as PostgreSQL DDL in `03_schema.sql`.

## Tables and dependencies

- **users:** `id → phone, password_hash, created_at`; `phone` is unique.
- **devices:** `id → user_id, name, created_at, revoked_at`.
- **login_requests:** `id → token_hash, browser_hash, browser_name, status, created_at, expires_at, approval details`; `token_hash` is unique.
- **sessions:** `id → user_id, device_id, login_request_id, type, name, created_at, expires_at, revoked_at`; `device_id` is required, and a non-null `login_request_id` is unique.
- **recovery_codes:** `id → user_id, code_hash, created_at, used_at`; each random code hash is unique.

## First normal form

Every column stores one value. A user's devices and sessions are separate rows, not lists stored on the user. Each request has one status and one expiry time.

## Second normal form

Every table uses one-column primary keys, so non-key columns depend on the complete key. Unique phone numbers, request-token hashes, and session request IDs prevent duplicate facts.

## Third normal form

User details live in `users`; device details live in `devices`; each login request and session has its own row. Other tables refer to these rows by foreign key instead of copying phone numbers or passwords. A browser session points to the request that created it, so that relationship is traceable without duplicating request data.

## Relationships and integrity rules

- One user can have several registered devices and sessions.
- A user can approve several login requests. Each request can be approved by one user and one device.
- A login request creates zero or one browser session; the unique foreign key on `sessions.login_request_id` enforces at most one. Every session records the phone device it belongs to or that approved it.
- A user can hold several one-time recovery codes. Only a hash is stored; using a code marks it used.
- Foreign keys keep related records valid. Deleting a user cascades to their devices and sessions; deleting an approver/device does not erase the request history.
- PostgreSQL enums restrict request status and session type. Check constraints require expiry after creation, require approval details on approved requests, and require a device for a phone session or request for a browser session.
- Indexes support active-device lookups, pending-request expiry checks, a user's active-session list, and expiry cleanup.

## Transaction example

Phone approval uses one database transaction. It changes a request only if the request is still pending and unexpired, then inserts its browser session. The conditional update ensures that two approvals cannot both create a session for the same request. If the insert fails, PostgreSQL rolls the status change back too.

## Scope

This course version does not store public keys, certificates, OAuth identities, or SMS delivery data. Recovery is through random one-time codes shown at registration, not phone-number verification. A phone/password account is a classroom demonstration and the phone number is not verified. The SQL files are the DE-facing explanation; Prisma models and migrations are used by the AP application.
