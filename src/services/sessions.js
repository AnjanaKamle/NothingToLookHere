import { randomUUID } from "node:crypto";
import jwt from "jsonwebtoken";
import { prisma } from "../db.js";

const SESSION_DAYS = 7;

export async function createSession({ userId, type, name, deviceId = null, loginRequestId = null }, client = prisma) {
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);
  const session = await client.session.create({
    data: { id: randomUUID(), userId, type, name, deviceId, loginRequestId, expiresAt }
  });
  const token = jwt.sign({ sub: userId, sid: session.id, type }, process.env.JWT_SECRET, { expiresIn: `${SESSION_DAYS}d` });
  return { session, token };
}

export function setSessionCookie(res, token) {
  res.cookie("session", token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: SESSION_DAYS * 24 * 60 * 60 * 1000,
    path: "/"
  });
}

export function createTokenForExistingSession(session) {
  return jwt.sign({ sub: session.userId, sid: session.id, type: session.type }, process.env.JWT_SECRET, { expiresIn: "7d" });
}
