-- PostgreSQL schema for sem3 Capstone.
-- The Prisma model is in prisma/schema.prisma; this SQL is the DE submission view.

CREATE TYPE login_request_status AS ENUM ('PENDING', 'APPROVED', 'DENIED');
CREATE TYPE session_type AS ENUM ('PHONE', 'BROWSER');

CREATE TABLE users (
  id UUID PRIMARY KEY,
  phone VARCHAR(24) NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE devices (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(80) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at TIMESTAMPTZ
);

CREATE TABLE login_requests (
  id UUID PRIMARY KEY,
  token VARCHAR(64) NOT NULL UNIQUE,
  browser_secret VARCHAR(64) NOT NULL,
  browser_name VARCHAR(120) NOT NULL,
  status login_request_status NOT NULL DEFAULT 'PENDING',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  approved_at TIMESTAMPTZ,
  approved_by_user_id UUID REFERENCES users(id) ON DELETE RESTRICT,
  approved_by_device_id UUID REFERENCES devices(id) ON DELETE RESTRICT,
  CONSTRAINT login_requests_expiry_after_creation CHECK (expires_at > created_at),
  CONSTRAINT login_requests_approval_fields CHECK (
    (status <> 'APPROVED') OR (approved_at IS NOT NULL AND approved_by_user_id IS NOT NULL AND approved_by_device_id IS NOT NULL)
  )
);

CREATE TABLE sessions (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id UUID NOT NULL REFERENCES devices(id) ON DELETE RESTRICT,
  login_request_id UUID UNIQUE REFERENCES login_requests(id) ON DELETE CASCADE,
  type session_type NOT NULL,
  name VARCHAR(120) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  CONSTRAINT sessions_expiry_after_creation CHECK (expires_at > created_at),
  CONSTRAINT browser_sessions_have_request CHECK (type <> 'BROWSER' OR login_request_id IS NOT NULL)
);

CREATE INDEX devices_user_active_idx ON devices(user_id, revoked_at);
CREATE INDEX login_requests_status_expiry_idx ON login_requests(status, expires_at);
CREATE INDEX sessions_user_type_revoked_idx ON sessions(user_id, type, revoked_at);
CREATE INDEX sessions_expiry_idx ON sessions(expires_at);
