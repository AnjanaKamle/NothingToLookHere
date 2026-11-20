# API reference

Base path: `/api`. JSON in and out (`Content-Type: application/json`, request bodies ≤ 16 KB).
Timestamps are ISO 8601 UTC strings. Binary values are **unpadded base64url**.
Responses carry `Cache-Control: no-store`.

## Callers and authentication

| Caller      | How it authenticates                                                                                                                                                                                                                   |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Phone**   | `Authorization: Bearer <deviceToken>`: 32 random bytes issued once at enrollment and stored in `expo-secure-store`. Only its SHA-256 is stored server-side. Approving a login _additionally_ requires a signature from the device key. |
| **Browser** | Cookies set by the API (below), plus an `Origin` header matching `WEB_ORIGIN` on every state-changing request (CSRF defence).                                                                                                          |
| **Public**  | Password sign-in, enrollment and recovery. Rate-limited per IP.                                                                                                                                                                        |

### Cookies

| Cookie                                                          | Set by                                | Flags                                                                                                                      | Purpose                                   |
| --------------------------------------------------------------- | ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| `capstone_login_<challengeId>` (`__Secure-` prefix when secure) | `POST /login/challenges`              | `HttpOnly; SameSite=Strict; Path=/api/login/challenges/<id>; Max-Age=TTL+completion window`; `Secure` when `COOKIE_SECURE` | Proves this browser created the challenge |
| `capstone_session` (`__Host-capstone_session` when secure)      | `POST /login/challenges/:id/complete` | `HttpOnly; SameSite=Lax; Path=/; Max-Age=SESSION_TTL_SECONDS`; `Secure` when `COOKIE_SECURE`                               | Browser session (random 256-bit token)    |

`COOKIE_SECURE` defaults to `true` in production and cannot be turned off there.

### Error format

Every error response has this shape:

```json
{
  "error": {
    "code": "invalid_request",
    "message": "Human-readable text",
    "details": [{ "path": "email", "message": "Must be an email address" }]
  }
}
```

`details` appears only on validation errors. Clients should branch on `code`.

| Status | Codes                                                                                                                                  |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| 400    | `invalid_request` (field validation; unknown fields are rejected), `invalid_json`, `invalid_public_key`                                |
| 401    | `invalid_credentials`, `invalid_signature`, `key_not_active`, `device_auth_required`, `session_required`                               |
| 403    | `untrusted_origin`, `key_not_owned`, `enrollment_not_owned`, `account_disabled`                                                        |
| 404    | `not_found`, `challenge_not_found`, `challenge_unavailable` (inspect), `session_not_found`, `device_not_found`                         |
| 409    | `challenge_unavailable` (decision), `challenge_not_approved`, `enrollment_unavailable`, `public_key_already_registered`, `email_taken` |
| 413    | `payload_too_large`                                                                                                                    |
| 429    | `rate_limited` (with `RateLimit` / `RateLimit-Policy` headers)                                                                         |
| 500    | `internal_error` (details are logged server-side only)                                                                                 |

## Login challenge states

```
            phone approves (signed)            browser completes (binding cookie)
 pending ─────────────────────────► approved ─────────────────────────────────► consumed
    │  phone denies (signed)
    ├──────────────────────────────► denied
    │  now() ≥ expires_at                         approval older than LOGIN_COMPLETION_WINDOW_SECONDS
    └──────────────────────────────► expired ◄──────────────────────────────── approved
```

`pending`, `approved`, `denied` and `consumed` are stored. `expired` is derived on read and never
stored. Each transition happens at most once, enforced in the database (see
[dbms/01_normalization.md §6](../dbms/01_normalization.md#6-transaction-strategy-safe-one-time-approval)).

## Approval sequence

```mermaid
sequenceDiagram
    participant B as Browser
    participant A as API
    participant P as Phone
    B->>A: POST /login/challenges (Origin)
    A-->>B: 201 {challengeId, qrPayload, watchToken} + Set-Cookie binding (HttpOnly, Strict)
    B->>A: socket emit login:watch {challengeId, watchToken}
    A-->>B: ack {ok, status: "pending"}
    Note over B: shows QR "capstone-auth:v1:<challengeId>.<nonce>"
    P->>P: scan QR, parse challengeId + nonce
    P->>A: POST /login/challenges/:id/inspect {nonce} (Bearer)
    A-->>P: requester IP / user agent, expiresAt, audience
    P->>P: user confirms; key signs message (biometric/passcode)
    P->>A: POST /login/challenges/:id/decision {nonce, keyId, decision, signature}
    A->>A: load registered key, verify ES256, guarded UPDATE (single use)
    A-->>P: 200 {status: "approved"}
    A--)B: socket login:approved {challengeId}
    B->>A: POST /login/challenges/:id/complete (binding cookie, Origin)
    A->>A: consume challenge + create session (one statement)
    A-->>B: 200 {user, session} + Set-Cookie session (HttpOnly, Lax)
```

If the browser's WebSocket drops, it reconnects and emits `login:watch` again. The ack carries the
current status, so an approval that happened while it was offline is not lost. Alternatively it can
poll `GET /login/challenges/:id`.

## Cryptography

| Item              | Choice                                                                                                                                                                                                                                                                                                                             |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Algorithm         | **ES256**: ECDSA on P-256 (secp256r1 / prime256v1) with SHA-256. Supported by the iOS Secure Enclave (its only curve), Android Keystore/StrongBox, and `node:crypto`.                                                                                                                                                              |
| Public key format | DER **SubjectPublicKeyInfo**, uncompressed point, exactly 91 bytes, base64url. The server re-encodes it and rejects anything non-canonical or not P-256.                                                                                                                                                                           |
| Signature format  | DER **ECDSA-Sig-Value** `SEQUENCE { r INTEGER, s INTEGER }` (ANSI X9.62), base64url, ≤ 72 bytes. This is the native output of iOS `SecKeyCreateSignature(.ecdsaSignatureMessageX962SHA256)` and Android `Signature.getInstance("SHA256withECDSA")`. The server parses it strictly, verifies it, and stores the 64-byte `r‖s` form. |
| What is signed    | The UTF-8 bytes of a fixed text message (below), built by `@capstone/protocol` on both sides. The platform hashes it with SHA-256 as part of signing.                                                                                                                                                                              |
| Private key       | Generated in, and never leaves, the phone's secure hardware. No endpoint accepts a private key.                                                                                                                                                                                                                                    |
| Test vector       | [`packages/protocol/test-vectors/es256.json`](../packages/protocol/test-vectors/es256.json): a test-only key, both messages and their DER signatures. The API test suite verifies it, and the phone must reproduce the message bytes exactly.                                                                                      |

**Login decision message.** Lines are joined by `\n`, with no trailing newline:

```
capstone-auth/login-decision/v1
audience=<AUTH_AUDIENCE>
challenge=<challengeId>
nonce=<nonce from the QR code>
key=<keyId>
decision=<approved|denied>
```

**Enrollment / key-rotation message:**

```
capstone-auth/enroll/v1
audience=<AUTH_AUDIENCE>
enrollment=<enrollmentId>
nonce=<nonce>
```

This binding means a signature is valid for exactly one challenge (its id and one-time nonce), one
deployment (audience), one key, and one decision. The server rebuilds the message itself from the
request and its own configuration, so a client cannot choose what the signature covers.

Other secrets: nonces, binding secrets, session tokens and device tokens are 32 bytes from
`crypto.randomBytes`, and only their SHA-256 is stored. Challenge ids come from PostgreSQL
`gen_random_uuid()` (122 bits from the server CSPRNG). Watch tokens are
`HMAC-SHA256(WATCH_TOKEN_SECRET, "login-watch:v1:" + challengeId)`. Passwords use scrypt
(N=2^17, r=8, p=1) and recovery codes scrypt (N=2^15), both stored as PHC strings.

## Endpoints

### Health

`GET /health` → `200 {status:"ok", database:"ok", protocolVersion}` or `503` with `database:"unreachable"`.

### Account sign-in and enrollment

**`POST /auth/password-login`** (public; 10 / 15 min / IP). Initial sign-in on the phone.

| Request    | Type   | Notes            |
| ---------- | ------ | ---------------- |
| `email`    | string | case-insensitive |
| `password` | string | 1–1024 chars     |

`200 { enrollment: { enrollmentId, nonce, expiresAt, audience } }`. The password only buys an
enrollment challenge (default 5 min); it never creates a browser session or device credential.
Errors: `401 invalid_credentials` (same response for an unknown email or a wrong password, with
equal timing), `403 account_disabled`.

**`POST /devices/enroll`** (public; 20 / 15 min / IP). Registers the phone and its public key.

| Request        | Type   | Notes                                                           |
| -------------- | ------ | --------------------------------------------------------------- |
| `enrollmentId` | uuid   | from password login or recovery                                 |
| `nonce`        | string | from the same response                                          |
| `publicKey`    | string | DER SPKI, base64url                                             |
| `signature`    | string | DER ECDSA signature of the enrollment message, base64url        |
| `keyStorage`   | enum   | `secure_enclave` · `strongbox` · `tee` · `software` · `unknown` |
| `deviceName`   | string | 1–64 chars                                                      |
| `platform`     | enum   | `ios` · `android`                                               |

`201 { device: { id, keyId, name, platform }, deviceToken, audience }`. `deviceToken` is shown
**once**. Errors: `400 invalid_public_key`, `401 invalid_signature`, `409 enrollment_unavailable`
(unknown, expired or already used), `409 public_key_already_registered`. A failed attempt does not
consume the challenge.

**`GET /devices`** (phone). `200 { devices: [{ id, name, platform, createdAt, lastUsedAt, current, key: { id, storage, createdAt } }] }`.

**`POST /devices/:deviceId/revoke`** (phone). Body `{ reason?: "user" | "lost" }`. Revokes the
device, its keys and every session it approved, in one transaction. Notifies affected browsers.
`200 { revokedSessions }`. `404 device_not_found`.

**`POST /devices/me/key-rotation`** (phone). `200 { enrollment }`: a fresh proof-of-possession challenge.

**`POST /devices/me/keys`** (phone). Body: `enrollmentId, nonce, publicKey, signature, keyStorage`
(signed by the **new** key). Revokes the old key and activates the new one. `201 { keyId }`.
`403 enrollment_not_owned`, plus the enrollment errors above.

**`GET /activity?limit=50[&before=<iso>&beforeId=<n>]`** (phone). `200 { events: [{ id, occurredAt, type, deviceId, sessionId, ip, userAgent, details }], nextCursor: { before, beforeId } | null }`.

### QR login

**`POST /login/challenges`** (browser, Origin required; 30 / min / IP). No body.
`201 { challengeId, expiresAt, qrPayload, watchToken }` + binding cookie.
`qrPayload` = `capstone-auth:v1:<challengeId>.<nonce>`. It contains only one-time values valid for
`LOGIN_CHALLENGE_TTL_SECONDS` (default 60 s), never a credential or session secret.

**`GET /login/challenges/:challengeId`** (browser, binding cookie). Polling fallback.
`200 { challengeId, status, expiresAt }`, where `status` ∈ `pending|approved|denied|consumed|expired`.
`404 challenge_not_found` if the challenge is unknown or the cookie is missing or wrong (the two cases
are indistinguishable).

**`POST /login/challenges/:challengeId/inspect`** (phone; 120 / min / IP). Body `{ nonce }`.
`200 { challengeId, createdAt, expiresAt, requester: { ip, userAgent }, audience }`: shown to the
user before they approve. `404 challenge_unavailable` once decided or expired.

**`POST /login/challenges/:challengeId/decision`** (phone; 120 / min / IP).

| Request     | Type   | Notes                                             |
| ----------- | ------ | ------------------------------------------------- |
| `nonce`     | string | from the QR code                                  |
| `keyId`     | uuid   | the phone's active key                            |
| `decision`  | enum   | `approved` · `denied`                             |
| `signature` | string | DER ECDSA signature of the login decision message |

`200 { challengeId, status }` and a Socket.IO event to the waiting browser.
Errors: `401 key_not_active` (unknown or revoked key, device or account), `403 key_not_owned` (key
belongs to another device), `401 invalid_signature`, `409 challenge_unavailable` (expired, already
decided, or nonce mismatch; also logged as `login.replay_rejected`).

**`POST /login/challenges/:challengeId/complete`** (browser, binding cookie, Origin required).
`200 { user: { id, email, displayName }, session: { id, expiresAt } }` + session cookie, and the
binding cookie is cleared. `409 challenge_not_approved` (not approved, already completed, approved
longer than `LOGIN_COMPLETION_WINDOW_SECONDS` ago, or the approving device was revoked meanwhile).
`404 challenge_not_found` (no binding cookie).

### Browser session

**`GET /session`** (session cookie). `200 { user, session: { id, expiresAt } }`. `401 session_required`
if the session is missing, expired, idle longer than `SESSION_IDLE_TIMEOUT_SECONDS`, revoked, or
its approving device or account was revoked.

**`POST /session/logout`** (session cookie, Origin required). `204`; clears the cookie.

### Session management (phone)

**`GET /sessions`** → `200 { sessions: [{ id, createdAt, lastSeenAt, expiresAt, ip, userAgent, approvedBy: { deviceId, deviceName } }] }`. Active sessions for the user, from any of their phones.

**`DELETE /sessions/:sessionId`** → `204`. The browser receives `session:revoked`.
`404 session_not_found` (not active, or not this user's).

### Recovery

**`POST /recovery`** (public; 5 / 15 min / IP). See [RECOVERY.md](RECOVERY.md).

| Request        | Type    | Notes                                                 |
| -------------- | ------- | ----------------------------------------------------- |
| `email`        | string  |                                                       |
| `password`     | string  | current password                                      |
| `recoveryCode` | string  | `XXXX-XXXX-XXXX`; case, spaces and dashes are ignored |
| `newPassword`  | string? | optional, ≥ 12 chars                                  |

`200 { enrollment, revoked: { devices, sessions }, passwordChanged }`. Errors:
`401 invalid_credentials` (the same for a wrong email, password or code), `403 account_disabled`.

**`GET /recovery/codes`** (phone) → `200 { remaining }`.
**`POST /recovery/codes`** (phone) → `201 { recoveryCodes: [10 codes] }`, shown once. The previous codes are revoked.

## Socket.IO

Path `/socket.io`. Connections must come from an allowed `Origin`.

| Event             | Direction     | Payload                             | Notes                                                                                                                                                                                  |
| ----------------- | ------------- | ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `login:watch`     | browser → API | `{ challengeId, watchToken }` + ack | Ack: `{ ok: true, challengeId, status, expiresAt }` or `{ ok: false, error }` (`invalid_request`, `invalid_watch_token`, `challenge_not_found`, `too_many_watches`). Max 5 per socket. |
| `login:approved`  | API → browser | `{ challengeId }`                   | Only to sockets watching this challenge.                                                                                                                                               |
| `login:denied`    | API → browser | `{ challengeId }`                   |                                                                                                                                                                                        |
| `login:expired`   | API → browser | `{ challengeId }`                   | Sent at expiry if still pending.                                                                                                                                                       |
| `session:revoked` | API → browser | `{ sessionId }`                     | To sockets whose handshake carried that session's cookie.                                                                                                                              |

Event payloads contain identifiers only. A watch token lets its holder learn the outcome, but
completing sign-in also requires the HttpOnly binding cookie.

## Development-only account setup

There is no public sign-up endpoint. Create accounts with:

```bash
npm run dev:create-user -- --email you@example.test
```

The script prompts for the password without echo, writes directly to the database, and prints the
first 10 recovery codes once. It refuses to run when `NODE_ENV=production`.

## Logging

The request log contains only method, path (no query string), status and duration. Bodies, headers,
cookies, tokens, nonces, signatures and QR payloads are never logged; `test/logging.test.js`
asserts this for a full flow. Unexpected errors log the stack only. PostgreSQL value details are not
logged.
