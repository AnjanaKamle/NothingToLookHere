-- Representative PostgreSQL queries used by the app.
-- $1, $2, ... are values supplied as parameters by Prisma (never concatenate user input).

-- DEQ-01: create a user (registration)
INSERT INTO users (id, phone, password_hash)
VALUES ($1, $2, $3)
RETURNING id, phone, created_at;

-- DEQ-02: look up a phone account (password hash is verified in Node)
SELECT id, phone, password_hash
FROM users
WHERE phone = $1;

-- DEQ-03: register a phone browser as a device
INSERT INTO devices (id, user_id, name)
VALUES ($1, $2, $3)
RETURNING id, name, created_at;

-- DEQ-04: start a one-time QR request
INSERT INTO login_requests (id, token, browser_secret, browser_name, expires_at)
VALUES ($1, $2, $3, $4, $5)
RETURNING id, status, created_at, expires_at;

-- DEQ-05: find a request by the token scanned from the QR code
SELECT id, browser_name, status, expires_at
FROM login_requests
WHERE token = $1;

-- DEQ-06: atomically approve once and create the browser session
BEGIN;
UPDATE login_requests
SET status = 'APPROVED', approved_at = NOW(),
    approved_by_user_id = $2, approved_by_device_id = $3
WHERE id = $1 AND status = 'PENDING' AND expires_at > NOW()
RETURNING id, browser_name;
-- Insert the session only if the UPDATE returned one row; otherwise ROLLBACK.
INSERT INTO sessions (id, user_id, device_id, login_request_id, type, name, expires_at)
VALUES ($4, $2, $3, $1, 'BROWSER', $5, $6);
COMMIT;

-- DEQ-07: list active browser sessions for the signed-in phone user
SELECT id, name, created_at, expires_at
FROM sessions
WHERE user_id = $1 AND type = 'BROWSER'
  AND revoked_at IS NULL AND expires_at > NOW()
ORDER BY created_at DESC;

-- DEQ-08: revoke one of the user's browser sessions
UPDATE sessions
SET revoked_at = NOW()
WHERE id = $1 AND user_id = $2 AND type = 'BROWSER' AND revoked_at IS NULL;

-- DEQ-09: check the session named by a verified JWT cookie
SELECT id, user_id, type, device_id, expires_at
FROM sessions
WHERE id = $1 AND user_id = $2
  AND revoked_at IS NULL AND expires_at > NOW();

-- DEQ-10: expire old pending requests
UPDATE login_requests
SET status = 'DENIED'
WHERE status = 'PENDING' AND expires_at <= NOW();

-- DEQ-11: common lookup plans use these indexes (created in 03_schema.sql)
-- devices_user_active_idx(user_id, revoked_at)
-- login_requests_status_expiry_idx(status, expires_at)
-- sessions_user_type_revoked_idx(user_id, type, revoked_at)
-- sessions_expiry_idx(expires_at)
