import QRCode from "qrcode";
import { prisma } from "../db.js";
import { appEvents } from "../events.js";
import { makeToken, sessionExpiry, setSessionCookie } from "../services/sessions.js";

const REQUEST_SECONDS = 120;
const REQUEST_COOKIE = "request_secret";

// POST /api/requests — the shared computer asks for a new QR code.
export async function createRequest(req, res, next) {
  try {
    const expiresAt = new Date(Date.now() + REQUEST_SECONDS * 1000);
    const browserName = String(req.get("user-agent") || "Browser").slice(0, 120);
    // Prisma fills in two random values (see @default(uuid()) in schema.prisma):
    // request.token goes into the QR code; request.browserSecret stays in this browser's cookie.
    const request = await prisma.loginRequest.create({ data: { browserName, expiresAt } });
    res.cookie(REQUEST_COOKIE, request.browserSecret, {
      httpOnly: true,
      sameSite: "lax",
      maxAge: REQUEST_SECONDS * 1000
    });
    const approveUrl = `${req.protocol}://${req.get("host")}/?approve=${request.token}`;
    const qr = await QRCode.toDataURL(approveUrl, { width: 280, margin: 2 });
    return res.status(201).json({ id: request.id, qr, expiresAt });
  } catch (error) {
    next(error);
  }
}

// GET /api/requests/:id — the computer polls this until the phone answers.
export async function requestStatus(req, res, next) {
  try {
    const request = await prisma.loginRequest.findUnique({
      where: { id: req.params.id },
      include: { session: true }
    });
    if (!request) return res.status(404).json({ error: "Request not found" });
    // Only the browser that created the request may collect its session cookie.
    if (req.cookies[REQUEST_COOKIE] !== request.browserSecret) {
      return res.status(403).json({ error: "This browser did not create the request" });
    }
    if (request.status === "PENDING" && request.expiresAt <= new Date()) {
      await prisma.loginRequest.update({ where: { id: request.id }, data: { status: "DENIED" } });
      return res.json({ status: "EXPIRED" });
    }
    if (request.status === "APPROVED" && request.session) {
      setSessionCookie(res, makeToken(request.session));
      res.clearCookie(REQUEST_COOKIE);
      return res.json({ status: "APPROVED" });
    }
    return res.json({ status: request.status });
  } catch (error) {
    next(error);
  }
}

// GET /api/requests/preview/:token — the phone sees which browser is asking.
export async function previewRequest(req, res, next) {
  try {
    const request = await prisma.loginRequest.findUnique({ where: { token: req.params.token } });
    if (!request || request.status !== "PENDING" || request.expiresAt <= new Date()) {
      return res.status(410).json({ error: "This QR request has expired or was already handled" });
    }
    return res.json({ browserName: request.browserName, expiresAt: request.expiresAt });
  } catch (error) {
    next(error);
  }
}

// POST /api/requests/approve — the signed-in phone approves or denies.
export async function approveRequest(req, res, next) {
  try {
    const { token, decision } = req.body;
    if (typeof token !== "string" || !["approve", "deny"].includes(decision))
      return res.status(400).json({ error: "Invalid decision" });

    // Change the request only if it is still pending and unexpired.
    // count is 0 when the QR was already used, so each QR works once.
    const changed = await prisma.loginRequest.updateMany({
      where: { token, status: "PENDING", expiresAt: { gt: new Date() } },
      data:
        decision === "deny"
          ? { status: "DENIED" }
          : {
              status: "APPROVED",
              approvedAt: new Date(),
              approvedByUserId: req.auth.userId,
              approvedByDeviceId: req.auth.device.id
            }
    });
    if (changed.count !== 1)
      return res.status(410).json({ error: "This request has expired or was already handled" });
    if (decision === "deny") return res.json({ status: "DENIED" });

    const request = await prisma.loginRequest.findUnique({ where: { token } });
    await prisma.session.create({
      data: {
        userId: req.auth.userId,
        deviceId: req.auth.device.id,
        loginRequestId: request.id,
        type: "BROWSER",
        name: request.browserName,
        expiresAt: sessionExpiry()
      }
    });
    appEvents.emit("login:approved", { requestId: request.id });
    return res.json({ status: "APPROVED" });
  } catch (error) {
    next(error);
  }
}
