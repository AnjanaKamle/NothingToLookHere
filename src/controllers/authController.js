import { prisma } from "../db.js";
import { hashPassword, verifyPassword } from "../services/passwords.js";
import { createSession, setSessionCookie } from "../services/sessions.js";
import { hashRecoveryCode, makeRecoveryCodes } from "../services/recoveryCodes.js";

function validCredentials(phone, password) {
  return typeof phone === "string" && phone.trim().length >= 5 && phone.trim().length <= 24
    && typeof password === "string" && password.length >= 8 && password.length <= 128;
}

export async function register(req, res, next) {
  try {
    const { phone, password, deviceName } = req.body;
    if (!validCredentials(phone, password)) return res.status(400).json({ error: "Enter a phone number and a password of at least 8 characters" });
    const recoveryCodes = makeRecoveryCodes();
    const result = await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({ data: { phone: phone.trim(), passwordHash: await hashPassword(password) } });
      const device = await tx.device.create({ data: { userId: user.id, name: String(deviceName || "My phone").slice(0, 80) } });
      await tx.recoveryCode.createMany({ data: recoveryCodes.map((code) => ({ userId: user.id, codeHash: hashRecoveryCode(code) })) });
      const session = await createSession({ userId: user.id, deviceId: device.id, type: "PHONE", name: device.name }, tx);
      return { user, token: session.token };
    });
    const { user, token } = result;
    setSessionCookie(res, token);
    return res.status(201).json({ user: { id: user.id, phone: user.phone }, recoveryCodes });
  } catch (error) {
    if (error.code === "P2002") return res.status(409).json({ error: "That phone number already has an account" });
    next(error);
  }
}

export async function recover(req, res, next) {
  try {
    const { phone, code, newPassword, deviceName } = req.body;
    if (typeof phone !== "string" || phone.trim().length < 5 || typeof code !== "string"
      || typeof newPassword !== "string" || newPassword.length < 8 || newPassword.length > 128) {
      return res.status(400).json({ error: "Enter your phone number, recovery code, and a new password of at least 8 characters" });
    }
    const user = await prisma.user.findUnique({ where: { phone: phone.trim() } });
    if (!user) return res.status(400).json({ error: "Phone number or recovery code is incorrect" });
    const passwordHash = await hashPassword(newPassword);
    const name = String(deviceName || "Recovered phone").slice(0, 80);
    const recoveryCodes = makeRecoveryCodes();
    const token = await prisma.$transaction(async (tx) => {
      const used = await tx.recoveryCode.updateMany({
        where: { userId: user.id, codeHash: hashRecoveryCode(code), usedAt: null },
        data: { usedAt: new Date() }
      });
      if (!used.count) return null;
      await tx.user.update({ where: { id: user.id }, data: { passwordHash } });
      await tx.session.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: new Date() } });
      await tx.device.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: new Date() } });
      await tx.recoveryCode.updateMany({ where: { userId: user.id, usedAt: null }, data: { usedAt: new Date() } });
      await tx.recoveryCode.createMany({ data: recoveryCodes.map((recoveryCode) => ({ userId: user.id, codeHash: hashRecoveryCode(recoveryCode) })) });
      const device = await tx.device.create({ data: { userId: user.id, name } });
      const session = await createSession({ userId: user.id, deviceId: device.id, type: "PHONE", name }, tx);
      return session.token;
    });
    if (!token) return res.status(400).json({ error: "Phone number or recovery code is incorrect" });
    setSessionCookie(res, token);
    return res.json({ user: { id: user.id, phone: user.phone }, recoveryCodes });
  } catch (error) { next(error); }
}

export async function login(req, res, next) {
  try {
    const { phone, password, deviceName } = req.body;
    if (!validCredentials(phone, password)) return res.status(400).json({ error: "Enter a valid phone number and password" });
    const user = await prisma.user.findUnique({ where: { phone: phone.trim() } });
    if (!user || !(await verifyPassword(password, user.passwordHash))) return res.status(401).json({ error: "Phone number or password is incorrect" });
    const name = String(deviceName || "My phone").slice(0, 80);
    const device = await prisma.device.create({ data: { userId: user.id, name } });
    const { token } = await createSession({ userId: user.id, deviceId: device.id, type: "PHONE", name });
    setSessionCookie(res, token);
    return res.json({ user: { id: user.id, phone: user.phone } });
  } catch (error) { next(error); }
}

export async function me(req, res) {
  const user = await prisma.user.findUnique({ where: { id: req.auth.userId }, select: { id: true, phone: true } });
  return res.json({ user, type: req.auth.type });
}

export async function logout(req, res, next) {
  try {
    await prisma.session.update({ where: { id: req.auth.sessionId }, data: { revokedAt: new Date() } });
    res.clearCookie("session", { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/" });
    return res.json({ ok: true });
  } catch (error) { next(error); }
}
