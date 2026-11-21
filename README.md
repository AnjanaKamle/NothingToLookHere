# sem3 Capstone: Sign in on a shared computer using your phone

Have you ever logged into WhatsApp Web? You open a page on a computer, it shows a QR code, you scan it with your phone, and the computer is suddenly logged in. **You never typed your password on that computer.**

This project builds a small, beginner-friendly version of that idea using **Node.js, Express, PostgreSQL, Prisma, cookies and JWTs**. It is written for students who are still learning these topics, so this README explains every piece, not just how to run it.

---

## Table of contents

1. [The problem this project solves](#1-the-problem-this-project-solves)
2. [How it works (the big picture)](#2-how-it-works-the-big-picture)
3. [Tech stack: what each tool is and why it is here](#3-tech-stack-what-each-tool-is-and-why-it-is-here)
4. [Repository structure: what every folder and file does](#4-repository-structure-what-every-folder-and-file-does)
5. [Setup: run it on your own machine](#5-setup-run-it-on-your-own-machine)
6. [Trying the full flow](#6-trying-the-full-flow)
7. [API reference](#7-api-reference)
8. [The database](#8-the-database)
9. [Key concepts explained with code from this project](#9-key-concepts-explained-with-code-from-this-project)
10. [Course topics used](#10-course-topics-used)
11. [Limitations and ideas for improving it](#11-limitations-and-ideas-for-improving-it)
12. [Troubleshooting](#12-troubleshooting)

---

## 1. The problem this project solves

Imagine you need to check something on a **library computer** or a **friend's laptop**. Typing your password there is risky: the computer might have a keylogger, the browser might save your password, or you might forget to log out.

**The idea:** your phone is already a device you trust and are signed in on. So instead of typing a password on the untrusted computer, the computer shows a QR code, and your **phone approves it**. The password only ever gets typed on your own phone.

The phone can also see every computer it has approved and **sign any of them out remotely**, so if you forget to log out at the library, you can fix it from your phone.

---

## 2. How it works (the big picture)

There are two "characters":

- **The phone**: a browser on your phone where you signed in normally (phone number + password).
- **The computer**: an untrusted browser that wants to sign in without a password.

```text
 COMPUTER (untrusted)              SERVER (Express + PostgreSQL)             PHONE (trusted, signed in)
 ────────────────────              ─────────────────────────────             ──────────────────────────
 1. Click "Show sign-in QR"  ───►  creates a login_request row
                                   (random token, expires in 2 min)
    shows the QR code       ◄───   returns QR image + request id
                                   + sets a "request_secret" cookie

 2. Every 2 seconds asks:    ───►  "status is PENDING"
    "is my request approved?"

                                                                     3. Scan QR with phone camera.
                                                                        The QR is a link: /?approve=<token>
                                   shows which browser is asking ◄─── 4. Phone opens the link
                                                                     5. Tap "Approve sign-in"
                                   marks request APPROVED       ◄───
                                   creates a BROWSER session row

 6. Next check:              ───►  "status is APPROVED"
    computer is signed in!  ◄───   sets an HTTP-only "session" cookie (a JWT)

                                                                     7. Phone lists active browser sessions
                                   marks session revoked        ◄───    and can "Sign out" any of them
```

A few rules make this safe enough for a classroom project:

- **Each QR works once.** When the phone approves, the server only updates the request **if it is still `PENDING` and not expired**. A second approval finds nothing to update and is rejected.
- **QR codes expire after 2 minutes**, so an old photo of a QR code is useless.
- **Only a signed-in *phone* can approve.** A computer session cannot approve other computers.
- **Only the computer that created the request can collect the login.** It holds a secret cookie (`request_secret`). Someone who only knows the request id cannot steal the session.
- **Revoking really works.** Every request checks the database to see if the session was revoked, not just whether the JWT looks valid.

---

## 3. Tech stack: what each tool is and why it is here

| Tool | What it is | Why this project uses it |
|---|---|---|
| **Node.js** (v22) | A JavaScript runtime built on Google's V8 engine. It lets JavaScript run outside the browser, on a server. Its event loop handles many requests without waiting on each one (non-blocking I/O). | Runs our backend server. |
| **ES Modules** (`import` / `export`) | The modern JavaScript module system. Enabled by `"type": "module"` in `package.json`. | Every file imports what it needs instead of using `require()`. |
| **Express** (v5) | A small web framework on top of Node's `http` module. It gives you routing (`router.get(...)`), middleware, `req`, and `res`. | Defines all our API endpoints and serves the HTML/CSS/JS files. |
| **PostgreSQL** | A relational (SQL) database. Data lives in tables with rows and columns, connected by foreign keys. | Stores users, devices, login requests and sessions. |
| **Prisma ORM** (v7) | An ORM (Object Relational Mapper). You describe tables in `schema.prisma`, and Prisma gives you JavaScript functions like `prisma.user.create(...)` instead of writing SQL by hand. It also creates **migrations** (versioned SQL files that build your tables). | All database reads and writes. |
| **pg** + **@prisma/adapter-pg** | `pg` is the PostgreSQL **database driver** for Node (the low-level code that talks to the database). Prisma 7 connects through it using an "adapter". | The connection between Prisma and PostgreSQL. |
| **bcryptjs** | A library for **hashing** passwords. A hash is a one-way scramble: you can check a password against it, but you cannot turn it back into the password. | We never store real passwords, only bcrypt hashes. |
| **jsonwebtoken** (JWT) | Creates and verifies **JSON Web Tokens**: small signed strings that say "this is user X, session Y". The signature proves the server made it, so nobody can edit it. | The login token stored in the `session` cookie. |
| **cookie-parser** | Express middleware that reads the `Cookie` header and puts the values on `req.cookies`. | Reading the `session` and `request_secret` cookies. |
| **qrcode** | Turns text into a QR code image. | Draws the QR code the phone scans. |
| **dotenv** | Loads variables from a `.env` file into `process.env`. | Keeps the database URL and JWT secret out of the code. |
| **HTML, CSS, plain JavaScript** | The frontend, with no framework. Uses `fetch()` to call the API. | One simple page that acts as both the "computer" and "phone" screens. |

**What we deliberately did not use:** WebSockets / Socket.io (we use simple polling instead, see [section 9](#polling-instead-of-websockets)), OAuth, certificates, or React. This keeps every piece inside the course topics.

---

## 4. Repository structure: what every folder and file does

```text
.
├── src/                         ← the backend (Node.js + Express)
│   ├── server.js                ← START HERE: starts the HTTP server
│   ├── app.js                   ← builds the Express app and plugs in middleware
│   ├── db.js                    ← creates the one shared Prisma client
│   ├── events.js                ← EventEmitter example (logs approvals)
│   ├── routes/
│   │   └── api.js               ← every URL the API answers, and who may call it
│   ├── controllers/             ← the "C" in MVC: what happens for each URL
│   │   ├── authController.js    ← register, login, "who am I?", logout
│   │   ├── loginRequestController.js ← the QR flow: create, check, preview, approve
│   │   └── sessionController.js ← list and revoke browser sessions
│   ├── middleware/
│   │   └── authenticate.js      ← checks the JWT cookie; "phone only" guard
│   └── services/                ← small reusable helpers
│       ├── passwords.js         ← bcrypt hash / compare
│       └── sessions.js          ← create sessions, sign JWTs, set the cookie
│
├── prisma/                      ← the database layer (the "M" in MVC)
│   ├── schema.prisma            ← the tables (models), columns and relations
│   ├── migrations/              ← SQL files that create the tables, in order
│   │   ├── 20261121000000_init/migration.sql
│   │   └── migration_lock.toml  ← tells Prisma which database type we use
│   └── seed.js                  ← script to create a demo user from the terminal
│
├── public/                      ← the frontend (the "V" in MVC), served as static files
│   ├── index.html               ← the single page with all panels
│   ├── style.css                ← styling
│   └── app.js                   ← browser code: calls the API, shows/hides panels
│
├── dbms/                        ← Database Engineering course deliverables
│   ├── 01_normalization.md      ← why the tables are in 1NF/2NF/3NF
│   ├── 02_er_diagram.mmd        ← ER diagram (Mermaid format)
│   ├── 03_schema.sql            ← the schema as plain PostgreSQL
│   └── 04_queries.sql           ← the main queries the app runs, written as SQL
│
├── package.json                 ← project name, scripts, dependencies
├── package-lock.json            ← exact installed versions (do not edit by hand)
├── prisma.config.ts             ← tells the Prisma CLI where the schema, migrations and DB are
├── .env.example                 ← template for your own .env file
├── .nvmrc                       ← the Node version (22) for nvm users
├── .gitignore                   ← files git should never commit (.env, node_modules…)
├── .editorconfig                ← shared editor settings (indentation etc.)
├── .prettierrc.json             ← code formatting rules for Prettier
└── .prettierignore              ← files Prettier should skip
```

### The backend files in more detail

**`src/server.js`**: The entry point (`npm run dev` runs this file). It:
1. Checks that `DATABASE_URL` and a real `JWT_SECRET` are set, and refuses to start otherwise.
2. Calls `app.listen(port)` to start the server.
3. Listens for `SIGINT` (Ctrl+C) and `SIGTERM` with `process.on(...)` so it can close the server and the database connection cleanly before exiting.

**`src/app.js`**: Creates the Express app and sets the middleware **in order**:
1. `express.json()`: turns a JSON request body into `req.body`.
2. `cookieParser()`: turns the `Cookie` header into `req.cookies`.
3. `app.use("/api", apiRoutes)`: every URL starting with `/api` goes to the router.
4. `express.static("public")`: serves `index.html`, `style.css` and `app.js`.
5. A fallback that sends `index.html` for any other URL (so `/?approve=...` works).
6. An **error-handling middleware** (it has 4 arguments: `error, req, res, next`). Any `next(error)` in a controller ends up here and returns a `500`.

**`src/db.js`**: Creates **one** `PrismaClient` and exports it. Every other file imports this same client instead of making new ones, which would open too many database connections.

**`src/events.js`**: An `EventEmitter` (the **Observer pattern**). When a login is approved, the controller *emits* `"login:approved"`, and a *listener* here logs it. The controller does not need to know who is listening. You could add more listeners later (send an email, write an audit log…) without touching the controller.

**`src/routes/api.js`**: Maps each **HTTP method + URL** to a controller function, with middleware in between. For example:

```js
router.post("/requests/approve", authenticate, requirePhone, requests.approveRequest);
//           URL                 1st: signed in?  2nd: is a phone?  3rd: do the work
```

**`src/controllers/authController.js`**:
- `register`: validates input, hashes the password, creates the user **and** their first device in one nested write, starts a phone session.
- `login`: finds the user by phone number, compares the password with bcrypt, records this phone as a device, starts a session.
- `me`: returns the signed-in user and whether this is a `PHONE` or `BROWSER` session.
- `logout`: marks the current session as revoked and clears the cookie.

**`src/controllers/loginRequestController.js`**: The heart of the project:
- `createRequest`: the computer asks for a QR code. Saves a `login_requests` row with a random `token` (goes into the QR) and a `browserSecret` (goes into this browser's cookie).
- `requestStatus`: the computer polls this. If the phone approved, it hands the computer its `session` cookie.
- `previewRequest`: the phone asks "which browser is this?" before approving.
- `approveRequest`: the phone approves or denies. Uses the "only if still `PENDING`" update so a QR can only be used once.

**`src/controllers/sessionController.js`**: Lets the phone list active browser sessions and revoke one.

**`src/middleware/authenticate.js`**:
- `authenticate`: reads the `session` cookie, verifies the JWT, then **looks up the session in the database** to make sure it is not revoked or expired. Puts the result on `req.auth` for the controllers.
- `requirePhone`: lets the request through only if `req.auth.type` is `"PHONE"`.

**`src/services/passwords.js`**: `hashPassword()` and `verifyPassword()` with bcrypt.

**`src/services/sessions.js`**: `createPhoneSession()`, `makeToken()` (signs the JWT), `setSessionCookie()` (with `httpOnly` and `sameSite` options), and `sessionExpiry()` (7 days).

### The frontend files

**`public/index.html`** has four panels; only one or two are visible at a time:
- `browser-panel`: the computer view, with the "Show sign-in QR" button.
- `auth-panel`: the phone sign-in / create-account form.
- `approval-panel`: "Approve this sign-in?" after scanning a QR.
- `phone-panel`: the signed-in phone, with the list of active browser sessions.

**`public/app.js`** decides which panel to show. It calls `/api/auth/me` on load; if the URL contains `?approve=<token>`, it shows the approval screen. If nobody is signed in, it checks `navigator.userAgent`: a **phone** gets the sign-in form, and a **laptop/desktop** only gets the QR button, because the whole point is that you never type a password on the computer. It uses `setInterval` to poll the request status every 2 seconds.

---

## 5. Setup: run it on your own machine

### Prerequisites

- **Node.js 22.12 or newer**. Check with `node -v`. (If you use nvm, run `nvm use` in the project folder; it reads `.nvmrc`.)
- **PostgreSQL 14 or newer**, installed and running. Check with `psql --version`.
  - macOS: [Postgres.app](https://postgresapp.com/) or `brew install postgresql@16`
  - Windows: the installer from [postgresql.org](https://www.postgresql.org/download/)
  - Linux: `sudo apt install postgresql`
- **Git**

### Step 1: Get the code

```bash
git clone https://github.com/AnjanaKamle/NothingToLookHere.git
```

```bash
cd NothingToLookHere
```

### Step 2: Install dependencies

```bash
npm install
```

This reads `package.json` and downloads everything into `node_modules/`.

### Step 3: Create the database

Create an empty PostgreSQL database called `sem3_capstone`:

```bash
createdb sem3_capstone
```

(Or in `psql`: `CREATE DATABASE sem3_capstone;`)

### Step 4: Create your `.env` file

Copy the template:

```bash
cp .env.example .env
```

Open `.env` and fill in the values:

```env
DATABASE_URL="postgresql://postgres:your_password@localhost:5432/sem3_capstone?schema=public"
JWT_SECRET="paste-a-long-random-string-here"
PORT=3000
NODE_ENV=development
```

- `DATABASE_URL` format: `postgresql://USER:PASSWORD@HOST:PORT/DATABASE`. Use your own PostgreSQL username and password.
- `JWT_SECRET` must be **at least 32 random characters**. Generate one with:

```bash
openssl rand -hex 32
```

> **Never commit `.env`.** It contains secrets. It is already listed in `.gitignore`.

### Step 5: Create the tables (run the migration)

```bash
npm run db:migrate
```

Prisma reads `prisma/migrations/` and runs the SQL against your database, creating the `users`, `devices`, `login_requests` and `sessions` tables.

Then generate the Prisma Client (the JavaScript code behind `prisma.user.create(...)` and friends, built from your schema):

```bash
npm run db:generate
```

### Step 6 (optional): Create a demo user

```bash
npm run db:seed -- 9876543210 mypassword123
```

You can also just create an account from the web page.

### Step 7: Start the server

```bash
npm run dev
```

You should see:

```text
sem3 Capstone is running at http://localhost:3000
```

`npm run dev` uses `node --watch`, so the server restarts automatically when you save a file.

### All npm scripts

| Command | What it does |
|---|---|
| `npm run dev` | Start the server and restart on file changes |
| `npm start` | Start the server (no watching) |
| `npm run db:migrate` | Apply migrations / create new ones after you edit `schema.prisma` |
| `npm run db:generate` | Regenerate the Prisma Client after a schema change |
| `npm run db:seed -- <phone> <password>` | Create or update a user |
| `npm run db:studio` | Open Prisma Studio, a web UI to browse your tables |

---

## 6. Trying the full flow

### Option A: Phone + computer (the real experience)

The phone needs to reach your computer's server, so both must be on the **same Wi-Fi**.

1. Find your computer's local IP address:
   - macOS: `ipconfig getifaddr en0`
   - Windows: `ipconfig` and look for "IPv4 Address"
   - Linux: `hostname -I`
2. On the **computer**, open `http://<your-ip>:3000` (for example `http://192.168.1.20:3000`). Use the IP, not `localhost`, because the QR code link is built from this address.
3. On the **phone**, open the same `http://<your-ip>:3000`, and tap **Create account** (phones see the sign-in form straight away).
4. On the **computer**, click **Show sign-in QR**.
5. Scan the QR with the **phone camera**. It opens the approval page. Tap **Approve sign-in**.
6. Within 2 seconds the computer shows **"This browser is signed in."**
7. On the phone, open `http://<your-ip>:3000` again. You'll see the computer under **Active browser sessions**. Tap **Sign out** and the computer is logged out.

### Option B: Everything on one computer

Use two different browsers (for example Chrome as the "phone" and Firefox as the "computer"), or a normal window and a private window, because cookies are separate in each.

The app only shows the sign-in form to phones, so make browser 1 pretend to be a phone: in Chrome, open DevTools (`F12` or `Cmd+Option+I`), click the **Toggle device toolbar** icon (or `Ctrl+Shift+M` / `Cmd+Shift+M`), choose a phone such as "iPhone 12 Pro", and reload.

1. In browser 1 ("phone", in device mode), open `http://localhost:3000` and create an account.
2. In browser 2 ("computer"), open `http://localhost:3000` and click **Show sign-in QR**.
3. Get the link that is inside the QR code. Either scan it with any QR reader app and copy the link, or run `npm run db:studio`, open the `login_requests` table and copy the newest `token`. The link is `http://localhost:3000/?approve=<token>`.
4. Paste that link into **browser 1** and approve. Within 2 seconds browser 2 becomes signed in.

---

## 7. API reference

All endpoints are under `/api`. Request and response bodies are JSON. "Auth" means a valid `session` cookie is required.

| Method | URL | Auth | What it does |
|---|---|---|---|
| `GET` | `/api/health` | none | Returns `{ ok: true }`. Used to check the server is up. |
| `POST` | `/api/auth/register` | none | Body: `{ phone, password, deviceName? }`. Creates an account and signs in this phone. `201` on success, `409` if the phone number is taken. |
| `POST` | `/api/auth/login` | none | Body: `{ phone, password, deviceName? }`. Signs in this phone. `401` if wrong. |
| `GET` | `/api/auth/me` | any | Returns `{ user, type }` where `type` is `PHONE` or `BROWSER`. |
| `POST` | `/api/auth/logout` | any | Revokes the current session and clears the cookie. |
| `POST` | `/api/requests` | none | Computer creates a QR login request. Returns `{ id, qr, expiresAt }` (`qr` is an image data URL). |
| `GET` | `/api/requests/:id` | request cookie | Computer polls the status: `PENDING`, `APPROVED`, `DENIED` or `EXPIRED`. On `APPROVED` it also sets the `session` cookie. |
| `GET` | `/api/requests/preview/:token` | phone | Phone sees which browser is asking. `410` if expired or used. |
| `POST` | `/api/requests/approve` | phone | Body: `{ token, decision }` with `decision` `"approve"` or `"deny"`. `410` if expired or already used. |
| `GET` | `/api/sessions` | phone | Lists active browser sessions this user approved. |
| `DELETE` | `/api/sessions/:id` | phone | Signs out one browser session. |

**Status codes used:** `200` OK · `201` Created · `400` bad input · `401` not signed in · `403` signed in but not allowed · `404` not found · `409` conflict (duplicate) · `410` gone (expired/used) · `500` server error.

---

## 8. The database

Four tables, defined in `prisma/schema.prisma`:

```text
users ──< devices ──< sessions >── login_requests
  │                      ▲               │
  └──────────────────────┘               │
  users ──< login_requests (approved by) ┘
```

| Table | One row means… | Important columns |
|---|---|---|
| `users` | one account | `phone` (unique), `password_hash` (bcrypt, never the real password) |
| `devices` | one phone the user signed in on | `user_id`, `name`, `revoked_at` |
| `login_requests` | one QR code shown on a computer | `token` (in the QR, unique), `browser_secret` (in the computer's cookie), `status` (`PENDING`/`APPROVED`/`DENIED`), `expires_at`, who approved it |
| `sessions` | one signed-in browser or phone | `type` (`PHONE`/`BROWSER`), `device_id`, `login_request_id`, `expires_at`, `revoked_at` |

**Relations (the Prisma Relations lectures):**
- One **user** has many **devices** and many **sessions** (one-to-many).
- One **login request** creates at most one **session** (one-to-one, enforced by a unique `login_request_id`).
- A **login request** remembers which **user** and **device** approved it.

**Soft deletes:** we never delete sessions or devices. We set `revoked_at` to the current time instead. This keeps history and makes "is this still valid?" a simple `revokedAt: null` check.

The `dbms/` folder has the same design written as plain SQL, an ER diagram, and a normalization write-up.

---

## 9. Key concepts explained with code from this project

### Password hashing (never store plain passwords)

```js
// src/services/passwords.js
export function hashPassword(password) {
  return bcrypt.hash(password, 10);        // "secret123" → "$2a$10$Xy...long random-looking string"
}
export function verifyPassword(password, savedHash) {
  return bcrypt.compare(password, savedHash); // true or false
}
```

If the database leaks, attackers get hashes, not passwords. bcrypt adds a random **salt** to each password, so two users with the same password get different hashes.

### JWT inside an HTTP-only cookie

After login the server signs a JWT and puts it in a cookie:

```js
// src/services/sessions.js
jwt.sign({ sub: userId, sid: sessionId, type: "PHONE" }, process.env.JWT_SECRET, { expiresIn: "7d" });

res.cookie("session", token, { httpOnly: true, sameSite: "lax", maxAge: 7 days });
```

- The browser sends the cookie automatically with every request, so the frontend never handles the token.
- `httpOnly` means JavaScript in the page **cannot read** the cookie, which protects it from XSS attacks.
- `sameSite: "lax"` stops other websites from sending it in most cross-site requests (CSRF protection).

### Token + session row = sessions you can revoke

A plain JWT is valid until it expires; you cannot "cancel" it. So our JWT only contains a **session id** (`sid`), and the `authenticate` middleware checks that row in the database:

```js
// src/middleware/authenticate.js
const payload = jwt.verify(token, process.env.JWT_SECRET);      // 1. is the signature real?
const session = await prisma.session.findFirst({
  where: { id: payload.sid, revokedAt: null, expiresAt: { gt: new Date() } } // 2. still active in the DB?
});
```

This combines **token-based** auth (JWT) with **session-based** auth (a database row), getting the benefits of both.

### Middleware chains

```js
router.get("/sessions", authenticate, requirePhone, sessions.listSessions);
```

Express runs these left to right. Each one either calls `next()` to continue or sends a response to stop. So `listSessions` only runs for a signed-in phone, and it does not need to check that itself.

### "Use this QR only once" with a conditional update

```js
// src/controllers/loginRequestController.js
const changed = await prisma.loginRequest.updateMany({
  where: { token, status: "PENDING", expiresAt: { gt: new Date() } },
  data:  { status: "APPROVED", ... }
});
if (changed.count !== 1) return res.status(410).json({ error: "already handled" });
```

The `WHERE` only matches a request that is still pending and not expired. If two approvals arrive at the same moment, the database updates the row for the first one; the second one matches **0 rows** and is rejected. No extra locking code needed.

### Nested writes (Prisma relations)

```js
// src/controllers/authController.js: create a user AND their first device together
await prisma.user.create({
  data: { phone, passwordHash, devices: { create: { name: "My phone" } } },
  include: { devices: true }
});
```

### Relation filtering

```js
// only accept a PHONE session if its device has not been revoked
where: { ..., device: { revokedAt: null } }
```

### Polling instead of WebSockets

The computer needs to know when the phone approves. A real-time WebSocket would push the news instantly, but it is a whole extra technology. Instead the frontend simply asks every 2 seconds:

```js
// public/app.js
pollTimer = setInterval(() => pollRequest(request.id), 2000);
```

A 2-second delay is fine for logging in, and it is just normal HTTP requests you can see in the browser's Network tab.

### MVC

- **Model**: `prisma/schema.prisma` (what the data looks like) and the Prisma Client.
- **View**: `public/` (what the user sees).
- **Controller**: `src/controllers/` (what happens on each request).
- **Routes** connect URLs to controllers; **services** hold reusable logic; **middleware** runs before controllers.

### Error handling

Each controller wraps its work in `try { ... } catch (error) { next(error); }`. `next(error)` skips the remaining normal middleware and jumps to the error handler at the bottom of `src/app.js`, which logs the error and returns `500` without leaking details to the user.

---

## 10. Course topics used

| Course module | Where to see it |
|---|---|
| **Node.js internals**: event loop, non-blocking I/O, `process`, `path`, ES Modules | `src/server.js` (`process.env`, `process.on("SIGINT")`), `src/app.js` (`path`, `import.meta.url`), every `await` |
| **EventEmitter / Observer pattern** | `src/events.js`, emitted in `approveRequest` |
| **HTTP**: methods, status codes, headers, request/response | `src/routes/api.js`, every `res.status(...)`, `req.get("user-agent")` |
| **Express**: routing, route parameters, request/response, static files | `src/routes/api.js` (`/requests/:id`), `express.static` in `src/app.js` |
| **Middleware** | `express.json()`, `cookieParser()`, `authenticate`, `requirePhone`, the error handler |
| **REST API, resource-based URLs** | `/api/requests`, `/api/sessions/:id` with `GET`/`POST`/`DELETE` |
| **MVC architecture and folder structure** | `routes/`, `controllers/`, `services/`, `prisma/`, `public/` |
| **Databases, drivers, ORM** | `pg` driver + Prisma in `src/db.js` |
| **Prisma schema, models, migrations** | `prisma/schema.prisma`, `prisma/migrations/` |
| **Prisma CRUD and seeding** | `create`, `findUnique`, `findMany`, `update`, `updateMany`, `upsert` in `prisma/seed.js` |
| **Prisma relations and relation filters** | `User → Device → Session`, nested `create`, `include`, `device: { revokedAt: null }` |
| **Authentication, cookies, session-based auth** | `setSessionCookie`, the `sessions` table, logout and revoke |
| **Token-based auth, JWT, auth middleware** | `src/services/sessions.js`, `src/middleware/authenticate.js` |

---

## 11. Limitations and ideas for improving it

This is a learning project, not a production login system.

- **No phone number verification.** Anyone can register any number; there is no SMS code.
- **No account recovery.** If you lose your phone, there is no way back into the account in this version.
- **The phone is "trusted" because it is signed in.** The original idea uses a private key stored in the phone's secure hardware to *sign* the approval. That needs native app APIs and is outside this course.
- **Use HTTPS** before putting this anywhere outside your own Wi-Fi. Cookies get the `secure` flag automatically when `NODE_ENV=production`.
- **No rate limiting.** Someone could try many passwords quickly.

Good next steps if you want to practice:
- Replace polling with **Socket.io** so the computer is told instantly.
- Add **API versioning** (`/api/v1/...`).
- Add rate limiting to `/api/auth/login`.
- Add an "Active phones" list so the user can sign out a lost phone from another phone.

---

## 12. Troubleshooting

| Problem | Fix |
|---|---|
| `Set DATABASE_URL and replace the JWT_SECRET placeholder…` on start | Your `.env` is missing or still has the example `JWT_SECRET`. See [Step 4](#step-4-create-your-env-file). |
| `Can't reach database server` / `ECONNREFUSED 5432` | PostgreSQL is not running, or the host/port/password in `DATABASE_URL` is wrong. |
| `database "sem3_capstone" does not exist` | Run `createdb sem3_capstone` ([Step 3](#step-3-create-the-database)). |
| `The table "public.users" does not exist` | Run `npm run db:migrate`. |
| Phone can't open the QR link | Phone and computer must be on the same Wi-Fi, and you must open the computer page using its IP address, not `localhost`. Some public/university Wi-Fi blocks devices from talking to each other. Try a phone hotspot. |
| "This QR request has expired" | QR codes last 2 minutes. Click **Show sign-in QR** again. |
| "This browser did not create the request" | The status was checked from a different browser than the one that showed the QR (cookies are per browser). |
| Port 3000 already in use | Change `PORT` in `.env`, or stop the other program. |
