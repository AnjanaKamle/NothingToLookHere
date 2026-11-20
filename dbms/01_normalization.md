# 01 — Normalization, functional dependencies and design choices

Database for **sem3 Capstone**, a QR handoff authentication system. A user enrolls a trusted phone
holding a hardware-protected key pair. A browser shows a short-lived QR challenge, the phone signs
it, and the browser receives a session.

| Deliverable                   | File                                                                                   |
| ----------------------------- | -------------------------------------------------------------------------------------- |
| Normalization & design (this) | `dbms/01_normalization.md`                                                             |
| ER diagram                    | `dbms/02_er_diagram.png` (editable source `dbms/02_er_diagram.mmd`)                    |
| Final schema                  | `dbms/03_schema.sql`: generated from `db/migrations/*.sql`                             |
| Application queries           | `dbms/04_queries.sql`: generated from `db/queries.sql` (43 queries: 13 READ, 30 WRITE) |
| Query timings                 | `dbms/05_query_timings.md`: measured by `npm run db:benchmark` (see §9)                |
| Raw query plans               | `dbms/plans/`: one `EXPLAIN (ANALYZE, BUFFERS)` file per query, with all three runs    |

PostgreSQL 18 is the target. The schema uses only features available since PostgreSQL 13
(`gen_random_uuid()`, identity columns, partial and expression indexes, BRIN).

## 1. Entities and relationships

| Relation                | Represents                                                  | Relationships                                                       |
| ----------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------- |
| `users`                 | An account                                                  | 1 — N `devices`, `enrollment_challenges`, `recovery_code_batches`   |
| `devices`               | A trusted phone enrolled by a user                          | N — 1 `users`; 1 — N `device_keys`, `browser_sessions`              |
| `device_keys`           | A public key registered for a device (rotatable)            | N — 1 `devices`; 1 — N `login_challenges` (as decision signer)      |
| `enrollment_challenges` | One-time nonce proving the phone holds the key it registers | N — 1 `users`                                                       |
| `login_challenges`      | The short-lived, single-use QR challenge                    | N — 0..1 `device_keys`; 1 — 0..1 `browser_sessions`                 |
| `browser_sessions`      | A signed-in browser                                         | N — 1 `devices` (approver); 0..1 — 1 `login_challenges`             |
| `recovery_code_batches` | A set of recovery codes issued together                     | N — 1 `users`; 1 — N `recovery_codes`                               |
| `recovery_codes`        | One single-use recovery code (hashed)                       | N — 1 `recovery_code_batches`                                       |
| `audit_events`          | Append-only security log                                    | Logical references to users/devices/sessions/challenges, **no FKs** |

Two design decisions follow from the requirements:

- **Device vs. key are separate entities.** A phone keeps its identity, name and session history
  when its key changes. Android invalidates biometric-bound keys when fingerprints change, so
  rotation is a real event, not a theoretical one. At most one key per device is active.
- **The user is never stored where it can be derived.** Sessions reach their user through
  `approved_by_device_id → devices.user_id`, challenges through `decided_by_key_id → device_keys →
devices`, and recovery codes through `batch_id → recovery_code_batches.user_id`.

## 2. Functional dependencies

Notation: `X → Y` means X determines Y. "CK" = candidate key. Every relation has a surrogate
primary key `id`. Natural candidate keys that also exist are declared `UNIQUE`.

### users

- CKs: `{id}`, `{email}`
- `id → email, display_name, password_hash, created_at, updated_at, disabled_at`
- `email → id` (UNIQUE `users_email_key`)

### devices

- CKs: `{id}`, `{api_token_hash}`
- `id → user_id, name, platform, api_token_hash, created_at, last_used_at, revoked_at, revoked_reason`
- `api_token_hash → id`
- `revoked_reason` depends on the device (`id`), not on `revoked_at`. The CHECK
  `(revoked_at IS NULL) = (revoked_reason IS NULL)` is an inter-attribute _constraint_, not an FD.

### device_keys

- CKs: `{id}`, `{public_key_spki}`
- `id → device_id, algorithm, public_key_spki, key_storage, created_at, last_used_at, revoked_at`
- `public_key_spki → id`, and therefore `public_key_spki → algorithm`. An SPKI encodes its
  algorithm, so `algorithm` is derivable, but the determinant is a candidate key, so BCNF holds.
  The column is kept for cheap filtering and to validate the key length per algorithm.
- Partial dependency `device_id → id` **where `revoked_at IS NULL`**: for active keys `device_id` is
  a key (enforced by the partial unique index `device_keys_one_active_per_device`).

### enrollment_challenges

- CK: `{id}`
- `id → user_id, nonce_hash, created_at, expires_at, consumed_at`

### login_challenges

- CK: `{id}`. `nonce_hash` is unique in practice (256 random bits) but is never used as a lookup
  key, so it is not declared UNIQUE.
- `id → nonce_hash, browser_binding_hash, status, created_at, expires_at, requester_ip,
requester_user_agent, decided_at, decided_by_key_id, decision_signature, consumed_at`
- Derived, **not stored**: `decided_by_key_id → device_id → user_id`; "expired" = `now() ≥ expires_at`.

### browser_sessions

- CKs: `{id}`, `{token_hash}`, `{login_challenge_id}` (when not NULL)
- `id → login_challenge_id, approved_by_device_id, token_hash, created_at, last_seen_at, expires_at,
ip, user_agent, revoked_at, revoked_reason`
- `login_challenge_id → approved_by_device_id` holds while the challenge row exists (via the
  challenge's signing key). The determinant is a candidate key, so this is BCNF-compliant. It is
  inter-table duplication, discussed in §4.

### recovery_code_batches / recovery_codes

- `recovery_code_batches`: CK `{id}`; `id → user_id, created_at, revoked_at`. For active batches,
  `user_id` is also a key (partial unique index).
- `recovery_codes`: CK `{id}`; `id → batch_id, code_hash, used_at`. No `user_id`: it would be
  transitively dependent (`batch_id → user_id`).

### audit_events

- CK: `{id}`; `id → occurred_at, event_type, user_id, device_id, session_id, challenge_id, ip,
user_agent, details`

## 3. Normal-form analysis

**1NF.** Every column holds one atomic value of one type, and there are no repeating groups. A
user's devices, a batch's codes and a device's keys are separate rows, not arrays or lists. Two
values deserve comment:

- `inet` and `timestamptz` are atomic domain values.
- `audit_events.details` is `jsonb`. It holds event-specific context (e.g. a failure reason) that
  the application never filters, joins or updates relationally. The database treats it as one
  opaque value, constrained to be a JSON object. Anything the application queries by (user, device,
  session, challenge, type, time) is a real column.

**2NF.** Every primary key is a single column, so no partial dependency on part of a composite key
is possible. The natural candidate keys (`email`, `api_token_hash`, `public_key_spki`, `token_hash`,
`login_challenge_id`) are single columns as well.

**3NF / BCNF.** For every non-trivial FD `X → Y` listed in §2, `X` is a candidate key of its relation.
In particular, the classic transitive dependencies were designed out:

| Would-be column                      | Transitive path removed                     |
| ------------------------------------ | ------------------------------------------- |
| `browser_sessions.user_id`           | `approved_by_device_id → devices.user_id`   |
| `login_challenges.user_id/device_id` | `decided_by_key_id → device_keys → devices` |
| `recovery_codes.user_id`             | `batch_id → recovery_code_batches.user_id`  |
| `device_keys.user_id`                | `device_id → devices.user_id`               |

All nine relations are therefore in **BCNF**. The deliberate exceptions to "store each fact once"
are listed next. None of them violates BCNF within a relation.

## 4. Controlled redundancy (deliberate)

1. **`login_challenges.status` vs. the nullability of `decided_at` / `consumed_at`.** `pending` ⇔
   `decided_at IS NULL`, and `consumed` ⇔ `consumed_at IS NOT NULL`. Only approved vs. denied is
   independent information. Status is kept because the one-time guarantees are written as simple
   predicates (`WHERE status = 'pending'`, `WHERE status = 'approved'`), and because it makes the
   lifecycle explicit. The CHECK `login_challenges_state_columns` makes inconsistent combinations
   impossible, and the trigger `login_challenges_enforce_transition` allows only `pending→approved`,
   `pending→denied` and `approved→consumed`. Update anomalies are therefore prevented by the database,
   not by convention.
2. **`browser_sessions.approved_by_device_id`** duplicates what can be derived from the consumed
   challenge. Challenges are purged shortly after they expire, while sessions live for hours or days.
   Without this column, a session would lose its owner when its challenge is purged.
   `login_challenge_id` uses `ON DELETE SET NULL` for that reason.
3. **`audit_events`** copies identifiers, IP and user agent, and has no foreign keys. An audit log
   records what was true _when the event happened_. It must survive deletion of the rows it mentions
   and must never be updated (a trigger rejects UPDATE). `ON DELETE SET NULL` FKs would require
   exactly the updates the log forbids.

**Not stored (derived on read):** challenge expiry ("expired" status), a session's idle timeout
(`last_seen_at` compared with a configured interval), and the owning user of sessions, challenges,
keys and codes.

## 5. Other design choices

| Choice                                                                               | Reason                                                                                                                                                                               |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Surrogate `uuid` keys (`gen_random_uuid()`)                                          | Challenge and session ids appear in URLs, QR codes and Socket.IO rooms. Random ids do not reveal counts or ordering and cannot be enumerated. Natural keys (email) can change.       |
| `bigint` identity for `audit_events`                                                 | Append-only, high volume, never exposed as a bearer value. A sequential key is compact and gives a total order for keyset pagination.                                                |
| `text` + `CHECK (... IN (...))` instead of ENUM types or lookup tables               | Closed, small value sets with no attributes of their own. Adding a value is one `ALTER TABLE ... DROP/ADD CONSTRAINT` in a migration, and constraint names appear in error messages. |
| Secrets stored only as SHA-256 digests (`bytea`, CHECK length 32)                    | Session tokens, phone API tokens, QR nonces and browser binding secrets are 256-bit random values, so a fast hash is enough. A database leak does not yield usable credentials.      |
| Passwords and recovery codes stored as PHC strings from a slow KDF                   | Lower-entropy secrets need a slow, salted hash. The CHECK only validates the PHC prefix, so the algorithm can change without a migration.                                            |
| Exact sizes enforced (`public_key_spki` = 91 bytes for ES256, signature 64–72 bytes) | Rejects malformed keys and signatures at the storage layer, independent of application code.                                                                                         |
| All times are `timestamptz` and default to `now()`                                   | Expiry is judged by the database clock in the same statement that acts on it. Client clocks are never trusted.                                                                       |
| Time-window CHECKs (challenge ≤ 5 min, enrollment ≤ 10 min, session ≤ 30 days)       | Caps damage from a configuration mistake. The 5-minute cap equals `LOGIN_CHALLENGE_TTL.maxSeconds` in `packages/protocol`.                                                           |
| Soft revocation (`revoked_at`, write-once) instead of DELETE                         | Keeps history for the phone's session list and audit, and revocation can never be undone by an UPDATE (trigger `write_once`).                                                        |
| Soft disable of users (`disabled_at`); FKs `ON DELETE CASCADE`                       | The application never deletes users. Cascades exist so an administrator's erasure request removes all of a user's data in one statement.                                             |
| Email normalised in the application, enforced by CHECK                               | Avoids the `citext` extension while still guaranteeing case-insensitive uniqueness.                                                                                                  |
| Forward-only migrations with checksums                                               | An applied migration is never edited. The runner refuses to continue if one was. Changes go in a new numbered file.                                                                  |

## 6. Transaction strategy: safe one-time approval

The QR flow has two state changes that must each happen **at most once**, even when requests race
(a double-tap on the phone, two phones, a replayed HTTP request, two browser tabs):

1. **Decision**: the phone's signed approve/deny, `pending → approved | denied` (query `Q-LCH-03`).
2. **Consumption**: the browser exchanges the approval for a session, `approved → consumed` plus
   INSERT `browser_sessions` (query `Q-LCH-05`).

### How each step is made atomic

Both are **single SQL statements** whose `WHERE` clause re-states every precondition:

```sql
-- Q-LCH-03 (abridged)
UPDATE login_challenges AS c SET status = $2, decided_at = now(), decided_by_key_id = k.id, decision_signature = $4
FROM device_keys k JOIN devices d ON d.id = k.device_id JOIN users u ON u.id = d.user_id
WHERE c.id = $1 AND c.nonce_hash = $5 AND c.status = 'pending' AND c.expires_at > now()
  AND k.id = $3 AND k.revoked_at IS NULL AND d.revoked_at IS NULL AND u.disabled_at IS NULL
RETURNING ...;

-- Q-LCH-05 (abridged)
WITH consumed AS (
  UPDATE login_challenges c SET status = 'consumed', consumed_at = now()
  FROM device_keys k JOIN devices d ... JOIN users u ...
  WHERE c.id = $1 AND c.browser_binding_hash = $2 AND c.status = 'approved'
    AND c.decided_at > now() - make_interval(secs => $7)
    AND k.id = c.decided_by_key_id AND k.revoked_at IS NULL AND d.revoked_at IS NULL AND u.disabled_at IS NULL
  RETURNING c.id, d.id AS device_id, d.user_id)
INSERT INTO browser_sessions (...) SELECT ... FROM consumed RETURNING ...;
```

This works under PostgreSQL's default **READ COMMITTED** isolation, for these reasons:

- `UPDATE` takes a row-level lock on the challenge. A concurrent `UPDATE` of the same row waits
  until the first transaction commits or rolls back.
- After waiting, PostgreSQL re-evaluates the waiting statement's `WHERE` clause against the newly
  committed row version. The loser then sees `status = 'approved'` (or `'consumed'`), no longer
  matches, and updates **zero rows**. In `Q-LCH-05` the INSERT selects from the CTE's (empty) result,
  so no session is created.
- The application treats "zero rows returned" as _rejected_ (replay, expired, revoked or wrong
  browser), rolls back, and writes a `login.replay_rejected` audit event in a separate statement.

No `SELECT ... FOR UPDATE` followed by an `UPDATE` is needed: there is no read-then-write gap to
protect. SERIALIZABLE would also be correct, but it needs a retry loop on serialization failures and
adds nothing here.

### Independent safeguards in the schema

| Safeguard                                                       | Prevents                                                                                                                                                                              |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `UNIQUE (browser_sessions.login_challenge_id)`                  | A second session for the same challenge, even if application code were wrong.                                                                                                         |
| Trigger `login_challenges_enforce_transition`                   | Any transition other than pending→approved, pending→denied, approved→consumed (e.g. "un-consuming" a challenge), and edits to a recorded decision or to the nonce, binding or expiry. |
| CHECK `login_challenges_state_columns`                          | Rows whose columns contradict their status.                                                                                                                                           |
| CHECK `login_challenges_decided_before_expiry`                  | Recording a decision after expiry.                                                                                                                                                    |
| `write_once` triggers on `revoked_at`, `used_at`, `consumed_at` | Undoing a revocation, reusing a recovery code or enrollment nonce.                                                                                                                    |

### Multi-statement transactions

Where several rows must change together, the API wraps catalogued statements in `BEGIN … COMMIT`.
The first statement of each is a guarded single-use operation, so a lost race aborts the whole
transaction. The full list is in the header of `dbms/04_queries.sql`. For example:

- `T-LOGIN-COMPLETE` = `Q-LCH-05` + `Q-AUD-01` (session and its audit row commit together).
- `T-DEVICE-REVOKE` = `Q-DEV-05` → `Q-KEY-03` → `Q-SES-06` → `Q-AUD-01`. A lost phone's keys and every
  session it approved die atomically.
- `T-RECOVERY` starts with `Q-REC-05`, which spends the recovery code. A second concurrent attempt
  with the same code updates zero rows and is rolled back before anything is revoked.

### Evidence

`db/test/flows.test.js` runs these guarantees against a real PostgreSQL 18 database:

- Approve then complete yields exactly one session; a second completion yields none.
- Two **concurrent** completions: the test proves the second is blocked on the first's row lock
  (`pg_stat_activity.wait_event_type = 'Lock'`), commits the first, and the second returns zero rows.
- Two concurrent approvals from different phones produce exactly one decision.
- Expired challenges, wrong nonces, wrong browser binding, denied challenges, stale approvals,
  revoked keys and revoked devices are all rejected.
- The trigger, CHECK, UNIQUE and write-once safeguards each reject a direct violation.

No timings or query plans are claimed here. None have been measured.

## 7. Indexes and their justification

PostgreSQL creates a unique B-tree index for every PRIMARY KEY and UNIQUE constraint. All
primary-key lookups (`… WHERE id = $1`, e.g. `Q-USR-03`, `Q-LCH-02/03/04/05/07`, `Q-ENR-02`,
`Q-KEY-06`, `Q-REC-05`) use those. Additional indexes:

| Index                                       | Kind                                                  | Used by                                                    | Justification                                                                                                                                                                   |
| ------------------------------------------- | ----------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `users_email_key`                           | unique (constraint)                                   | `Q-USR-02`                                                 | Password sign-in and recovery look the account up by email; also enforces one account per email.                                                                                |
| `devices_api_token_hash_key`                | unique (constraint)                                   | `Q-DEV-03`                                                 | Runs on **every** phone API request (bearer-token authentication).                                                                                                              |
| `devices_user_id_idx`                       | B-tree `(user_id)`                                    | `Q-DEV-02`, `Q-DEV-06`, `Q-KEY-04`, `Q-SES-03`, `Q-SES-07` | User→device lookup: lists a user's phones, and is the entry point of every "all sessions/keys of this user" join. Also serves the FK.                                           |
| `device_keys_public_key_spki_key`           | unique (constraint)                                   | `Q-KEY-01`                                                 | The same public key cannot be enrolled twice (on two devices or two accounts).                                                                                                  |
| `device_keys_one_active_per_device`         | unique partial `(device_id) WHERE revoked_at IS NULL` | `Q-KEY-02`, `Q-KEY-03`, `Q-DEV-02`                         | Integrity: one active key per device. Also finds the active key for rotation, revocation and the device list.                                                                   |
| `device_keys_device_id_idx`                 | B-tree `(device_id)`                                  | FK cascades, `Q-KEY-04`                                    | The partial index cannot serve rows of revoked keys. This one serves the FK and "all keys of these devices".                                                                    |
| `enrollment_challenges_expires_at_idx`      | B-tree `(expires_at)`                                 | `Q-ENR-03`                                                 | Cleanup job deletes by expiry range instead of scanning the table.                                                                                                              |
| `login_challenges_expires_at_idx`           | B-tree `(expires_at)`                                 | `Q-LCH-06`                                                 | Same, for QR challenges. All per-challenge lookups use the PK. Expiry is a WHERE predicate on an already-identified row, so it needs no index for those.                        |
| `browser_sessions_token_hash_key`           | unique (constraint)                                   | `Q-SES-01`, `Q-SES-05`                                     | Runs on **every** authenticated browser request; also guarantees token uniqueness.                                                                                              |
| `browser_sessions_login_challenge_id_key`   | unique (constraint)                                   | FK `SET NULL` on purge                                     | Primarily the replay backstop (one session per challenge). Also lets challenge purges find referencing sessions.                                                                |
| `browser_sessions_device_idx`               | B-tree `(approved_by_device_id)`                      | `Q-SES-03`, `Q-SES-04`, `Q-SES-06`, `Q-SES-07`             | Active sessions per user are found via the user's devices. Revoking a device revokes its sessions. Also serves the FK.                                                          |
| `browser_sessions_ended_at_idx`             | expression `(LEAST(expires_at, revoked_at))`          | `Q-SES-08`                                                 | The retention purge deletes sessions that _ended_ (expired or revoked) before a cutoff. The expression matches the query exactly, so one index replaces an OR over two columns. |
| `recovery_code_batches_one_active_per_user` | unique partial `(user_id) WHERE revoked_at IS NULL`   | `Q-REC-01`, `Q-REC-04`, `Q-REC-06`                         | Integrity: one active batch per user. Also the lookup path for that batch.                                                                                                      |
| `recovery_codes_batch_id_idx`               | B-tree `(batch_id)`                                   | `Q-REC-04`, `Q-REC-06`, FK                                 | Fetches the (≤ 10) codes of the active batch during a recovery attempt.                                                                                                         |
| `audit_events_user_time_idx`                | B-tree `(user_id, occurred_at DESC, id DESC)`         | `Q-AUD-02`                                                 | The phone's activity view: one user's newest events with keyset pagination. Column order matches the WHERE and ORDER BY.                                                        |
| `audit_events_occurred_at_brin`             | BRIN `(occurred_at)`                                  | `Q-AUD-03`                                                 | Rows are appended in time order, so a BRIN index is tiny and lets the retention purge skip old/new block ranges.                                                                |

**Deliberately not indexed**

- `login_challenges.decided_by_key_id` (FK): only used when a key row is deleted, which happens
  only during user erasure. The table is kept small by the cleanup job.
- `enrollment_challenges.user_id` (FK): same reasoning. Rows live at most 10 minutes plus the
  cleanup grace period.
- `login_challenges.status`: a low-cardinality column always used together with the primary key.
- `audit_events.event_type`: no application query filters by type alone. Add an index only when a
  real query needs it.

## 8. Keeping the AP files in sync with the migrations

- **Canonical:** `db/migrations/*.sql` (schema) and `db/queries.sql` (queries). The API loads
  statements from `db/queries.sql` by ID, so the documented queries _are_ the executed queries.
- **Generated:** `dbms/03_schema.sql` (all migrations concatenated in order, wrapped in one
  transaction) and `dbms/04_queries.sql`, written by `npm run db:ap:build`.
- **Enforced:** `npm test` fails if either generated file differs from what its sources would
  produce (`npm run db:ap:check` runs the same comparison on its own). The same test run applies the
  migrations to a scratch database and `PREPARE`s all 43 catalogued queries against it.
- `dbms/02_er_diagram.png` is rendered from `dbms/02_er_diagram.mmd` with `npm run db:ap:diagram`.
  Update the `.mmd` in the same change as any migration that alters tables or relationships.

## 9. Measured performance

The AP baseline was captured with `npm run db:benchmark` on 2026-11-16. It uses a separate
`capstone_bench` database with 20,000 users, 30,000 devices, 300,000 login challenges, 210,000
browser sessions, 200,000 recovery codes and 1,000,000 audit events. Every query was run exactly
three times under `EXPLAIN (ANALYZE, BUFFERS)`, and the table reports the arithmetic average of
those three execution times. Each run was rolled back so writes saw the same starting data. There
was no extra warm-up run. The table is in [05_query_timings.md](05_query_timings.md);
the [plans folder](plans/) contains all three raw plans for every query.
The measurements are from PostgreSQL 18.6 in Docker on an Apple M4 and exclude network time. Your
own computer may produce different results.

- **The measured access paths use indexes.** None of the 129 captured plans contains a sequential
  scan. Examples include the session-token index for `Q-SES-01`, the user/time index for
  `Q-AUD-02`, and the BRIN index for `Q-AUD-03`.
- **The login-path queries are fast in this test dataset.** Their three-run average execution
  times range from 0.026 ms (`Q-DEV-03`, phone token lookup) to 0.242 ms (`Q-LCH-05`, consuming a
  challenge and creating a browser session). These measurements show database execution only;
  they do not include network or signature-verification time.
- **The challenge cleanup is the slowest measured query.** `Q-LCH-06` averaged 252.381 ms while
  deleting about 10,009 expired challenges. The last captured plan shows about 234.5 ms spent in the
  foreign-key action that clears the challenge link from related browser sessions. The deletion
  itself uses `login_challenges_expires_at_idx`. This is a background cleanup query, not part of
  the sign-in request. The production-sized effect depends on how many expired challenges a cleanup
  run actually deletes.
