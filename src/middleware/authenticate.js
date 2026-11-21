import jwt from "jsonwebtoken";
import { prisma } from "../db.js";

export async function authenticate(req, res, next) {
  try {
    const token = req.cookies?.session;
    if (!token) return res.status(401).json({ error: "Sign in first" });

    const payload = jwt.verify(token, process.env.JWT_SECRET);
    const session = await prisma.session.findFirst({
      where: {
        id: payload.sid,
        userId: payload.sub,
        revokedAt: null,
        expiresAt: { gt: new Date() },
        ...(payload.type === "PHONE" ? { device: { revokedAt: null } } : {})
      },
      include: { device: true }
    });
    if (!session) return res.status(401).json({ error: "Session expired or revoked" });
    req.auth = { userId: session.userId, sessionId: session.id, type: session.type, device: session.device };
    next();
  } catch {
    return res.status(401).json({ error: "Sign in again" });
  }
}

export function requirePhone(req, res, next) {
  if (req.auth?.type !== "PHONE") return res.status(403).json({ error: "Approve this request from a signed-in phone" });
  next();
}
