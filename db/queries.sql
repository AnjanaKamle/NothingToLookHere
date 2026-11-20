-- db/queries.sql: every SQL statement the application runs.
--
-- Canonical source. dbms/04_queries.sql is GENERATED from this file (npm run db:ap:build).
-- The API loads statements from this file by ID (db/src/queries.js), so it cannot drift from
-- what is documented here. Tests PREPARE every statement against the real schema.
--
-- Format of each entry:
--   -- @id Q-XXX-NN
--   -- READ | WRITE
--   -- <description>
--   <one SQL statement ending with ;>
--
-- Parameters are positional ($1, $2, ...) and cast explicitly so their types are unambiguous.
-- Hashes are SHA-256 digests computed by the API (32-byte bytea). Durations are in seconds.
--
-- Multi-statement transactions (run with BEGIN ... COMMIT, READ COMMITTED isolation):
--   T-REGISTER        Q-USR-01, Q-AUD-01
--   T-ENROLL          Q-ENR-02, Q-DEV-01, Q-KEY-01, Q-AUD-01
--   T-KEY-ROTATE      Q-ENR-02, Q-KEY-02, Q-KEY-01, Q-AUD-01
--   T-LOGIN-DECIDE    Q-LCH-03, Q-KEY-05, Q-AUD-01
--   T-LOGIN-COMPLETE  Q-LCH-05, Q-AUD-01
--   T-DEVICE-REVOKE   Q-DEV-05, Q-KEY-03, Q-SES-06, Q-AUD-01
--   T-RECOVERY-CODES  Q-REC-01, Q-REC-02, Q-REC-03, Q-AUD-01
--   T-RECOVERY        Q-REC-05, Q-SES-07, Q-KEY-04, Q-DEV-06, Q-REC-01, Q-USR-04, Q-ENR-01, Q-AUD-01
-- Every guarded UPDATE re-checks its preconditions in its WHERE clause, so the transaction
-- aborts (zero rows returned -> ROLLBACK) if another request got there first.

-- =============================================================================================
-- Users
-- =============================================================================================

-- @id Q-USR-01
-- WRITE
-- Register an account. email must already be normalised (trimmed, lower case).
INSERT INTO users (email, display_name, password_hash)
VALUES ($1::text, $2::text, $3::text)
RETURNING id, created_at;

-- @id Q-USR-02
-- READ
-- Find an account by email for the password check (initial phone sign-in and recovery).
SELECT id, password_hash, disabled_at
FROM users
WHERE email = $1::text;

-- @id Q-USR-03
-- READ
-- Load an account's profile.
SELECT id, email, display_name, created_at, disabled_at
FROM users
WHERE id = $1::uuid;

-- @id Q-USR-04
-- WRITE
-- Replace the password hash (recovery flow).
UPDATE users
SET password_hash = $2::text, updated_at = now()
WHERE id = $1::uuid AND disabled_at IS NULL
RETURNING id;

-- =============================================================================================
-- Device enrollment
-- =============================================================================================

-- @id Q-ENR-01
-- WRITE
-- Issue a proof-of-possession nonce after password sign-in. $2 = SHA-256(nonce), $3 = TTL seconds.
INSERT INTO enrollment_challenges (user_id, nonce_hash, expires_at)
VALUES ($1::uuid, $2::bytea, now() + make_interval(secs => $3::int))
RETURNING id, expires_at;

-- @id Q-ENR-02
-- WRITE
-- Atomically consume an enrollment challenge. Returns no row if it is unknown, expired, already
-- used, the nonce does not match, or the account is disabled. Run only after the signature
-- over the nonce has been verified with the public key being registered.
UPDATE enrollment_challenges AS c
SET consumed_at = now()
FROM users AS u
WHERE c.id = $1::uuid
  AND c.nonce_hash = $2::bytea
  AND c.consumed_at IS NULL
  AND c.expires_at > now()
  AND u.id = c.user_id
  AND u.disabled_at IS NULL
RETURNING c.user_id;

-- @id Q-ENR-03
-- WRITE
-- Cleanup job: delete enrollment challenges that expired more than $1 seconds ago.
DELETE FROM enrollment_challenges
WHERE expires_at < now() - make_interval(secs => $1::int);

-- =============================================================================================
-- Devices
-- =============================================================================================

-- @id Q-DEV-01
-- WRITE
-- Register a trusted phone. $4 = SHA-256 of the phone's API bearer token.
INSERT INTO devices (user_id, name, platform, api_token_hash)
VALUES ($1::uuid, $2::text, $3::text, $4::bytea)
RETURNING id, created_at;

-- @id Q-DEV-02
-- READ
-- List a user's active trusted phones with their current key.
SELECT d.id, d.name, d.platform, d.created_at, d.last_used_at,
       k.id AS key_id, k.key_storage, k.created_at AS key_created_at
FROM devices AS d
LEFT JOIN device_keys AS k ON k.device_id = d.id AND k.revoked_at IS NULL
WHERE d.user_id = $1::uuid
  AND d.revoked_at IS NULL
ORDER BY d.created_at;

-- @id Q-DEV-03
-- READ
-- Authenticate a phone's API request by the SHA-256 of its bearer token.
SELECT d.id AS device_id, d.user_id
FROM devices AS d
JOIN users AS u ON u.id = d.user_id
WHERE d.api_token_hash = $1::bytea
  AND d.revoked_at IS NULL
  AND u.disabled_at IS NULL;

-- @id Q-DEV-04
-- WRITE
-- Record phone activity, at most once per $2 seconds to avoid a write on every request.
UPDATE devices
SET last_used_at = now()
WHERE id = $1::uuid
  AND (last_used_at IS NULL OR last_used_at < now() - make_interval(secs => $2::int));

-- @id Q-DEV-05
-- WRITE
-- Revoke one of the user's own devices. $3 = reason ('user' | 'lost' | 'admin').
UPDATE devices
SET revoked_at = now(), revoked_reason = $3::text
WHERE id = $1::uuid AND user_id = $2::uuid AND revoked_at IS NULL
RETURNING id;

-- @id Q-DEV-06
-- WRITE
-- Recovery: revoke every active device of the user.
UPDATE devices
SET revoked_at = now(), revoked_reason = 'recovery'
WHERE user_id = $1::uuid AND revoked_at IS NULL
RETURNING id;

-- =============================================================================================
-- Device keys
-- =============================================================================================

-- @id Q-KEY-01
-- WRITE
-- Register a device's public key (DER SubjectPublicKeyInfo).
INSERT INTO device_keys (device_id, algorithm, public_key_spki, key_storage)
VALUES ($1::uuid, $2::text, $3::bytea, $4::text)
RETURNING id, created_at;

-- @id Q-KEY-02
-- WRITE
-- Key rotation: revoke the device's active key before inserting the new one.
UPDATE device_keys
SET revoked_at = now()
WHERE device_id = $1::uuid AND revoked_at IS NULL
RETURNING id;

-- @id Q-KEY-03
-- WRITE
-- Device revocation: revoke all active keys of the device (same statement as Q-KEY-02,
-- kept separate so each use is audited under its own ID).
UPDATE device_keys
SET revoked_at = now()
WHERE device_id = $1::uuid AND revoked_at IS NULL
RETURNING id;

-- @id Q-KEY-04
-- WRITE
-- Recovery: revoke every active key on every device of the user.
UPDATE device_keys AS k
SET revoked_at = now()
FROM devices AS d
WHERE d.user_id = $1::uuid
  AND k.device_id = d.id
  AND k.revoked_at IS NULL
RETURNING k.id;

-- @id Q-KEY-05
-- WRITE
-- Record that a key was used to sign a decision.
UPDATE device_keys
SET last_used_at = now()
WHERE id = $1::uuid;

-- @id Q-KEY-06
-- READ
-- Load an active key for signature verification, with its device and user. No row means the
-- key, its device, or the account is revoked/disabled.
SELECT k.id AS key_id, k.algorithm, k.public_key_spki, d.id AS device_id, d.user_id
FROM device_keys AS k
JOIN devices AS d ON d.id = k.device_id
JOIN users AS u ON u.id = d.user_id
WHERE k.id = $1::uuid
  AND k.revoked_at IS NULL
  AND d.revoked_at IS NULL
  AND u.disabled_at IS NULL;

-- =============================================================================================
-- Login challenges (QR)
-- =============================================================================================

-- @id Q-LCH-01
-- WRITE
-- Browser requests a QR login. $1 = SHA-256(nonce), $2 = SHA-256(browser binding secret),
-- $3 = TTL seconds.
INSERT INTO login_challenges (nonce_hash, browser_binding_hash, expires_at, requester_ip, requester_user_agent)
VALUES ($1::bytea, $2::bytea, now() + make_interval(secs => $3::int), $4::inet, $5::text)
RETURNING id, expires_at;

-- @id Q-LCH-02
-- READ
-- Phone fetches the request details to show the user. Requires the nonce from the QR code, so
-- knowing only the challenge id is not enough. Returns nothing once decided or expired.
SELECT id, created_at, expires_at, requester_ip, requester_user_agent
FROM login_challenges
WHERE id = $1::uuid
  AND nonce_hash = $2::bytea
  AND status = 'pending'
  AND expires_at > now();

-- @id Q-LCH-03
-- WRITE
-- Record the phone's signed decision. Single statement, so it is atomic: the row lock taken by
-- UPDATE makes concurrent decisions serialize, and the loser re-evaluates "status = 'pending'"
-- against the committed row and matches nothing. Also re-checks that the signing key, its
-- device and the account are still active. $2 = 'approved' | 'denied'.
-- Run only after the signature has been verified with the key loaded by Q-KEY-06.
UPDATE login_challenges AS c
SET status = $2::text,
    decided_at = now(),
    decided_by_key_id = k.id,
    decision_signature = $4::bytea
FROM device_keys AS k
JOIN devices AS d ON d.id = k.device_id
JOIN users AS u ON u.id = d.user_id
WHERE c.id = $1::uuid
  AND c.nonce_hash = $5::bytea
  AND c.status = 'pending'
  AND c.expires_at > now()
  AND k.id = $3::uuid
  AND k.revoked_at IS NULL
  AND d.revoked_at IS NULL
  AND u.disabled_at IS NULL
RETURNING c.id, c.status, d.id AS device_id, d.user_id;

-- @id Q-LCH-04
-- READ
-- The waiting browser polls its challenge (HTTP fallback after a lost WebSocket).
-- Matching the binding hash proves this browser created the challenge. Reports the effective
-- status: 'expired' for a pending challenge past expires_at, or an approval older than the
-- completion window ($3 seconds).
SELECT id, expires_at,
       CASE
         WHEN status = 'pending' AND expires_at <= now() THEN 'expired'
         WHEN status = 'approved' AND decided_at <= now() - make_interval(secs => $3::int) THEN 'expired'
         ELSE status
       END AS status
FROM login_challenges
WHERE id = $1::uuid
  AND browser_binding_hash = $2::bytea;

-- @id Q-LCH-05
-- WRITE
-- Exchange an approval for a browser session, atomically and exactly once.
-- The CTE consumes the challenge (approved -> consumed) only if this browser created it, it was
-- approved within the last $7 seconds, and the approving key, device and account are still
-- active. The INSERT runs only for a row the CTE returned. Concurrent attempts serialize on the
-- challenge row lock; the second sees status = 'consumed' and inserts nothing. The UNIQUE
-- constraint on browser_sessions.login_challenge_id is a second, independent guard.
-- $3 = SHA-256(session token), $4 = session lifetime seconds.
WITH consumed AS (
  UPDATE login_challenges AS c
  SET status = 'consumed', consumed_at = now()
  FROM device_keys AS k
  JOIN devices AS d ON d.id = k.device_id
  JOIN users AS u ON u.id = d.user_id
  WHERE c.id = $1::uuid
    AND c.browser_binding_hash = $2::bytea
    AND c.status = 'approved'
    AND c.decided_at > now() - make_interval(secs => $7::int)
    AND k.id = c.decided_by_key_id
    AND k.revoked_at IS NULL
    AND d.revoked_at IS NULL
    AND u.disabled_at IS NULL
  RETURNING c.id AS challenge_id, d.id AS device_id, d.user_id
)
INSERT INTO browser_sessions (login_challenge_id, approved_by_device_id, token_hash, expires_at, ip, user_agent)
SELECT challenge_id, device_id, $3::bytea, now() + make_interval(secs => $4::int), $5::inet, $6::text
FROM consumed
RETURNING id, approved_by_device_id, expires_at,
          (SELECT user_id FROM consumed) AS user_id;

-- @id Q-LCH-07
-- READ
-- Effective status for a Socket.IO watcher that presented a valid watch token for this
-- challenge id (on subscribe, on reconnect, and when its expiry timer fires). Same status rules
-- as Q-LCH-04; $2 = completion window seconds.
SELECT id, expires_at,
       CASE
         WHEN status = 'pending' AND expires_at <= now() THEN 'expired'
         WHEN status = 'approved' AND decided_at <= now() - make_interval(secs => $2::int) THEN 'expired'
         ELSE status
       END AS status
FROM login_challenges
WHERE id = $1::uuid;

-- @id Q-LCH-06
-- WRITE
-- Cleanup job: delete login challenges that expired more than $1 seconds ago.
DELETE FROM login_challenges
WHERE expires_at < now() - make_interval(secs => $1::int);

-- =============================================================================================
-- Browser sessions
-- =============================================================================================

-- @id Q-SES-01
-- READ
-- Authenticate a browser request by the SHA-256 of its session cookie. Applies absolute expiry,
-- idle timeout ($2 seconds), revocation, and device/account status.
SELECT s.id AS session_id, s.expires_at, s.last_seen_at, d.id AS device_id, d.user_id
FROM browser_sessions AS s
JOIN devices AS d ON d.id = s.approved_by_device_id
JOIN users AS u ON u.id = d.user_id
WHERE s.token_hash = $1::bytea
  AND s.revoked_at IS NULL
  AND s.expires_at > now()
  AND s.last_seen_at > now() - make_interval(secs => $2::int)
  AND d.revoked_at IS NULL
  AND u.disabled_at IS NULL;

-- @id Q-SES-02
-- WRITE
-- Record browser activity, at most once per $2 seconds.
UPDATE browser_sessions
SET last_seen_at = now()
WHERE id = $1::uuid
  AND revoked_at IS NULL
  AND last_seen_at < now() - make_interval(secs => $2::int);

-- @id Q-SES-03
-- READ
-- Phone lists the user's active browser sessions. $2 = idle timeout seconds.
SELECT s.id, s.created_at, s.last_seen_at, s.expires_at, s.ip, s.user_agent,
       d.id AS approved_by_device_id, d.name AS approved_by_device_name
FROM browser_sessions AS s
JOIN devices AS d ON d.id = s.approved_by_device_id
WHERE d.user_id = $1::uuid
  AND s.revoked_at IS NULL
  AND s.expires_at > now()
  AND s.last_seen_at > now() - make_interval(secs => $2::int)
ORDER BY s.last_seen_at DESC;

-- @id Q-SES-04
-- WRITE
-- Phone revokes one of the user's sessions. The join ensures a user can revoke only their own.
UPDATE browser_sessions AS s
SET revoked_at = now(), revoked_reason = 'revoked_by_phone'
FROM devices AS d
WHERE s.id = $1::uuid
  AND d.id = s.approved_by_device_id
  AND d.user_id = $2::uuid
  AND s.revoked_at IS NULL
RETURNING s.id;

-- @id Q-SES-05
-- WRITE
-- Browser signs itself out.
UPDATE browser_sessions
SET revoked_at = now(), revoked_reason = 'signed_out'
WHERE token_hash = $1::bytea AND revoked_at IS NULL
RETURNING id;

-- @id Q-SES-06
-- WRITE
-- Device revocation: revoke every active session that device approved.
UPDATE browser_sessions
SET revoked_at = now(), revoked_reason = 'device_revoked'
WHERE approved_by_device_id = $1::uuid AND revoked_at IS NULL
RETURNING id;

-- @id Q-SES-07
-- WRITE
-- Recovery: revoke every active session of the user.
UPDATE browser_sessions AS s
SET revoked_at = now(), revoked_reason = 'recovery'
FROM devices AS d
WHERE d.user_id = $1::uuid
  AND s.approved_by_device_id = d.id
  AND s.revoked_at IS NULL
RETURNING s.id;

-- @id Q-SES-08
-- WRITE
-- Retention job: delete sessions that ended (expired or revoked) more than $1 seconds ago.
-- The expression matches index browser_sessions_ended_at_idx.
DELETE FROM browser_sessions
WHERE LEAST(expires_at, revoked_at) < now() - make_interval(secs => $1::int);

-- =============================================================================================
-- Recovery codes
-- =============================================================================================

-- @id Q-REC-01
-- WRITE
-- Revoke the user's active recovery-code batch (before issuing a new one, or after recovery).
UPDATE recovery_code_batches
SET revoked_at = now()
WHERE user_id = $1::uuid AND revoked_at IS NULL
RETURNING id;

-- @id Q-REC-02
-- WRITE
-- Create a new recovery-code batch.
INSERT INTO recovery_code_batches (user_id)
VALUES ($1::uuid)
RETURNING id, created_at;

-- @id Q-REC-03
-- WRITE
-- Store the batch's code hashes in one statement. $2 = array of PHC hash strings.
INSERT INTO recovery_codes (batch_id, code_hash)
SELECT $1::uuid, code_hash
FROM unnest($2::text[]) AS t(code_hash)
RETURNING id;

-- @id Q-REC-04
-- READ
-- Unused codes in the user's active batch, for verifying a recovery attempt in the API.
SELECT c.id, c.code_hash
FROM recovery_codes AS c
JOIN recovery_code_batches AS b ON b.id = c.batch_id
WHERE b.user_id = $1::uuid
  AND b.revoked_at IS NULL
  AND c.used_at IS NULL;

-- @id Q-REC-05
-- WRITE
-- Atomically spend a recovery code. No row means it was already used (e.g. a concurrent attempt)
-- or its batch was revoked.
UPDATE recovery_codes AS c
SET used_at = now()
FROM recovery_code_batches AS b
WHERE c.id = $1::uuid
  AND c.used_at IS NULL
  AND b.id = c.batch_id
  AND b.user_id = $2::uuid
  AND b.revoked_at IS NULL
RETURNING c.id;

-- @id Q-REC-06
-- READ
-- Number of unused codes left, shown on the phone so the user knows when to regenerate.
SELECT count(*)::int AS remaining
FROM recovery_codes AS c
JOIN recovery_code_batches AS b ON b.id = c.batch_id
WHERE b.user_id = $1::uuid
  AND b.revoked_at IS NULL
  AND c.used_at IS NULL;

-- =============================================================================================
-- Audit events
-- =============================================================================================

-- @id Q-AUD-01
-- WRITE
-- Append an audit event. $8 = details object (jsonb) or NULL.
INSERT INTO audit_events (event_type, user_id, device_id, session_id, challenge_id, ip, user_agent, details)
VALUES ($1::text, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::inet, $7::text, COALESCE($8::jsonb, '{}'::jsonb))
RETURNING id, occurred_at;

-- @id Q-AUD-02
-- READ
-- A user's recent security activity, newest first, keyset-paginated. For the first page pass
-- $2 = NULL; afterwards pass the last row's (occurred_at, id) as ($2, $3). $4 = page size.
SELECT id, occurred_at, event_type, device_id, session_id, ip, user_agent, details
FROM audit_events
WHERE user_id = $1::uuid
  AND ($2::timestamptz IS NULL OR (occurred_at, id) < ($2::timestamptz, $3::bigint))
ORDER BY occurred_at DESC, id DESC
LIMIT $4::int;

-- @id Q-AUD-03
-- WRITE
-- Retention job: delete audit events older than $1 seconds.
DELETE FROM audit_events
WHERE occurred_at < now() - make_interval(secs => $1::int);
