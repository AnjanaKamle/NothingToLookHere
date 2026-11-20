# Architecture

sem3 Capstone lets a person sign in to a browser on a new or shared computer **without typing their
password there**. A phone they enrolled earlier holds a hardware-protected private key. It scans a QR
code shown by the browser and signs the challenge inside it. The server verifies the signature and
pushes the approval to the waiting browser in real time.

> Status: complete (phase 5). All components are integrated and verified end to end except the
> phone's native key module on physical devices ([CLIENTS.md](CLIENTS.md#verification-status)).

## Components

```
                 ┌──────────────────────────┐
                 │  Trusted phone            │  apps/mobile  (React Native, Expo dev build)
                 │  - device key in SE/TEE   │
                 │  - scans QR, signs        │
                 │  - lists/revokes sessions │
                 └────────────┬─────────────┘
                      HTTPS (JSON)
                              │
┌──────────────────┐   ┌──────▼────────────────────┐    ┌─────────────┐
│  Browser          │   │  API                       │    │ PostgreSQL  │
│  apps/web (React) │◄─►│  apps/api (Node, Express,  │◄──►│ users,      │
│  - shows QR       │   │  Socket.IO)                │    │ devices,    │
│  - waits for      │WS │  - accounts, enrollment    │    │ challenges, │
│    approval       │◄──│  - challenges, verification│    │ sessions    │
│  - holds session  │   │  - sessions, recovery      │    └─────────────┘
└──────────────────┘   └────────────────────────────┘
          packages/protocol: constants all three share (event names, QR prefix, version)
```

| Component                 | Responsibilities                                                                                                                                                                                                                                  | Never does                                                                       |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| **API** (`apps/api`)      | Owns all security decisions: password check for the first login, device enrollment, issuing and verifying challenges, enforcing expiry and single use, creating and revoking sessions, account recovery. Only component that talks to PostgreSQL. | Trust a client's claim about who it is without verifying a signature or session. |
| **Browser** (`apps/web`)  | Requests a login challenge, renders it as a QR code, waits on Socket.IO, then completes sign-in over HTTPS and holds an `HttpOnly` session cookie.                                                                                                | See or handle the user's password or any long-lived key.                         |
| **Phone** (`apps/mobile`) | Initial sign-in and enrollment, generating the device key in secure hardware, scanning QR codes, showing the user what they are approving, signing approvals, listing and revoking browser sessions.                                              | Export the private key, or store it in ordinary app storage.                     |
| **PostgreSQL**            | Durable state. Single-use is enforced by atomic SQL updates, not in application memory.                                                                                                                                                           |                                                                                  |
| **`packages/protocol`**   | Shared constants: protocol version, QR prefix, Socket.IO event names, TTL bounds, the exact signed-message formats, QR payload format, and an ES256 test vector.                                                                                  | Crypto or I/O. Each runtime uses its own platform crypto.                        |

## Main flows

Implemented in the API (phase 3). The endpoint-level reference, message formats and error codes are
in [API.md](API.md). The phone and browser screens are described in [CLIENTS.md](CLIENTS.md).

### 1. Enrolling a trusted phone

1. The user signs in on the phone with their password (`POST /api/auth/password-login`). The API
   returns only a short-lived **enrollment challenge**: an id and a random nonce, stored hashed.
2. The phone's native `device-key` module generates a P-256 key pair in the Secure Enclave (iOS) or
   Android Keystore (StrongBox if present). Only the public key reaches JavaScript.
3. The phone signs the enrollment message (audience, enrollment id, nonce) with the new key and sends
   the public key (DER SPKI), the signature (DER), its name, platform and key storage type
   (`POST /api/devices/enroll`). The signature is **proof of possession**.
4. The API checks that the key is a canonical P-256 key and verifies the signature. Then, in one
   transaction (`T-ENROLL`), it consumes the challenge (single use), stores the device and its key,
   and writes an audit event.
5. The API returns a random **device token** (shown once; the phone keeps it in `expo-secure-store`)
   for the phone's own API calls. Recovery codes are issued at account creation and can be
   regenerated from the phone.

Device certificates are not issued yet (open decision 1).

### 2. Signing in a browser by QR

1. The browser calls `POST /api/login/challenges`. The API stores a challenge with a random id, the
   hash of a 256-bit nonce, the hash of a 256-bit **browser binding secret**, and a 60 s expiry. The
   binding secret goes into an `HttpOnly; SameSite=Strict` cookie scoped to that challenge.
2. The browser shows `capstone-auth:v1:<challengeId>.<nonce>` as a QR code and subscribes over
   Socket.IO with an HMAC **watch token** valid only for that challenge.
3. The phone scans the code and fetches the request details (requester IP, user agent, time) so the
   user can spot an unexpected request. The user confirms, and biometric or passcode unlock is
   required to use the key.
4. The phone signs the login decision message (audience, challenge id, nonce, key id, decision)
   and posts the signature.
5. The API loads the **registered** public key for that key id, but only if the key, its device and
   the account are active and the key belongs to the calling phone. It rebuilds the message itself
   and verifies the ES256 signature. Then one guarded `UPDATE` (`Q-LCH-03`) records the decision
   only if the challenge is still `pending`, unexpired and the nonce matches. Concurrent approvals
   cannot both succeed.
6. The API emits `login:approved` to that challenge's room only. The browser calls
   `POST /api/login/challenges/:id/complete` with its binding cookie. One statement (`Q-LCH-05`)
   moves the challenge `approved → consumed` and inserts the session, at most once per challenge.
   The browser receives an `HttpOnly; SameSite=Lax` session cookie (`Secure` in production).
   Details: [dbms/01_normalization.md §6](../dbms/01_normalization.md#6-transaction-strategy-safe-one-time-approval).

A browser whose connection drops re-subscribes, and the subscription ack reports the current status
(or it polls `GET /api/login/challenges/:id`), so no approval is lost.

### 3. Viewing and revoking sessions

The phone lists the user's active sessions (`GET /api/sessions`) and revokes any of them
(`DELETE /api/sessions/:id`). Every authenticated browser request re-checks revocation, expiry, idle
time, and the approving device and account. The API pushes `session:revoked` so an open tab can sign
out immediately. Revoking a device also revokes every session it approved.

### 4. Lost phone: account recovery

Full policy: [RECOVERY.md](RECOVERY.md). In short: users can enroll several phones and revoke one
from another. If all are lost, password **plus** one single-use recovery code revokes every device,
key and session in one transaction and returns an enrollment challenge for the new phone. Attempts
are rate-limited and audit-logged. Email notification is not implemented yet.

## Trusted-phone key storage

**Requirement:** the private key stays on the phone in platform-protected storage and never enters
ordinary app storage.

**Choice:** a small local Expo module (`apps/mobile/modules/device-key`, Swift + Kotlin) using:

- **iOS:** `SecKeyCreateRandomKey` with `kSecAttrTokenIDSecureEnclave`, P-256 (the only curve the
  Secure Enclave supports), access control `kSecAttrAccessibleWhenUnlockedThisDeviceOnly` +
  `.privateKeyUsage` (+ `.userPresence` for approvals).
- **Android:** `KeyPairGenerator` with `AndroidKeyStore`, `EC secp256r1`, `PURPOSE_SIGN`,
  `setIsStrongBoxBacked(true)` with fallback to the TEE, user authentication required. Key
  attestation is available for later hardening.

Signing happens inside the secure hardware, so the private key is non-exportable and never reaches
JavaScript. Signatures are ECDSA-SHA256, which Node verifies with built-in `node:crypto`. No extra
server crypto dependency is needed.

**Alternatives considered:**

| Option                                                                                                   | Why not                                                                                                                                                                                                   |
| -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Generate the key in JS (`@noble/curves`, `react-native-quick-crypto`) and save it in `expo-secure-store` | The key exists in JS memory and is exportable. SecureStore encrypts it at rest (Keychain / Keystore-encrypted prefs), but the hardware does not do the signing. Acceptable only as a documented fallback. |
| Third-party Expo signing modules (e.g. `expo-secure-signing`)                                            | The ones found are beta or have small user bases. Worth re-evaluating; our module's API matches theirs, so swapping is cheap.                                                                             |
| `expo-app-integrity`                                                                                     | Built for app attestation (App Attest / Play Integrity), not general challenge signing.                                                                                                                   |

**Consequence: an Expo development build is required.** Custom native code cannot run in Expo Go.
The app is built with `npx expo run:ios` / `npx expo run:android` (or EAS Build) and includes
`expo-dev-client`. `ios/` and `android/` are generated by `expo prebuild` (Continuous Native
Generation) and git-ignored. Secure Enclave signing needs a **physical iPhone**: the iOS Simulator has
no Secure Enclave.

Other mobile libraries (Expo SDK 58), added when their phase starts:

- `expo-camera`: `CameraView` with `barcodeScannerSettings={{ barcodeTypes: ['qr'] }}`. Physical device only.
- `expo-secure-store`: stores the phone's **API credential** (not the signing key), with
  `WHEN_UNLOCKED_THIS_DEVICE_ONLY` so it never migrates through backups.
- `expo-local-authentication`: only if prompts are needed outside key use.

## Data model

Implemented in [`db/migrations/001_initial_schema.sql`](../db/migrations/001_initial_schema.sql). The
ER diagram is [`dbms/02_er_diagram.png`](../dbms/02_er_diagram.png), and the design rationale
(functional dependencies, BCNF analysis, transactions, index justification) is in
[`dbms/01_normalization.md`](../dbms/01_normalization.md).

| Table                                      | Purpose                                                                        |
| ------------------------------------------ | ------------------------------------------------------------------------------ |
| `users`                                    | Accounts. Password used only for the first phone sign-in and recovery.         |
| `devices`                                  | Trusted phones, with the SHA-256 of each phone's API bearer token.             |
| `device_keys`                              | Phone public keys (ES256, DER SPKI); rotatable, at most one active per device. |
| `enrollment_challenges`                    | One-time nonces for proof of possession during enrollment.                     |
| `login_challenges`                         | QR challenges: `pending → approved/denied → consumed`, ≤ 5 min lifetime.       |
| `browser_sessions`                         | Signed-in browsers (token stored hashed); one session per challenge.           |
| `recovery_code_batches` / `recovery_codes` | Hashed single-use recovery codes, one active batch per user.                   |
| `audit_events`                             | Append-only security log.                                                      |

Every SQL statement the API runs is catalogued with a stable ID in
[`db/queries.sql`](../db/queries.sql) and loaded by ID at runtime (`getQuery('Q-LCH-05')`).

Compared with the phase 1 sketch: the user is no longer stored on sessions and challenges (it is
derived through the device), keys moved to their own table to support rotation, and "expired" is
derived from `expires_at` instead of being stored. No certificate columns were added; they will
come in a new migration once open decision 1 is settled.

## Security notes

- **Secrets:** only in `.env` (git-ignored). `.env.example` contains placeholders only. Nothing secret
  goes in `VITE_*` or `EXPO_PUBLIC_*` variables, because those end up in client bundles.
- **Same origin:** in development, Vite proxies `/api` and `/socket.io` to the API, so the session cookie
  is first-party and no CORS allowances are needed. Production should serve both from one origin behind
  a TLS-terminating reverse proxy.
- **Transport:** production requires HTTPS/WSS. The phone talks to the API over the LAN in development.
- **Clock:** expiry is checked against the database clock (`now()`), never the client's.

## Open decisions

1. **What "certificate-backed" means concretely.** Recommended: the API runs a small private CA and
   issues an X.509 device certificate at enrollment (e.g. with `@peculiar/x509`; `node:crypto` can parse
   certificates but cannot create them). The database stays the source of truth for revocation. The
   simpler alternative is a server-signed JSON statement binding the same fields.
2. **Hardware key module:** _decided in phase 4_: our own local Expo module
   (`apps/mobile/modules/device-key`), with no third-party crypto dependency.
3. **Android devices without StrongBox/TEE:** _phase 4 default_: the app refuses software-only keys
   (except a development flag for emulators). The server still trusts the app's reported
   `keyStorage`; Android key attestation would let the server verify it.
4. **Local HTTPS for phone testing:** plain HTTP over the LAN works in debug builds. Release builds and
   realistic testing need TLS (e.g. a tunnel or a local CA such as `mkcert`).
5. **Real-time phishing relay.** An attacker's page can show a genuine QR code that the attacker
   requested. The signature binds the approval to that challenge, not to the page the user is
   looking at. The current mitigation is showing the requester's IP and user agent on the phone.
   Stronger options: number matching (the browser shows 2 digits that the user picks on the phone),
   or IP/location proximity checks.
6. **Running more than one API instance.** Socket.IO rooms and the rate-limit counters are
   in-memory. Multiple instances need a Socket.IO adapter (e.g. Redis) and a shared rate-limit store.
   Correctness of the one-time approval does not depend on this: it is enforced by PostgreSQL.
7. **Account provisioning and notifications.** Accounts are created with a development-only script.
   Production needs a registration or invitation flow, email notification of recovery and new
   devices, and per-account lockout (see [RECOVERY.md](RECOVERY.md)).
