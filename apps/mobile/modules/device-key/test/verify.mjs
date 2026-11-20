#!/usr/bin/env node
// Compiles ios/DeviceKeyCrypto.swift with the macOS Swift toolchain, signs the protocol's login
// decision message with it, and verifies the result with the API's own ES256 verifier.
// Proves the Swift side produces exactly the public-key and signature formats the server accepts.
// Requires macOS with swiftc (Xcode Command Line Tools). Usage: node test/verify.mjs
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildLoginDecisionMessage } from '@capstone/protocol';
import { parseEs256PublicKey, verifyEs256 } from '../../../../api/src/security/signatures.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const vector = JSON.parse(
  readFileSync(path.join(here, '../../../../../packages/protocol/test-vectors/es256.json'), 'utf8'),
);
const message = buildLoginDecisionMessage(vector.loginDecision.fields);

const workDir = mkdtempSync(path.join(tmpdir(), 'devicekey-'));
const binary = path.join(workDir, 'devicekey-test');
try {
  execFileSync('swiftc', [
    '-O',
    path.join(here, '../ios/DeviceKeyCrypto.swift'),
    path.join(here, 'main.swift'),
    '-o',
    binary,
  ]);
  const result = JSON.parse(execFileSync(binary, [message], { encoding: 'utf8' }));

  const failures = [];
  if (result.publicKeyLength !== 91)
    failures.push(`SPKI is ${result.publicKeyLength} bytes, expected 91`);
  const parsed = parseEs256PublicKey(Buffer.from(result.publicKey, 'base64url'));
  if (!parsed) failures.push('server rejected the Swift-encoded public key');
  const raw =
    parsed &&
    verifyEs256({
      keyObject: parsed.keyObject,
      message,
      signatureDer: Buffer.from(result.signature, 'base64url'),
    });
  if (!raw) failures.push('server rejected the Swift DER signature');
  if (result.softwareKeyReportedExportable !== true)
    failures.push('exportability check did not detect a software key');

  if (failures.length) {
    console.error('FAIL\n- ' + failures.join('\n- '));
    process.exit(1);
  }
  console.log(
    'PASS: Swift DeviceKeyCrypto SPKI (91 bytes) and DER ECDSA signature verify with the API verifier;',
  );
  console.log(
    '      exportability check flags software keys (Secure Enclave keys are refused if exportable).',
  );
} finally {
  rmSync(workDir, { recursive: true, force: true });
}
