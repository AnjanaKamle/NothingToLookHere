CREATE TYPE "login_request_status" AS ENUM ('PENDING', 'APPROVED', 'DENIED');
CREATE TYPE "session_type" AS ENUM ('PHONE', 'BROWSER');

CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "phone" VARCHAR(24) NOT NULL,
    "password_hash" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "devices" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMPTZ(6),
    CONSTRAINT "devices_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "login_requests" (
    "id" UUID NOT NULL,
    "token_hash" VARCHAR(64) NOT NULL,
    "browser_hash" VARCHAR(64) NOT NULL,
    "browser_name" VARCHAR(120) NOT NULL,
    "status" "login_request_status" NOT NULL DEFAULT 'PENDING',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "approved_at" TIMESTAMPTZ(6),
    "approved_by_user_id" UUID,
    "approved_by_device_id" UUID,
    CONSTRAINT "login_requests_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "login_requests_expiry_after_creation" CHECK ("expires_at" > "created_at"),
    CONSTRAINT "login_requests_approval_fields" CHECK (
      "status" <> 'APPROVED' OR ("approved_at" IS NOT NULL AND "approved_by_user_id" IS NOT NULL AND "approved_by_device_id" IS NOT NULL)
    )
);

CREATE TABLE "sessions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "device_id" UUID NOT NULL,
    "login_request_id" UUID,
    "type" "session_type" NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "revoked_at" TIMESTAMPTZ(6),
    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "sessions_expiry_after_creation" CHECK ("expires_at" > "created_at"),
    CONSTRAINT "browser_sessions_have_request" CHECK ("type" <> 'BROWSER' OR "login_request_id" IS NOT NULL)
);

CREATE TABLE "recovery_codes" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "code_hash" VARCHAR(64) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "used_at" TIMESTAMPTZ(6),
    CONSTRAINT "recovery_codes_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "users_phone_key" ON "users"("phone");
CREATE UNIQUE INDEX "login_requests_token_hash_key" ON "login_requests"("token_hash");
CREATE UNIQUE INDEX "sessions_login_request_id_key" ON "sessions"("login_request_id");
CREATE UNIQUE INDEX "recovery_codes_code_hash_key" ON "recovery_codes"("code_hash");
CREATE INDEX "devices_user_active_idx" ON "devices"("user_id", "revoked_at");
CREATE INDEX "login_requests_status_expiry_idx" ON "login_requests"("status", "expires_at");
CREATE INDEX "sessions_user_type_revoked_idx" ON "sessions"("user_id", "type", "revoked_at");
CREATE INDEX "sessions_expiry_idx" ON "sessions"("expires_at");
CREATE INDEX "recovery_codes_user_used_idx" ON "recovery_codes"("user_id", "used_at");

ALTER TABLE "devices" ADD CONSTRAINT "devices_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "login_requests" ADD CONSTRAINT "login_requests_approved_by_user_id_fkey"
  FOREIGN KEY ("approved_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "login_requests" ADD CONSTRAINT "login_requests_approved_by_device_id_fkey"
  FOREIGN KEY ("approved_by_device_id") REFERENCES "devices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_device_id_fkey"
  FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_login_request_id_fkey"
  FOREIGN KEY ("login_request_id") REFERENCES "login_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "recovery_codes" ADD CONSTRAINT "recovery_codes_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
