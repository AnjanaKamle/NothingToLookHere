import { createHash, randomBytes, randomUUID } from "node:crypto";
import QRCode from "qrcode";
import { prisma } from "../db.js";
import { appEvents } from "../events.js";
import { createTokenForExistingSession, setSessionCookie } from "../services/sessions.js";

const REQUEST_SECONDS = 120;
const hashToken = (token) => createHash("sha256").update(token).digest("hex");

export async function createRequest(req, res, next) {
  try {
    const token = randomBytes(24).toString("base64url");
    const browserSecret = randomBytes(24).toString("base64url");
    const id = randomUUID();
    const expiresAt = new Date(Date.now() + REQUEST_SECONDS * 1000);
    const browserName = String(req.get("user-agent") || "Browser").slice(0, 120);
    await prisma.loginRequest.create({ data: { id, tokenHash: hashToken(token), browserHash: hashToken(browserSecret), browserName, expiresAt } });
    res.cookie("request_binding", browserSecret, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: REQUEST_SECONDS * 1000,
      path: "/api/requests"
    });
    const approveUrl = `${req.protocol}://${req.get("host")}/?approve=${encodeURIComponent(token)}`;
    const qr = await QRCode.toDataURL(approveUrl, { width: 280, margin: 2 });
    return res.status(201).json({ id, qr, expiresAt });
  } catch (error) { next(error); }
}

export async function requestDetails(req, res, next) {
  try {
    const request = await prisma.loginRequest.findUnique({ where: { id: req.params.id }, include: { session: true } });
    if (!request) return res.status(404).json({ error: "Request not found" });
    if (!req.cookies?.request_binding || hashToken(req.cookies.request_binding) !== request.browserHash) {
      return res.status(403).json({ error: "This browser did not create the request" });
    }
    if (request.status === "PENDING" && request.expiresAt <= new Date()) {
      await prisma.loginRequest.updateMany({ where: { id: request.id, status: "PENDING" }, data: { status: "DENIED" } });
      return res.json({ status: "EXPIRED" });
    }
    if (request.status === "APPROVED" && request.session) {
      const token = createTokenForExistingSession(request.session);
      setSessionCookie(res, token);
      res.clearCookie("request_binding", { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/api/requests" });
      return res.json({ status: "APPROVED" });
    }
    return res.json({ status: request.status });
  } catch (error) { next(error); }
}

export async function previewRequest(req, res, next) {
  try {
    const request = await prisma.loginRequest.findUnique({ where: { tokenHash: hashToken(req.params.token) } });
    if (!request || request.status !== "PENDING" || request.expiresAt <= new Date()) {
      return res.status(410).json({ error: "This QR request has expired or was already handled" });
    }
    return res.json({ browserName: request.browserName, expiresAt: request.expiresAt });
  } catch (error) { next(error); }
}

export async function approveRequest(req, res, next) {
  try {
    const { token, decision } = req.body;
    if (typeof token !== "string" || !["approve", "deny"].includes(decision)) return res.status(400).json({ error: "Invalid decision" });
    const request = await prisma.loginRequest.findUnique({ where: { tokenHash: hashToken(token) } });
    if (!request || request.status !== "PENDING" || request.expiresAt <= new Date()) return res.status(410).json({ error: "This request has expired" });
    if (decision === "deny") {
      await prisma.loginRequest.updateMany({ where: { id: request.id, status: "PENDING" }, data: { status: "DENIED" } });
      return res.json({ status: "DENIED" });
    }
    const result = await prisma.$transaction(async (tx) => {
      const changed = await tx.loginRequest.updateMany({
        where: { id: request.id, status: "PENDING", expiresAt: { gt: new Date() } },
        data: { status: "APPROVED", approvedAt: new Date(), approvedByUserId: req.auth.userId, approvedByDeviceId: req.auth.device.id }
      });
      if (changed.count !== 1) return null;
      return tx.session.create({
        data: {
          userId: req.auth.userId,
          deviceId: req.auth.device.id,
          type: "BROWSER",
          name: request.browserName,
          loginRequestId: request.id,
          expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
        }
      });
    });
    if (!result) return res.status(409).json({ error: "This request was already handled" });
    appEvents.emit("login:approved", { requestId: request.id });
    return res.json({ status: "APPROVED" });
  } catch (error) { next(error); }
}
