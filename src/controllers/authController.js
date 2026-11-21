import { prisma } from "../db.js";
import { hashPassword, verifyPassword } from "../services/passwords.js";
import { createPhoneSession, setSessionCookie } from "../services/sessions.js";

function validCredentials(phone, password) {
  return (
    typeof phone === "string" &&
    phone.trim().length >= 5 &&
    phone.trim().length <= 24 &&
    typeof password === "string" &&
    password.length >= 8 &&
    password.length <= 128
  );
}

const deviceNameFrom = (body) => String(body.deviceName || "My phone").slice(0, 80);

export async function register(req, res, next) {
  try {
    const { phone, password } = req.body;
    if (!validCredentials(phone, password))
      return res
        .status(400)
        .json({ error: "Enter a phone number and a password of at least 8 characters" });
    // Nested write: Prisma creates the user and their first device together.
    const user = await prisma.user.create({
      data: {
        phone: phone.trim(),
        passwordHash: await hashPassword(password),
        devices: { create: { name: deviceNameFrom(req.body) } }
      },
      include: { devices: true }
    });
    setSessionCookie(res, await createPhoneSession(user.id, user.devices[0]));
    return res.status(201).json({ user: { id: user.id, phone: user.phone } });
  } catch (error) {
    if (error.code === "P2002")
      return res.status(409).json({ error: "That phone number already has an account" });
    next(error);
  }
}

export async function login(req, res, next) {
  try {
    const { phone, password } = req.body;
    if (!validCredentials(phone, password))
      return res.status(400).json({ error: "Enter a valid phone number and password" });
    const user = await prisma.user.findUnique({ where: { phone: phone.trim() } });
    if (!user || !(await verifyPassword(password, user.passwordHash)))
      return res.status(401).json({ error: "Phone number or password is incorrect" });
    const device = await prisma.device.create({
      data: { userId: user.id, name: deviceNameFrom(req.body) }
    });
    setSessionCookie(res, await createPhoneSession(user.id, device));
    return res.json({ user: { id: user.id, phone: user.phone } });
  } catch (error) {
    next(error);
  }
}

export async function me(req, res, next) {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.auth.userId },
      select: { id: true, phone: true }
    });
    return res.json({ user, type: req.auth.type });
  } catch (error) {
    next(error);
  }
}

export async function logout(req, res, next) {
  try {
    await prisma.session.update({
      where: { id: req.auth.sessionId },
      data: { revokedAt: new Date() }
    });
    res.clearCookie("session", { path: "/" });
    return res.json({ ok: true });
  } catch (error) {
    next(error);
  }
}
