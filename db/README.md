# Database

PostgreSQL schema, migrations and the application's SQL query catalogue (`@capstone/db` workspace).

```
db/
  migrations/001_initial_schema.sql   canonical schema, forward-only, applied in filename order
  queries.sql                          canonical list of every SQL statement the API runs (by ID)
  src/                                 migration runner and query loader (imported by the API)
  scripts/migrate.js                   CLI: apply migrations / show status
  scripts/build-ap.js                  generates dbms/03_schema.sql and dbms/04_queries.sql
  scripts/render-diagram.js            renders dbms/02_er_diagram.mmd -> .png
  test/                                schema, query and concurrency tests (real PostgreSQL)
dbms/                                  AP submission: design notes, ER diagram, generated SQL
```

Design rationale (normal forms, functional dependencies, transactions, indexes):
[dbms/01_normalization.md](../dbms/01_normalization.md).

## Apply migrations

From the repository root, with `.env` created from `.env.example`:

```bash
npm run db:up
```

```bash
npm run db:migrate
```

```bash
npm run db:migrate:status
```

The runner (`db/src/migrations.js`):

- runs each pending file in **its own transaction** together with its `schema_migrations` row;
- takes a PostgreSQL advisory lock, so two runners cannot interleave;
- stores a SHA-256 checksum per file and **refuses to run** if an applied file was edited.

The project's database listens on **port 5433** (not 5432) so it does not clash with a PostgreSQL
already installed on the machine. Set `POSTGRES_PORT` in `.env` to change it.

## Inspect the local schema

```bash
npm run db:psql
```

Useful `psql` commands once connected:

| Command                            | Shows                                              |
| ---------------------------------- | -------------------------------------------------- |
| `\dt`                              | tables                                             |
| `\d+ login_challenges`             | columns, constraints, indexes, triggers of a table |
| `\di`                              | all indexes                                        |
| `\df`                              | trigger functions                                  |
| `SELECT * FROM schema_migrations;` | applied migrations and their checksums             |

To use another client (TablePlus, DBeaver, pgAdmin), connect to `localhost:5433` with the
credentials from `.env`.

## Change the schema

1. Add `db/migrations/NNN_short_description.sql` (next number). Never edit an applied migration.
   Do not put `BEGIN`/`COMMIT` in the file: the runner adds them.
2. Add or change statements in `db/queries.sql` using the entry format described at its top
   (`-- @id`, `-- READ`/`-- WRITE`, description, one statement).
3. Update `dbms/02_er_diagram.mmd` if tables or relationships changed, then run `npm run db:ap:diagram`.
4. Regenerate the AP SQL files and run the tests:

```bash
npm run db:ap:build
```

```bash
npm test
```

## Query performance (AP)

```bash
npm run db:benchmark
```

Creates (or resets) a separate `capstone_bench` database. It refuses any name not ending in
`_bench`, and the dev and test databases are untouched. It seeds about 2 million synthetic rows
(`BENCH_USERS`, default 20000), runs every catalogued query under `EXPLAIN (ANALYZE, BUFFERS)`
(exactly 3 runs per query, arithmetic average reported; each in `BEGIN … ROLLBACK`), and writes
the AP checkpoint deliverables `dbms/05_query_timings.md` and one file per query in `dbms/plans/`.
Each plan file contains all three measured runs. It takes about 20 s.

## Tests

`npm test` (or `npm test --workspace @capstone/db`) runs against `TEST_DATABASE_URL`, the separate
`capstone_test` database. Each test file **drops and recreates** that database's `public` schema.
As a guard, the helper refuses to reset any database whose name does not end in `_test`. Database
tests are skipped with a message if `TEST_DATABASE_URL` is not set.

The tests check:

- the generated `dbms/` files are in sync;
- migrations apply, are idempotent, and detect edits;
- every catalogued query is accepted by `PREPARE`;
- the one-time approval guarantees hold, including a real two-connection race.
