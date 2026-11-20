import { createPublicKey, verify } from 'node:crypto';

/**
 * ES256 device signatures: ECDSA on curve P-256 (prime256v1 / secp256r1) with SHA-256.
 *
 * Formats on the wire (all base64url, unpadded):
 *  - Public key: DER-encoded SubjectPublicKeyInfo with an uncompressed point (91 bytes). This is
 *    what iOS (SecKeyCopyExternalRepresentation + SPKI header) and Android
 *    (PublicKey.getEncoded()) produce.
 *  - Signature: DER-encoded ECDSA-Sig-Value, SEQUENCE { r INTEGER, s INTEGER } (ANSI X9.62), the
 *    native output of iOS SecKeyCreateSignature(.ecdsaSignatureMessageX962SHA256) and Android
 *    Signature("SHA256withECDSA"). 8–72 bytes.
 *
 * The DER signature is parsed strictly and converted to the fixed 64-byte r||s form (IEEE P1363),
 * which is what gets verified and stored.
 */

const SPKI_LENGTH = 91;

/**
 * Parses a DER SPKI public key and checks it is a P-256 key in canonical uncompressed form.
 * Returns { keyObject, spki } or null if the bytes are not an acceptable ES256 public key.
 */
export function parseEs256PublicKey(spkiDer) {
  if (!Buffer.isBuffer(spkiDer) || spkiDer.length !== SPKI_LENGTH) return null;
  let keyObject;
  try {
    keyObject = createPublicKey({ key: spkiDer, format: 'der', type: 'spki' });
  } catch {
    return null;
  }
  if (keyObject.asymmetricKeyType !== 'ec') return null;
  if (keyObject.asymmetricKeyDetails?.namedCurve !== 'prime256v1') return null;
  // Re-encoding must reproduce the input exactly (rejects unusual but parseable encodings).
  const canonical = keyObject.export({ type: 'spki', format: 'der' });
  if (!canonical.equals(spkiDer)) return null;
  return { keyObject, spki: canonical };
}

function readDerInteger(der, offset) {
  if (der[offset] !== 0x02) return null;
  const length = der[offset + 1];
  if (length === undefined || length < 1 || length > 33) return null;
  const start = offset + 2;
  const bytes = der.subarray(start, start + length);
  if (bytes.length !== length) return null;
  if (bytes[0] & 0x80) return null; // negative
  if (length > 1 && bytes[0] === 0x00 && !(bytes[1] & 0x80)) return null; // non-minimal
  const value = bytes[0] === 0x00 ? bytes.subarray(1) : bytes;
  if (value.length > 32) return null;
  return { value, next: start + length };
}

/** Strict DER ECDSA signature -> 64-byte r||s, or null if not canonical DER. */
export function derSignatureToRaw(der) {
  if (!Buffer.isBuffer(der) || der.length < 8 || der.length > 72) return null;
  if (der[0] !== 0x30 || der[1] !== der.length - 2) return null;
  const r = readDerInteger(der, 2);
  if (!r) return null;
  const s = readDerInteger(der, r.next);
  if (!s || s.next !== der.length) return null;
  const raw = Buffer.alloc(64);
  r.value.copy(raw, 32 - r.value.length);
  s.value.copy(raw, 64 - s.value.length);
  return raw;
}

/**
 * Verifies an ES256 signature over a UTF-8 message.
 * Returns the 64-byte raw signature when valid, or null when invalid or malformed.
 */
export function verifyEs256({ keyObject, message, signatureDer }) {
  const raw = derSignatureToRaw(signatureDer);
  if (!raw) return null;
  const valid = verify(
    'sha256',
    Buffer.from(message, 'utf8'),
    { key: keyObject, dsaEncoding: 'ieee-p1363' },
    raw,
  );
  return valid ? raw : null;
}
