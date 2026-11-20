# sem3 Capstone: Sign in with your phone

This project lets you sign in to a browser on a new or shared computer by approving the sign-in on your trusted phone. You never type your password on that computer.

> **Project status:** The API, database, live approval service, browser and phone app have been built. The browser sign-in flow has been tested end to end. The phone app's native security code still needs to be built and tested on real iPhone and Android devices. See [Known limitations](#known-limitations).

## How sign-in works

1. Sign in on your phone and register it as trusted.
2. On the computer, open the browser sign-in page. It shows a QR code that works for 60 seconds.
3. Scan the code with your phone. Check the browser details shown on the phone.
4. Approve or reject the request on the phone.
5. If approved, the computer signs in. You can see or sign out that browser from your phone.

The phone keeps its private key in protected phone hardware. The QR code contains a short-lived request, not a password or sign-in token. If all your phones are lost, use your password and a one-time recovery code to revoke them and register a new phone. See [Recovery](docs/RECOVERY.md).

## Project parts

| Part                | What it does                                                                                                     |
| ------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `apps/api`          | Checks passwords and phone signatures, manages devices and browser sessions, and sends live approval updates.    |
| `db`                | PostgreSQL setup, database changes and the SQL used by the API.                                                  |
| `apps/web`          | Shows the sign-in QR code, waits for the phone, and keeps the browser session in a protected cookie.             |
| `apps/mobile`       | Signs in and registers a phone, scans and approves QR requests, and manages browsers, phones and recovery codes. |
| `packages/protocol` | Holds the message formats shared by the API and apps.                                                            |

For more detail, see [the architecture guide](docs/ARCHITECTURE.md), [API guide](docs/API.md), [phone and browser guide](docs/CLIENTS.md), and [database submission](dbms/01_normalization.md).

## What you need

- Node.js 22.12 or newer and npm 10 or newer.
- Docker Desktop with Docker Compose, for PostgreSQL 18.
- For the phone app: Xcode for iPhone or Android Studio for Android. A real phone with a screen lock is needed to test secure hardware keys. Expo Go is not supported.

## Set up the project

From the project folder, install the JavaScript packages:

```bash
npm install
```

Create your local settings file:

```bash
cp .env.example .env
```

In `.env`, choose a local database password. Use that same password in `POSTGRES_PASSWORD`, `DATABASE_URL` and `TEST_DATABASE_URL`. Set `WATCH_TOKEN_SECRET` using the command shown in the file. Keep `.env` private; it is excluded from git.

Copy the phone app's settings example:

```bash
cp apps/mobile/.env.example apps/mobile/.env
```

For phone testing, set `EXPO_PUBLIC_API_URL` there to your computer's Wi-Fi address, for example `http://192.168.1.20:4000`. The phone and computer must be on the same network.

Start PostgreSQL and apply the database setup:

```bash
npm run db:up
npm run db:migrate
```

PostgreSQL is available only on your computer at `127.0.0.1:5433`. This avoids a clash with a PostgreSQL server using the usual port 5432. Check migration status with `npm run db:migrate:status`; open a database shell with `npm run db:psql`.

Create a local development account:

```bash
npm run dev:create-user -- --email you@example.test
```

This development-only command asks for a password of at least 12 characters and displays recovery codes once. Save the codes somewhere safe.

## Start the API and browser

Start each service in its own terminal:

```bash
npm run dev:api
```

```bash
npm run dev:web
```

Open these addresses:

| Address                          | Purpose                            |
| -------------------------------- | ---------------------------------- |
| http://localhost:5173            | Browser sign-in page.              |
| http://localhost:4000/api/health | API and database health check.     |
| `http://<your-Wi-Fi-IP>:4000`    | API address used by the phone app. |

## Run the phone app

The app uses native code to create and use secure hardware keys. Build it on a real phone the first time and after any native code change. Follow the setup steps in [the phone and browser guide](docs/CLIENTS.md#manual-setup).

For iPhone:

```bash
npm run ios --workspace @capstone/mobile -- --device
```

For Android:

```bash
npm run android --workspace @capstone/mobile -- --device
```

After installing the development build, start the phone app's JavaScript bundler with:

```bash
npm run dev:mobile
```

Expo Go cannot load the secure key module. Android emulators do not have the same secure hardware as a phone. For development only, `EXPO_PUBLIC_ALLOW_SOFTWARE_KEYS=true` enables software keys in the emulator and shows a warning. Do not use that setting for real accounts.

## Checks and useful commands

| Command                                                   | What it does                                                                                                                                                                     |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm test`                                                | Runs 98 automated tests against PostgreSQL.                                                                                                                                      |
| `npm run smoke`                                           | Checks the full API flow against the running local services, including expiry and recovery. It takes about 65 seconds. Use `SMOKE_SKIP_EXPIRY=1 npm run smoke` to skip the wait. |
| `npm run build:web`                                       | Builds the browser app for release.                                                                                                                                              |
| `npm run test:native-crypto --workspace @capstone/mobile` | Checks the Swift signing format against the API. This does not test an iPhone's Secure Enclave.                                                                                  |
| `npm run db:ap:check`                                     | Checks generated schema/query files and confirms the AP timing table links to all 43 three-run query-plan files.                                                                 |
| `npm run db:benchmark`                                    | Re-runs the database timing and query-plan measurements, writing the AP checkpoint timing table and one plans file per query.                                                    |
| `npm run db:down`                                         | Stops PostgreSQL. Your database files remain saved.                                                                                                                              |

## Security in brief

- The phone creates an ES256 key (ECDSA on the P-256 curve with SHA-256). Its private part stays in the phone's Secure Enclave or Android Keystore; the server receives only the public key.
- The phone signs a message tied to one specific QR request. The server looks up the registered key and checks the signature. Each request can be approved only once.
- QR codes expire after 60 seconds. The browser also needs its own protected cookie to finish sign-in.
- The browser session cookie is hidden from page scripts. The browser does not save session credentials in local storage.
- Passwords and recovery codes are stored as slow password hashes. The API and database logs do not print password or token values.

More detail is in [the API guide](docs/API.md) and [the architecture guide](docs/ARCHITECTURE.md).

## Recovery if a phone is lost

If you have another trusted phone, use it to revoke the missing phone. If all trusted phones are lost, use your password and one recovery code on a new phone. This signs out every browser and revokes every old phone before you register the replacement. If you have no recovery codes left, an administrator must verify your identity manually. See [the full recovery guide](docs/RECOVERY.md).

## Known limitations

- The native phone module has not yet been built or tested on a real iPhone or Android phone. Secure Enclave, StrongBox and biometric prompts still need device testing.
- Phone traffic uses plain HTTP on the local network in development. A production setup needs HTTPS.
- Accounts are created with a development tool; there is no public sign-up or email verification.
- Running multiple API servers needs shared storage for live messages and rate limits.
- The server registers public keys but does not yet issue device certificates. See [open design decisions](docs/ARCHITECTURE.md#open-decisions).
- Database timings were measured on one computer with generated sample data. They are not a promise of production performance. See [the results](dbms/05_query_timings.md) and per-query plans in [dbms/plans/](dbms/plans/).

## Important folders

```text
apps/api/          API and live approval service
apps/web/          Browser sign-in page
apps/mobile/       Trusted-phone app and native secure-key module
packages/protocol/ Shared message formats
 db/               Database migrations and SQL queries
 dbms/             Database assignment materials
 docs/             Architecture, API, recovery and client guides
```

Never put secrets in `VITE_*` or `EXPO_PUBLIC_*` settings. Those values are included in browser or phone app files that other people can inspect.
