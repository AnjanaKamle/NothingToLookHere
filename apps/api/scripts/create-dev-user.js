#!/usr/bin/env node
/**
 * DEVELOPMENT-ONLY account setup.
 *
 *   npm run dev:create-user -- --email you@example.test [--name "Your Name"]
 *
 * Creates an account directly in the database and prints its first recovery codes once.
 * The password is read from the terminal without echo (or from stdin when piped).
 *
 * This is not a sign-up flow: there is no email verification, no CAPTCHA, and it needs direct
 * database access. It refuses to run when NODE_ENV=production. A production deployment needs a
 * real registration or invitation flow, which is out of scope for this project.
 */
import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline';
import pg from 'pg';
import { createAccount, MIN_PASSWORD_LENGTH } from '../src/services/accounts.js';

if (process.env.NODE_ENV === 'production') {
  console.error(
    'create-dev-user is a development tool and refuses to run with NODE_ENV=production.',
  );
  process.exit(1);
}

const { values } = parseArgs({
  options: { email: { type: 'string' }, name: { type: 'string' } },
});
const email = values.email?.trim().toLowerCase();
if (!email || !/^[^\s@]+@[^\s@]+$/.test(email)) {
  console.error('Usage: npm run dev:create-user -- --email you@example.test [--name "Your Name"]');
  process.exit(2);
}
if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set. Copy .env.example to .env at the repository root.');
  process.exit(2);
}

function readPassword(prompt) {
  return new Promise((resolve) => {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: process.stdin.isTTY,
    });
    if (process.stdin.isTTY) {
      process.stdout.write(prompt);
      // Suppress echo of typed characters.
      rl._writeToOutput = () => {};
    }
    rl.question(process.stdin.isTTY ? '' : prompt, (answer) => {
      rl.close();
      if (process.stdin.isTTY) process.stdout.write('\n');
      resolve(answer);
    });
  });
}

const password = await readPassword(`Password for ${email} (min ${MIN_PASSWORD_LENGTH} chars): `);
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
try {
  const { userId, recoveryCodes } = await createAccount(pool, {
    email,
    password,
    displayName: values.name ?? null,
  });
  console.log(`\nCreated account ${email} (${userId}).`);
  console.log('\nRecovery codes (shown once; store them somewhere safe):');
  for (const code of recoveryCodes) console.log(`  ${code}`);
  console.log('\nNext: sign in on the phone app to enroll it as a trusted device.');
} catch (error) {
  console.error(`Could not create account: ${error.message}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
