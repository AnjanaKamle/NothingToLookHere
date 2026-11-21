import { prisma } from "../db.js";

export async function listSessions(req, res, next) {
  try {
    const sessions = await prisma.session.findMany({
      where: { userId: req.auth.userId, type: "BROWSER", revokedAt: null, expiresAt: { gt: new Date() } },
      select: { id: true, name: true, createdAt: true, expiresAt: true },
      orderBy: { createdAt: "desc" }
    });
    return res.json({ sessions });
  } catch (error) { next(error); }
}

export async function revokeSession(req, res, next) {
  try {
    const result = await prisma.session.updateMany({
      where: { id: req.params.id, userId: req.auth.userId, type: "BROWSER", revokedAt: null },
      data: { revokedAt: new Date() }
    });
    if (!result.count) return res.status(404).json({ error: "Active browser session not found" });
    return res.json({ ok: true });
  } catch (error) { next(error); }
}
