# Account recovery: lost or replaced phone

## Policy

Signing in to a browser normally requires a trusted phone. If every trusted phone is lost,
recovery requires **two independent factors**:

1. the account **password** (something you know), and
2. one unused **recovery code** (something you were given and stored offline).

Neither alone is enough. A thief with the phone has neither factor in a usable form: the phone
holds no password, and its key can only be used after the phone is unlocked.

## Recovery codes

- 10 codes per batch, format `XXXX-XXXX-XXXX` (Crockford base32, 60 random bits each).
- Shown **once**: when the account is created, and whenever the user regenerates them on the
  phone (`POST /api/recovery/codes`). Generating a new batch revokes the old one.
- Stored only as scrypt hashes. Each code works once (`used_at` is write-once in the database).
- The phone can show how many remain (`GET /api/recovery/codes`). Users should regenerate when few
  are left.

## What recovery does

`POST /api/recovery` with email, password and a code. On success, **in one database transaction**:

1. the code is spent (a concurrent second attempt with the same code fails);
2. **every** browser session of the account is revoked, and open browsers are signed out in real time;
3. **every** device key and trusted device is revoked, including the lost phone;
4. the rest of the current recovery-code batch is revoked;
5. the password is replaced, if `newPassword` was supplied;
6. an enrollment challenge is returned, so the new phone can enroll immediately.

Each step is recorded in `audit_events` (`recovery.code_used`, `recovery.completed`, and
`user.password_changed` when applicable). Failed attempts are recorded as `recovery.failed`.

After enrolling, the new phone should immediately generate a new batch of recovery codes.

## Other paths

| Situation                                        | What to do                                                                                               |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| One of several phones lost                       | From another trusted phone: `POST /api/devices/:id/revoke` with `reason: "lost"`. No recovery needed.    |
| Phone replaced, old one still in hand            | Enroll the new phone (password sign-in), then revoke the old one from the new one.                       |
| Android invalidated the key (biometrics changed) | Key rotation from the same phone: `POST /api/devices/me/key-rotation`, then `POST /api/devices/me/keys`. |
| Password suspected compromised                   | Recover with `newPassword` set (this also revokes everything).                                           |
| No codes left and no phone                       | Manual identity verification by an administrator. Not automated in this project.                         |

## Abuse resistance

- `POST /api/recovery` is limited to 5 attempts per 15 minutes per IP.
- Wrong email, wrong password and wrong code return the same `401 invalid_credentials`. Password
  checks take the same time whether or not the account exists, and every candidate code is checked
  so timing does not reveal which code matched.

## Not implemented (decisions for later)

- **Email notification** when recovery succeeds or fails. There is no mail infrastructure in this
  project; production must notify the account owner.
- **Per-account lockout** in addition to per-IP limits (a distributed attacker can spread
  attempts across IPs). The 60-bit codes and the password requirement make guessing impractical,
  but lockout or exponential back-off per account is recommended.
- **Delay before recovery takes effect** (e.g. 24 hours with a cancel link) to blunt an attacker who
  stole both the password and the codes.
