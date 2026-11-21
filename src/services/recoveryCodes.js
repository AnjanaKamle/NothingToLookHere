import { createHash, randomBytes } from "node:crypto";

export function makeRecoveryCodes(count = 8) {
  return Array.from({ length: count }, () => randomBytes(8).toString("hex"));
}

export function hashRecoveryCode(code) {
  return createHash("sha256").update(String(code).trim().toLowerCase()).digest("hex");
}
