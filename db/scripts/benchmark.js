#!/usr/bin/env node
/**
 * Query performance capture for the AP submission.
 *
 *   npm run db:benchmark                 (BENCH_USERS=20000 by default)
 *
 * 1. Creates (or resets) a SEPARATE database "capstone_bench" next to DATABASE_URL. It refuses to
 *    touch any database whose name does not end in "_bench". The dev and test databases are untouched.
 * 2. Applies the migrations and seeds synthetic data with SQL (sizes scale with BENCH_USERS).
 * 3. Runs every query in db/queries.sql with representative parameters under
 *    EXPLAIN (ANALYZE, BUFFERS): exactly RUNS measured runs, each inside
 *    BEGIN … ROLLBACK, so writes never change the data between runs.
 * 4. Writes the AP checkpoint deliverables dbms/05_query_timings.md and one raw-plan file per
 *    query under dbms/plans/ (all three measured runs are kept in each file).
 *
 * All numbers come from PostgreSQL's own "Planning Time" / "Execution Time" lines.
 */
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { migrateUp } from '../src/migrations.js';
import { loadQueries } from '../src/queries.js';
import { paths } from '../src/paths.js';

const RUNS = Number(process.env.BENCH_RUNS || 3);
if (!Number.isInteger(RUNS) || RUNS !== 3) {
  console.error('BENCH_RUNS must be 3 to match the AP checkpoint.');
  process.exit(2);
}
const N = Number(process.env.BENCH_USERS || 20000);
const SIZES = {
  users: N,
  devices: Math.round(N * 1.5),
  challenges: N * 15,
  enrollments: N * 2,
  audit: N * 50,
};

const baseUrl = process.env.BENCH_DATABASE_URL || process.env.DATABASE_URL;
if (!baseUrl) {
  console.error('DATABASE_URL is not set (copy .env.example to .env).');
  process.exit(2);
}
const benchUrl = new URL(baseUrl);
if (!process.env.BENCH_DATABASE_URL) benchUrl.pathname = '/capstone_bench';
const benchName = benchUrl.pathname.slice(1);
if (!benchName.endsWith('_bench')) {
  console.error(`Refusing to use "${benchName}": the benchmark database name must end in _bench.`);
  process.exit(2);
}

const sha = (value) => createHash('sha256').update(value).digest();
const log = (message) => console.log(`[bench] ${message}`);

// ------------------------------------------------------------------------------------------------
// 1. Create and reset the benchmark database
// ------------------------------------------------------------------------------------------------
{
  const adminUrl = new URL(benchUrl);
  adminUrl.pathname = '/postgres';
  const admin = new pg.Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  const { rowCount } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [
    benchName,
  ]);
  if (!rowCount) {
    log(`creating database ${benchName}`);
    await admin.query(`CREATE DATABASE "${benchName}"`);
  }
  await admin.end();
}

const db = new pg.Client({ connectionString: benchUrl.toString() });
await db.connect();
await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
await migrateUp(db);

// ------------------------------------------------------------------------------------------------
// 2. Seed. Deterministic ids (md5-derived UUIDs) let rows reference each other without lookups.
// ------------------------------------------------------------------------------------------------
const SPKI_HEADER_HEX = '3059301306072a8648ce3d020106082a8648ce3d030107034200';
const seed = [
  [
    'users',
    `INSERT INTO users (id, email, password_hash, created_at, updated_at, disabled_at)
     SELECT md5('u'||i)::uuid, 'user'||i||'@bench.test', '$scrypt$ln=17,r=8,p=1$c2FsdA$aGFzaA',
            now() - interval '400 days', now() - interval '400 days',
            CASE WHEN i % 100 = 0 THEN now() - interval '1 day' END
     FROM generate_series(1, ${SIZES.users}) i`,
  ],
  [
    'devices (10% revoked)',
    `INSERT INTO devices (id, user_id, name, platform, api_token_hash, created_at, last_used_at, revoked_at, revoked_reason)
     SELECT md5('d'||d)::uuid, md5('u'||((d-1) % ${SIZES.users} + 1))::uuid, 'Phone '||d,
            CASE WHEN d % 2 = 0 THEN 'ios' ELSE 'android' END, sha256(('dev'||d)::bytea),
            now() - interval '300 days', now() - interval '1 day',
            CASE WHEN d % 10 = 0 THEN now() - interval '30 days' END,
            CASE WHEN d % 10 = 0 THEN 'lost' END
     FROM generate_series(1, ${SIZES.devices}) d`,
  ],
  [
    'device_keys (current)',
    `INSERT INTO device_keys (id, device_id, public_key_spki, key_storage, created_at, last_used_at, revoked_at)
     SELECT md5('k'||d)::uuid, md5('d'||d)::uuid,
            decode('${SPKI_HEADER_HEX}04', 'hex') || sha256(('k'||d)::bytea) || sha256(('k2'||d)::bytea),
            (ARRAY['secure_enclave','strongbox','tee'])[d % 3 + 1],
            now() - interval '300 days', now() - interval '1 day',
            CASE WHEN d % 10 = 0 THEN now() - interval '30 days' END
     FROM generate_series(1, ${SIZES.devices}) d`,
  ],
  [
    'device_keys (rotated-out history, 20% of devices)',
    `INSERT INTO device_keys (id, device_id, public_key_spki, key_storage, created_at, revoked_at)
     SELECT md5('ko'||d)::uuid, md5('d'||d)::uuid,
            decode('${SPKI_HEADER_HEX}04', 'hex') || sha256(('ko'||d)::bytea) || sha256(('ko2'||d)::bytea),
            'tee', now() - interval '350 days', now() - interval '300 days'
     FROM generate_series(1, ${SIZES.devices}) d WHERE d % 5 = 0`,
  ],
  [
    'enrollment_challenges',
    `INSERT INTO enrollment_challenges (user_id, nonce_hash, created_at, expires_at, consumed_at)
     SELECT md5('u'||((e-1) % ${SIZES.users} + 1))::uuid, sha256(('en'||e)::bytea), t, t + interval '5 minutes',
            CASE WHEN e % 10 <> 0 THEN t + interval '1 minute' END
     FROM generate_series(1, ${SIZES.enrollments}) e,
          LATERAL (SELECT now() - interval '10 minutes' - e * interval '1 minute' AS t) x`,
  ],
  [
    'login_challenges (30 days: 70% consumed, 5% denied, 25% expired unanswered)',
    `INSERT INTO login_challenges (id, nonce_hash, browser_binding_hash, status, created_at, expires_at,
                                   requester_ip, requester_user_agent, decided_at, decided_by_key_id,
                                   decision_signature, consumed_at)
     SELECT md5('c'||c)::uuid, sha256(('n'||c)::bytea), sha256(('b'||c)::bytea),
            CASE WHEN c % 20 = 0 THEN 'denied' WHEN c % 20 <= 5 THEN 'pending' ELSE 'consumed' END,
            t, t + interval '60 seconds', ('203.0.113.'||(c % 250 + 1))::inet, 'Mozilla/5.0 (bench)',
            CASE WHEN c % 20 = 0 OR c % 20 > 5 THEN t + interval '20 seconds' END,
            CASE WHEN c % 20 = 0 OR c % 20 > 5 THEN md5('k'||((c-1) % ${SIZES.devices} + 1))::uuid END,
            CASE WHEN c % 20 = 0 OR c % 20 > 5 THEN sha256(('s1'||c)::bytea) || sha256(('s2'||c)::bytea) END,
            CASE WHEN c % 20 > 5 THEN t + interval '22 seconds' END
     FROM generate_series(1, ${SIZES.challenges}) c,
          LATERAL (SELECT now() - interval '2 minutes' - make_interval(secs => c * 2592000.0 / ${SIZES.challenges}) AS t) x`,
  ],
  [
    'browser_sessions (one per consumed challenge; 20% signed out)',
    `INSERT INTO browser_sessions (id, login_challenge_id, approved_by_device_id, token_hash, created_at,
                                   last_seen_at, expires_at, ip, user_agent, revoked_at, revoked_reason)
     SELECT md5('s'||c)::uuid, md5('c'||c)::uuid, md5('d'||((c-1) % ${SIZES.devices} + 1))::uuid,
            sha256(('tok'||c)::bytea), t, LEAST(t + make_interval(secs => c % 3600), now()),
            t + interval '12 hours', ('203.0.113.'||(c % 250 + 1))::inet, 'Mozilla/5.0 (bench)',
            CASE WHEN c % 5 = 0 THEN t + interval '1 hour' END,
            CASE WHEN c % 5 = 0 THEN 'signed_out' END
     FROM generate_series(1, ${SIZES.challenges}) c,
          LATERAL (SELECT now() - interval '2 minutes' - make_interval(secs => c * 2592000.0 / ${SIZES.challenges})
                          + interval '22 seconds' AS t) x
     WHERE c % 20 > 5`,
  ],
  [
    'recovery_code_batches (active + some revoked history)',
    `INSERT INTO recovery_code_batches (id, user_id, created_at, revoked_at)
     SELECT md5('rb'||i)::uuid, md5('u'||i)::uuid, now() - interval '200 days', NULL
     FROM generate_series(1, ${SIZES.users}) i
     UNION ALL
     SELECT md5('rbo'||i)::uuid, md5('u'||i)::uuid, now() - interval '300 days', now() - interval '200 days'
     FROM generate_series(1, ${SIZES.users}) i WHERE i % 3 = 0`,
  ],
  [
    'recovery_codes (10 per active batch, 2 used)',
    `INSERT INTO recovery_codes (batch_id, code_hash, used_at)
     SELECT md5('rb'||i)::uuid, '$scrypt$ln=15,r=8,p=1$c2FsdA$aGFzaA',
            CASE WHEN k <= 2 THEN now() - interval '10 days' END
     FROM generate_series(1, ${SIZES.users}) i, generate_series(1, 10) k`,
  ],
  [
    'audit_events (365 days, appended in time order)',
    `INSERT INTO audit_events (occurred_at, event_type, user_id, device_id, ip, user_agent, details)
     SELECT now() - interval '365 days' + make_interval(secs => a * 31536000.0 / ${SIZES.audit}),
            (ARRAY['login.approved','session.created','login.challenge_created','session.revoked','device.enrolled'])[a % 5 + 1],
            md5('u'||((a-1) % ${SIZES.users} + 1))::uuid, md5('d'||((a-1) % ${SIZES.devices} + 1))::uuid,
            ('203.0.113.'||(a % 250 + 1))::inet, 'Mozilla/5.0 (bench)', '{}'::jsonb
     FROM generate_series(1, ${SIZES.audit}) a`,
  ],
];

for (const [label, sql] of seed) {
  const started = Date.now();
  const { rowCount } = await db.query(sql);
  log(
    `seeded ${label}: ${rowCount.toLocaleString('en-US')} rows (${((Date.now() - started) / 1000).toFixed(1)} s)`,
  );
}
await db.query('VACUUM ANALYZE');
log('VACUUM ANALYZE done');

// ------------------------------------------------------------------------------------------------
// 3. Representative parameters, taken from the seeded data
// ------------------------------------------------------------------------------------------------
const {
  rows: [active],
} = await db.query(`
  SELECT s.id AS session_id, s.token_hash, d.id AS device_id, d.user_id, d.api_token_hash, k.id AS key_id, u.email
  FROM browser_sessions s
  JOIN devices d ON d.id = s.approved_by_device_id
  JOIN users u ON u.id = d.user_id
  JOIN device_keys k ON k.device_id = d.id AND k.revoked_at IS NULL
  WHERE s.revoked_at IS NULL AND s.expires_at > now() AND s.last_seen_at > now() - interval '2 hours'
    AND d.revoked_at IS NULL AND u.disabled_at IS NULL
  ORDER BY s.created_at DESC LIMIT 1`);
if (!active) throw new Error('seed produced no active session to benchmark with');

const {
  rows: [code],
} = await db.query(
  `SELECT c.id, c.batch_id FROM recovery_codes c JOIN recovery_code_batches b ON b.id = c.batch_id
   WHERE b.user_id = $1 AND b.revoked_at IS NULL AND c.used_at IS NULL LIMIT 1`,
  [active.user_id],
);

// Fresh rows that must be "live" when measured (committed now, valid for minutes).
const pendingNonce = randomBytes(32).toString('base64url');
const pendingBinding = randomBytes(32).toString('base64url');
const {
  rows: [pending],
} = await db.query(
  `INSERT INTO login_challenges (nonce_hash, browser_binding_hash, expires_at)
   VALUES ($1, $2, now() + interval '5 minutes') RETURNING id`,
  [sha(pendingNonce), sha(pendingBinding)],
);
const approvedBinding = randomBytes(32).toString('base64url');
const {
  rows: [approved],
} = await db.query(
  `INSERT INTO login_challenges (nonce_hash, browser_binding_hash, expires_at, status, decided_at,
                                 decided_by_key_id, decision_signature)
   VALUES ($1, $2, now() + interval '5 minutes', 'approved', now(), $3, $4) RETURNING id`,
  [sha(randomBytes(32)), sha(approvedBinding), active.key_id, randomBytes(64)],
);
const enrollNonce = randomBytes(32).toString('base64url');
const {
  rows: [enrollment],
} = await db.query(
  `INSERT INTO enrollment_challenges (user_id, nonce_hash, expires_at)
   VALUES ($1, $2, now() + interval '10 minutes') RETURNING id`,
  [active.user_id, sha(enrollNonce)],
);

const U = active.user_id;
const D = active.device_id;
const K = active.key_id;
const PHC = '$scrypt$ln=17,r=8,p=1$c2FsdA$aGFzaA';
const newSpki = () => Buffer.concat([Buffer.from(`${SPKI_HEADER_HEX}04`, 'hex'), randomBytes(64)]);
const day = 86400;

/** id -> { params: () => array, setup?: async (client) => extra, describe } */
const plans = {
  'Q-USR-01': {
    params: () => [`new-${randomBytes(4).toString('hex')}@bench.test`, null, PHC],
    describe: 'new email',
  },
  'Q-USR-02': { params: () => [active.email], describe: 'existing email' },
  'Q-USR-03': { params: () => [U], describe: 'user id' },
  'Q-USR-04': { params: () => [U, PHC], describe: 'user id, new hash' },
  'Q-ENR-01': { params: () => [U, sha(randomBytes(32)), 300], describe: 'user, nonce hash, 300 s' },
  'Q-ENR-02': {
    params: () => [enrollment.id, sha(enrollNonce)],
    describe: 'live enrollment challenge',
  },
  'Q-ENR-03': { params: () => [27 * day], describe: 'retention 27 days (~1 day of rows)' },
  'Q-DEV-01': {
    params: () => [U, 'Bench phone', 'ios', sha(randomBytes(32))],
    describe: 'new device',
  },
  'Q-DEV-02': { params: () => [U], describe: 'user id' },
  'Q-DEV-03': { params: () => [active.api_token_hash], describe: 'active device token hash' },
  'Q-DEV-04': { params: () => [D, 0], describe: 'device id, interval 0 (forces the write)' },
  'Q-DEV-05': { params: () => [D, U, 'lost'], describe: 'active device of user' },
  'Q-DEV-06': { params: () => [U], describe: 'user id' },
  'Q-KEY-01': {
    setup: async (client) => {
      const { rows } = await client.query(
        `INSERT INTO devices (user_id, name, platform, api_token_hash) VALUES ($1, 'Bench', 'ios', $2) RETURNING id`,
        [U, sha(randomBytes(32))],
      );
      return rows[0].id;
    },
    params: (deviceId) => [deviceId, 'ES256', newSpki(), 'secure_enclave'],
    describe: 'new device created in the same transaction (setup, not measured)',
  },
  'Q-KEY-02': { params: () => [D], describe: 'device with an active key' },
  'Q-KEY-03': { params: () => [D], describe: 'device with an active key' },
  'Q-KEY-04': { params: () => [U], describe: 'user id' },
  'Q-KEY-05': { params: () => [K], describe: 'key id' },
  'Q-KEY-06': { params: () => [K], describe: 'active key id' },
  'Q-LCH-01': {
    params: () => [
      sha(randomBytes(32)),
      sha(randomBytes(32)),
      60,
      '203.0.113.9',
      'Mozilla/5.0 (bench)',
    ],
    describe: 'new challenge',
  },
  'Q-LCH-02': { params: () => [pending.id, sha(pendingNonce)], describe: 'live pending challenge' },
  'Q-LCH-03': {
    params: () => [pending.id, 'approved', K, randomBytes(64), sha(pendingNonce)],
    describe: 'live pending challenge, active key',
  },
  'Q-LCH-04': {
    params: () => [pending.id, sha(pendingBinding), 60],
    describe: 'live pending challenge',
  },
  'Q-LCH-05': {
    params: () => [
      approved.id,
      sha(approvedBinding),
      sha(randomBytes(32)),
      43200,
      '203.0.113.9',
      'Mozilla/5.0 (bench)',
      300,
    ],
    describe: 'live approved challenge',
  },
  'Q-LCH-06': { params: () => [29 * day], describe: 'retention 29 days (~1 day of rows)' },
  'Q-LCH-07': { params: () => [pending.id, 60], describe: 'live pending challenge' },
  'Q-SES-01': { params: () => [active.token_hash, 7200], describe: 'active session token hash' },
  'Q-SES-02': {
    params: () => [active.session_id, 0],
    describe: 'session id, interval 0 (forces the write)',
  },
  'Q-SES-03': { params: () => [U, 7200], describe: 'user with active sessions' },
  'Q-SES-04': { params: () => [active.session_id, U], describe: 'own active session' },
  'Q-SES-05': { params: () => [active.token_hash], describe: 'active session token hash' },
  'Q-SES-06': { params: () => [D], describe: 'device with sessions' },
  'Q-SES-07': { params: () => [U], describe: 'user id' },
  'Q-SES-08': { params: () => [29 * day], describe: 'retention 29 days (~1 day of rows)' },
  'Q-REC-01': { params: () => [U], describe: 'user id' },
  'Q-REC-02': {
    setup: async (client) =>
      client.query(
        'UPDATE recovery_code_batches SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL',
        [U],
      ),
    params: () => [U],
    describe: 'after revoking the active batch (setup, not measured)',
  },
  'Q-REC-03': {
    params: () => [code.batch_id, Array(10).fill('$scrypt$ln=15,r=8,p=1$c2FsdA$aGFzaA')],
    describe: '10 code hashes',
  },
  'Q-REC-04': { params: () => [U], describe: 'user id' },
  'Q-REC-05': { params: () => [code.id, U], describe: 'unused code of user' },
  'Q-REC-06': { params: () => [U], describe: 'user id' },
  'Q-AUD-01': {
    params: () => [
      'login.approved',
      U,
      D,
      null,
      pending.id,
      '203.0.113.9',
      'Mozilla/5.0 (bench)',
      { bench: true },
    ],
    describe: 'one event',
  },
  'Q-AUD-02': { params: () => [U, null, null, 50], describe: 'first page of 50' },
  'Q-AUD-03': { params: () => [364 * day], describe: 'retention 364 days (~1 day of rows)' },
};

// ------------------------------------------------------------------------------------------------
// 4. Measure
// ------------------------------------------------------------------------------------------------
const queries = [...loadQueries().values()];
const missing = queries.filter((q) => !plans[q.id]).map((q) => q.id);
if (missing.length) throw new Error(`no benchmark parameters for ${missing.join(', ')}`);

const average = (values) => values.reduce((total, value) => total + value, 0) / values.length;

async function explainOnce(query) {
  await db.query('BEGIN');
  try {
    const plan = plans[query.id];
    const extra = plan.setup ? await plan.setup(db) : undefined;
    const { rows } = await db.query(`EXPLAIN (ANALYZE, BUFFERS) ${query.sql}`, plan.params(extra));
    return rows.map((r) => r['QUERY PLAN']).join('\n');
  } finally {
    await db.query('ROLLBACK');
  }
}

const measurements = [];
for (const query of queries) {
  const executions = [];
  const runPlans = [];
  const plannings = [];
  let lastPlan = '';
  for (let run = 0; run < RUNS; run += 1) {
    lastPlan = await explainOnce(query);
    runPlans.push(lastPlan);
    executions.push(Number(/Execution Time: ([\d.]+) ms/.exec(lastPlan)[1]));
    plannings.push(Number(/Planning Time: ([\d.]+) ms/.exec(lastPlan)[1]));
  }
  const access = [
    ...new Set(
      [
        ...lastPlan.matchAll(
          /(Index Only Scan|Index Scan|Bitmap Index Scan)(?: Backward)? (?:using|on) (\w+)|Seq Scan on (\w+)/g,
        ),
      ].map((m) => (m[3] ? `Seq Scan ${m[3]}` : `${m[1]} ${m[2]}`)),
    ),
  ];
  const topRows = /actual time=[\d.]+\.\.[\d.]+ rows=([\d.]+)/.exec(lastPlan)?.[1] ?? '?';
  const triggers = [
    ...lastPlan.matchAll(
      /Trigger (?:for constraint )?(\w+)(?: on \w+)?: time=([\d.]+) calls=(\d+)/g,
    ),
  ].map(([, name, time, calls]) => `${name} ${Number(time).toFixed(1)} ms / ${calls} calls`);
  measurements.push({
    query,
    executions,
    plannings,
    runPlans,
    lastPlan,
    access,
    topRows,
    triggers,
  });
  log(`${query.id} average ${average(executions).toFixed(3)} ms`);
}

// ------------------------------------------------------------------------------------------------
// 5. Report
// ------------------------------------------------------------------------------------------------
const counts = {};
for (const table of [
  'users',
  'devices',
  'device_keys',
  'enrollment_challenges',
  'login_challenges',
  'browser_sessions',
  'recovery_code_batches',
  'recovery_codes',
  'audit_events',
]) {
  counts[table] = Number((await db.query(`SELECT count(*) FROM ${table}`)).rows[0].count);
}
const { rows: settings } = await db.query(
  `SELECT name, setting, unit FROM pg_settings WHERE name IN ('shared_buffers','work_mem','effective_cache_size','random_page_cost','jit','track_io_timing')`,
);
const version = (await db.query('SELECT version()')).rows[0].version;
await db.end();

const cpu = (() => {
  try {
    return execFileSync('sysctl', ['-n', 'machdep.cpu.brand_string'], { encoding: 'utf8' }).trim();
  } catch {
    return os.cpus()[0]?.model ?? 'unknown';
  }
})();
const capturedAt = new Date().toISOString();
const fmt = (n) => n.toFixed(3);

const md = [
  '# AP query timings (measured)',
  '',
  '> GENERATED by `npm run db:benchmark` (db/scripts/benchmark.js). Do not edit by hand; re-run to refresh.',
  `> Captured ${capturedAt}. Raw EXPLAIN (ANALYZE, BUFFERS) plans for all three runs are in plans/, one file per query.`,
  '',
  '## Environment',
  '',
  `- PostgreSQL: ${version}`,
  `- Host: ${cpu}, ${os.cpus().length} cores, ${(os.totalmem() / 2 ** 30).toFixed(0)} GiB RAM, ${os.type()} ${os.release()}; PostgreSQL runs in Docker (docker-compose.yml).`,
  `- Settings: ${settings.map((s) => `${s.name}=${s.setting}${s.unit ? ' ' + s.unit : ''}`).join(', ')}`,
  `- Database: \`${benchName}\` (separate from dev/test), freshly migrated, seeded, then \`VACUUM ANALYZE\`.`,
  '',
  '## Dataset',
  '',
  '| Table | Rows |',
  '| --- | ---: |',
  ...Object.entries(counts).map(([t, c]) => `| ${t} | ${c.toLocaleString('en-US')} |`),
  '',
  `Synthetic data (BENCH_USERS=${N}): 1.5 phones per user (10% revoked), one active key per phone plus rotated-out keys,`,
  '30 days of QR challenges (70% consumed, 5% denied, 25% expired unanswered), one session per consumed challenge',
  '(12 h lifetime, 20% signed out), 10 recovery codes per user, 365 days of audit events appended in time order.',
  'Public keys and signatures are random bytes of the correct length (the database never verifies them).',
  '',
  '## Method',
  '',
  `- Each query runs exactly ${RUNS} times under \`EXPLAIN (ANALYZE, BUFFERS)\` with bound parameters.`,
  '- Every run is wrapped in `BEGIN … ROLLBACK`, so write queries are measured against identical data each time.',
  "- Times are PostgreSQL's own `Execution Time` / `Planning Time`. They exclude network and client overhead, and include",
  "  EXPLAIN ANALYZE's per-node timing overhead. No warm-up run is included; the three measured runs are averaged.",
  '- "Rows" is the actual row count of the top plan node in the last run. For INSERT/UPDATE/DELETE without RETURNING,',
  '  PostgreSQL reports 0 at that node even when rows were written.',
  '- "Triggers" lists time spent in triggers, including foreign-key actions such as ON DELETE SET NULL. It is part of the',
  '  execution time.',
  '',
  '## Results',
  '',
  `| ID | Type | ${Array.from({ length: RUNS }, (_, i) => `Run ${i + 1} (ms)`).join(' | ')} | Exec average (ms) | Plan average (ms) | Rows | Access path (last run) | Triggers | Parameters |`,
  `| --- | --- | ${Array(RUNS + 3)
    .fill('---:')
    .join(' | ')} | --- | --- | --- |`,
  ...measurements.map(
    ({ query, executions, plannings, access, topRows, triggers }) =>
      `| [${query.id}](plans/${query.id}.txt) | ${query.kind} | ${executions.map(fmt).join(' | ')} | ${fmt(average(executions))} | ${fmt(average(plannings))} | ${topRows} | ${access.join('; ') || '(no table scan: VALUES/Result)'} | ${triggers.join('; ') || '—'} | ${plans[query.id].describe} |`,
  ),
  '',
  '## Reading the results',
  '',
  'See the interpretation notes in [01_normalization.md §7](01_normalization.md#7-indexes-and-their-justification) for why each index',
  'exists; this table shows which index each query actually used on this dataset. Re-run on your own hardware with',
  '`npm run db:benchmark`; absolute numbers will differ, access paths should not.',
  '',
].join('\n');

mkdirSync(paths.apPlansDir, { recursive: true });
writeFileSync(path.join(paths.apDir, '05_query_timings.md'), md);
for (const { query, runPlans } of measurements) {
  const raw = [
    `# ${query.id} — ${query.description}`,
    `# GENERATED by npm run db:benchmark at ${capturedAt}.`,
    '# EXPLAIN (ANALYZE, BUFFERS) raw output for all three measured runs.',
    `# Type: ${query.kind}; parameters: ${plans[query.id].describe}`,
    `# PostgreSQL: ${version}`,
    `# Dataset: ${Object.entries(counts)
      .map(([table, count]) => `${table}=${count}`)
      .join(', ')}`,
    '',
    ...runPlans.flatMap((plan, index) => [
      '='.repeat(100),
      `${query.id} Run ${index + 1}  [${query.kind}]  ${query.description}`,
      `Parameters: ${plans[query.id].describe}`,
      '-'.repeat(100),
      plan,
      '',
    ]),
  ].join('\n');
  writeFileSync(path.join(paths.apPlansDir, `${query.id}.txt`), raw);
}
log(`wrote dbms/05_query_timings.md and ${measurements.length} files in dbms/plans/`);
