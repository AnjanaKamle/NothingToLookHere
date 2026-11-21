import jwt from "jsonwebtoken";
import { prisma } from "../db.js";

const SESSION_DAYS = 7;
const SESSION_MS = SESSION_DAYS * 24 * 60 * 60 * 1000;

export function sessionExpiry() {
  return new Date(Date.now() + SESSION_MS);
}

// The JWT only names a session row; authenticate() checks that row is still active.
export function makeToken(session) {
  return jwt.sign({ sub: session.userId, sid: session.id, type: session.type }, process.env.JWT_SECRET, { expiresIn: `${SESSION_DAYS}d` });
}

export async function createPhoneSession(userId, device) {
  const session = await prisma.session.create({
    data: { userId, deviceId: device.id, type: "PHONE", name: device.name, expiresAt: sessionExpiry() }
  });
  return makeToken(session);
}

export function setSessionCookie(res, token) {
  res.cookie("session", token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: SESSION_MS,
    path: "/"
  });
}
