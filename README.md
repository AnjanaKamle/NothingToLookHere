# sem3 Capstone

A small phone-approved sign-in demo for a shared computer. Sign in on your phone with a phone number and password, scan the computer's QR code with the phone camera, then approve the request. The computer checks the request until it is approved and receives a protected sign-in cookie.

This course version uses ordinary web technology. It does not issue certificates, use phone hardware keys, send SMS codes, or use OAuth. The QR flow demonstrates device approval; it is not a production identity service.

## Simple flow

1. Create an account and sign in on your phone's browser.
2. On the computer, create a one-time sign-in request. The server stores its hash and expiry in PostgreSQL and shows a QR code.
3. Scan the QR with the phone camera. The link opens this app and asks the signed-in phone to approve or deny the request.
4. The computer checks the request status. When approved, the server creates a browser session and sets an HTTP-only JWT cookie.
5. The phone can list and revoke browser sessions. Account creation also displays one-time recovery codes; using one changes the password and signs out old devices and browsers.

## Project structure

```text
prisma/                 Prisma schema and migrations
src/
  app.js                Express app and middleware
  server.js             HTTP server startup and shutdown
  db.js                 Prisma connection
  routes/               HTTP route definitions
  controllers/          Request and response handling
  middleware/           JWT cookie authentication
  services/             Passwords, sessions, and QR approval rules
  events.js             Small EventEmitter audit example
public/                 One plain HTML/CSS/JavaScript interface
dbms/                   Database Engineering report and SQL deliverables
```

## Requirements

- Node.js 22.12 or newer
- PostgreSQL 14 or newer

## Run locally

1. Create a PostgreSQL database named `sem3_capstone`.
2. Copy `.env.example` to `.env`, set `DATABASE_URL`, and replace `JWT_SECRET` with a random value of at least 32 characters (for example, `openssl rand -hex 32`).
3. Install packages and create the database tables:

   ```sh
   npm install
   npm run db:migrate
   ```

4. Start the app:

   ```sh
   npm run dev
   ```

5. Open `http://localhost:3000`. For phone scanning, open the same app using your computer's local network address on both devices. The phone and computer must be on the same Wi-Fi. Use HTTPS before exposing the app outside a trusted development network.

The first user can create an account from the sign-in page. The phone browser where the user signs in is treated as the trusted phone for this demo. Save the one-time recovery codes after account creation. Prisma's `prisma.config.ts` file provides the migration connection string; `src/db.js` connects through the PostgreSQL adapter.

## Course topics in the project

- **Advanced Programming:** Node.js and ES modules, asynchronous I/O, Express, HTTP/REST routes, middleware, MVC-style controllers, event handling, password hashing, JWT cookies, and the QR approval workflow.
- **Database Engineering:** PostgreSQL tables, keys, foreign keys, one-to-many relationships, unique and check constraints, Prisma models and migrations, CRUD queries, transactions for one-time approval, and indexes for common lookups.

The browser polls a normal REST endpoint instead of adding a socket server. This keeps the request/response flow visible and easy to explain.

## Scope and limitations

This is a learning project. Phone number and password are used directly; there is no SMS ownership check. Recovery codes are shown once and stored as hashes. A QR approval relies on the phone browser's signed-in cookie. JWTs are checked against database sessions so a revoked session stops working. Production use would need verified phone sign-in, HTTPS, and stronger abuse controls.

OAuth and certificate-backed key signing are intentionally out of this course version.
