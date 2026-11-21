import { promisify } from "node:util";
import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";

const scrypt = promisify(scryptCallback);
const KEY_LENGTH = 64;

export async function hashPassword(password) {
  const salt = randomBytes(16).toString("hex");
  const derived = await scrypt(password, salt, KEY_LENGTH);
  return `${salt}:${derived.toString("hex")}`;
}

export async function verifyPassword(password, savedHash) {
  const [salt, hashHex] = savedHash.split(":");
  if (!salt || !hashHex) return false;
  const saved = Buffer.from(hashHex, "hex");
  const candidate = await scrypt(password, salt, saved.length);
  return saved.length === candidate.length && timingSafeEqual(saved, candidate);
}
